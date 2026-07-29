const test = require('node:test');
const assert = require('node:assert/strict');
const { load, makeAsset } = require('./helpers');

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function emptyComposition(name = '服装', slotGroup = 'Cloth') {
  return { version: 6, name, slotGroup, materials: [], layers: [], recycle: [] };
}
function compositionFor(asset, name = '服装') {
  return {
    version: 6, name, slotGroup: asset.Group.Name, recycle: [],
    materials: [{ id: 'm1', sourceGroup: asset.Group.Name, sourceAsset: asset.Name, colors: ['#ffffff'] }],
    layers: [{ materialId: 'm1', sourceGroup: asset.Group.Name, sourceAsset: asset.Name, sourceLayer: 'Base', sourceLayerIndex: 0, priority: 10, offsetX: 0, offsetY: 0, opacity: 1 }],
  };
}

function appearanceAsset(group, name, allowNone = true) {
  return makeAsset(group, name, { Group: { Name: group, Family: 'Female3DCG', Category: 'Appearance', AllowNone: allowNone } });
}

test('wardrobe v1 migrates to v2 with sets initialized and outfit state preserved', () => {
  const { api } = load();
  const result = api.migrateWardrobeData({ schemaVersion: 1, schemes: [{ id: 's', composition: emptyComposition() }], equippedIds: ['s'] });
  assert.equal(result.fromVersion, 1);
  assert.equal(result.toVersion, 2);
  assert.equal(result.data.schemaVersion, 2);
  assert.deepEqual(plain(result.data.sets), []);
  assert.deepEqual(plain(result.data.equippedIds), ['s']);
  assert.equal(result.data.schemes[0].id, 's');
});

test('set Appearance Property keeps BC empty layer keys, offsets, priorities and TypeRecord differences', () => {
  const { api } = load();
  const property = api.sanitizeSetProperty({
    DrawingLeft: { '': { Default: 12 }, '花钿': { Default: -3 } },
    DrawingTop: { '': { Default: 8 } },
    OverridePriority: { '': 7, '花钿': 9 },
    Opacity: 0.75,
    TypeRecord: { pattern: 3 },
    Expression: 'Closed',
    LockedBy: 42,
  });
  assert.deepEqual(plain(property), {
    DrawingLeft: { '': { Default: 12 }, '花钿': { Default: -3 } },
    DrawingTop: { '': { Default: 8 } },
    OverridePriority: { '': 7, '花钿': 9 },
    Opacity: 0.75,
    TypeRecord: { pattern: 3 },
  });
});

test('set normalization strips expressions, runtime lock fields, duplicate groups and dangling references', () => {
  const { api } = load();
  const wardrobe = api.normalizeWardrobe({
    schemaVersion: 2,
    schemes: [{ id: 's', composition: emptyComposition() }],
    sets: [{
      id: 'set', name: '夜宴',
      appearance: [
        { group: 'Eyes', asset: 'AnimeEyes', color: ['#55aaff'], property: { Expression: 'Closed', Type: 'A', LockedBy: 'x' } },
        { group: 'Eyes', asset: 'OtherEyes', property: {} },
      ],
      customOutfits: [
        { slotGroup: 'Cloth', schemeId: 's' },
        { slotGroup: 'Cloth', schemeId: 'missing' },
        { slotGroup: 'ClothOuter', schemeId: 'missing' },
      ],
    }],
    equippedIds: [],
  }, { validateReferences: false });
  assert.equal(wardrobe.sets[0].appearance.length, 1);
  assert.deepEqual(plain(wardrobe.sets[0].appearance[0].property), { Type: 'A' });
  assert.deepEqual(plain(wardrobe.sets[0].customOutfits), [{ slotGroup: 'Cloth', schemeId: 's' }]);
});

