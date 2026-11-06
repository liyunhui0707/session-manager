# Historical physical-page reader

These five modules implemented the original byte-page reader. The production
entry point now uses `lib/codex-page-reader-v2.js`, which selects prompts/final
replies and opens the latest conversation page.

Retained only for historical regression tests and the older measurement scripts.
They are excluded from the packaged app. Shared production limits live in
`lib/codex-page-limits.js`; the checked raw/zstd stream remains production code.
Do not add new product behavior here.
