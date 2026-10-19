# mnkconsulting.co.uk

Source of the MNK Consulting website, published with GitHub Pages.

- `index.html` – company home page
- `storyprints/` – StoryPrints app page
- `storyprints/privacy/` – StoryPrints privacy policy (linked from Google Play)
- `CNAME` – tells GitHub Pages the custom domain

Plain HTML and one stylesheet (`styles.css`); no build step.

## Help voice-over

`storyprints/help/*/*/narration/` holds the recorded Read aloud voice: one MP3
per caption line plus `index.json`. Make or update it with Kokoro, from this
folder, in the Python environment that has Kokoro installed:

    python _tools\make_narration.py --samples          # hear the British voices
    python _tools\make_narration.py --voice bf_emma     # first time
    python _tools\make_narration.py                     # after changing captions

`_tools/` and `_narration-samples/` start with `_`, so GitHub Pages does not publish them.
