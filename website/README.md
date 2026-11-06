# Product website

Canonical static source: `public/`. Preview locally:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory public
```

The site uses local CSS, JavaScript, SVG and screenshots, without analytics,
remote fonts or a build dependency. `reader-preview.png` and `reader-dark.png`
were captured from the packaged app with invented conversations using the
repository's synthetic smoke harness. They contain no real user chats.

Run `node build.mjs` to copy the static source into ignored `dist/` for deployment.

Source identity for Sites hosting is in `.openai/hosting.json`. Deploy an isolated
copy of this directory, never the parent application's private Git history.
Update exact-version download links and the release summary after publishing a
GitHub Release. `tools/release/website.test.mjs` verifies version agreement and
local assets from the repository root.