test('capturing a set saves complete Appearance, excludes non-Appearance and converts COE tags to references', () => {
  const body = appearanceAsset('BodyUpper', 'FemaleBody', false);
  const eyes = appearanceAsset('Eyes', 'AnimeEyes', false);
  const tag = appearanceAsset('Cloth', 'COECustomOutfit');
  tag.Group.Clothing = true;
  const restraint = makeAsset('ItemArms', 'Rope');
  restraint.Group.Category = 'Item';
  const player = {
    AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [
      { Asset: body, Color: 'Default', Property: {} },
      { Asset: eyes, Color: ['#55aaff'], Property: { Expression: 'Closed', Type: 'Wide' } },
      { Asset: tag, Color: 'Default', Property: {} },
      { Asset: restraint, Color: 'Default', Property: {} },
    ], AppearanceLayers: [], ExtensionSettings: {},
  };
  const { api } = load({ assets: [body, eyes, tag, restraint], player });
  api.setWardrobeForTest({ schemaVersion: 2, schemes: [{ id: 'dress', composition: emptyComposition('裙子', 'Cloth') }], sets: [], equippedIds: ['dress'] });
  const result = api.captureCurrentSet('夜宴');
  assert.deepEqual(plain(result.set.appearance.map(entry => entry.group)), ['BodyUpper', 'Eyes']);
  assert.deepEqual(plain(result.set.appearance[1].property), { Type: 'Wide' });
  assert.deepEqual(plain(result.set.customOutfits), [{ slotGroup: 'Cloth', schemeId: 'dress' }]);
  assert.deepEqual(plain(result.anomalies), []);
});

test('orphan COE tags are reported and prevent saving a misleading set', () => {
  const tag = appearanceAsset('Cloth', 'COECustomOutfit');
  tag.Group.Clothing = true;
  const player = { AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [{ Asset: tag }], AppearanceLayers: [], ExtensionSettings: {} };
  const { api } = load({ assets: [tag], player });
  api.setWardrobeForTest({ schemaVersion: 2, schemes: [], sets: [], equippedIds: [] });
  assert.throws(() => api.saveCurrentSetTransaction('坏套装', { persist() {} }), /没有对应自定义服装/);
  assert.equal(api.getWardrobeForTest().sets.length, 0);
});

test('deleting a referenced outfit removes only its references and rolls back on persistence failure', () => {
  const { api } = load();
  const initial = {
    schemaVersion: 2,
    schemes: [{ id: 'a', composition: emptyComposition('A') }, { id: 'b', composition: emptyComposition('B', 'ClothOuter') }],
    sets: [
      { id: 'x', name: 'X', appearance: [{ group: 'Eyes', asset: 'Eyes' }], customOutfits: [{ slotGroup: 'Cloth', schemeId: 'a' }, { slotGroup: 'ClothOuter', schemeId: 'b' }] },
      { id: 'y', name: 'Y', appearance: [], customOutfits: [{ slotGroup: 'Cloth', schemeId: 'a' }] },
    ],
    equippedIds: ['a', 'b'],
  };
  api.setWardrobeForTest(initial);
  assert.throws(() => api.removeSchemeAndSetReferences('a', { persist() { throw new Error('disk'); }, sync: false }), /disk/);
  assert.deepEqual(plain(api.getWardrobeForTest()), plain(api.normalizeWardrobe(initial, { validateReferences: false })));
  const result = api.removeSchemeAndSetReferences('a', { persist() {}, sync: false });
  const current = api.getWardrobeForTest();
  assert.equal(result.removedReferences, 2);
  assert.deepEqual(plain(current.schemes.map(entry => entry.id)), ['b']);
  assert.deepEqual(plain(current.equippedIds), ['b']);
  assert.deepEqual(plain(current.sets[0].appearance), [{ group: 'Eyes', asset: 'Eyes', color: 'Default', property: {} }]);
  assert.deepEqual(plain(current.sets[0].customOutfits), [{ slotGroup: 'ClothOuter', schemeId: 'b' }]);
  assert.deepEqual(plain(current.sets[1].customOutfits), []);
});

