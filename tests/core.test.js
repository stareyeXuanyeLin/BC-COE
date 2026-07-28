const test = require('node:test');
const assert = require('node:assert/strict');
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
  const store = options.store || new Map();
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
    localStorage: {
      getItem: key => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
      removeItem: key => store.delete(key),
    },
    document: { getElementById: () => null, body: null, head: { appendChild() {} }, createElement: () => ({}) },
    requestAnimationFrame: fn => fn(), cancelAnimationFrame() {}, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
    window: { addEventListener() {} }, alert() {}, confirm: () => true,
    CharacterRefresh() {},
  };
  Object.assign(sandbox, options.globals || {});
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'custom-outfit-editor.js' });
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
  assert.match(source, /onInput:\s*fieldset\s*=>/);
  assert.match(source, /onExit:\s*\(\{ colors \}, save\)/);
  assert.match(source, /onPreview\?\.\(selected\)/);
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

test('copied layer labels use the next unique numeric suffix across active and recycled layers', () => {
  const { api } = load();
  const original = { materialId: 'm', layerLabel: '花边' };
  const composition = {
    layers: [original, { materialId: 'm', layerLabel: '花边_副本1' }],
    recycle: [{ materialId: 'm', layerLabel: '花边_副本2' }, { materialId: 'other', layerLabel: '花边_副本3' }],
  };
  assert.equal(api.nextCopyLayerLabel(original, composition), '花边_副本3');
  assert.equal(api.nextCopyLayerLabel({ materialId: 'm', layerLabel: '花边_副本1' }, composition), '花边_副本3');
  assert.equal(api.nextCopyLayerLabel({ materialId: 'm', layerLabel: '花边_copy_copy' }, composition), '花边_副本3');
});

test('pose controls provide compact Chinese labels for vanilla pose names', () => {
  const { api } = load();
  assert.equal(api.localizedPoseLabel({ Name: 'KneelingSpread', Description: 'Kneeling spread' }), '跪姿张腿');
  assert.equal(api.localizedPoseLabel({ Name: 'FuturePose', Description: '未来姿势' }), '未来姿势');
});

test('transform targets come from persistent list selection without dropdown or pointer handles', () => {
  const source = fs.readFileSync(path.join(root, 'src', '10-editor.js'), 'utf8');
  assert.doesNotMatch(source, /data-transform-target|const layerOptions/);
  assert.doesNotMatch(source, /data-edit-transform|data-edit-overall/);
  assert.doesNotMatch(source, /data-transform-handle|function bindTransformHandle/);
  assert.match(source, /data-select-material/);
  assert.match(source, /data-select-layer/);
});

test('material categories default to collapsed and matching search categories expand automatically', () => {
  const source = fs.readFileSync(path.join(root, 'src', '10-editor.js'), 'utf8');
  assert.match(source, /const searching =[^;]+query\.trim\(\)\.length > 0/);
  assert.match(source, /const collapsed = !searching && !expandedMaterialGroups\.has\(groupName\)/);
});

test('editor exposes only clothing or underwear appearance slots and stores the selected slot', () => {
  const cloth = makeAsset('Cloth', 'Dress');
  cloth.Group.Clothing = true;
  cloth.Group.Description = '衣服';
  const eyes = makeAsset('Eyes', 'Blue');
  eyes.Group.AllowNone = false;
  const customBurger = makeAsset('BurgerCloth', 'BurgerTag');
  customBurger.Group.Clothing = true;
  customBurger.Group.Description = '🍔 第三方服装格';
  const { api } = load({ assets: [cloth, eyes, customBurger] });
  assert.deepEqual(Array.from(api.clothingSlotGroups(), group => group.Name), ['Cloth']);
  assert.equal(api.clothingSlotGroups().some(group => group.Name === 'BurgerCloth'), false);
  const normalized = api.normalizeComposition({ name: '星裙', slotGroup: 'Cloth', materials: [], layers: [] }, { validateReferences: false });
  assert.equal(normalized.slotGroup, 'Cloth');
  assert.equal(api.compactCompositionForStorage(normalized).slotGroup, 'Cloth');
  const shellSource = fs.readFileSync(path.join(root, 'src', '08-ui-shell.js'), 'utf8');
  assert.match(shellSource, /id="coe-slot"/);
});

