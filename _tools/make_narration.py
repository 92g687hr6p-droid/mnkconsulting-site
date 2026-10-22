"""Make the recorded voice-over for the StoryPrints help chapters with Kokoro.

Run from the website repository's top folder, in the Python environment that
has Kokoro installed:

    python _tools\\make_narration.py --samples              # hear every British voice
    python _tools\\make_narration.py --say "Any words" --voice bf_emma
    python _tools\\make_narration.py --voice bf_emma         # make the chapters' audio
    python _tools\\make_narration.py                         # update after wording changes

What it makes, for every chapter folder under storyprints/help/*/:
    narration/index.json         which caption line plays which file, and the voices
    narration/<voice>/<id>.mp3   one short file per caption line

The help player (storyprints/help/player.js) plays these files when "Read aloud"
is on, so nothing is sent anywhere and every browser hears the same voice.

Only lines whose words (or pronunciation) changed are made again; files no
longer used are deleted. Nothing outside the narration folders is changed.

The first run downloads Kokoro's model and voices (about 330 MB) from Hugging
Face into your user folder; after that it works without the internet.
Kokoro-82M and its voices are Apache 2.0 licensed.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import wave
from html.parser import HTMLParser
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
HELP = ROOT / "storyprints" / "help"
SAMPLES = ROOT / "_narration-samples"   # starts with _ so GitHub Pages never publishes it
RATE = 24000                            # Kokoro's sample rate
TAIL = 0.12                             # seconds of quiet added after each line

# Kokoro's British English voices (lang_code "b"). Grades in Kokoro's own voice
# list put Emma highest of the British voices; listen to all of them with --samples.
VOICES = {
    "bf_emma": "Emma",
    "bf_isabella": "Isabella",
    "bf_alice": "Alice",
    "bf_lily": "Lily",
    "bm_george": "George",
    "bm_fable": "Fable",
    "bm_lewis": "Lewis",
    "bm_daniel": "Daniel",
}

# How words are said. Applied to the spoken text only; the captions are not
# changed. Add a line here when a word comes out wrong, then run the script
# again (only lines containing it are remade). Kokoro also accepts phonemes:
#   (r"\bHEIF\b", "[HEIF](/hˈiːf/)")
SAY = [
    (r"\bStoryPrints\b", "Story Prints"),
    (r"\bHEIF\b", "heef"),
    (r"\bHEVC\b", "H E V C"),
    (r"\bOneDrive\b", "One Drive"),
    (r"\bDCIM\b", "D C I M"),
    # iPhone "Live Photos" / "turn Live off": live as in a live broadcast
    # (rhymes with five), not "to live". Kokoro's phonemes: I is the "eye" sound.
    (r"\bLive\b", "[Live](/lˈIv/)"),
]

SAMPLE_TEXT = (
    "StoryPrints finds the edges for you and outlines the photo in lime. "
    "If the outline is right, click Accept crop. "
    "Copy your photos to the PC with a USB cable, then make a PDF of the show."
)


# ---- reading the chapters ----------------------------------------------------

class BeatReader(HTMLParser):
    """Collects the text of every <li> inside an <ol class="beats">."""

    def __init__(self):
        super().__init__()
        self.in_beats = 0
        self.in_li = False
        self.buf = []
        self.lines = []

    def handle_starttag(self, tag, attrs):
        if tag == "ol" and "beats" in (dict(attrs).get("class") or "").split():
            self.in_beats += 1
        elif tag == "li" and self.in_beats:
            self.in_li, self.buf = True, []

    def handle_endtag(self, tag):
        if tag == "li" and self.in_li:
            self.in_li = False
            self.lines.append("".join(self.buf))
        elif tag == "ol" and self.in_beats:
            self.in_beats -= 1

    def handle_data(self, data):
        if self.in_li:
            self.buf.append(data)


class SceneReader(HTMLParser):
    """Scenes with their duration and caption lines (for the timing report)."""

    def __init__(self):
        super().__init__()
        self.scenes = []
        self.li = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "figure" and "scene" in (a.get("class") or "").split():
            self.scenes.append({"title": a.get("data-title", ""),
                                "duration": float(a.get("data-duration") or 10), "beats": []})
        elif tag == "li" and "data-at" in a and self.scenes:
            self.li = {"at": float(a["data-at"] or 0), "text": ""}

    def handle_endtag(self, tag):
        if tag == "li" and self.li is not None:
            self.scenes[-1]["beats"].append(self.li)
            self.li = None

    def handle_data(self, data):
        if self.li is not None:
            self.li["text"] += data


def caption_key(text):
    """The key the player looks the line up by (it collapses spaces the same way)."""
    return re.sub(r"\s+", " ", text).strip()


def spoken(text):
    """What is actually said: the player's own clean-up, then the SAY list."""
    t = caption_key(text)
    t = re.sub(r"^[\s…]+|[\s…]+$", "", t).replace("…", ", ").replace("·", ",")
    for pattern, said in SAY:
        t = re.sub(pattern, said, t)
    return t


