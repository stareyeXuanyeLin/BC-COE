const test = require('node:test');
const assert = require('node:assert/strict');
const { load, makeAsset } = require('./helpers');

function alphaData(width, height, pixels) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [x, y, alpha = 255] of pixels) data[(y * width + x) * 4 + 3] = alpha;
  return data;
}

test('alpha bounds derive a normalized content pivot and ignore low-alpha pixels', () => {
  const { api } = load();
  const bounds = api.scanAlphaBounds(alphaData(10, 8, [
    [0, 0, 8],
    [2, 1, 255],
    [3, 1, 255],
    [6, 3, 255],
    [6, 4, 255],
  ]), 10, 8);
  assert.equal(bounds.minX, 2);
  assert.equal(bounds.minY, 1);
  assert.equal(bounds.maxX, 6);
  assert.equal(bounds.maxY, 4);
  assert.equal(bounds.count, 4);
  const pivot = api.contentPivotFromBounds(bounds, 10, 8);
  assert.equal(pivot.x, 0.45);
  assert.equal(pivot.y, 0.375);
});

test('alpha pivot falls back to texture center when content is absent or too small', () => {
  const { api } = load();
  assert.equal(api.scanAlphaBounds(alphaData(4, 4, [[1, 1, 255]]), 4, 4), null);
  const pivot = api.contentPivotFromBounds(null, 4, 4);
  assert.equal(pivot.x, 0.5);
  assert.equal(pivot.y, 0.5);
});

test('texture pivot scan reuses the loaded GLDraw image and caches its result', () => {
  const width = 10;
  const height = 8;
  const data = alphaData(width, height, [[2, 1], [3, 1], [6, 3], [6, 4]]);
  const image = { naturalWidth: width, naturalHeight: height, width, height, complete: true, addEventListener() {} };
  const context = { clearRect() {}, drawImage() {}, getImageData() { return { data }; } };
  const { api } = load({ globals: {
    GLDrawImageCache: new Map([['texture.png', image]]),
    document: { getElementById: () => null, createElement: tag => tag === 'canvas' ? { getContext: () => context } : {} },
  } });
  assert.equal(api.resolveTextureContentPivot('texture.png'), null);
  const pivot = api.resolveTextureContentPivot('texture.png');
  assert.equal(pivot.x, 0.45);
  assert.equal(pivot.y, 0.375);
});

