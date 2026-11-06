# Session-import fixtures

The `upstream-baseline/*.md` files are **unmodified upstream outputs**
captured by running the original Local-Web-Server importers against the
JSONL fixtures below. Tests derive their expected bytes at runtime by
inserting a single `source: claude|codex` line via `helpers.mjs`
`expectedFromBaseline()`.

## Layout

- `upstream-baseline/claude-<scenario>.md` — Claude upstream output.
- `upstream-baseline/codex-<scenario>.md`  — Codex upstream output.
- `claude/<scenario>/<encoded-project>/<uuid>.jsonl` — source JSONL.
- `codex/<scenario>/<YYYY>/<MM>/<DD>/rollout-…<uuid>.jsonl` — source JSONL.

## Capture procedure

Both upstream and ported runs **must** use:

- `FIXED_NOW`  = `new Date('2026-01-01T00:00:00.000Z')` (`helpers.mjs`).
- `FIXED_MTIME` = `new Date('2026-01-01T00:00:00.000Z')` pinned via
  `fs.utimesSync` on every source JSONL; upstream emits `source_mtime`
  derived from `fs.stat`, so unpinned mtimes will make baselines flaky.

Capture must use an explicit temp directory (`mktemp -d`) — **never write
inside `Local-Web-Server/` or the developer's default `~/agent-sessions/`**.
Pass the `realpathSync` of the temp dir to the upstream importers (macOS's
`/var/folders/...` is itself a symlink chain and trips the importer's
ancestor-symlink guard).

```sh
# One-time setup (per scenario)
CAP=$(node -e "console.log(require('fs').realpathSync(require('fs').mkdtempSync(require('os').tmpdir()+'/lws-capture-')))")
mkdir -p "$CAP/src-claude/<project>" "$CAP/out-claude"
# … write source JSONL into "$CAP/src-claude/<project>/<uuid>.jsonl" …
node -e "const m = new Date('2026-01-01T00:00:00.000Z'); require('fs').utimesSync('<path>', m, m)"

# Run upstream
cd /path/to/Local-Web-Server
node --input-type=module -e "
  import { runImport } from './tools/import-claude.js';
  await runImport({
    sourceRoot: '$CAP/src-claude',
    outputBase: '$CAP/out-claude',
    maxBytes: 52428800,
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
"

# Copy bytes into the repo (do NOT hand-edit)
cp "$CAP/out-claude/<project>/<uuid>.md" \
   apps/desktop/test/session-import/fixtures/upstream-baseline/claude-<scenario>.md
cp "$CAP/src-claude/<project>/<uuid>.jsonl" \
   apps/desktop/test/session-import/fixtures/claude/<scenario>/<project>/<uuid>.jsonl

rm -rf "$CAP"
```

Codex requires `<home>/sessions/<YYYY>/<MM>/<DD>/<rollout>.jsonl` because
`runImport` derives the forbidden Codex-home from
`path.dirname(realpath(sourceRoot))`. Use `$CAP/fake-codex/sessions` as the
source root and `$CAP/out-codex` for output.

## Why unmodified baselines

Hand-edited goldens drift away from upstream every time upstream renderers
or frontmatter logic changes. The runtime `expectedFromBaseline()` derives
the port's expected output from the upstream baseline at test time, so
upstream-side changes are reflected automatically once the baseline is
re-captured.