test('set apply plan replaces Appearance, preserves current expressions and reports missing content', () => {
  const body = appearanceAsset('BodyUpper', 'FemaleBody', false);
  const eyes = appearanceAsset('Eyes', 'AnimeEyes', false);
  const tag = appearanceAsset('Cloth', 'COECustomOutfit');
  tag.Group.Clothing = true;
  const old = appearanceAsset('ClothOuter', 'OldCoat');
  const player = {
    AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [
      { Asset: eyes, Color: 'Default', Property: { Expression: 'Closed' } },
      { Asset: old, Color: 'Default', Property: {} },
    ], AppearanceLayers: [], ExtensionSettings: {},
  };
  const { api } = load({ assets: [body, eyes, tag, old], player });
  api.setWardrobeForTest({
    schemaVersion: 2,
    schemes: [{ id: 'dress', composition: emptyComposition('裙子', 'Cloth') }],
    sets: [], equippedIds: [],
  });
  const set = {
    id: 'set', name: '夜宴',
    appearance: [
      { group: 'BodyUpper', asset: 'FemaleBody', color: 'Default', property: {} },
      { group: 'Eyes', asset: 'AnimeEyes', color: ['#55aaff'], property: { Type: 'Wide' } },
      { group: 'Hat', asset: 'MissingHat', color: 'Default', property: {} },
    ],
    customOutfits: [{ slotGroup: 'Cloth', schemeId: 'dress' }, { slotGroup: 'ClothOuter', schemeId: 'missing' }],
  };
  const plan = api.applySetTransaction(set, { persist() {} });
  assert.deepEqual(plain(player.Appearance.map(item => item.Asset.Group.Name).sort()), ['BodyUpper', 'Cloth', 'Eyes']);
  assert.equal(player.Appearance.find(item => item.Asset.Group.Name === 'Eyes').Property.Expression, 'Closed');
  assert.equal(player.Appearance.some(item => item.Asset.Name === 'OldCoat'), false);
  assert.deepEqual(plain(api.getWardrobeForTest().equippedIds), ['dress']);
  assert.equal(plan.missingAppearance.length, 1);
  assert.equal(plan.missingSchemes.length, 1);
});

test('set apply keeps required body Appearance fallback when an old set omitted it', () => {
  const body = appearanceAsset('BodyUpper', 'FemaleBody', false);
  const eyes = appearanceAsset('Eyes', 'AnimeEyes', false);
  const player = { AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [
    { Asset: body, Color: ['#fff'], Property: { TypeRecord: { body: 1 } } },
    { Asset: eyes, Color: ['#000'], Property: {} },
  ], AppearanceLayers: [], ExtensionSettings: {} };
  const { api } = load({ assets: [body, eyes], player });
  api.setWardrobeForTest({ schemaVersion: 2, schemes: [], sets: [], equippedIds: [] });
  api.applySetTransaction({ id: 'old', name: '旧套装', appearance: [{ group: 'Eyes', asset: 'AnimeEyes', color: ['#55aaff'], property: {} }], customOutfits: [] }, { persist() {} });
  assert.deepEqual(plain(player.Appearance.map(item => item.Asset.Group.Name)), ['BodyUpper', 'Eyes']);
  assert.deepEqual(plain(player.Appearance[0].Property), { TypeRecord: { body: 1 } });
});

test('set application restores Appearance and equipped ids when persistence fails', () => {
  const body = appearanceAsset('BodyUpper', 'FemaleBody', false);
  const old = appearanceAsset('BodyUpper', 'OldBody', false);
  const player = { AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [{ Asset: old, Color: 'Default', Property: {} }], AppearanceLayers: [], ExtensionSettings: {} };
  const { api } = load({ assets: [body, old], player });
  api.setWardrobeForTest({ schemaVersion: 2, schemes: [], sets: [], equippedIds: [] });
  assert.throws(() => api.applySetTransaction({ id: 's', name: 'S', appearance: [{ group: 'BodyUpper', asset: 'FemaleBody' }], customOutfits: [] }, { persist() { throw new Error('quota'); } }), /quota/);
  assert.equal(player.Appearance[0].Asset.Name, 'OldBody');
  assert.deepEqual(plain(api.getWardrobeForTest().equippedIds), []);
});

