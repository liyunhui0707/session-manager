# ADR 001: Preserve Codex message boundaries

Status: accepted; direct-file and source-folder readers implement this decision.

## Context

Exported Markdown mixes role headings and message text in one stream. Literal
headings in a message can be ambiguous, and an export cannot always recover the
original record boundaries. A local reader should preserve structured roles
without rewriting a user's existing files.

## Decision

Keep a direct, read-only Codex path alongside the Markdown library workflow.
Read canonical records into bounded prompt/final-reply representations. Render
each message independently: Markdown may change formatting inside a message,
never another message's role or boundaries.

The main process owns paths, descriptors and snapshots. The renderer receives
validated operations and presentation data. It cannot authorize an arbitrary
path. All transcript text remains inert; reading does not start Codex, run tools,
rewrite sources or create a persistent decoded transcript copy.

Importers and the existing Markdown export format remain separate contracts.
Do not silently migrate old exports or imply they have the same structural
fidelity as direct source records.

## Consequences

Two input paths require separate regression coverage. Streaming projection,
explicit incomplete-read diagnostics, snapshot validation and bounded caches
preserve the direct-reader boundary as conversations grow. Local attachment
preview uses a separate validated path, not arbitrary Markdown resource loading.

See [current architecture](architecture.md) for data flow and [user guide](user-guide.md)
for shipped behavior and limits.
