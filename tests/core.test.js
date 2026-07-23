const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TextEncoder, TextDecoder } = require('node:util');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const parts = [
  '00-userscript-header.js','01-runtime.js','02-data.js','03-storage.js','04-assets.js',
  '05-capabilities.js','06-adapters.js','07-renderer.js','08-ui-shell.js','09-wardrobe.js',
  '10-editor.js','11-remote-protocol.js','12-remote-store.js','13-remote-transport.js',
  '14-remote-controller.js','15-bootstrap.js',
];
const code = parts.map(name => fs.readFileSync(path.join(root, 'src', name), 'utf8')).join('\n');

function makeAsset(group = 'Cloth', name = 'Dress', extra = {}) {
  const layer = { Name: 'Base', Priority: 10, HasImage: true, LockLayer: false, AllowColorize: true, ColorIndex: 0, Opacity: 1, MinOpacity: 0, MaxOpacity: 1, DrawingLeft: {}, DrawingTop: {}, ParentGroup: {}, PoseMapping: {}, CreateLayerTypes: [], ...extra.layer };
  return {
    Name: name, Wear: true, IsLock: false, DefaultColor: ['Default'], ColorableLayerCount: 1,
    Group: { Name: group, Family: 'Female3DCG', Category: 'Appearance', AllowNone: true },
    Layer: [layer], ...extra,
  };
}

function load(options = {}) {
  const assets = options.assets || [];
  const player = options.player || { AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [], AppearanceLayers: [], ExtensionSettings: {} };
  const store = new Map();
  const sandbox = {
    __COE_TEST_MODE__: true,
    console: { log() {}, info() {}, warn() {}, error() {} },
    location: { href: 'http://localhost/' },
    TextEncoder, TextDecoder, crypto: webcrypto,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    Player: player,
    Asset: assets,
    AssetGet: (_family, group, name) => assets.find(a => a.Group.Name === group && a.Name === name) || null,
    localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    document: { getElementById: () => null, body: null, head: { appendChild() {} }, createElement: () => ({}) },
    requestAnimationFrame: fn => fn(), cancelAnimationFrame() {}, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
    window: { addEventListener() {} }, alert() {}, confirm: () => true,
    CharacterRefresh() {},
  };
  Object.assign(sandbox, options.globals || {});
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'coe-echo.js' });
  return { api: sandbox.__COE_TEST_API__, sandbox, assets, player, store };
}

function compositionFor(asset) {
  return {
    version: 3, name: 'x', recycle: [],
    materials: [{ id: 'm1', sourceGroup: asset.Group.Name, sourceAsset: asset.Name, colors: ['#ffffff'], sourceProperty: {} }],
    layers: [{ materialId: 'm1', sourceGroup: asset.Group.Name, sourceAsset: asset.Name, sourceLayer: 'Base', sourceLayerIndex: 0, priority: 10, offsetX: 0, offsetY: 0, opacity: 1 }],
  };
}

test('runtime source no longer contains the legacy formal-container mechanism', () => {
  const runtimeSource = parts.map(name => fs.readFileSync(path.join(root, 'src', name), 'utf8')).join('\n');
  for (const forbidden of [
    'CONTAINER_GROUP', 'LEGACY_CONTAINER_GROUP', 'CONTAINER_ASSET', 'APPEARANCE_SANITIZED_VERSION',
    'isLegacyContainerItem', 'getLegacyContainerItem', 'migrateLegacyContainerState',
    'ServerPlayerAppearanceSync', 'ChatRoomCharacterUpdate', 'CustomComposition',
  ]) assert.equal(runtimeSource.includes(forbidden), false, forbidden);
});

test('editor module defines every helper used by the wardrobe entry flow', () => {
  const source = fs.readFileSync(path.join(root, 'src', '10-editor.js'), 'utf8');
  for (const name of ['openEditor', 'renderPoseControls', 'setPreviewPose']) {
    assert.match(source, new RegExp(`\\bfunction\\s+${name}\\s*\\(`), `${name} must be defined`);
  }
});