test('tag assets register as transparent clothing and enabling can replace the current slot item', () => {
  const dress = makeAsset('Cloth', 'Dress');
  dress.Group.Clothing = true;
  dress.Group.Description = '衣服';
  const burger = makeAsset('BurgerCloth', 'BurgerDress');
  burger.Group.Clothing = true;
  burger.Group.Description = '🍔 第三方服装格';
  const assets = [dress, burger];
  const player = { AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [{ Asset: dress }], AppearanceLayers: [], ExtensionSettings: {} };
  const globals = {
    AssetGroup: [dress.Group, burger.Group],
    AssetFemale3DCG: [{ Group: 'Cloth', Clothing: true, AllowNone: true }, { Group: 'BurgerCloth', Clothing: true, AllowNone: true }],
    AssetAdd: (group, definition) => {
      const asset = { Name: definition.Name, Wear: true, Group: group, Layer: definition.Layer, Description: definition.Description, DynamicDescription: definition.DynamicDescription, DynamicName: definition.DynamicName, DefaultColor: [] };
      group.Asset ||= [];
      group.Asset.push(asset);
      assets.push(asset);
    },
    InventoryWear: (character, assetName, groupName) => {
      const asset = assets.find(entry => entry.Name === assetName && entry.Group.Name === groupName);
      if (!asset) return null;
      character.Appearance = character.Appearance.filter(item => item.Asset.Group.Name !== groupName);
      const item = { Asset: asset, Color: 'Default', Property: {} };
      character.Appearance.push(item);
      return item;
    },
  };
  const { api } = load({ assets, player, globals });
  assert.equal(api.registerTagAssets(), true);
  const tag = assets.find(asset => asset.Name === 'COECustomOutfit');
  assert.equal(tag.Layer[0].HasImage, false);
  assert.equal(assets.some(asset => asset.Name === 'COECustomOutfit' && asset.Group.Name === 'BurgerCloth'), false);
  assert.equal(tag.DynamicDescription(), '自定义衣服');
  assert.equal(api.equipTagForGroup('Cloth'), true);
  assert.equal(player.Appearance.length, 1);
  assert.equal(player.Appearance[0].Asset, tag);
});

test('local custom visuals require both an enabled material and its equipped tag asset', () => {
  const source = makeAsset('Cloth', 'StarDress');
  source.Group.Clothing = true;
  const tag = makeAsset('Cloth', 'COECustomOutfit', { layer: { HasImage: false } });
  tag.Group.Clothing = true;
  const { api, player } = load({ assets: [source, tag] });
  const composition = compositionFor(source);
  composition.materials[0].wearGroup = 'Cloth';
  api.setActiveCompositionForTest(composition);
  assert.equal(api.buildSyntheticItems(player).length, 0);
  player.Appearance.push({ Asset: tag, Color: 'Default', Property: {} });
  assert.equal(api.buildSyntheticItems(player).length, 1);
  player.Appearance.length = 0;
  assert.equal(api.buildSyntheticItems(player).length, 0);
});

test('activating a scheme disables only the other enabled scheme in the same clothing slot', () => {
  const cloth = makeAsset('Cloth', 'Dress');
  cloth.Group.Clothing = true;
  const outer = makeAsset('ClothOuter', 'Coat');
  outer.Group.Clothing = true;
  const { api } = load({ assets: [cloth, outer] });
  const scheme = (id, slotGroup) => ({ id, composition: { name: id, slotGroup, materials: [], layers: [] } });
  api.setWardrobeForTest({ version: 6, schemes: [scheme('cloth-a', 'Cloth'), scheme('cloth-b', 'Cloth'), scheme('outer', 'ClothOuter')], equippedIds: ['cloth-a', 'outer'] });
  const wardrobe = api.getWardrobeForTest();
  assert.equal(api.activateScheme(wardrobe.schemes.find(entry => entry.id === 'cloth-b'), false), true);
  assert.deepEqual(Array.from(api.getWardrobeForTest().equippedIds).sort(), ['cloth-b', 'outer']);
});

test('remote snapshot wear-group field is validated and preserved', () => {
  const { api } = load();
  const snapshot = api.validateRemoteSnapshot({ v: 1, m: [{ g: 'Cloth', a: 'Dress', c: ['Default'], w: 'Cloth' }], l: [{ m: 0, n: 'Base', i: 0, p: 10, x: 0, y: 0, o: 1 }] });
  assert.equal(snapshot.m[0].w, 'Cloth');
});

