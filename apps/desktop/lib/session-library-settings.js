'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function createLibrarySettings(options) {
  const settingsPath = options && options.settingsPath;
  if (typeof settingsPath !== 'string' || !path.isAbsolute(settingsPath)) {
    throw new Error('absolute settingsPath is required');
  }

  const absolute = value => typeof value === 'string' && path.isAbsolute(value);
  async function read() {
    try {
      const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
      return { ...(absolute(parsed?.libraryPath) ? { libraryPath: parsed.libraryPath } : {}),
        ...(absolute(parsed?.codexPath) ? { codexPath: parsed.codexPath } : {}),
        ...(['library', 'codex'].includes(parsed?.sourceKind) ? { sourceKind: parsed.sourceKind } : {}) };
    } catch { return {}; }
  }
  async function getLibraryPath() { return (await read()).libraryPath || null; }
  async function getSource() {
    const saved = await read();
    return { kind: saved.sourceKind || 'codex', path: saved.codexPath || null };
  }
  async function save(key, value, sourceKind) {
    if (!absolute(value)) throw new Error('source path must be absolute');
    const saved = { ...await read(), [key]: value, sourceKind };
    const directory = path.dirname(settingsPath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${settingsPath}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(
        temporaryPath,
        JSON.stringify(saved, null, 2) + '\n',
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      );
      await fs.rename(temporaryPath, settingsPath);
    } finally {
      try {
        await fs.unlink(temporaryPath);
      } catch {}
    }
  }

  return { getLibraryPath, getSource,
    setLibraryPath: value => save('libraryPath', value, 'library'),
    setCodexPath: value => save('codexPath', value, 'codex') };
}

module.exports = { createLibrarySettings };