def line_id(said, speed):
    return hashlib.sha1(f"{speed:.2f}|{said}".encode("utf-8")).hexdigest()[:12]


def chapters():
    for page in sorted(HELP.glob("*/*/index.html")):
        html = page.read_text(encoding="utf-8")
        if 'class="beats"' in html:
            yield page.parent, html


# ---- making sound --------------------------------------------------------------

class Speaker:
    def __init__(self):
        try:
            from kokoro import KPipeline
        except ImportError:
            sys.exit("Kokoro is not installed in this Python environment (pip install kokoro).")
        print("Loading Kokoro (British English)...")
        self.pipe = KPipeline(lang_code="b", repo_id="hexgrad/Kokoro-82M")
        g2p = getattr(self.pipe, "g2p", None)
        if g2p is not None and getattr(g2p, "fallback", "unknown") is None:
            print("\nWARNING: espeak-ng was not found, so any word missing from Kokoro's"
                  "\ndictionary will be SILENTLY LEFT OUT. Install espeak-ng (the .msi from"
                  "\nhttps://github.com/espeak-ng/espeak-ng/releases) or add the word to SAY.\n")
        self.unknown = {}

    def say(self, text, voice, speed):
        parts = []
        for result in self.pipe(text, voice=voice, speed=speed, split_pattern=None):
            audio = getattr(result, "audio", None)
            if audio is None and isinstance(result, tuple):
                audio = result[2]
            for tok in getattr(result, "tokens", None) or []:
                word = (getattr(tok, "text", "") or "").strip()
                if re.search(r"[A-Za-z0-9]", word) and not getattr(tok, "phonemes", None):
                    self.unknown.setdefault(word, text)
            if audio is None:
                continue
            if hasattr(audio, "detach"):
                audio = audio.detach().cpu().numpy()
            parts.append(np.asarray(audio, dtype=np.float32).reshape(-1))
        if not parts:
            return np.zeros(int(RATE * 0.3), dtype=np.float32)
        return np.concatenate(parts + [np.zeros(int(RATE * TAIL), dtype=np.float32)])

    def report_unknown(self):
        if self.unknown:
            print("\nWords Kokoro could not pronounce (left out of the audio):")
            for word, text in sorted(self.unknown.items()):
                print(f"  {word!r}  in: {text}")
            print("Add them to SAY at the top of this script and run it again.")


def write_wav(path, audio):
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())


def mp3_writer():
    """soundfile (libsndfile 1.1+ writes MP3) if it can, else ffmpeg, else None."""
    try:
        import soundfile as sf
        if "MP3" in sf.available_formats():
            def write(path, audio):
                sf.write(str(path), audio, RATE, format="MP3", subtype="MPEG_LAYER_III")
            return write
    except Exception:
        pass
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        def write(path, audio):
            with tempfile.TemporaryDirectory() as tmp:
                wav = Path(tmp) / "line.wav"
                write_wav(wav, audio)
                subprocess.run([ffmpeg, "-loglevel", "error", "-y", "-i", str(wav),
                                "-codec:a", "libmp3lame", "-b:a", "64k", str(path)], check=True)
        return write
    return None


def seconds_of(path):
    if path.suffix == ".wav":
        with wave.open(str(path)) as w:
            return w.getnframes() / w.getframerate()
    try:
        import soundfile as sf
        return sf.info(str(path)).duration
    except Exception:
        pass
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        out = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration",
                              "-of", "csv=p=0", str(path)], capture_output=True, text=True)
        try:
            return float(out.stdout.strip())
        except ValueError:
            pass
    return None


# ---- the three jobs --------------------------------------------------------------

def make_samples(args, writer, ext):
    SAMPLES.mkdir(exist_ok=True)
    speaker = Speaker()
    voices = args.voice or list(VOICES)
    text = spoken(args.say) if args.say else spoken(SAMPLE_TEXT)
    for v in voices:
        out = SAMPLES / f"{'say' if args.say else 'sample'}-{v}{ext}"
        writer(out, speaker.say(text, v, args.speed))
        print(f"  {VOICES.get(v, v):9} {out}")
    speaker.report_unknown()
    print(f"\nListen to the files in {SAMPLES}")