test('COE-SET round trip packages each dependency once and remaps ids on import', () => {
  const dress = appearanceAsset('Cloth', 'Dress');
  dress.Group.Clothing = true;
  const eyes = appearanceAsset('Eyes', 'AnimeEyes', false);
  const source = load({ assets: [dress, eyes] });
  source.api.setWardrobeForTest({
    schemaVersion: 2,
    schemes: [{ id: 'sender-id', composition: compositionFor(dress, '星裙') }],
    sets: [{ id: 'set-id', name: '夜宴', appearance: [{ group: 'Eyes', asset: 'AnimeEyes', color: ['#55aaff'], property: {} }], customOutfits: [{ slotGroup: 'Cloth', schemeId: 'sender-id' }] }],
    equippedIds: [],
  });
  const text = source.api.createSetExchangeString('set-id');
  assert.match(text, /^COE-SET:1:b64:/);
  assert.equal(text.includes('sender-id'), false);

  const target = load({ assets: [dress, eyes] });
  target.api.setWardrobeForTest({ schemaVersion: 2, schemes: [], sets: [], equippedIds: [] });
  const parsed = target.api.parseSetExchangeString(text);
  const plan = target.api.buildSetImportPlan(parsed);
  assert.equal(plan.report.outfitsCreated, 1);
  assert.notEqual(plan.set.customOutfits[0].schemeId, 'sender-id');
  target.api.commitSetImportPlan(plan, { persist() {} });
  assert.equal(target.api.getWardrobeForTest().sets.length, 1);
  assert.deepEqual(plain(target.api.getWardrobeForTest().equippedIds), []);
});

test('set import reuses identical composition and skips an all-missing dependency without losing the set', () => {
  const dress = appearanceAsset('Cloth', 'Dress');
  dress.Group.Clothing = true;
  const cape = appearanceAsset('ClothOuter', 'Cape');
  cape.Group.Clothing = true;
  const source = load({ assets: [dress, cape] });
  source.api.setWardrobeForTest({
    schemaVersion: 2,
    schemes: [{ id: 'dress', composition: compositionFor(dress, '裙子') }, { id: 'cape', composition: compositionFor(cape, '披风') }],
    sets: [{ id: 'set', name: '组合', appearance: [], customOutfits: [{ slotGroup: 'Cloth', schemeId: 'dress' }, { slotGroup: 'ClothOuter', schemeId: 'cape' }] }],
    equippedIds: [],
  });
  const text = source.api.createSetExchangeString('set');
  const target = load({ assets: [dress] });
  target.api.setWardrobeForTest({ schemaVersion: 2, schemes: [{ id: 'existing', composition: compositionFor(dress, '本地名字') }], sets: [], equippedIds: [] });
  const plan = target.api.buildSetImportPlan(target.api.parseSetExchangeString(text));
  assert.equal(plan.report.outfitsReused, 1);
  assert.equal(plan.report.outfitsSkipped, 1);
  assert.equal(plan.report.missingLayers, 1);
  assert.deepEqual(plain(plan.set.customOutfits), [{ slotGroup: 'Cloth', schemeId: 'existing' }]);
});

test('set import commit is atomic when persistence fails', () => {
  const dress = appearanceAsset('Cloth', 'Dress');
  dress.Group.Clothing = true;
  const source = load({ assets: [dress] });
  source.api.setWardrobeForTest({
    schemaVersion: 2,
    schemes: [{ id: 'source', composition: compositionFor(dress) }],
    sets: [{ id: 'source-set', name: 'S', appearance: [], customOutfits: [{ slotGroup: 'Cloth', schemeId: 'source' }] }],
    equippedIds: [],
  });
  const text = source.api.createSetExchangeString('source-set');
  const target = load({ assets: [dress] });
  const initial = { schemaVersion: 2, schemes: [], sets: [], equippedIds: [] };
  target.api.setWardrobeForTest(initial);
  const plan = target.api.buildSetImportPlan(target.api.parseSetExchangeString(text));
  assert.throws(() => target.api.commitSetImportPlan(plan, { persist() { throw new Error('quota'); } }), /quota/);
  assert.deepEqual(plain(target.api.getWardrobeForTest()), plain(target.api.normalizeWardrobe(initial)));
});

