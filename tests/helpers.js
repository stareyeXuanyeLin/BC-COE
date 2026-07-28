const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TextEncoder, TextDecoder } = require('node:util');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const parts = [
  '00-userscript-header.js','01-runtime.js','02-data.js','02-schema-migrations.js','03-storage.js','04-assets.js',
  '05-capabilities.js','06-adapters.js','07-renderer.js','08-ui-shell.js','09-wardrobe.js',
  '10-editor.js','11-remote-protocol.js','12-remote-store.js','13-remote-transport.js',
  '14-remote-controller.js','15-bootstrap.js',
];
const code = parts.map(name => fs.readFileSync(path.join(root, 'src', name), 'utf8')).join('\n');

function makeAsset(group = 'Cloth', name = 'Dress', extra = {}) {
  const layer = { Name: 'Base', Priority: 10, HasImage: true, LockLayer: false, AllowColorize: true, ColorIndex: 0, Opacity: 1, MinOpacity: 0, MaxOpacity: 1, DrawingLeft: {}, DrawingTop: {}, ParentGroup: {}, PoseMapping: {}, CreateLayerTypes: ['typed'], ...extra.layer };
  return { Name: name, Wear: true, IsLock: false, DefaultColor: ['Default'], ColorableLayerCount: 1, Group: { Name: group, Family: 'Female3DCG', Category: 'Appearance', AllowNone: true }, Layer: [layer], ...extra };
}

function snapshot() {
  return { v: 1, m: [{ g: 'Cloth', a: 'Dress', c: ['#FFFFFF'], p: { Type: 'A', TypeRecord: { typed: 1 } } }], l: [{ m: 0, n: 'Base', i: 0, p: 10, x: 0, y: 0, o: 1 }] };
}

function load(options = {}) {
  const assets = options.assets || [];
  const player = options.player || { AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [], AppearanceLayers: [], ExtensionSettings: {} };
  const store = options.store || new Map();
  const sent = [];
  const sandbox = {
    __COE_TEST_MODE__: true,
    console: { log() {}, info() {}, warn() {}, error() {} }, location: { href: 'http://localhost/' },
    TextEncoder, TextDecoder, crypto: webcrypto,
    btoa: value => Buffer.from(value, 'binary').toString('base64'), atob: value => Buffer.from(value, 'base64').toString('binary'),
    Player: player, ChatRoomCharacter: options.characters || [], Asset: assets,
    AssetGet: (_family, group, name) => assets.find(asset => asset.Group.Name === group && asset.Name === name) || null,
    ServerSend: (name, packet) => sent.push({ name, packet }),
    localStorage: {
      getItem: key => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
      removeItem: key => store.delete(key),
    },
    document: { getElementById: () => null, body: null, head: { appendChild() {} }, createElement: () => ({}) },
    requestAnimationFrame: fn => fn(), cancelAnimationFrame() {}, setTimeout, clearTimeout, setInterval() {}, clearInterval() {},
    window: { addEventListener() {} }, alert() {}, confirm: () => true, CharacterRefresh() {},
  };
  Object.assign(sandbox, options.globals || {});
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'custom-outfit-editor.js' });
  return { api: sandbox.__COE_TEST_API__, sandbox, assets, player, store, sent };
}

module.exports = { load, makeAsset, snapshot };