def make_chapters(args, writer, ext):
    todo = []
    for folder, html in chapters():
        if args.chapter and folder.name not in args.chapter:
            continue
        reader = BeatReader()
        reader.feed(html)
        index_path = folder / "narration" / "index.json"
        old = {}
        if index_path.exists():
            old = json.loads(index_path.read_text(encoding="utf-8"))
        voices = [v["id"] for v in old.get("voices", [])]
        voices += [v for v in (args.voice or []) if v not in voices]
        voices = [v for v in voices if v not in (args.remove_voice or [])] or ["bf_emma"]
        todo.append((folder, reader.lines, voices, index_path))

    if not todo:
        sys.exit("No help chapters found under " + str(HELP))

    speaker = None
    made = 0
    for folder, lines, voices, index_path in todo:
        narr = folder / "narration"
        table = {}
        for text in lines:
            said = spoken(text)
            if said:
                table[caption_key(text)] = line_id(said, args.speed)
        said_by_id = {line_id(spoken(t), args.speed): spoken(t) for t in lines if spoken(t)}

        for v in voices:
            vdir = narr / v
            vdir.mkdir(parents=True, exist_ok=True)
            for lid, said in said_by_id.items():
                out = vdir / f"{lid}{ext}"
                if out.exists() and not args.force:
                    continue
                if speaker is None:
                    speaker = Speaker()
                print(f"  {folder.name}/{v}: {said}")
                writer(out, speaker.say(said, v, args.speed))
                made += 1
            for f in vdir.iterdir():   # files for wording that has gone
                if f.is_file() and (f.stem not in said_by_id or f.suffix != ext):
                    f.unlink()
        if narr.exists():               # voices no longer offered
            for d in narr.iterdir():
                if d.is_dir() and d.name not in voices:
                    shutil.rmtree(d)

        index = {
            "format": "storyprints-narration",
            "version": 1,
            "made_with": "Kokoro-82M (Apache 2.0)",
            "speed": args.speed,
            "ext": ext,
            "voices": [{"id": v, "label": VOICES.get(v, v)} for v in voices],
            "lines": table,
        }
        narr.mkdir(exist_ok=True)
        index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    if speaker:
        speaker.report_unknown()
    print(f"\n{made} audio file(s) made.")
    timing_report(todo, args.speed, ext)


def timing_report(todo, speed, ext):
    """Where a line is longer than its gap the scene waits for it (that is fine);
    this shows how much each chapter grows, so data-at times can be retuned if wanted."""
    print("\nTiming (first voice), seconds:")
    print(f"  {'chapter':28} {'as timed':>8} {'with voice':>10}  lines that hold the scene")
    for folder, html_lines, voices, _ in todo:
        reader = SceneReader()
        reader.feed((folder / "index.html").read_text(encoding="utf-8"))
        v = voices[0]
        planned = played = 0.0
        held = 0
        for sc in reader.scenes:
            beats = sc["beats"]
            planned += sc["duration"]
            t_end = 0.0
            for k, b in enumerate(beats):
                slot_end = beats[k + 1]["at"] if k + 1 < len(beats) else sc["duration"]
                said = spoken(b["text"])
                f = folder / "narration" / v / f"{line_id(said, speed)}{ext}"
                secs = seconds_of(f) if said and f.exists() else 0
                secs = secs or 0
                start = max(b["at"], t_end)
                t_end = start + secs
                if t_end > slot_end + 0.05:
                    held += 1
            played += max(sc["duration"], t_end)
        print(f"  {folder.name:28} {planned:8.1f} {played:10.1f}  {held}")


def main():
    p = argparse.ArgumentParser(description="Make the StoryPrints help voice-over with Kokoro.")
    p.add_argument("--voice", action="append",
                   help="add this voice, e.g. bf_emma (repeat for several; voices made before are kept)")
    p.add_argument("--remove-voice", action="append", help="stop offering this voice")
    p.add_argument("--speed", type=float, default=1.0, help="Kokoro speaking speed (default 1.0)")
    p.add_argument("--chapter", action="append", help="only this chapter folder, e.g. cropping")
    p.add_argument("--samples", action="store_true", help="write a sample of each voice to _narration-samples")
    p.add_argument("--say", help="with --voice: say these words into _narration-samples")
    p.add_argument("--format", choices=["mp3", "wav"], default="mp3")
    p.add_argument("--force", action="store_true", help="make every file again")
    args = p.parse_args()

    for v in (args.voice or []):
        if v not in VOICES:
            print(f"Note: {v} is not one of the British voices ({', '.join(VOICES)}).")

    writer, ext = write_wav, ".wav"
    if args.format == "mp3":
        writer = mp3_writer()
        ext = ".mp3"
        if writer is None:
            sys.exit("Can't write MP3 here: pip install soundfile (or put ffmpeg on PATH), "
                     "or use --format wav.")

    if args.samples or args.say:
        make_samples(args, writer, ext)
    else:
        make_chapters(args, writer, ext)


if __name__ == "__main__":
    main()
