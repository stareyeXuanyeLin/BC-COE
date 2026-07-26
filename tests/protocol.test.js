const test = require('node:test');
const assert = require('node:assert/strict');
const { load, snapshot, makeAsset } = require('./helpers');

test('identical visual snapshots have identical canonical text and SHA-256 hash', async () => {
  const { api } = load();
  const a = api.canonicalRemoteSnapshot(snapshot());
  const b = api.canonicalRemoteSnapshot(JSON.parse(JSON.stringify(snapshot())));
  assert.equal(a, b);
  assert.equal(await api.sha256Base64Url(a), await api.sha256Base64Url(b));
});

test('content length and namespace are rejected before JSON parsing', () => {
  const { api } = load();
  assert.throws(() => api.parseRemoteContent('x'.repeat(1801)), /remote-content/);
  assert.throws(() => api.parseRemoteContent('OTHER|{'), /remote-content/);
  assert.throws(() => api.parseRemoteContent('COE_RVS/3|{'), /remote-json/);
});

test('snapshot validator rejects pollution keys, non-finite values and illegal Property', () => {
  const { api } = load();
  const polluted = JSON.parse('{"v":1,"m":[{"g":"Cloth","a":"Dress","c":[],"__proto__":{}}],"l":[]}');
  assert.throws(() => api.validateRemoteSnapshot(polluted), /pollution|material-key/);
  const nonFinite = snapshot(); nonFinite.l[0].x = Infinity;
  assert.throws(() => api.validateRemoteSnapshot(nonFinite), /number/);
  const property = snapshot(); property.m[0].p = { Effect: ['Lock'] };
  assert.throws(() => api.validateRemoteSnapshot(property), /property-key/);
});

test('local remote snapshot contains only compact visual fields', () => {
  const asset = makeAsset();
  const { api } = load({ assets: [asset] });
  const composition = {
    version: 3,
    name: 'CustomOutfit',
    CustomComposition: { denied: true },
    Player: { Appearance: [] },
    materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', colors: ['#fff'], sourceProperty: {} }],
    layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 10, offsetX: 0, offsetY: 0, opacity: 1, __coeMaterialId: 'denied' }],
    recycle: [],
  };
  api.setActiveCompositionForTest(composition);
  const value = api.buildLocalRemoteSnapshot();
  assert.deepEqual(Object.keys(value), ['v', 'px', 'py', 'm', 'l']);
  assert.deepEqual(Object.keys(value.m[0]), ['g', 'a', 'c']);
  assert.deepEqual(Object.keys(value.l[0]), ['m', 'n', 'i', 'p', 'x', 'y', 'o']);
  assert.equal(value.px, 50);
  assert.equal(value.py, 50);
  const text = JSON.stringify(value);
  for (const forbidden of ['CustomOutfit', 'CustomComposition', '__coeMaterialId', 'Appearance']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('decoded byte budget is enforced and chunk split stays bounded', () => {
  const { api } = load();
  const encoded = api.encodeRemoteText('x'.repeat(32769));
  assert.throws(() => api.decodeRemoteText(encoded), /decoded-budget/);
  const chunks = api.splitRemoteData(api.encodeRemoteText('x'.repeat(2000)));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(part => part.length <= 1200));
});

test('local canonical visual changes increment revision while identical visual does not', async () => {
  const asset = makeAsset();
  const { api } = load({ assets: [asset] });
  const composition = { version: 3, name: 'ignored', recycle: [], materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', colors: ['#fff'], sourceProperty: {} }], layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 10, offsetX: 0, offsetY: 0, opacity: 1 }] };
  api.setActiveCompositionForTest(composition);
  api.setLocalRemoteStateForTest({ session: 'session_A', revision: 0, hash: '', canonical: '', snapshot: null, buildToken: 1 });
  const generation = api.getRemoteStoreForTest().roomGeneration;
  await api.updateLocalRemoteSnapshot(generation, 1);
  assert.equal(api.getLocalRemoteStateForTest().revision, 1);
  const state = api.getLocalRemoteStateForTest();
  api.setLocalRemoteStateForTest({ ...state, buildToken: 2 });
  await api.updateLocalRemoteSnapshot(generation, 2);
  assert.equal(api.getLocalRemoteStateForTest().revision, 1);
  composition.layers[0].priority = 11;
  api.setActiveCompositionForTest(composition);
  api.setLocalRemoteStateForTest({ ...api.getLocalRemoteStateForTest(), buildToken: 3 });
  await api.updateLocalRemoteSnapshot(generation, 3);
  assert.equal(api.getLocalRemoteStateForTest().revision, 2);
  api.setLocalRemoteStateForTest({ ...api.getLocalRemoteStateForTest(), buildToken: 4 });
  assert.equal(await api.updateLocalRemoteSnapshot(generation - 1, 4), false);
  assert.equal(api.getLocalRemoteStateForTest().revision, 2);
});

test('envelope validator rejects same-revision conflict through peer store', () => {
  const { api } = load();
  api.setRemotePeer(7, { session: 'session_A', revision: 2, hash: 'hash_A', size: 10, sharing: true });
  assert.throws(() => api.setRemotePeer(7, { session: 'session_A', revision: 2, hash: 'hash_B', size: 10, sharing: true }), /revision-hash-conflict/);
  assert.doesNotThrow(() => api.setRemotePeer(7, { session: 'session_B', revision: 1, hash: 'hash_C', size: 10, sharing: true }));
});
