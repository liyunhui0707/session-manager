import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  expandHome,
  isForbiddenPath,
  assertSafeInt,
  resolveSourceRoot,
  preResolveOutputBase,
  resolveOutputBase,
} from './lib/output-root.mjs';
import { readSessionFileSafe, __testHooks } from './lib/safe-read.mjs';
import { writeAtomically } from './lib/atomic-write.mjs';
import {
  renderTranscript,
  extractEnrichment,
  buildClaudeFrontmatter,
} from './lib/render-claude.mjs';

const __filename = fileURLToPath(import.meta.url);

const PROJECT_NAME_RE = /^[-A-Za-z0-9._]+$/;
const SESSION_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export function parseRawFlag(v) {
  if (typeof v !== 'string') return false;
  const norm = v.trim().toLowerCase();
  return norm === '1' || norm === 'true';
}

export function parseMaxBytesEnv(raw) {
  if (raw === undefined || raw === '') return 52428800;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(
      `SESSION_IMPORT_MAX_BYTES must be an integer, got: ${JSON.stringify(raw)}`,
    );
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(
      `SESSION_IMPORT_MAX_BYTES must be a positive safe integer, got: ${n}`,
    );
  }
  return n;
}

async function importProject({
  projectName,
  canonicalSourceRoot,
  canonicalOutputBase,
  maxBytes,
  importStamp,
  includeRaw,
  summary,
}) {
  const projectAbs = path.join(canonicalSourceRoot, projectName);
  let projLst;
  try {
    projLst = await fs.lstat(projectAbs);
  } catch {
    summary.errors += 1;
    return;
  }
  if (projLst.isSymbolicLink() || !projLst.isDirectory()) return;
  let projReal;
  try {
    projReal = await fs.realpath(projectAbs);
  } catch {
    summary.errors += 1;
    return;
  }
  if (
    projReal !== canonicalSourceRoot &&
    !projReal.startsWith(canonicalSourceRoot + path.sep)
  ) {
    summary.errors += 1;
    return;
  }

  const projOutPath = path.join(canonicalOutputBase, projectName);
  let projOutExists = false;
  try {
    const projOutLst = await fs.lstat(projOutPath);
    projOutExists = true;
    if (projOutLst.isSymbolicLink() || !projOutLst.isDirectory()) {
      summary.errors += 1;
      return;
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      projOutExists = false;
    } else {
      summary.errors += 1;
      return;
    }
  }
  if (!projOutExists) {
    try {
      await fs.mkdir(projOutPath, { mode: 0o700 });
    } catch {
      summary.errors += 1;
      return;
    }
  }
  let canonicalProjOut;
  try {
    canonicalProjOut = await fs.realpath(projOutPath);
  } catch {
    summary.errors += 1;
    return;
  }
  if (
    canonicalProjOut !== canonicalOutputBase &&
    !canonicalProjOut.startsWith(canonicalOutputBase + path.sep)
  ) {
    summary.errors += 1;
    return;
  }

  let sessionEntries;
  try {
    sessionEntries = await fs.readdir(projReal);
  } catch {
    summary.errors += 1;
    return;
  }
  sessionEntries.sort();

  for (const fileName of sessionEntries) {
    if (!SESSION_FILE_RE.test(fileName)) continue;
    const fileAbs = path.join(projReal, fileName);
    let lst;
    try {
      lst = await fs.lstat(fileAbs);
    } catch {
      summary.errors += 1;
      continue;
    }
    if (lst.isSymbolicLink() || !lst.isFile()) {
      summary.skipped += 1;
      continue;
    }
    if (lst.size > maxBytes) {
      summary.skipped += 1;
      continue;
    }

    let buf;
    try {
      const res = await readSessionFileSafe(
        fileAbs,
        canonicalSourceRoot,
        maxBytes,
      );
      buf = res.buf;
    } catch (err) {
      if (err && err.code === 'OVER_CAP') {
        summary.skipped += 1;
      } else {
        summary.errors += 1;
      }
      continue;
    }

    const content = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    const uuid = fileName.replace(/\.jsonl$/i, '');
    const dest = path.join(canonicalProjOut, uuid + '.md');
    if (!dest.startsWith(canonicalProjOut + path.sep)) {
      summary.errors += 1;
      continue;
    }

    const enrichment = extractEnrichment(content, uuid);
    const fm = buildClaudeFrontmatter({
      projectName,
      uuid,
      lst,
      importStamp,
      enrichment,
    });
    const body = renderTranscript(content, { includeRaw });

    try {
      await writeAtomically(dest, fm + body);
      summary.imported += 1;
      summary.outputs.push(dest);
    } catch {
      summary.errors += 1;
    }
  }
}

export async function runClaudeImport({
  sourceRoot,
  outputBase,
  maxBytes,
  now,
  includeRaw = false,
}) {
  if (__testHooks.getONOFOLLOW() === undefined) {
    throw new Error(
      'symlink-safe reads unsupported on this platform: fs.constants.O_NOFOLLOW unavailable',
    );
  }
  assertSafeInt('maxBytes', maxBytes, { min: 1, max: Number.MAX_SAFE_INTEGER });
  const importStamp = now instanceof Date ? now : new Date();

  const resolvedOutputBase = preResolveOutputBase(outputBase);
  const src = await resolveSourceRoot(sourceRoot);
  if (src.noSource) {
    return {
      imported: 0,
      skipped: 0,
      errors: 0,
      note: 'no-source',
      outputs: [],
      root: src.resolved,
    };
  }
  const canonicalOutputBase = await resolveOutputBase(resolvedOutputBase, {
    container: src.container,
    containerIsHidden: src.containerIsHidden,
  });

  const summary = {
    imported: 0,
    skipped: 0,
    errors: 0,
    outputs: [],
    root: canonicalOutputBase,
  };

  let projectEntries;
  try {
    projectEntries = await fs.readdir(src.canonical);
  } catch {
    summary.errors += 1;
    return summary;
  }
  projectEntries.sort();

  for (const projectName of projectEntries) {
    if (projectName.startsWith('.')) continue;
    if (!PROJECT_NAME_RE.test(projectName)) continue;
    await importProject({
      projectName,
      canonicalSourceRoot: src.canonical,
      canonicalOutputBase,
      maxBytes,
      importStamp,
      includeRaw,
      summary,
    });
  }

  return summary;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  (async () => {
    try {
      const env = process.env;
      const sourceRoot = path.join(os.homedir(), '.claude', 'projects');
      const sessionRootRaw = env.SESSION_ROOT || '~/agent-sessions';
      const resolvedSessionRoot = path.resolve(expandHome(sessionRootRaw));
      if (isForbiddenPath(resolvedSessionRoot)) {
        throw new Error(`SESSION_ROOT must not be ${resolvedSessionRoot}`);
      }
      const outputBase = path.join(resolvedSessionRoot, 'claude-code');
      const maxBytes = parseMaxBytesEnv(env.SESSION_IMPORT_MAX_BYTES);
      const includeRaw = parseRawFlag(env.SESSION_IMPORT_RAW);
      const result = await runClaudeImport({
        sourceRoot,
        outputBase,
        maxBytes,
        now: new Date(),
        includeRaw,
      });
      const where = result.root || outputBase;
      const note = result.note ? ` (${result.note})` : '';
      console.log(
        `Imported ${result.imported} (skipped ${result.skipped}, errors ${result.errors}) into ${where}${note}`,
      );
    } catch (err) {
      console.error(err && err.message ? err.message : String(err));
      process.exit(1);
    }
  })();
}
