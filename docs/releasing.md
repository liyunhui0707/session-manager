# Release procedure

## Channels and identity

The public product repository is `liyunhui0707/session-manager`. Maintain source
there after the initial publication. Never push the original private development
repository or archive refs into it. Public commits use a maintainer's GitHub
noreply address; no global Git identity change is required.

The current channel offers unsigned, unnotarized Apple Silicon DMG and ZIP files.
Intel builds are candidates until architecture-specific GUI acceptance is recorded.
Do not publish an update manifest or advertise in-app update installation before
Developer ID signing, notarization and a real signed upgrade test are available.

## Prepare

1. Start from an accepted public `main`. Update the package and lockfile versions
   together under SemVer; add a concrete CHANGELOG entry.
2. Run `python3 tools/release/audit-public-tree.py` from the root. Review all
   filenames/categories and screenshots. It scans only the bounded current tree,
   not Git history, ignored files or user stores. It does not guarantee complete
   secret detection. Public history and commit metadata need separate review.
3. Run `node --test tools/release/*.test.mjs`. In `apps/desktop`, run
   `npm run test:ci`, `npm run audit:prod`, `npm run audit:release`, and `npm run dist:mac`.
   The full-tree audit includes Electron: npm lists it as a development dependency,
   but its runtime ships in the App. A production-only audit cannot cover it.
4. Run the packaged synthetic smoke harness. Record version, OS/CPU, exact ASAR
   hash, test result and exit status. Perform the native download/install checks
   in `test-manual.md` separately. An unavailable second Mac must be reported.
5. Commit the exact reviewed state, tag `v<package-version>`, and push only the
   intended branch and tag. Never use `--mirror` or `--all` from a private archive.

## Build candidates

The manually dispatched **Build unsigned release candidates** workflow takes an
existing version tag. It checks tag/version/architecture, audits the public tree,
runs tests and builds on native ARM and Intel runners. It retains artifacts for
14 days and has no release publication permission. Candidate builds are not
proof of interactive installation or minimum-OS acceptance.

Local packaging prepares the locked Electron runtime automatically using its
checksum-validating installer. A fresh checkout needs only `npm ci`, then
`npm run dist:mac`; the first build may download Electron and needs network
access. Installation failure stops the build. Existing versioned DMG/ZIP files
are refused before packaging; move them aside when intentionally rebuilding.
`dist:mac` uses the current host architecture and rejects cross-build arguments so a host-native helper
cannot silently ship in the wrong architecture bundle.

## Publish downloads

Generate checksums from exact-version files, never a broad directory glob:

```sh
node tools/release/release-metadata.mjs apps/desktop/dist 0.10.2 arm64
```

Create a **draft** GitHub Release for the verified tag. Upload only the reviewed
DMG, ZIP, `SHA256SUMS-arm64.txt`, and release acceptance notes. Confirm uploaded
sizes and SHA-256 against the local files. Release notes must state architecture,
minimum OS, unsigned/notarized status, manual update steps, and any verification
limits. Publish the draft only after those checks.

Do not publish old artifacts left in `dist`, test fixtures, local paths or logs.
Do not claim a code-signing identity from an ad-hoc signature.

## Website

The canonical website source is `website/public`; `.openai/hosting.json` under
`website` records its Sites identity. Preview with a static HTTP server rooted at
`website/public`. No build dependencies, analytics or remote fonts are required.

After publishing a release, update the website's version, exact download URLs
and release summary in a reviewed change. The general release/changelog
links lead to GitHub. Verify each exact download URL and mobile/desktop layout.
A Sites deployment uses an isolated copy of **only** the website directory so
private application history cannot be uploaded through the site source remote.
Record the website commit/deployment URL; do not store source-write credentials.

## Signed distribution later

When the maintainer obtains Apple Developer membership, configure a Developer ID
Application identity and notarization credentials in secure local/CI storage.
Then implement signed build, notarization/stapling and a tested update feed.
Do not add certificate private keys, Apple passwords or API keys to Git. Retest a
real downloaded install and an older-to-newer signed upgrade before enabling
one-click installation. Users themselves do not need a developer membership.
