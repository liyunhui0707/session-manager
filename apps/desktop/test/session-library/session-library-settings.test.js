'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createLibrarySettings,
} = require('../../lib/session-library-settings');

test('persists only the selected absolute library path outside the library', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-session-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, 'user-data');
  const library = path.join(root, 'library');
  fs.mkdirSync(library);
  const sentinel = path.join(library, 'sentinel.md');
  fs.writeFileSync(sentinel, 'unchanged\n');
  const before = fs.readFileSync(sentinel, 'utf8');

  const settings = createLibrarySettings({
    settingsPath: path.join(userData, 'session-library.json'),
  });
  assert.equal(await settings.getLibraryPath(), null);
  await settings.setLibraryPath(library);

  assert.equal(await settings.getLibraryPath(), library);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), before);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(userData, 'session-library.json'), 'utf8')),
    { libraryPath: library, sourceKind: 'library' },
  );
});

test('fails closed for malformed settings and rejects relative paths', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-session-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsPath = path.join(root, 'session-library.json');
  fs.writeFileSync(settingsPath, '{broken');
  const settings = createLibrarySettings({ settingsPath });

  assert.equal(await settings.getLibraryPath(), null);
  await assert.rejects(
    () => settings.setLibraryPath('relative/library'),
    /absolute/i,
  );
});

test('remembers last selected source and Codex root without storing transcript content', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-source-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsPath = path.join(root, 'settings.json');
  const first = createLibrarySettings({ settingsPath });
  assert.deepEqual(await first.getSource(), { kind: 'codex', path: null });
  await first.setCodexPath('/synthetic/custom-codex');
  const restored = createLibrarySettings({ settingsPath });
  assert.deepEqual(await restored.getSource(), { kind: 'codex', path: '/synthetic/custom-codex' });
  await restored.setLibraryPath('/synthetic/library');
  assert.deepEqual(await restored.getSource(), { kind: 'library', path: '/synthetic/custom-codex' });
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
  await assert.rejects(() => restored.setCodexPath('relative'), /absolute/);
});

test('concurrent source preferences preserve both paths and the last choice', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-window-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = createLibrarySettings({ settingsPath: path.join(root, 'settings.json') });
  await Promise.all([settings.setLibraryPath('/synthetic/library'), settings.setCodexPath('/synthetic/codex')]);
  assert.equal(await settings.getLibraryPath(), '/synthetic/library');
  assert.deepEqual(await settings.getSource(), { kind: 'codex', path: '/synthetic/codex' });
});
