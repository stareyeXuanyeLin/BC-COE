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

test('character without remote snapshot returns original base layer reference', () => {
  const asset = makeAsset();
  const remote = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const { api } = load({ assets: [asset], characters: [remote] });
  api.setRemotePrefsForTest({ receivingEnabled: true });
  const hooks = hooksFor(api);
  const base = [{ Asset: asset, Priority: 10 }];
  assert.equal(hooks.CharacterAppearanceSortLayers([remote], () => base), base);
});

test('loaded static BC/Echo/other assets project through an inert visual proxy', () => {
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