test('deleting a set never deletes its referenced custom outfit', () => {
  const { api } = load();
  api.setWardrobeForTest({
    schemaVersion: 2,
    schemes: [{ id: 's', composition: emptyComposition() }],
    sets: [{ id: 'set', name: 'S', appearance: [], customOutfits: [{ slotGroup: 'Cloth', schemeId: 's' }] }],
    equippedIds: [],
  });
  assert.equal(api.deleteSetTransaction('set', { persist() {} }), true);
  assert.deepEqual(plain(api.getWardrobeForTest().schemes.map(entry => entry.id)), ['s']);
  assert.deepEqual(plain(api.getWardrobeForTest().sets), []);
});

test('whole wardrobe import clears dangling set references and reports their count', () => {
  const { api } = load();
  const documentData = {
    format: 'COE_WARDROBE', formatVersion: 1,
    payload: {
      schemaVersion: 2,
      schemes: [{ id: 's', composition: emptyComposition() }],
      sets: [{ id: 'set', name: 'S', appearance: [], customOutfits: [{ slotGroup: 'Cloth', schemeId: 'missing' }] }],
      equippedIds: ['s'],
    },
  };
  const parsed = api.parseWardrobeExchangeDocument(JSON.stringify(documentData));
  assert.equal(parsed.missingSetReferences, 1);
  assert.deepEqual(plain(parsed.wardrobe.sets[0].customOutfits), []);
});

test('single outfit parsing keeps partial-import semantics when every source layer is unavailable', () => {
  const dress = appearanceAsset('Cloth', 'Dress');
  dress.Group.Clothing = true;
  const source = load({ assets: [dress] });
  const text = source.api.createOutfitExchangeString(compositionFor(dress));
  const target = load({ assets: [] });
  const parsed = target.api.parseOutfitExchangeString(text);
  assert.equal(parsed.allAssetsMissing, true);
  assert.equal(parsed.composition.layers.length, 0);
  assert.equal(parsed.missingLayers, 1);
});

test('set exchange rejects duplicate slots, future versions and pollution keys', () => {
  const { api } = load();
  const encode = envelope => `COE-SET:1:b64:${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64')}`;
  const base = {
    format: 'COE_SET', formatVersion: 1,
    payload: { set: { name: 'S', appearance: [], customOutfits: [] }, outfits: [] },
  };
  const future = { ...base, formatVersion: 2 };
  assert.throws(() => api.parseSetExchangeString(`COE-SET:2:b64:${Buffer.from(JSON.stringify(future)).toString('base64')}`), /更新版本/);
  const pollutedText = '{"format":"COE_SET","formatVersion":1,"payload":{"set":{"name":"S","appearance":[{"group":"Eyes","asset":"Eyes","property":{"__proto__":{"x":1}}}],"customOutfits":[]},"outfits":[]}}';
  assert.throws(() => api.parseSetExchangeString(`COE-SET:1:b64:${Buffer.from(pollutedText).toString('base64')}`), /危险字段/);

  const dress = appearanceAsset('Cloth', 'Dress');
  dress.Group.Clothing = true;
  const env = load({ assets: [dress] });
  const composition = compositionFor(dress);
  const duplicate = {
    ...base,
    payload: {
      set: { name: 'S', appearance: [], customOutfits: [{ slotGroup: 'Cloth', outfitRef: 'a' }, { slotGroup: 'Cloth', outfitRef: 'a' }] },
      outfits: [{ ref: 'a', composition }],
    },
  };
  assert.throws(() => env.api.parseSetExchangeString(encode(duplicate)), /重复的自定义服装部位/);
});
