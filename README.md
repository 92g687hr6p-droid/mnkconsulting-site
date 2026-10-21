# mnkconsulting.co.uk

Source of the MNK Consulting website, published with GitHub Pages.

- `index.html` – company home page
- `storyprints/` – StoryPrints app page
- `storyprints/privacy/` – StoryPrints privacy policy (linked from Google Play)
- `storyprints/help/windows/` – StoryPrints for Windows help chapters. The app's
  Help buttons link to these addresses (and to `#scene-N` for one scene), so
  keep the folder names; if one must move, change the app's help table too.
- `CNAME` – tells GitHub Pages the custom domain

Plain HTML and one stylesheet (`styles.css`); no build step.

## Help voice-over

`storyprints/help/*/*/narration/` holds the recorded Read aloud voice: one MP3
per caption line plus `index.json`. Make or update it with Kokoro, from this
folder, in the Python environment that has Kokoro installed:

    python _tools\make_narration.py --samples          # hear the British voices
    python _tools\make_narration.py --voice bf_emma     # first time
    python _tools\make_narration.py                     # after changing captions

Before committing help changes, check them (any Python 3, nothing to install):

    python _tools\check_help.py

It says "All help pages OK." or lists caption lines with no recording, links
to pages or files that are not in the site, and scenes with no written step.

`_tools/` and `_narration-samples/` start with `_`, so GitHub Pages does not publish them.
