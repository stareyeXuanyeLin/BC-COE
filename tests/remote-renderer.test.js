const test = require('node:test');
const assert = require('node:assert/strict');
const { load, makeAsset, snapshot } = require('./helpers');

function activate(api, member, value = snapshot()) {
  const canonical = api.canonicalRemoteSnapshot(value);
  api.setPendingRequest(member, { requestId: 'request_A', session: `session_${member}`, revision: 1, hash: 'hash_A' });
  api.acceptRemoteSnapshot(member, `${member}:identity`, value, canonical);
  api.setRemotePrefsForTest({ receivingEnabled: true, sharingEnabled: false });
}

function hooksFor(api) {
  const hooks = {};
  api.installHooksForTest({ hookFunction(name, _priority, fn) { hooks[name] = fn; } });
  return hooks;
}

test('legacy non-uniform scale fields are discarded by the new schema', () => {
  const asset = makeAsset();
  const { api } = load({ assets: [asset] });
  api.setActiveCompositionForTest({
    materials: [{ id: 'm1', sourceGroup: 'Cloth', sourceAsset: 'Dress', colors: ['#fff'] }],
    layers: [{ materialId: 'm1', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1, scaleX: 1.5, scaleY: 0.75 }],
  });
  const snapshot = api.buildLocalRemoteSnapshot();
  assert.equal(Object.hasOwn(snapshot.l[0], 's'), false);
  assert.equal(Object.hasOwn(snapshot.l[0], 'sx'), false);
  assert.equal(Object.hasOwn(snapshot.l[0], 'sy'), false);
});

test('character without remote snapshot returns original base layer reference', () => {
  const asset = makeAsset();
  const remote = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const { api } = load({ assets: [asset], characters: [remote] });
  api.setRemotePrefsForTest({ receivingEnabled: true });
  const hooks = hooksFor(api);
  const base = [{ Asset: asset, Priority: 10 }];
  assert.equal(hooks.CharacterAppearanceSortLayers([remote], () => base), base);
});

test('loaded static vanilla and third-party assets project through an inert visual proxy', () => {
  for (const asset of [makeAsset('Cloth', 'Dress'), makeAsset('Shoes', '鱼嘴高跟鞋'), makeAsset('ClothAccessory', 'OtherMod')]) {
    const remote = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
    const value = { v: 1, m: [{ g: asset.Group.Name, a: asset.Name, c: ['#fff'] }], l: [{ m: 0, n: 'Base', i: 0, p: 10, x: 0, y: 0, o: 1 }] };
    const { api } = load({ assets: [asset], characters: [remote] });
    const groups = api.buildRemoteSyntheticItems(remote, api.validateRemoteSnapshot(value));
    assert.equal(groups.length, 1);
    const proxy = groups[0].item.Asset;
    proxy.DynamicBeforeDraw = true; proxy.DynamicAfterDraw = true; proxy.DynamicScriptDraw = true;
    assert.equal(proxy.DynamicBeforeDraw, false);
    assert.equal(proxy.DynamicAfterDraw, false);
    assert.equal(proxy.DynamicScriptDraw, false);
    assert.equal(proxy.Extended, false);
    assert.equal(proxy.Archetype, null);
  }
});

test('CommonDraw image callbacks receive per-layer transform options', () => {
  const asset = makeAsset('Cloth', 'Dress');
  const remote = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const value = { v: 1, m: [{ g: 'Cloth', a: 'Dress', c: ['#fff'] }], l: [{ m: 0, n: 'Base', i: 0, p: 10, x: 0, y: 0, o: 1, r: Math.PI / 2, s: 1.5 }] };
  const { api } = load({ assets: [asset], characters: [remote] });
  activate(api, 7, value);
  const hooks = hooksFor(api);
  const sorted = hooks.CharacterAppearanceSortLayers([remote], () => []);
  remote.AppearanceLayers = sorted;
  const seen = [];
  const callbacks = {
    clearRect() {}, clearRectBlink() {}, drawCanvas() {}, drawCanvasBlink() {},
    drawImage(_src, _x, _y, options) { seen.push(options); },
    drawImageBlink() {}, drawImageColorize() {}, drawImageColorizeBlink() {},
  };
  hooks.CommonDrawAppearanceBuild([remote, callbacks], args => {
    for (const layer of remote.AppearanceLayers) args[1].drawImage('Assets/Female3DCG/Cloth/Dress/Dress_Base.png', 0, 0, {});
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].Rotation, Math.PI / 2);
  assert.equal(seen[0].Scale, 1.5);
});

test('missing or mismatched material is skipped locally while other material survives', () => {
  const good = makeAsset('Cloth', 'Dress');
  const remote = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const value = { v: 1, m: [{ g: 'Cloth', a: 'Missing', c: [] }, { g: 'Cloth', a: 'Dress', c: [] }], l: [{ m: 0, n: 'Base', i: 0, p: 1, x: 0, y: 0, o: 1 }, { m: 1, n: 'Base', i: 0, p: 2, x: 0, y: 0, o: 1 }] };
  const { api } = load({ assets: [good], characters: [remote] });
  const groups = api.buildRemoteSyntheticItems(remote, api.validateRemoteSnapshot(value));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].material.sourceAsset, 'Dress');
  assert.equal(api.getRemoteStoreForTest().stats.remoteMaterialsSkipped, 1);
});

test('snapshot is keyed by MemberNumber and CommonDraw restores original references after throw', () => {
  const asset = makeAsset();
  const a = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const b = { MemberNumber: 8, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const { api } = load({ assets: [asset], characters: [a, b] });
  activate(api, 7);
  const hooks = hooksFor(api);
  const baseA = [], baseB = [];
  assert.notEqual(hooks.CharacterAppearanceSortLayers([a], () => baseA), baseA);
  assert.equal(hooks.CharacterAppearanceSortLayers([b], () => baseB), baseB);
  const appearance = a.Appearance, layers = a.AppearanceLayers;
  assert.throws(() => hooks.CommonDrawAppearanceBuild([a], () => { throw new Error('draw'); }), /draw/);
  assert.equal(a.Appearance, appearance);
  assert.equal(a.AppearanceLayers, layers);
  api.clearRemoteMember(7);
  const afterClear = [];
  assert.equal(hooks.CharacterAppearanceSortLayers([a], () => afterClear), afterClear);
});

test('formal same-Asset conflict protects remote character Appearance', () => {
  const asset = makeAsset();
  const remote = { MemberNumber: 7, Appearance: [{ Asset: asset }], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const { api } = load({ assets: [asset], characters: [remote] });
  assert.equal(api.buildRemoteSyntheticItems(remote, api.validateRemoteSnapshot(snapshot())).length, 0);
});
