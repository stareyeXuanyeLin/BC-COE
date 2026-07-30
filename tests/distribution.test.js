const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('public installation routes all resolve to dev', () => {
  const header = read('src/00-userscript-header.js');
  const loader = read('dist/CustomOutfitEditor.loader.user.js');
  const readme = read('README.md');

  for (const [name, content] of Object.entries({ header, loader, readme })) {
    assert.match(content, /stareyeXuanyeLin\/BC-COE\/(?:dev|@dev)/, `${name} must reference dev`);
    assert.doesNotMatch(content, /(?:single-layer-transform-rebuild|@layer-transform)/, `${name} must not reference an obsolete release branch`);
  }

  assert.match(loader, /@name\s+Bondage Club - Custom Outfit Editor（dev 测试加载器）/);
  assert.match(loader, /__CUSTOM_OUTFIT_EDITOR_DEV_LOADER__/);
  assert.match(loader, /@grant\s+GM_xmlhttpRequest/);
  assert.match(loader, /@grant\s+GM_addElement/);
  assert.match(loader, /@grant\s+unsafeWindow/);
  assert.match(loader, /raw\.githubusercontent\.com/);
  assert.match(loader, /cdn\.jsdelivr\.net/);
  assert.match(loader, /fastly\.jsdelivr\.net/);
  assert.match(loader, /gcore\.jsdelivr\.net/);
  assert.match(loader, /BC-COE@dev\/dist\/CustomOutfitEditor\.user\.js/);
  assert.doesNotMatch(loader, /script\.src\s*=/);
});

test('remote loader fetches GitHub raw first and executes downloaded core through Tampermonkey', () => {
  const loader = read('dist/CustomOutfitEditor.loader.user.js');
  const requested = [];
  const unsafeWindow = {};
  const validCore = 'const MOD_NAME = "CustomOutfitEditor"; function initialize() {}';
  const context = {
    unsafeWindow,
    document: { head: {}, documentElement: {} },
    GM_xmlhttpRequest(options) {
      requested.push(options.url);
      options.onload({ status: 200, responseText: validCore });
    },
    GM_addElement(_parent, tag, attributes) {
      assert.equal(tag, 'script');
      assert.match(attributes.textContent, /sourceURL=https:\/\/raw\.githubusercontent\.com/);
      unsafeWindow.__CUSTOM_OUTFIT_EDITOR_DEV_CORE_EVALUATED__ = true;
      return {};
    },
    console: { info() {}, warn() {}, error() {} },
    Date: { now: () => 123456 },
  };

  vm.runInNewContext(loader, context);

  assert.equal(new URL(requested[0]).host, 'raw.githubusercontent.com');
  assert.equal(requested.length, 1);
  assert.equal(unsafeWindow.__CUSTOM_OUTFIT_EDITOR_DEV_LOADER__, true);
  assert.equal(unsafeWindow.__CUSTOM_OUTFIT_EDITOR_DEV_CORE_EVALUATED__, undefined);
});

test('remote loader falls back after invalid responses and clears its guard after total failure', () => {
  const loader = read('dist/CustomOutfitEditor.loader.user.js');
  const requested = [];
  const unsafeWindow = {};
  const context = {
    unsafeWindow,
    document: { head: {}, documentElement: {} },
    GM_xmlhttpRequest(options) {
      requested.push(options.url);
      options.onload({ status: 503, responseText: '<html>unavailable</html>' });
    },
    GM_addElement() { throw new Error('invalid responses must not execute'); },
    console: { info() {}, warn() {}, error() {} },
    Date: { now: () => 123456 },
  };

  vm.runInNewContext(loader, context);

  assert.deepEqual(requested.map(url => new URL(url).host), [
    'raw.githubusercontent.com',
    'cdn.jsdelivr.net',
    'fastly.jsdelivr.net',
    'gcore.jsdelivr.net',
  ]);
  assert.equal(unsafeWindow.__CUSTOM_OUTFIT_EDITOR_LOADER__, undefined);
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
    assert.match(content, /COE_RVP\/1/, `${name} must declare COE_RVP/1`);
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
