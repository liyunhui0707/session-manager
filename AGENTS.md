# AI Session Manager contributor guide

## Product boundary

This repository is the standalone, read-only Codex and Claude Code session
manager. It is not a Markdown editor. Do not add note editing, AI summarize or
rewrite, vault management, CodeMirror, Tiptap, or Toast UI code here.

The selected library is owned by the Electron main process. Opening, loading,
rendering, and searching it must remain read-only. Only the explicit Refresh
action may write, and it must use the hardened importers to write directly to
`<library>/claude-code` and `<library>/codex`.

## Safety

- Never inspect real user transcripts for development or QA.
- Use only synthetic fixtures under `apps/desktop/test/session-import/` or a
  temporary synthetic library.
- Never read `.env`, `.env.*`, or `secrets/**`.
- Never commit transcripts, secrets, environment files, dependencies, or build
  output.
- Preserve importer security rules and transcript formats unless a separately
  approved task explicitly changes them.

## Workflow

Run commands from `apps/desktop/`:

```bash
npm test
npm run test:ci
npm run audit:prod
npm run pack
```

Use minimal changes and TDD. Keep source files near 300 lines where practical;
test files may be longer when cohesive. Update user-facing documentation with
behavior changes.

For branch, checkpoint, cleanup and fixed-install discipline, follow
[`docs/repository-maintenance.md`](docs/repository-maintenance.md).

## Versioning

The app version is declared in `apps/desktop/package.json`. Follow SemVer:
patch for fixes, minor for new user-visible behavior while pre-1.0, and major
only when deliberately declaring 1.0 readiness. Keep the lockfile version in
sync.

## Auxiliary testing and independent review

See `docs/auxiliary-testing-review.md` for portable second-machine checks.
Each remote run needs an authorized host and current testing window. Each external
review needs an authorized minimal source scope and resource budget. Never share
real chats or credentials. Historical acceptance is not fresh authorization.
