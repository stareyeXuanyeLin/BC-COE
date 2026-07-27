const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('public installation routes all resolve to main', () => {
  const header = read('src/00-userscript-header.js');
  const loader = read('dist/CustomOutfitEditor.loader.user.js');
  const readme = read('README.md');

  for (const [name, content] of Object.entries({ header, loader, readme })) {
    assert.match(content, /stareyeXuanyeLin\/BC-COE\/(?:main|@main)/, `${name} must reference main`);
    assert.doesNotMatch(content, /(?:single-layer-transform-rebuild|@layer-transform)/, `${name} must not reference an obsolete release branch`);
  }

  assert.match(loader, /cdn\.jsdelivr\.net/);
  assert.match(loader, /fastly\.jsdelivr\.net/);
  assert.match(loader, /gcore\.jsdelivr\.net/);
  assert.match(loader, /BC-COE@main\/dist\/CustomOutfitEditor\.user\.js/);
  assert.doesNotMatch(loader, /script\.src\s*=.*raw\.githubusercontent\.com/);
});

test('remote loader falls back across executable CDN endpoints', () => {
  const loader = read('dist/CustomOutfitEditor.loader.user.js');
  const requested = [];
  const window = {};
  const context = {
    window,
    document: {
      head: {
        appendChild(script) {
          requested.push(script.src);
          if (requested.length < 3) script.onerror();
          else script.onload();
        },
      },
      documentElement: null,
      createElement() {
        return { remove() {} };
      },
    },
    console: { info() {}, warn() {}, error() {} },
    Date: { now: () => 123456 },
    setTimeout: () => 1,
    clearTimeout() {},
  };

  vm.runInNewContext(loader, context);

  assert.deepEqual(requested.map(url => new URL(url).host), [
    'cdn.jsdelivr.net',
    'fastly.jsdelivr.net',
    'gcore.jsdelivr.net',
  ]);
  assert.equal(window.__CUSTOM_OUTFIT_EDITOR_LOADER__, true);
  assert.ok(requested.every(url => url.includes('BC-COE@main/dist/CustomOutfitEditor.user.js')));
});

test('remote loader clears its guard after every CDN endpoint fails', () => {
  const loader = read('dist/CustomOutfitEditor.loader.user.js');
  const window = {};
  const context = {
    window,
    document: {
      head: { appendChild(script) { script.onerror(); } },
      documentElement: null,
      createElement() { return { remove() {} }; },
    },
    console: { info() {}, warn() {}, error() {} },
    Date: { now: () => 123456 },
    setTimeout: () => 1,
    clearTimeout() {},
  };

  vm.runInNewContext(loader, context);
  assert.equal(window.__CUSTOM_OUTFIT_EDITOR_LOADER__, undefined);
});

test('published core, docs and runtime agree on protocol and release version', () => {
  const sourceHeader = read('src/00-userscript-header.js');
  const sourceRuntime = read('src/01-runtime.js');
  const sourceProtocol = read('src/11-remote-protocol.js');
  const distCore = read('dist/CustomOutfitEditor.user.js');
  const protocolSpec = read('docs/protocol-spec.md');
  const limitations = read('docs/known-limitations.md');
  const packageVersion = require(path.join(root, 'package.json')).version;

  const headerVersion = sourceHeader.match(/@version\s+(\d+\.\d+\.\d+)/)?.[1];
  const runtimeVersion = sourceRuntime.match(/const VERSION = "(\d+\.\d+\.\d+)"/)?.[1];
  assert.equal(headerVersion, packageVersion);
  assert.equal(runtimeVersion, packageVersion);

  for (const [name, content] of Object.entries({ sourceProtocol, distCore, protocolSpec, limitations })) {
    assert.match(content, /COE_RVS\/4/, `${name} must declare COE_RVS/4`);
  }
  assert.match(distCore, /const TAG_ASSET_NAME = "COECustomOutfit"/);
  assert.match(distCore, /registerTagAssets\(\)/);
});

test('formal public surfaces use only the Custom Outfit Editor name', () => {
  const publicFiles = [
    read('README.md'),
    read('src/00-userscript-header.js'),
    read('dist/CustomOutfitEditor.loader.user.js'),
    read('dist/CustomOutfitEditor.user.js'),
    read('docs/architecture.md'),
    read('docs/known-limitations.md'),
  ];
  for (const content of publicFiles) assert.doesNotMatch(content, /echo(?:\s*mirror)?/i);
});
