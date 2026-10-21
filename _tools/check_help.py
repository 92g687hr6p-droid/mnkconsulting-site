"""Check the StoryPrints help chapters before committing them.

Run from the website repository's top folder (any Python 3, nothing to
install):

    python _tools\\check_help.py

It checks every chapter under storyprints/help/*/*/:
  - every caption line has its Read aloud recording, in every voice
    (after changing a caption, run _tools\\make_narration.py first)
  - every link and file on the page that starts with "/" is in the site
  - each scene has its written step underneath, with the same title

It changes nothing. It ends with "All help pages OK." or a list of problems
(and exit code 1).
"""
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HELP = ROOT / "storyprints" / "help"


def text_of(fragment):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", fragment))).strip()


def exists_in_site(address):
    path = ROOT / address.split("#")[0].split("?")[0].lstrip("/")
    return path.is_file() or (path / "index.html").is_file()


def check_chapter(page, problems):
    folder = page.parent
    name = folder.relative_to(HELP).as_posix()
    source = page.read_text(encoding="utf-8")

    # links and files
    for address in re.findall(r'(?:href|src)="(/[^"]*)"', source):
        if not exists_in_site(address):
            problems.append(f"{name}: link to {address}, which is not in the site")

    scenes = re.findall(r'<figure class="scene"[^>]*data-title="([^"]*)"[^>]*>(.*?)</figure>', source, re.S)
    if not scenes:
        return

    # recordings
    beats = []
    for _, body in scenes:
        for ol in re.findall(r'<ol class="beats"[^>]*>(.*?)</ol>', body, re.S):
            beats += [text_of(li) for li in re.findall(r"<li[^>]*>(.*?)</li>", ol, re.S)]
    index_file = folder / "narration" / "index.json"
    if not index_file.is_file():
        problems.append(f"{name}: no narration/index.json - run _tools\\make_narration.py")
    else:
        index = json.loads(index_file.read_text(encoding="utf-8"))
        lines = {re.sub(r"\s+", " ", key).strip(): value for key, value in index.get("lines", {}).items()}
        ext = index.get("ext", ".mp3")
        for beat in beats:
            line_id = lines.get(beat)
            if not line_id:
                problems.append(f"{name}: no recording for “{beat}” - run _tools\\make_narration.py")
                continue
            for voice in index.get("voices", []):
                if not (folder / "narration" / voice["id"] / f"{line_id}{ext}").is_file():
                    problems.append(f"{name}: {voice['id']} recording {line_id}{ext} is missing")

    # written steps
    steps = re.search(r'<ol class="steps">(.*?)</ol>', source, re.S)
    titles = [text_of(t) for t in re.findall(r"<li><strong>(.*?)</strong>", steps.group(1), re.S)] if steps else []
    for title, _ in scenes:
        if html.unescape(title) not in titles:
            problems.append(f"{name}: scene “{html.unescape(title)}” has no written step underneath")


def main():
    problems = []
    pages = sorted(HELP.glob("*/*/index.html"))
    for page in pages:
        check_chapter(page, problems)
    for page in sorted(HELP.glob("*/index.html")) + [ROOT / "storyprints" / "index.html"]:
        source = page.read_text(encoding="utf-8")
        for address in re.findall(r'(?:href|src)="(/[^"]*)"', source):
            if not exists_in_site(address):
                problems.append(f"{page.relative_to(ROOT).as_posix()}: link to {address}, which is not in the site")
    if problems:
        print("\n".join(problems))
        print(f"\n{len(problems)} problem(s) in {len(pages)} chapters.")
        sys.exit(1)
    print(f"All help pages OK ({len(pages)} chapters).")


if __name__ == "__main__":
    main()