test('tag clothing preview is replaced with a night-sky emoticon', () => {
  const runtimeSource = parts.map(name => fs.readFileSync(path.join(root, 'src', name), 'utf8')).join('\n');
  assert.match(runtimeSource, /TAG_PREVIEW_EMOTICON/);
  assert.match(runtimeSource, /DrawPreviewBox\(x, y, "", description, options\)/);
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

test('static third-party assets are analyzed without provider branding', () => {
  const asset = makeAsset('Cloth', '测试裙');
  const { api } = load({ assets: [asset] });
  const result = api.analyzeSourceAsset(asset);
  assert.equal(result.provider, 'third-party');
  assert.equal(result.authorization, 'allowed');
  assert.equal(result.compatibility, 'safe');
  assert.equal(result.adapterId, 'static');
});

test('explicit high-risk third-party tuples remain diagnosable', () => {
  const { api } = load();
  const result = api.analyzeSourceAsset(makeAsset('Cloth', '交领右衽'));
  assert.equal(result.provider, 'third-party');
  assert.equal(result.compatibility, 'unsupported');
  assert.ok(result.reasons.includes('manifest-denied'));
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
  const raw = { version: 4, appearanceSanitizedVersion: 1, equippedIds: ['s'], schemes: [{ id: 's', updatedAt: 123, composition: { ...compositionFor(asset), materials: [{ ...compositionFor(asset).materials[0], collapsed: true, defaultColors: ['Default'], provider: 'third-party' }], layers: [{ ...compositionFor(asset).layers[0], defaultOffsetX: 0, defaultOffsetY: 0, defaultColor: null, defaultPriority: 10, defaultOpacity: 1, sourceProperty: { Type: 'x' }, sourceColor: 'Default' }] } }] };
  const compact = api.compactWardrobeForStorage(raw);
  const text = JSON.stringify(compact);
  for (const forbidden of ['updatedAt','appearanceSanitizedVersion','collapsed','defaultOffsetX','defaultOffsetY','defaultColor','defaultPriority','defaultOpacity','provider','sourceColor']) assert.equal(text.includes(forbidden), false, forbidden);
});

test('legacy wardrobe data migrates to schemaVersion 1 without losing saved outfit fields', () => {
  const asset = makeAsset();
  const { api } = load({ assets: [asset] });
  const legacy = {
    version: 7,
    schemes: [{
      id: 'saved-outfit',
      composition: {
        ...compositionFor(asset),
        version: 6,
        materials: [{ ...compositionFor(asset).materials[0], overallMirrorX: true, overallScale: 1.25 }],
        layers: [{ ...compositionFor(asset).layers[0], mirrorY: true, rotation: 0.5 }],
      },
    }],
    equippedIds: ['saved-outfit'],
  };
  const result = api.unpackWardrobeDetailed(`json:${JSON.stringify(legacy)}`);
  assert.equal(result.status, 'ok');
  assert.equal(result.migration.migrated, true);
  assert.equal(result.migration.fromVersion, 0);
  assert.equal(result.migration.toVersion, 1);
  assert.equal(result.data.schemaVersion, 1);
  assert.equal(result.data.schemes[0].id, 'saved-outfit');
  assert.equal(result.data.schemes[0].composition.materials[0].overallMirrorX, true);
  assert.equal(result.data.schemes[0].composition.materials[0].overallScale, 1.25);
  assert.equal(result.data.schemes[0].composition.layers[0].mirrorY, true);
  assert.equal(result.data.schemes[0].composition.layers[0].rotation, 0.5);
  const stored = JSON.parse(api.packWardrobe(result.data).slice(5));
  assert.equal(stored.schemaVersion, 1);
  assert.equal(Object.hasOwn(stored, 'version'), false);
});

test('current and future wardrobe schemas are distinguished before normalization', () => {
  const { api } = load();
  const current = api.unpackWardrobeDetailed('json:{"schemaVersion":1,"schemes":[],"equippedIds":[]}');
  assert.equal(current.status, 'ok');
  assert.equal(current.migration.migrated, false);
  assert.equal(current.migration.fromVersion, 1);
  assert.equal(current.migration.toVersion, 1);
  assert.equal(api.unpackWardrobeDetailed('json:{"schemaVersion":2,"schemes":[],"equippedIds":[]}').status, 'unsupported');
  assert.equal(api.unpackWardrobeDetailed('json:{"version":8,"schemes":[],"equippedIds":[]}').status, 'unsupported');
});

test('loadWardrobe backs up and automatically writes a legacy wardrobe in the current schema', () => {
  const asset = makeAsset();
  const legacy = {
    version: 7,
    schemes: [{ id: 'friend-test', composition: compositionFor(asset) }],
    equippedIds: ['friend-test'],
  };
  const oldPacked = `json:${JSON.stringify(legacy)}`;
  const store = new Map([['BC.CustomOutfitEditor.v1.1', oldPacked]]);
  const syncCalls = [];
  const player = {
    AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [], AppearanceLayers: [],
    ExtensionSettings: { CustomOutfitEditor: oldPacked },
  };
  const { api } = load({ assets: [asset], player, store, globals: { ServerPlayerExtensionSettingsSync: key => syncCalls.push(key) } });
  const state = api.loadWardrobe();
  assert.equal(state.migration.status, 'completed');
  assert.equal(state.migration.fromVersion, 0);
  assert.deepEqual(syncCalls, ['CustomOutfitEditor']);
  const local = api.unpackWardrobeDetailed(store.get('BC.CustomOutfitEditor.v1.1'));
  const server = api.unpackWardrobeDetailed(player.ExtensionSettings.CustomOutfitEditor);
  assert.equal(local.migration.migrated, false);
  assert.equal(server.migration.migrated, false);
  assert.equal(local.data.schemes[0].id, 'friend-test');
  const backup = JSON.parse(store.get('BC.CustomOutfitEditor.v1.1.migration-backup.v0'));
  assert.equal(backup.raw, oldPacked);
  assert.equal(backup.fromSchemaVersion, 0);
});

test('failed migration backup keeps legacy storage untouched and blocks automatic writes', () => {
  const legacy = 'json:{"version":7,"schemes":[],"equippedIds":[]}';
  const store = new Map([['BC.CustomOutfitEditor.v1.1', legacy]]);
  const syncCalls = [];
  const localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => {
      if (key.includes('migration-backup')) throw new Error('quota');
      store.set(key, value);
    },
    removeItem: key => store.delete(key),
  };
  const player = {
    AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [], AppearanceLayers: [],
    ExtensionSettings: { CustomOutfitEditor: legacy },
  };
  const { api } = load({ player, store, globals: { localStorage, ServerPlayerExtensionSettingsSync: key => syncCalls.push(key) } });
  const state = api.loadWardrobe();
  assert.equal(state.status, 'migration-failed');
  assert.equal(state.migration.status, 'failed');
  assert.equal(api.statusSnapshot().wardrobeRead.persistenceBlocked, true);
  assert.equal(store.get('BC.CustomOutfitEditor.v1.1'), legacy);
  assert.equal(player.ExtensionSettings.CustomOutfitEditor, legacy);
  assert.deepEqual(syncCalls, []);
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

test('single outfit exchange string round-trips compact composition data', () => {
  const asset = makeAsset();
  asset.Group.Clothing = true;
  const { api } = load({ assets: [asset] });
  const encoded = api.createOutfitExchangeString(compositionFor(asset));
  assert.match(encoded, /^COE-OUTFIT:1:b64:/);
  const parsed = api.parseOutfitExchangeString(encoded);
  assert.equal(parsed.composition.name, 'x');
  assert.equal(parsed.composition.layers.length, 1);
  assert.equal(parsed.composition.materials[0].sourceAsset, 'Dress');
  assert.equal(parsed.missingLayers, 0);
});

test('single outfit import reports partially missing asset layers and rejects unsupported slots', () => {
  const available = makeAsset('Cloth', 'Dress');
  available.Group.Clothing = true;
  const missing = makeAsset('Cloth', 'Cape');
  missing.Group.Clothing = true;
  const source = load({ assets: [available, missing] });
  const composition = compositionFor(available);
  composition.materials.push({ id: 'm2', sourceGroup: 'Cloth', sourceAsset: 'Cape', colors: ['Default'] });
  composition.layers.push({ materialId: 'm2', sourceGroup: 'Cloth', sourceAsset: 'Cape', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 11, offsetX: 0, offsetY: 0, opacity: 1 });
  const encoded = source.api.createOutfitExchangeString(composition);
  const target = load({ assets: [available] });
  const parsed = target.api.parseOutfitExchangeString(encoded);
  assert.equal(parsed.composition.layers.length, 1);
  assert.equal(parsed.missingLayers, 1);

  const invalid = compositionFor(available);
  invalid.slotGroup = 'BurgerCloth';
  assert.throws(() => target.api.parseOutfitExchangeString(source.api.createOutfitExchangeString(invalid)), /不受支持的服装格子/);
});

test('wardrobe exchange document round-trips and rejects duplicate scheme ids', () => {
  const asset = makeAsset();
  asset.Group.Clothing = true;
  const { api } = load({ assets: [asset] });
  const wardrobe = { version: 6, schemes: [{ id: 's', composition: compositionFor(asset) }], equippedIds: ['s'] };
  const documentData = api.createWardrobeExchangeDocument(wardrobe);
  const parsed = api.parseWardrobeExchangeDocument(`\uFEFF${JSON.stringify(documentData)}`);
  assert.equal(parsed.wardrobe.schemes.length, 1);
  assert.equal(parsed.missingLayers, 0);
  assert.equal(parsed.affectedSchemes, 0);
  assert.deepEqual(Array.from(parsed.wardrobe.equippedIds), ['s']);
  documentData.payload.schemes.push(documentData.payload.schemes[0]);
  assert.throws(() => api.parseWardrobeExchangeDocument(JSON.stringify(documentData)), /重复的方案 ID/);
});

test('wardrobe export filename uses immutable account identity, sanitized name and local timestamp', () => {
  const player = { AccountName: 'A:B*', Name: 'Display', MemberNumber: 42, AssetFamily: 'Female3DCG', Appearance: [], AppearanceLayers: [], ExtensionSettings: {} };
  const { api } = load({ player });
  const date = new Date(2026, 6, 8, 9, 5, 4);
  assert.equal(api.wardrobeExportFilename(date), 'A_B__42_20260708-090504.coe-wardrobe.json');
});

test('server sync capacity measures the complete Socket.IO AccountUpdate message in UTF-8 bytes', () => {
  const { api } = load();
  const packed = 'json:{"name":"衣柜"}';
  const expected = new TextEncoder().encode(`42${JSON.stringify(['AccountUpdate', { 'ExtensionSettings.CustomOutfitEditor': packed }])}`).length;
  assert.equal(api.serverSyncMessageBytes(packed), expected);
});

test('successful wardrobe save reports a sent server request instead of an unverified server success', () => {
  const syncCalls = [];
  const env = load({ globals: { ServerPlayerExtensionSettingsSync: key => syncCalls.push(key) } });
  env.api.setWardrobeForTest({ version: 6, schemes: [], equippedIds: [] });
  env.api.persistWardrobe();
  const status = env.api.statusSnapshot().wardrobeRead;
  assert.deepEqual(syncCalls, ['CustomOutfitEditor']);
  assert.equal(status.status, 'sync-sent');
  assert.equal(status.serverStatus, 'sent');
  assert.equal(status.syncMode, 'server');
  assert.ok(status.requestBytes > 0);
  assert.equal(status.maxRequestBytes, 160000);
});

test('oversized wardrobe remains local, skips server sync, and wins intentional divergence after reload', () => {
  const store = new Map();
  const oldServer = 'json:{"version":6,"schemes":[],"equippedIds":[]}';
  const player = { AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [], AppearanceLayers: [], ExtensionSettings: { CustomOutfitEditor: oldServer } };
  const syncCalls = [];
  let localJson = '';
  const lz = {
    compressToUTF16: () => 'x'.repeat(160000),
    decompressFromUTF16: () => localJson,
  };
  const first = load({ player, store, globals: { LZString: lz, ServerPlayerExtensionSettingsSync: key => syncCalls.push(key) } });
  const localWardrobe = {
    version: 6,
    schemes: [{ id: 'local-scheme', composition: { version: 5, name: '仅本机', slotGroup: 'Cloth', materials: [], layers: [], recycle: [] } }],
    equippedIds: [],
  };
  localJson = JSON.stringify(first.api.compactWardrobeForStorage(localWardrobe));
  first.api.setWardrobeForTest(localWardrobe);
  first.api.persistWardrobe();

  const firstStatus = first.api.statusSnapshot().wardrobeRead;
  assert.equal(syncCalls.length, 0);
  assert.equal(player.ExtensionSettings.CustomOutfitEditor, oldServer);
  assert.equal(firstStatus.status, 'local-only');
  assert.equal(firstStatus.syncReason, 'server-byte-budget');
  assert.ok(firstStatus.requestBytes > firstStatus.maxRequestBytes);
  assert.ok(store.has('BC.CustomOutfitEditor.v1.1.sync'));

  const reloadedPlayer = { ...player, Appearance: [], AppearanceLayers: [], ExtensionSettings: { CustomOutfitEditor: oldServer } };
  const second = load({ player: reloadedPlayer, store, globals: { LZString: lz } });
  const readState = second.api.loadWardrobe();
  assert.equal(readState.status, 'local-only');
  assert.equal(readState.source, 'local');
  assert.equal(readState.conflict, false);
  assert.equal(second.api.getWardrobeForTest().schemes[0].id, 'local-scheme');
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
