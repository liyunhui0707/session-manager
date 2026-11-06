# Packaged acceptance checklist

Use invented conversations and a fresh profile. Do not open personal chat stores for development or QA.

## Reader

- Open a synthetic Codex root with named, archived, background and empty initialization-only records. Confirm filtering, counts and restored source selection.
- Open a long conversation at the latest bottom. Older lands at the preceding part's bottom; newer lands at the next part's top; first/latest work.
- Append a prompt and final reply. Confirm following at the end and stable position while reading history.
- Search across parts, continue results, open a hit, cancel, and retry after source changes.
- Exercise favorites, 14–26 px type, both reading widths, light/dark/system and keyboard shortcuts at narrow and large windows.
- Test supported, missing, oversized and restricted local images. Repeatedly open/close large previews and switch conversations.
- Confirm question-response cards, assistant disclosure, corrupt-record warnings and source-unavailable recovery.
- Hash synthetic sources before/after browsing. Confirm no modifications.

## Distribution (separate evidence)

- Record OS, architecture, package version, source commit and SHA-256.
- Download the actual published artifact on a second Mac; compare checksum.
- Mount DMG, drag App to Applications, eject, and launch the installed copy.
- Record actual macOS quarantine/Gatekeeper behavior; do not claim notarization for an unsigned package.
- Replace a normally exited older installation and confirm local preferences survive. Never overwrite a running app.
- Verify CPU architecture for both helper and runtime. Do not extrapolate Apple Silicon evidence to Intel.
- Check clean exit and no candidate process left behind.

Automated companion: `node apps/desktop/tools/qa/reader-smoke.mjs '/absolute/path/AI Session Manager.app'`. The whole QA directory must accompany the entry point. Resource/long-run options are documented in the script. Harness success is not a substitute for the native installation checks above.