test('editor delegates color selection to the vanilla picker instead of browser color inputs', () => {
  const source = fs.readFileSync(path.join(root, 'src', '10-editor.js'), 'utf8');
  assert.match(source, /globalThis\.ColorPickerInit/);
  assert.match(source, /defaultColors:\s*\[resetColor\]/);
  assert.match(source, /onExit:\s*\(\{ colors \}, save\)/);
  assert.match(source, /classList\.add\("coe-owned-color-picker"\)/);
  assert.match(source, /classList\.remove\("coe-owned-color-picker"\)/);
  assert.doesNotMatch(source, /type=["']color["']/);
  const shellSource = fs.readFileSync(path.join(root, 'src', '08-ui-shell.js'), 'utf8');
  assert.match(shellSource, /\.coe-owned-color-picker\{[^}]*background:[^}]*!important/);
});

test('picker color normalization accepts BC defaults and canonicalizes short or mixed-case hex', () => {
  const { api } = load();
  assert.equal(api.normalizePickerColor('Default'), 'Default');
  assert.equal(api.normalizePickerColor('#a0F'), '#AA00FF');
  assert.equal(api.normalizePickerColor('  #aBc123  '), '#ABC123');
  assert.equal(api.normalizePickerColor('not-a-color', null), null);
});

test('stable insert returns the original array when there are no synthetic layers', () => {
  const { api } = load();
  const base = [{ Priority: 1 }, { Priority: 2 }];
  assert.equal(api.stableInsertSyntheticLayers(base, []), base);
});

test('stable insert preserves every base object and its relative order', () => {
  const { api } = load();
  const a = { id: 'a', Priority: 1 }, b = { id: 'b', Priority: 2 }, c = { id: 'c', Priority: 2 };
  const synthetic = { id: 's', Priority: 2, __coeSyntheticLayer: { materialOrder: 0, sourceOrder: 0 } };
  const result = api.stableInsertSyntheticLayers([a, b, c], [synthetic]);
  assert.deepEqual(result.map(x => x.id), ['a', 'b', 'c', 's']);
  assert.equal(result[0], a); assert.equal(result[1], b); assert.equal(result[2], c);
});

test('synthetic layers with equal priority use material/source order stably', () => {
  const { api } = load();
  const mk = (id, m, s) => ({ id, Priority: 5, __coeSyntheticLayer: { materialOrder: m, sourceOrder: s } });
  const result = api.stableInsertSyntheticLayers([], [mk('c', 1, 0), mk('b', 0, 1), mk('a', 0, 0)]);
  assert.deepEqual(result.map(x => x.id), ['a', 'b', 'c']);
});

test('stable insert failure returns original base without mutation', () => {
  const { api } = load();
  const base = [{ id: 'base', Priority: 1 }];
  const bad = { get Priority() { throw new Error('boom'); }, __coeSyntheticLayer: { materialOrder: 0, sourceOrder: 0 } };
  const result = api.stableInsertSyntheticLayers(base, [bad]);
  assert.equal(result, base);
  assert.deepEqual(base.map(x => x.id), ['base']);
});

test('dynamic BeforeDraw assets are flagged for diagnostics', () => {
  const { api } = load();
  const result = api.analyzeSourceAsset(makeAsset('Cloth', 'Dynamic', { DynamicBeforeDraw: true }));
  assert.equal(result.compatibility, 'unsupported');
  assert.ok(result.reasons.includes('dynamic-before-draw'));
});

test('functional non-image alpha layers are flagged for diagnostics', () => {
  const asset = makeAsset();
  asset.Layer.push({ HasImage: false, Alpha: [{ Masks: [[0,0,1,1]] }] });
  const { api } = load();
  const result = api.analyzeSourceAsset(asset);
  assert.equal(result.compatibility, 'unsupported');
  assert.ok(result.reasons.includes('functional-non-image-layer'));
});

test('synthetic visual layers drop pose names removed from the current BC runtime', () => {
  const asset = makeAsset('Cloth', 'LegacyPose', { layer: { PoseMapping: { BaseLower: '', LegsOpen: 'Hide' } } });
  const { api, player } = load({ assets: [asset], globals: { PoseRecord: { BaseLower: { Category: 'BodyLower' } } } });
  api.setActiveCompositionForTest(compositionFor(asset));
  const groups = api.buildSyntheticItems(player);
  const [layer] = api.makeSyntheticLayers(groups);
  assert.deepEqual(Object.keys(layer.PoseMapping), ['BaseLower']);
  assert.equal(layer.__coeSyntheticLayer.sourceLayer.PoseMapping.LegsOpen, undefined);
  assert.equal(asset.Layer[0].PoseMapping.LegsOpen, 'Hide');
});

test('active appearance semantics and WebGL names are flagged for diagnostics', () => {
  const { api } = load();
  assert.equal(api.analyzeSourceAsset(makeAsset('ItemMisc', '监控机器人')).compatibility, 'unsupported');
  assert.equal(api.analyzeSourceAsset(makeAsset('Cloth', 'PoseItem', { SetPose: ['Kneel'] })).compatibility, 'unsupported');
});

test('ordinary vanilla Hide Block and Effect metadata do not disable static clothing', () => {
  const { api } = load();
  const asset = makeAsset('Cloth', 'OrdinaryDress', { Hide: ['ClothLower'], Block: ['ItemTorso'], Effect: ['Lock'] });
  const result = api.analyzeSourceAsset(asset);
  assert.equal(result.compatibility, 'safe');
  assert.equal(result.hasPassiveAppearanceSemantics, true);
  assert.equal(result.reasons.includes('formal-appearance-semantics'), false);
});

test('verified installed Echo runtime enables static Chinese-named Echo assets', () => {
  const asset = makeAsset('Cloth', '测试裙');
  const bcModSdk = { getModsInfo: () => [{ name: '服装拓展', fullName: 'Echo的服装拓展', version: '1.129.4', repository: 'https://github.com/SugarChain-Studio/echo-clothing-ext' }] };
  const { api } = load({ assets: [asset], globals: { bcModSdk } });
  const result = api.analyzeSourceAsset(asset);
  assert.equal(result.provider, 'echo');
  assert.equal(result.authorization, 'allowed');
  assert.equal(result.compatibility, 'safe');
  assert.equal(result.adapterId, 'echo-static');
});

test('Echo candidates remain diagnosable without a verified runtime', () => {
  const { api } = load();
  const result = api.analyzeSourceAsset(makeAsset('Shoes', '鱼嘴高跟鞋'));
  assert.equal(result.provider, 'echo');
  assert.equal(result.compatibility, 'unverified');
  assert.ok(result.reasons.includes('echo-version-unknown'));
});

test('diagnostic incompatibility does not block static projection', () => {
  const asset = makeAsset('Cloth', '动态测试裙', { DynamicBeforeDraw: true, DynamicAfterDraw: true, Extended: true });
  const { api, player } = load({ assets: [asset] });
  api.setActiveCompositionForTest(compositionFor(asset));
  const groups = api.buildSyntheticItems(player);
  assert.equal(groups.length, 1);
  assert.notEqual(groups[0].item.Asset, asset);
  assert.equal(groups[0].item.Asset.__coeVisualProxy, true);
  assert.equal(groups[0].item.Asset.Asset, asset);
  assert.equal(groups[0].item.Asset.DynamicBeforeDraw, false);
  assert.equal(groups[0].item.Asset.DynamicAfterDraw, false);
  groups[0].item.Asset.DynamicBeforeDraw = true;
  groups[0].item.Asset.DynamicAfterDraw = true;
  groups[0].item.Asset.DynamicScriptDraw = true;
  assert.equal(groups[0].item.Asset.DynamicBeforeDraw, false);
  assert.equal(groups[0].item.Asset.DynamicAfterDraw, false);
  assert.equal(groups[0].item.Asset.DynamicScriptDraw, false);
  assert.equal(groups[0].item.Asset.Extended, false);
});

test('visual proxy satisfies LSCG smartGetAssetGroup fallback without enabling dynamic draw', () => {
  const asset = makeAsset('Cloth', 'LSCGCompat', { DynamicBeforeDraw: true });
  const { api, player, assets } = load({ assets: [asset] });
  api.setActiveCompositionForTest(compositionFor(asset));
  const proxy = api.buildSyntheticItems(player)[0].item.Asset;
  const smartGetAssetGroup = value => assets.includes(value) ? value.Group : value.Asset.Group;
  assert.equal(smartGetAssetGroup(proxy), asset.Group);
  proxy.DynamicBeforeDraw = true;
  assert.equal(proxy.DynamicBeforeDraw, false);
});

test('material picker never disables a loaded static-image asset by compatibility class', () => {
  const source = fs.readFileSync(path.join(root, 'src', '10-editor.js'), 'utf8');
  assert.doesNotMatch(source, /button\.disabled\s*=/);
  assert.doesNotMatch(source, /该素材不可用/);
});

test('plain property schema rejects cycles, arrays, functions and oversized records', () => {
  const { api } = load();
  assert.throws(() => api.sanitizePlainRecord([]), /property-not-plain/);
  assert.throws(() => api.sanitizePlainRecord({ x() {} }), /property-value-denied/);
  assert.throws(() => api.sanitizePlainRecord(Object.fromEntries(Array.from({length: 17}, (_, i) => [`k${i}`, i]))), /too-many/);
});

test('compact serializer omits redundant/UI/runtime fields', () => {
  const asset = makeAsset();
  const { api } = load({ assets: [asset] });
  const raw = { version: 4, appearanceSanitizedVersion: 1, equippedIds: ['s'], schemes: [{ id: 's', updatedAt: 123, composition: { ...compositionFor(asset), materials: [{ ...compositionFor(asset).materials[0], collapsed: true, defaultColors: ['Default'], provider: 'echo' }], layers: [{ ...compositionFor(asset).layers[0], defaultOffsetX: 0, defaultOffsetY: 0, defaultColor: null, defaultPriority: 10, defaultOpacity: 1, sourceProperty: { Type: 'x' }, sourceColor: 'Default' }] } }] };
  const compact = api.compactWardrobeForStorage(raw);
  const text = JSON.stringify(compact);
  for (const forbidden of ['updatedAt','appearanceSanitizedVersion','collapsed','defaultOffsetX','defaultOffsetY','defaultColor','defaultPriority','defaultOpacity','provider','sourceColor']) assert.equal(text.includes(forbidden), false, forbidden);
});

test('lz payload is deferred when LZString is not ready', () => {
  const { api } = load();
  assert.equal(api.unpackWardrobeDetailed('lz:anything').status, 'deferred');
});

test('lz null/empty result is corrupt, malformed JSON is corrupt, unknown prefix unsupported', () => {
  const env = load();
  env.sandbox.LZString = { decompressFromUTF16: () => null };
  assert.equal(env.api.unpackWardrobeDetailed('lz:x').status, 'corrupt');
  assert.equal(env.api.unpackWardrobeDetailed('json:{').status, 'corrupt');
  assert.equal(env.api.unpackWardrobeDetailed('raw:{}').status, 'unsupported');
});

test('packWardrobe normalizes then compacts without restoring omitted defaults', () => {
  const asset = makeAsset();
  const { api } = load({ assets: [asset] });
  const packed = api.packWardrobe({ version: 4, schemes: [{ id: 's', updatedAt: Date.now(), composition: compositionFor(asset) }], equippedIds: [] });
  assert.ok(packed.startsWith('json:'));
  assert.equal(packed.includes('updatedAt'), false);
  assert.equal(packed.includes('defaultOffsetX'), false);
});

test('formal same-Asset conflict skips synthetic material', () => {
  const asset = makeAsset();
  const player = { AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [{ Asset: asset, Color: ['Default'], Property: {} }], AppearanceLayers: [], ExtensionSettings: {} };
  const { api } = load({ assets: [asset], player });
  api.setActiveCompositionForTest(compositionFor(asset));
  assert.equal(api.buildSyntheticItems(player).length, 0);
});

test('remote CharacterAppearanceSortLayers result is returned unchanged', () => {
  const asset = makeAsset();
  const env = load({ assets: [asset] });
  const hooks = {};
  env.api.installHooksForTest({ hookFunction(name, _priority, fn) { hooks[name] = fn; } });
  const remote = { Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const base = [{ Asset: asset, Priority: 10 }];
  const result = hooks.CharacterAppearanceSortLayers([remote], () => base);
  assert.equal(result, base);
});

test('outbound bundle hook filters synthetic items and leaves formal items untouched', () => {
  const env = load();
  const hooks = {};
  env.api.installHooksForTest({ hookFunction(name, _priority, fn) { hooks[name] = fn; } });
  const normal = { Asset: makeAsset() };
  const synthetic = { Asset: makeAsset(), __coeMaterialId: 'x' };
  const otherFormalItem = { Asset: makeAsset('ClothOuter', 'OtherFormalItem') };
  const args = [[normal, synthetic, otherFormalItem]];
  const result = hooks.ServerAppearanceBundle(args, nextArgs => nextArgs[0]);
  assert.deepEqual(result, [normal, otherFormalItem]);
  assert.equal(env.api.statusSnapshot().outboundSyntheticFiltered, 1);
});

test('CommonDraw finally restores Appearance and AppearanceLayers when downstream throws', () => {
  const asset = makeAsset();
  const env = load({ assets: [asset] });
  const hooks = {};
  env.api.installHooksForTest({ hookFunction(name, _priority, fn) { hooks[name] = fn; } });
  env.api.setActiveCompositionForTest(compositionFor(asset));
  const base = [];
  hooks.CharacterAppearanceSortLayers([env.player], () => base);
  const originalAppearance = env.player.Appearance;
  const originalLayers = env.player.AppearanceLayers;
  assert.throws(() => hooks.CommonDrawAppearanceBuild([env.player], () => { throw new Error('draw failed'); }), /draw failed/);
  assert.equal(env.player.Appearance, originalAppearance);
  assert.equal(env.player.AppearanceLayers, originalLayers);
});

test('renderer does not install an inbound Appearance bundle filter', () => {
  const env = load();
  const hooks = {};
  env.api.installHooksForTest({ hookFunction(name, _priority, fn) { hooks[name] = fn; } });
  assert.equal(hooks.ServerAppearanceLoadFromBundle, undefined);
});

test('drawable layer predicate consistently rejects missing images and locked layers', () => {
  const { api } = load();
  assert.equal(api.isDrawableLayer({ HasImage: true, LockLayer: false }), true);
  assert.equal(api.isDrawableLayer({ HasImage: false, LockLayer: false }), false);
  assert.equal(api.isDrawableLayer({ HasImage: true, LockLayer: true }), false);
  assert.equal(api.isDrawableLayer(null), false);
});

test('material color normalization preserves fallback, padding and truncation behavior', () => {
  const { api } = load();
  const asset = { DefaultColor: ['#111111', '#222222', '#333333'], ColorableLayerCount: 3 };
  assert.deepEqual(Array.from(api.normalizedMaterialColors({ colors: ['#abcdef'] }, asset)), ['#abcdef', '#222222', '#333333']);
  assert.deepEqual(Array.from(api.normalizedMaterialColors({ colors: [], sourceColor: '#123456' }, asset)), ['#123456', '#222222', '#333333']);
  assert.deepEqual(Array.from(api.normalizedMaterialColors({ colors: ['a', 'b', 'c', 'd'] }, asset)), ['a', 'b', 'c']);
});
