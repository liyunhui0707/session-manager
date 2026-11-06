'use strict';

const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');

const INPUT_MAGIC = Buffer.from('ASMI\x02', 'binary');
const OUTPUT_MAGIC = Buffer.from('ASMO\x02', 'binary');
const PLAN_MAGIC = Buffer.from('ASMP\x02', 'binary');
const FRAME = Object.freeze({ PROBE: 1, ENTRY: 2, INDEX: 3, COMPLETE: 4 });
const STATUS = Object.freeze({ MISSING: 0, SAFE: 1, UNSAFE: 2, ERROR: 3 });
const AREA = Object.freeze({ 0: 'active', 1: 'archive' });
const MAX_ROOT_BYTES = 4096;
const MAX_PATH_BYTES = 4096;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_ENTRIES = 50000;
const INDEX_MAX_BYTES = 1024 * 1024;
const ROLLOUT_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function protocolError() {
  return codedError('SCAN_PROTOCOL_ERROR', 'Invalid source scanner response');
}

function defaultHelperPath() {
  if (!process.defaultApp && typeof process.resourcesPath === 'string') {
    return path.join(process.resourcesPath, 'bin', 'codex-source-helper');
  }
  return path.join(__dirname, '..', 'build', 'native', 'codex-source-helper');
}

function rootFrame(canonicalRoot) {
  if (typeof canonicalRoot !== 'string' || !path.isAbsolute(canonicalRoot) ||
      path.resolve(canonicalRoot) !== canonicalRoot || canonicalRoot.includes('\0')) {
    throw codedError('INVALID_SOURCE', 'Invalid source');
  }
  const root = Buffer.from(canonicalRoot, 'utf8');
  if (root.length === 0 || root.length > MAX_ROOT_BYTES) throw codedError('INVALID_SOURCE', 'Invalid source');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(root.length);
  return Buffer.concat([INPUT_MAGIC, length, root]);
}

function decodeRelativePath(bytes, layout, area) {
  if (bytes.length === 0 || bytes.length > MAX_PATH_BYTES || bytes.includes(0)) throw protocolError();
  let relativePath;
  try { relativePath = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw protocolError(); }
  if (path.isAbsolute(relativePath) || path.normalize(relativePath) !== relativePath) throw protocolError();
  const parts = relativePath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw protocolError();
  const fileName = parts.at(-1);
  const match = fileName.match(ROLLOUT_RE);
  if (!match) throw protocolError();
  if (layout === 'full' && area === 'active') {
    if (parts.length !== 5 || parts[0] !== 'sessions') throw protocolError();
  } else if (layout === 'active-only' && area === 'active') {
    if (parts.length !== 4) throw protocolError();
  } else if (layout === 'full' && area === 'archive') {
    if (parts.length < 2 || parts[0] !== 'archived_sessions') throw protocolError();
  } else {
    throw protocolError();
  }
  return { relativePath, fileName, sessionId: match[1] };
}

function decodeEntry(payload, layout) {
  if (payload.length < 25) throw protocolError();
  const area = AREA[payload.readUInt8(0)];
  if (!area) throw protocolError();
  const size = payload.readBigUInt64BE(1);
  const seconds = payload.readBigInt64BE(9);
  const nanoseconds = payload.readUInt32BE(17);
  const pathLength = payload.readUInt32BE(21);
  if (pathLength !== payload.length - 25 || pathLength > MAX_PATH_BYTES ||
      size > BigInt(Number.MAX_SAFE_INTEGER) || seconds < 0n ||
      seconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)) || nanoseconds > 999999999) {
    throw protocolError();
  }
  const decoded = decodeRelativePath(payload.subarray(25), layout, area);
  return {
    ...decoded,
    area,
    bytes: Number(size),
    updatedAt: Number(seconds) * 1000 + nanoseconds / 1e6,
  };
}

