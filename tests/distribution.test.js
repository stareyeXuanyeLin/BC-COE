const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('public installation routes all resolve to main', () => {
  const header = read('src/00-userscript-header.js');
  const loader = read('dist/CustomOutfitEditorEchoMirror.loader.user.js');
  const readme = read('README.md');

  for (const [name, content] of Object.entries({ header, loader, readme })) {
    assert.match(content, /stareyeXuanyeLin\/BC-COE\/(?:main|@main)/, `${name} must reference main`);
    assert.doesNotMatch(content, /(?:single-layer-transform-rebuild|@layer-transform)/, `${name} must not reference an obsolete release branch`);
  }

  assert.match(loader, /BC-COE\/main\/dist\/CustomOutfitEditorEchoMirror\.user\.js\?timestamp=/);
});

test('published core, docs and runtime agree on protocol and release version', () => {
  const sourceHeader = read('src/00-userscript-header.js');
  const sourceRuntime = read('src/01-runtime.js');
  const sourceProtocol = read('src/11-remote-protocol.js');
  const distCore = read('dist/CustomOutfitEditorEchoMirror.user.js');
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
