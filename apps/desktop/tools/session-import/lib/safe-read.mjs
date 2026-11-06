import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { assertSafeInt } from './output-root.mjs';

export const __testHooks = {
  getONOFOLLOW: () => fsConstants.O_NOFOLLOW,
  beforeOpen: null,
  betweenOpenAndStat: null,
};

export async function readSessionFileSafe(filePath, canonicalSourceRoot, maxBytes) {
  assertSafeInt('maxBytes', maxBytes, { min: 1, max: Number.MAX_SAFE_INTEGER });
  const oNoFollow = __testHooks.getONOFOLLOW();
  if (oNoFollow === undefined) {
    throw new Error(
      'symlink-safe reads unsupported on this platform: fs.constants.O_NOFOLLOW unavailable',
    );
  }
  if (typeof __testHooks.beforeOpen === 'function') {
    await __testHooks.beforeOpen(filePath);
  }
  let fh = null;
  try {
    fh = await fs.open(
      filePath,
      fsConstants.O_RDONLY | oNoFollow | fsConstants.O_NONBLOCK,
    );
    const fdStat = await fh.stat();
    if (!fdStat.isFile()) {
      throw new Error('path is not a regular file');
    }
    if (fdStat.size > maxBytes) {
      const err = new Error(
        `file exceeds maxBytes after open: ${fdStat.size} > ${maxBytes}`,
      );
      err.code = 'OVER_CAP';
      throw err;
    }
    if (typeof __testHooks.betweenOpenAndStat === 'function') {
      await __testHooks.betweenOpenAndStat(filePath);
    }
    const realFile = await fs.realpath(filePath);
    if (
      realFile !== canonicalSourceRoot &&
      !realFile.startsWith(canonicalSourceRoot + path.sep)
    ) {
      throw new Error('file resolves outside source root');
    }
    const pathStat = await fs.stat(realFile);
    if (fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) {
      throw new Error('post-open identity mismatch');
    }
    const buf = Buffer.alloc(fdStat.size);
    let total = 0;
    while (total < fdStat.size) {
      const { bytesRead } = await fh.read(
        buf,
        total,
        fdStat.size - total,
        total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return { buf: buf.subarray(0, total), fdStat };
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {}
    }
  }
}
