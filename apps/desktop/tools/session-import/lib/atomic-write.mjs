import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const __testHooks = {
  forceEexistRemaining: 0,
};

export async function writeAtomically(dest, body) {
  const dir = path.dirname(dest);
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const tmp = path.join(
      dir,
      '.' + crypto.randomBytes(8).toString('hex') + '.tmp',
    );
    let fh = null;
    try {
      if (__testHooks.forceEexistRemaining > 0) {
        __testHooks.forceEexistRemaining -= 1;
        const err = new Error('simulated EEXIST');
        err.code = 'EEXIST';
        throw err;
      }
      fh = await fs.open(tmp, 'wx', 0o600);
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        lastErr = err;
        continue;
      }
      throw err;
    }
    try {
      await fh.writeFile(body, 'utf8');
      await fh.close();
      fh = null;
      await fs.rename(tmp, dest);
      return;
    } catch (err) {
      if (fh) {
        try {
          await fh.close();
        } catch {}
      }
      try {
        await fs.unlink(tmp);
      } catch {}
      throw err;
    }
  }
  const reason = lastErr ? `: ${lastErr.message}` : '';
  throw new Error(`atomic write failed after 5 attempts${reason}`);
}
