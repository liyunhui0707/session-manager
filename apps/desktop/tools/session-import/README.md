# Hardened session importers

These zero-runtime-dependency ESM modules import local Claude Code and Codex
sessions into the standalone application's selected library.

The Electron main process invokes them only for the explicit Refresh action:

```text
<library>/claude-code
<library>/codex
```

Opening, browsing, and searching a selected library do not invoke an importer.

## Security properties

- Source and output roots are validated.
- Static output symlinks, including Codex year/month/day directories, are
  rejected. Source reads check post-open identity to detect tested swap cases.
  Output validation uses path-based checks; concurrent hostile replacement of
  directory ancestors is not proven race-free.
- Input files are size-capped and opened with `O_NOFOLLOW` where supported.
- Output writes are atomic and use restrictive file/directory modes.
- Missing optional sources are handled without exposing local paths to the
  renderer.

The committed synthetic fixture suite verifies output compatibility, title
metadata, idempotence, size limits, permissions, symlink defenses, and atomic
writes. Do not use real user sessions as test fixtures.

## Maintenance

Keep transcript formats and importer behavior stable during the repository
split. Any future format change requires a separately approved migration plan,
new golden fixtures, and explicit compatibility documentation.
