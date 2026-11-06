# Architecture

## Main-process ownership

The Electron main process owns source selection and filesystem access. The renderer has context isolation and sandboxing enabled, with Node integration disabled. Narrow preload calls pass validated operations and opaque catalog identifiers, rather than arbitrary renderer-supplied paths. Source generation and snapshot checks prevent results from a previous source replacing the current view.

`session-library-settings` stores local source preferences. First startup tries the default Codex root; later launches restore the previous source. Favorites and appearance are local settings. Direct-file reading does not authorize neighboring files.

## Catalog and conversation reading

The native C helper scans canonical directory entries and a bounded name index. A separate worker examines bounded source metadata, filters known background/non-interactive records and probes small initialization-only sessions. Uncertain classifications remain visible. Archived sessions are excluded from normal browsing and search.

The structured reader projects prompt/final-reply text from JSONL and Zstd sources. It validates and drains unsupported fields without retaining large image or tool payloads. Long visible messages use bounded pieces and descriptor-backed extraction; unreadable boundaries are explicitly reported. Source files are never rewritten.

Page content is bounded to nearby windows. An adaptive sparse index accelerates distant parts; raw files seek while Zstd must still decode earlier compressed bytes. Eligible raw-file updates verify the complete old prefix with SHA-256 before parsing appended records. Changed or ineligible sources fall back to complete reading. Repeated searches reuse bounded validated snippet windows; this is not a persistent index.

Foreground reads and searches can cancel background polling. The source lock, cancellation and generation guards still serialize operations. Reading history preserves the user's position; latest-following is decided against the current reading position when an update completes.

## Rendering and images

Safe Markdown rendering creates elements and text nodes; transcript content does not supply executable HTML or remote resources. Assistant replies start expanded; long prompts have optional disclosure. Question-response envelopes become readable cards.

Local image references use a separate main-process validation path. Supported PNG/JPEG files are decoded to bounded thumbnails, with limited retained card and enlarged-image resources. Path, type, size and pixel limits apply. Remote and embedded images are not fetched.

## Markdown libraries

The library reader opens exported Markdown under `codex/` and `claude-code/`. The explicit Refresh import action is the sole source workflow that writes exported files. It uses hardened importers and does not alter original Codex or Claude stores.

## Distribution

The application package uses a source allowlist and bundles its native helper. Tests, prototypes, release tools and historical readers are excluded. The helper and Electron runtime must have the same CPU architecture. Public release source has its own clean history; private development archives are not dependencies.

See [user guide](user-guide.md) for behavior and [release procedure](releasing.md) for packaging and verification.
