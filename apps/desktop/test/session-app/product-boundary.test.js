'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), 'utf8');
}

test('package identity and dependency surface belong only to AI Session Manager', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'ai-session-manager');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.productName, 'AI Session Manager');
  assert.equal(pkg.build.appId, 'com.aisessionmanager.desktop');
  assert.deepEqual(pkg.dependencies || {}, {});
  assert.equal(pkg.scripts['session-import:claude'], undefined);
  assert.equal(pkg.scripts['session-import:codex'], undefined);

  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.name, 'ai-session-manager');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.deepEqual(lock.packages[''].dependencies || {}, {});
  for (const included of [
    'lib/codex-source-catalog.js',
    'lib/codex-source-traversal.js',
    'lib/codex-folder-ipc.js',
  ]) assert.equal(pkg.build.files.includes(included), true);
  assert.equal(pkg.scripts['build:native'], 'node tools/build-codex-source-helper.mjs');
  assert.equal(pkg.scripts.prepack, 'npm run build:native && npm run build:icon');
  assert.equal(pkg.build.mac.icon, 'build/app.icns');
  assert.deepEqual(pkg.build.extraResources, [{
    from: 'build/native/codex-source-helper',
    to: 'bin/codex-source-helper',
  }]);
  assert.equal(pkg.build.mac.minimumSystemVersion, '12.0');
});

test('preload exposes only the narrow sessionApi surface', () => {
  const source = read('preload.js');
  assert.match(source, /exposeInMainWorld\(['"]sessionApi['"]/);
  for (const key of [
    'chooseCodexFile',
    'reloadCodexFile',
    'chooseCodexFolder',
    'rescanCodexFolder',
    'cancelCodexFolderScan',
    'loadCodexCatalogEntry',
    'reloadCodexCatalogEntry',
    'getSelectedLibrary',
    'chooseLibrary',
    'loadSessions',
    'refreshSessions',
  ]) {
    assert.match(source, new RegExp('\\b' + key + '\\b'));
  }
  assert.doesNotMatch(source, /vaultApi|summarizeNote|rewriteText/);
  assert.equal(
    (source.match(/exposeInMainWorld\(/g) || []).length,
    1,
    'preload must expose exactly one namespaced surface',
  );
});

test('standalone shell contains session features and no editor surfaces', () => {
  const html = read('index.html');
  assert.match(html, /AI Session Manager/);
  assert.match(html, /session-viewer\/grouping\.js/);
  assert.match(html, /session-viewer\/favorites\.js/);
  assert.match(html, /session-viewer\/search-index\.js/);
  assert.match(html, /session-viewer\/read-renderer\.js/);
  assert.match(html, /session-viewer\/large-session-guard\.js/);
  assert.match(html, /session-viewer\/codex-folder-view\.js/);
  for (const id of ['openCodexFolderButton', 'rescanCodexFolderButton', 'cancelCodexFolderScanButton', 'folderFilterInput']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /session-app\.js/);
  assert.doesNotMatch(
    html,
    /tiptap|codemirror|cm6-|toastui|writeEngine|Summarize|Rewrite|modeWrite|modePreview/i,
  );
});

test('main process registers only session-library/import IPC with hardened window settings', () => {
  const source = read('main.js') + read('lib/session-window-context.js');
  assert.match(source, /registerLibraryIpc/);
  assert.match(source, /registerCodexFolderIpc/);
  assert.match(source, /SessionImportIpc\.register/);
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.doesNotMatch(
    source,
    /AiIpc|AiSettings|VaultActions|save-note|delete-note|create-note/,
  );
});

test('renderer orchestration never writes innerHTML or exposes editing commands', () => {
  const source = read('lib/session-app.js');
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|execCommand/);
  assert.doesNotMatch(source, /saveNote|deleteNote|summarize|rewrite/i);
});

test('standalone tree omits inherited editor and local-agent configuration', () => {
  for (const relativePath of [
    'lib/cm6-bundle.js',
    'lib/tiptap-bundle.js',
    'lib/toastui-bundle.js',
    'lib/vault-actions.js',
    'test/cm6-write-view',
  ]) {
    assert.equal(
      fs.existsSync(path.join(APP_ROOT, relativePath)),
      false,
      `${relativePath} must not be part of the standalone app`,
    );
  }
  assert.equal(
    fs.existsSync(path.join(APP_ROOT, '..', '..', '.mcp.json')),
    false,
    'root .mcp.json must not be copied into the standalone repository',
  );
});

test('CI runs the standalone test, production audit, and package checks only', () => {
  const workflow = fs.readFileSync(
    path.join(APP_ROOT, '..', '..', '.github', 'workflows', 'desktop-ci.yml'),
    'utf8',
  );
  assert.match(workflow, /npm run test:ci/);
  assert.match(workflow, /npm run audit:prod/);
  assert.match(workflow, /npm run pack/);
  assert.doesNotMatch(workflow, /audit:full|verify:generated|build:cm6|tiptap/);
});
