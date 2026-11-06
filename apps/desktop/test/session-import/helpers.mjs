import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');
export const FIXED_MTIME = new Date('2026-01-01T00:00:00.000Z');

export function mkTempVault(prefix = 'mdvault-session-import-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanupTempVault(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

export function copyFixtureWithPinnedMtime(srcAbs, destAbs) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(srcAbs, destAbs);
  fs.utimesSync(destAbs, FIXED_MTIME, FIXED_MTIME);
}

export function expectedFromBaseline(baselineBytes, agentName) {
  if (!Buffer.isBuffer(baselineBytes)) {
    throw new TypeError('expectedFromBaseline: baselineBytes must be a Buffer');
  }
  const LF = 0x0a;
  const TAB = 0x09;
  const SP = 0x20;
  const prefix = Buffer.from('agent:', 'ascii');

  function isAgentLineAt(start) {
    if (start + prefix.length >= baselineBytes.length) return false;
    if (baselineBytes.compare(prefix, 0, prefix.length, start, start + prefix.length) !== 0) {
      return false;
    }
    const next = baselineBytes[start + prefix.length];
    return next === SP || next === TAB;
  }

  let agentLineStart = -1;
  if (isAgentLineAt(0)) {
    agentLineStart = 0;
  } else {
    let cursor = 0;
    while (cursor < baselineBytes.length) {
      const lf = baselineBytes.indexOf(LF, cursor);
      if (lf < 0) break;
      if (isAgentLineAt(lf + 1)) {
        agentLineStart = lf + 1;
        break;
      }
      cursor = lf + 1;
    }
  }
  if (agentLineStart < 0) {
    throw new Error('expectedFromBaseline: no `agent:` line found in baseline');
  }
  const agentLineEnd = baselineBytes.indexOf(LF, agentLineStart);
  if (agentLineEnd < 0) {
    throw new Error('expectedFromBaseline: `agent:` line is not LF-terminated');
  }
  const insertion = Buffer.from(`source: ${agentName}\n`, 'ascii');
  return Buffer.concat([
    baselineBytes.subarray(0, agentLineEnd + 1),
    insertion,
    baselineBytes.subarray(agentLineEnd + 1),
  ]);
}
