# 0.10.1 release acceptance

## Candidate

- Platform: Apple Silicon; packaged on macOS. Minimum declared OS: macOS 12.
- App ASAR SHA-256: `608a0b4de9cf37d28ad7cc4a221e08334c95ec9bcdc51456ad6fe594250c553c`.
- Source: the public `v0.10.1` tag. The private predecessor history is not published.
- Distribution: unsigned, not Apple notarized, manual updates only.

## Executed checks

- 691 application tests passed with Node.js 24.20.0, no failures or skips.
- Production dependency audit: no known vulnerabilities reported.
- 146 packaged synthetic reader checks passed; normal exit, no candidate process
  left running, source hashes and metadata unchanged.
- Release tooling checks cover exact-version/architecture asset selection,
  checksums, empty/symlink rejection, website download version and local links.
- Website preview HTTP responded successfully. All displayed conversations in
  screenshots are synthetic.

## Verification limits

A second Mac connection timed out before SSH setup completed; no remote GUI,
installation or upgrade test ran in this batch. No claim is made about an Intel
binary, every supported macOS version, actual browser-downloaded quarantine
behavior, notarization or signed in-app updates.

Browser automation for the website was unavailable in this environment; live
mobile/desktop interaction and visual acceptance remain unverified. Static asset,
anchor and download-target checks are recorded separately from browser QA.