async function scanCodexSourceTree(canonicalRoot, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') throw codedError('PLATFORM_UNSUPPORTED', 'Secure source scans unsupported');
  const input = rootFrame(canonicalRoot);
  const spawn = options.spawn || defaultSpawn;
  const signal = options.signal;
  if (signal?.aborted) throw codedError('SCAN_CANCELLED', 'Scan cancelled');

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(options.helperPath || defaultHelperPath(), [], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      reject(codedError('PLATFORM_UNSUPPORTED', 'Secure source scanner unavailable'));
      return;
    }

    let settled = false;
    let output = Buffer.alloc(0);
    let outputBytes = 0;
    let parentPeakRssBytes = process.memoryUsage().rss;
    let stderrBytes = 0;
    let headerRead = false;
    let probeRead = false;
    let layout = null;
    let indexStatus = STATUS.MISSING;
    let indexContent = '';
    let indexRead = false;
    let completed = null;
    let stdoutEnded = false;
    let closeResult = null;
    const candidates = [];

    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const fail = (error, kill = true) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (kill && child && !child.killed) {
        try { child.kill('SIGTERM'); } catch {}
      }
      reject(error);
    };
    const succeedIfFinished = () => {
      if (settled || !stdoutEnded || !closeResult) return;
      if (closeResult.signal || closeResult.code !== 0) {
        fail(codedError('SCAN_FAILED', 'Source scan failed'), false);
        return;
      }
      if (!headerRead || !probeRead || !completed || output.length !== 0) {
        fail(protocolError(), false);
        return;
      }
      settled = true;
      cleanup();
      resolve({
        layout,
        candidates,
        indexContent,
        titleIndexState: layout === 'active-only' ? 'not-selected'
          : indexRead ? 'loaded' : indexStatus === STATUS.MISSING ? 'missing' : 'unavailable',
        diagnostics: {
          skipped: completed.skipped,
          skippedReasons: completed.skippedReasons,
          errors: 0,
          indexErrors: layout === 'full' && indexStatus !== STATUS.MISSING && !indexRead ? 1 : 0,
        },
        visited: completed.visited,
        helperPeakRssBytes: completed.peakRssBytes,
        parentPeakRssBytes,
      });
    };
    const writePlan = (mode) => {
      const frame = Buffer.concat([PLAN_MAGIC, Buffer.from([mode])]);
      child.stdin.write(frame, (error) => { if (error) fail(codedError('SCAN_FAILED', 'Source scan failed')); });
    };
    const handleFrame = (type, payload) => {
      if (!probeRead) {
        if (type !== FRAME.PROBE || payload.length !== 3) throw protocolError();
        const [sessions, archive, index] = payload;
        if (![0, 1, 2, 3].includes(sessions) || ![0, 1, 2, 3].includes(archive) ||
            ![0, 1, 2, 3].includes(index)) throw protocolError();
        if (sessions === STATUS.SAFE) {
          if (archive === STATUS.ERROR) throw codedError('SCAN_FAILED', 'Source scan failed');
          layout = 'full';
          indexStatus = index;
          probeRead = true;
          writePlan(1);
        } else if (sessions === STATUS.MISSING) {
          layout = 'active-only';
          probeRead = true;
          writePlan(0);
        } else if (sessions === STATUS.ERROR) {
          throw codedError('SCAN_FAILED', 'Source scan failed');
        } else {
          throw codedError('INVALID_SOURCE', 'Invalid source');
        }
        return;
      }
      if (completed) throw protocolError();
      if (type === FRAME.ENTRY) {
        if (candidates.length >= MAX_ENTRIES) throw protocolError();
        candidates.push(decodeEntry(payload, layout));
        return;
      }
      if (type === FRAME.INDEX) {
        if (layout !== 'full' || indexStatus !== STATUS.SAFE || indexRead || payload.length > INDEX_MAX_BYTES) {
          throw protocolError();
        }
        indexRead = true;
        indexContent = new TextDecoder('utf-8', { fatal: false }).decode(payload);
        return;
      }
      if (type === FRAME.COMPLETE) {
        if (payload.length !== 36) throw protocolError();
        const peak = payload.readBigUInt64BE(8);
        if (peak > BigInt(Number.MAX_SAFE_INTEGER)) throw protocolError();
        const skippedReasons = Object.fromEntries(
          ['compressed', 'unsupportedName', 'layout', 'unsafe', 'other']
            .map((key, i) => [key, payload.readUInt32BE(16 + i * 4)]));
        const skipped = payload.readUInt32BE(0);
        const visited = payload.readUInt32BE(4);
        if (Object.values(skippedReasons).reduce((sum, n) => sum + n, 0) !== skipped ||
            skipped > visited || visited > 250000 || candidates.length + skipped > visited) throw protocolError();
        completed = {
          skippedReasons,
          skipped: payload.readUInt32BE(0),
          visited: payload.readUInt32BE(4),
          peakRssBytes: Number(peak),
        };
        return;
      }
      throw protocolError();
    };
    const parse = () => {
      if (!headerRead) {
        if (output.length < OUTPUT_MAGIC.length) return;
        if (!output.subarray(0, OUTPUT_MAGIC.length).equals(OUTPUT_MAGIC)) throw protocolError();
        output = output.subarray(OUTPUT_MAGIC.length);
        headerRead = true;
      }
      while (output.length >= 5) {
        const type = output.readUInt8(0);
        const length = output.readUInt32BE(1);
        if (length > MAX_FRAME_BYTES) throw protocolError();
        if (output.length < 5 + length) return;
        const payload = output.subarray(5, 5 + length);
        output = output.subarray(5 + length);
        handleFrame(type, payload);
      }
    };
    const onAbort = () => fail(codedError('SCAN_CANCELLED', 'Scan cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', () => fail(signal?.aborted
      ? codedError('SCAN_CANCELLED', 'Scan cancelled')
      : codedError('PLATFORM_UNSUPPORTED', 'Secure source scanner unavailable'), false));
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      parentPeakRssBytes = Math.max(parentPeakRssBytes, process.memoryUsage().rss);
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) { fail(protocolError()); return; }
      output = Buffer.concat([output, chunk]);
      try { parse(); } catch (error) { fail(error); }
    });
    child.stdout.on('end', () => {
      if (settled) return;
      stdoutEnded = true;
      try { parse(); } catch (error) { fail(error); return; }
      succeedIfFinished();
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) fail(protocolError());
    });
    child.on('close', (code, closeSignal) => {
      closeResult = { code, signal: closeSignal };
      succeedIfFinished();
    });
    child.stdin.on('error', () => fail(codedError('SCAN_FAILED', 'Source scan failed')));
    child.stdin.write(input, (error) => { if (error) fail(codedError('SCAN_FAILED', 'Source scan failed')); });
  });
}

module.exports = {
  scanCodexSourceTree,
  limits: { MAX_ROOT_BYTES, MAX_PATH_BYTES, MAX_FRAME_BYTES, MAX_OUTPUT_BYTES, MAX_ENTRIES, INDEX_MAX_BYTES },
};