test('layer transforms preserve rotation and scale while ignoring unknown fields', () => {
  const asset = makeAsset();
  const { api } = load({ assets: [asset] });
  const base = { materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress' }], layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1 }] };
  const transformed = api.compactCompositionForStorage({ ...base, layers: [{ ...base.layers[0], rotation: 0.5, scale: 1.5, extraField: true }] });
  assert.equal(transformed.layers[0].rotation, 0.5);
  assert.equal(transformed.layers[0].scale, 1.5);
  assert.equal(Object.hasOwn(transformed.layers[0], 'extraField'), false);
  const normalizedTransform = api.normalizeLayerTransform({ rotation: 0.5, scale: 1.5, extraField: true });
  assert.equal(normalizedTransform.rotation, 0.5);
  assert.equal(normalizedTransform.scale, 1.5);
  assert.equal(Object.hasOwn(normalizedTransform, 'extraField'), false);
});

test('editor normalization can retain unresolved references until persistence validation', () => {
  const { api } = load();
  const raw = { materials: [], layers: [{ sourceGroup: 'MissingGroup', sourceAsset: 'MissingAsset', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1 }] };
  assert.equal(api.normalizeComposition(raw).layers.length, 0);
  assert.equal(api.normalizeComposition(raw, { validateReferences: false }).layers.length, 1);
});

test('DrawingLeft and DrawingTop resolve the current pose before Default fallback', () => {
  const asset = makeAsset('Cloth', 'PoseDress', { Layer: [{ Name: 'Base', Priority: 1, HasImage: true, LockLayer: false, DrawingWidth: 100, DrawingHeight: 80, DrawingLeft: { Default: 10, Kneel: 30 }, DrawingTop: { Default: 20, Kneel: 40 } }] });
  const player = { AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', DrawPose: ['Kneel'], Appearance: [], AppearanceLayers: [], ExtensionSettings: {} };
  const { api } = load({ assets: [asset], player });
  const raw = { materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'PoseDress' }], layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'PoseDress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 5, offsetY: -5, opacity: 1 }] };
  const center = api.computeDefaultOverallCenter(api.normalizeComposition(raw), player);
  assert.equal(center.x, 85);
  assert.equal(center.y, 75);
  assert.equal(api.resolveNumericOrigin({ Default: 10, Kneel: 30 }, player), 30);
  assert.equal(api.resolveNumericOrigin({ Default: 10 }, player), 10);
  assert.equal(api.resolveNumericOrigin({ Kneel: Infinity }, player, 7), 7);
});

test('overall transform uses the largest visible layer center and ignores stored center fields', () => {
  const wide = makeAsset('Cloth', 'Wide', { Width: 400, Height: 100, Layer: [{ Name: 'Base', Priority: 1, HasImage: true, LockLayer: false, DrawingWidth: 400, DrawingHeight: 100, DrawingLeft: {}, DrawingTop: {} }] });
  const small = makeAsset('Cloth', 'Small', { Width: 50, Height: 50, Layer: [{ Name: 'Base', Priority: 2, HasImage: true, LockLayer: false, DrawingWidth: 50, DrawingHeight: 50, DrawingLeft: {}, DrawingTop: {} }] });
  const { api } = load({ assets: [wide, small] });
  const composition = { materials: [{ id: 'w', sourceGroup: 'Cloth', sourceAsset: 'Wide' }, { id: 's', sourceGroup: 'Cloth', sourceAsset: 'Small' }], layers: [
    { materialId: 'w', sourceGroup: 'Cloth', sourceAsset: 'Wide', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1 },
    { materialId: 's', sourceGroup: 'Cloth', sourceAsset: 'Small', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 2, offsetX: 0, offsetY: 0, opacity: 1 },
  ], overallRotation: 0.2, layersExtra: 'discarded' };
  const normalized = api.normalizeComposition(composition);
  const center = api.computeDefaultOverallCenter(normalized);
  assert.equal(center.x, 200);
  assert.equal(center.y, 50);
  assert.equal(normalized.layersExtra, undefined);
  const resolved = api.resolveOverallTransform(normalized);
  assert.equal(resolved.rotation, 0.2);
  assert.equal(resolved.scale, 1);
  assert.equal(resolved.offsetX, 0);
  assert.equal(resolved.offsetY, 0);
  assert.equal(resolved.centerX, 200);
  assert.equal(resolved.centerY, 50);
  const compact = api.compactCompositionForStorage(composition);
});

test('remote snapshots carry rotation, scale, and offsets without center fields', () => {
  const asset = makeAsset();
  const { api } = load({ assets: [asset] });
  api.setActiveCompositionForTest({ overallRotation: 0.2, overallScale: 1.25, overallOffsetX: 4, overallOffsetY: -3, materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', colors: [] }], layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1, rotation: 0.4, scale: 1.5 }] });
  const snapshot = api.buildLocalRemoteSnapshot();
  assert.equal(snapshot.or, 0.2);
  assert.equal(snapshot.os, 1.25);
  assert.equal(snapshot.ox, 4);
  assert.equal(snapshot.oy, -3);
  assert.equal(snapshot.l[0].r, 0.4);
  assert.equal(snapshot.l[0].s, 1.5);
  assert.equal(Object.hasOwn(snapshot, 'px'), false);
  assert.equal(Object.hasOwn(snapshot, 'py'), false);
  assert.equal(Object.hasOwn(snapshot.l[0], 'px'), false);
  assert.equal(Object.hasOwn(snapshot.l[0], 'py'), false);
  assert.deepEqual(api.validateRemoteSnapshot(snapshot), snapshot);
});

test('remote rendering resolves the automatic center on the receiving side', () => {
  const asset = makeAsset('Cloth', 'Wide', { Width: 400, Height: 100, Layer: [{ Name: 'Base', Priority: 1, HasImage: true, LockLayer: false, DrawingWidth: 400, DrawingHeight: 100, DrawingLeft: {}, DrawingTop: {} }] });
  const remote = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const { api } = load({ assets: [asset], characters: [remote] });
  const snapshot = api.validateRemoteSnapshot({ v: 1, or: 0.2, m: [{ g: 'Cloth', a: 'Wide', c: [] }], l: [{ m: 0, n: 'Base', i: 0, p: 1, x: 0, y: 0, o: 1 }] });
  const groups = api.buildRemoteSyntheticItems(remote, snapshot);
  assert.equal(groups[0].overall.centerX, 200);
  assert.equal(groups[0].overall.centerY, 50);
});

test('render callbacks keep local and overall transform layers separate', () => {
  const asset = makeAsset();
  const remote = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const value = { v: 1, or: 0.2, os: 1.25, ox: 4, oy: -3, m: [{ g: 'Cloth', a: 'Dress', c: [] }], l: [{ m: 0, n: 'Base', i: 0, p: 1, x: 0, y: 0, o: 1, r: 0.4, s: 1.5 }] };
  const { api } = load({ assets: [asset], characters: [remote] });
  const canonical = api.canonicalRemoteSnapshot(value);
  api.setPendingRequest(7, { requestId: 'request_A', session: 'session_7', revision: 1, hash: 'hash_A' });
  api.acceptRemoteSnapshot(7, '7:identity', value, canonical);
  api.setRemotePrefsForTest({ receivingEnabled: true });
  const hooks = {};
  api.installHooksForTest({ hookFunction(name, _priority, fn) { hooks[name] = fn; } });
  const sorted = hooks.CharacterAppearanceSortLayers([remote], () => []);
  remote.AppearanceLayers = sorted;
  const seen = [];
  const callbacks = { clearRect() {}, clearRectBlink() {}, drawCanvas() {}, drawCanvasBlink() {}, drawImage(_src, _x, _y, options) { seen.push(options); }, drawImageBlink() {}, drawImageColorize() {}, drawImageColorizeBlink() {} };
  hooks.CommonDrawAppearanceBuild([remote, callbacks], args => {
    for (const layer of remote.AppearanceLayers) args[1].drawImage('Assets/Female3DCG/Cloth/Dress/Dress_Base.png', 0, 0, {});
  });
  assert.equal(seen[0].Rotation, 0.4);
  assert.equal(seen[0].Scale, 1.5);
  assert.equal(seen[0].OverallRotation, 0.2);
  assert.equal(seen[0].OverallScale, 1.25);
  assert.equal(seen[0].OverallOffsetX, 4);
  assert.equal(seen[0].OverallOffsetY, -3);
});
