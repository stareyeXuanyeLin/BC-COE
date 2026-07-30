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
  const normalized = api.contentBoundsFromBounds(bounds, 10, 8);
  assert.equal(normalized.left, 0.2);
  assert.equal(normalized.top, 0.125);
  assert.equal(normalized.right, 0.7);
  assert.equal(normalized.bottom, 0.625);
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

test('texture pivot scan never requests a missing or virtual texture URL directly', () => {
  let constructed = 0;
  const cache = new Map();
  const data = alphaData(4, 4, [[0, 0], [1, 0], [0, 1], [1, 1]]);
  const image = { naturalWidth: 4, naturalHeight: 4, width: 4, height: 4, complete: true, addEventListener() {} };
  const context = { clearRect() {}, drawImage() {}, getImageData() { return { data }; } };
  const { api } = load({ globals: {
    Image: function Image() { constructed++; },
    GLDrawImageCache: cache,
    document: { getElementById: () => null, createElement: tag => tag === 'canvas' ? { getContext: () => context } : {} },
  } });

  assert.equal(api.resolveTextureContentPivot('./Assets/Female3DCG/Suit/虚拟服装.png'), null);
  assert.equal(constructed, 0);

  cache.set('./Assets/Female3DCG/Suit/虚拟服装.png', image);
  assert.equal(api.resolveTextureContentPivot('./Assets/Female3DCG/Suit/虚拟服装.png'), null);
  const pivot = api.resolveTextureContentPivot('./Assets/Female3DCG/Suit/虚拟服装.png');
  assert.equal(pivot.x, 0.25);
  assert.equal(pivot.y, 0.25);
  assert.equal(constructed, 0);
});

test('synthetic placeholder texture schedules a character refresh when the image finishes loading', () => {
  const listeners = {};
  const image = {
    naturalWidth: 0, naturalHeight: 0, width: 0, height: 0, complete: false,
    addEventListener(name, callback) { listeners[name] = callback; },
  };
  const data = alphaData(4, 4, [[0, 0], [1, 0], [0, 1], [1, 1]]);
  const context = { clearRect() {}, drawImage() {}, getImageData() { return { data }; } };
  let refreshes = 0;
  const player = { AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [], AppearanceLayers: [], ExtensionSettings: {} };
  const { api } = load({ player, globals: {
    GLDrawImageCache: new Map([['pending.png', image]]),
    CharacterRefresh(character) { if (character === player) refreshes++; },
    document: { getElementById: () => null, createElement: tag => tag === 'canvas' ? { getContext: () => context } : {} },
  } });
  api.cacheOverallLayerGeometry({
    __coeGeometryCharacter: player,
    __coeGeometryMaterialId: 'm',
    __coeGeometryLayerKey: '0:0',
  }, 0, 0, 0, 1, 1, 550, 'pending.png');
  assert.equal(api.cachedOverallCenter(player, 'm'), null);
  assert.equal(typeof listeners.load, 'function');
  image.naturalWidth = image.width = 4;
  image.naturalHeight = image.height = 4;
  image.complete = true;
  listeners.load();
  assert.ok(refreshes >= 1);
  assert.ok(api.resolveTextureContentBounds('pending.png'));
});

test('overall geometry uses visible alpha bounds instead of the transparent full texture canvas', () => {
  const width = 100;
  const height = 100;
  const data = alphaData(width, height, [[20, 10], [59, 10], [20, 39], [59, 39]]);
  const data2 = alphaData(width, height, [[0, 70], [19, 70], [0, 89], [19, 89]]);
  const image = { data, naturalWidth: width, naturalHeight: height, width, height, complete: true, addEventListener() {} };
  const image2 = { data: data2, naturalWidth: width, naturalHeight: height, width, height, complete: true, addEventListener() {} };
  let drawnImage = image;
  const context = { clearRect() {}, drawImage(value) { drawnImage = value; }, getImageData() { return { data: drawnImage.data }; } };
  const { api } = load({ globals: {
    GLDrawImageCache: new Map([['garment.png', image], ['trim.png', image2]]),
    document: { getElementById: () => null, createElement: tag => tag === 'canvas' ? { getContext: () => context } : {} },
  } });
  assert.equal(api.resolveTextureContentBounds('garment.png'), null);
  const visibleBounds = api.resolveTextureContentBounds('garment.png');
  assert.equal(visibleBounds.left, 0.2);
  assert.equal(visibleBounds.top, 0.1);
  assert.equal(visibleBounds.right, 0.6);
  assert.equal(visibleBounds.bottom, 0.4);

  const character = { MemberNumber: 1 };
  const identity = { __coeGeometryCharacter: character, __coeGeometryLayerKey: '0:0' };
  api.cacheOverallLayerGeometry({ ...identity, __coeGeometryMaterialId: 'normal' }, 10, 20, 0, width, height, 550, 'garment.png');
  let center = api.cachedOverallCenter(character, 'normal');
  assert.equal(center.x, 50);
  assert.equal(center.y, 45);

  assert.equal(api.resolveTextureContentBounds('trim.png'), null);
  assert.ok(api.resolveTextureContentBounds('trim.png'));
  api.cacheOverallLayerGeometry({ ...identity, __coeGeometryMaterialId: 'union', __coeGeometryLayerKey: 'base' }, 10, 20, 0, width, height, 550, 'garment.png');
  api.cacheOverallLayerGeometry({ ...identity, __coeGeometryMaterialId: 'union', __coeGeometryLayerKey: 'trim' }, 100, 0, 0, width, height, 550, 'trim.png');
  center = api.cachedOverallCenter(character, 'union');
  assert.equal(center.x, 75);
  assert.equal(center.y, 60);

  api.cacheOverallLayerGeometry({ ...identity, __coeGeometryMaterialId: 'mirrored', Mirror: true, Invert: true }, 10, 20, 0, width, height, 550, 'garment.png');
  center = api.cachedOverallCenter(character, 'mirrored');
  assert.equal(center.x, 450);
  assert.equal(center.y, 1055);
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

test('material overall transform uses that material center and does not rotate the composition', () => {
  const wide = makeAsset('Cloth', 'Wide', { Width: 400, Height: 100, Layer: [{ Name: 'Base', Priority: 1, HasImage: true, LockLayer: false, DrawingWidth: 400, DrawingHeight: 100, DrawingLeft: {}, DrawingTop: {} }] });
  const small = makeAsset('Cloth', 'Small', { Width: 50, Height: 50, Layer: [{ Name: 'Base', Priority: 2, HasImage: true, LockLayer: false, DrawingWidth: 50, DrawingHeight: 50, DrawingLeft: {}, DrawingTop: {} }] });
  const { api } = load({ assets: [wide, small] });
  const composition = { materials: [{ id: 'w', sourceGroup: 'Cloth', sourceAsset: 'Wide', overallRotation: 0.2 }, { id: 's', sourceGroup: 'Cloth', sourceAsset: 'Small' }], layers: [
    { materialId: 'w', sourceGroup: 'Cloth', sourceAsset: 'Wide', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1 },
    { materialId: 's', sourceGroup: 'Cloth', sourceAsset: 'Small', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 2, offsetX: 0, offsetY: 0, opacity: 1 },
  ], overallRotation: 0.9, layersExtra: 'discarded' };
  const normalized = api.normalizeComposition(composition);
  const wideMaterial = normalized.materials.find(material => material.id === 'w');
  const center = api.computeDefaultOverallCenter(normalized, undefined, 'w');
  assert.equal(center.x, 200);
  assert.equal(center.y, 50);
  assert.equal(normalized.layersExtra, undefined);
  assert.equal(normalized.overallRotation, undefined);
  const resolved = api.resolveOverallTransform(normalized, undefined, wideMaterial);
  assert.equal(resolved.rotation, 0.2);
  assert.equal(resolved.scale, 1);
  assert.equal(resolved.offsetX, 0);
  assert.equal(resolved.offsetY, 0);
  assert.equal(resolved.centerX, 200);
  assert.equal(resolved.centerY, 50);
  const compact = api.compactCompositionForStorage(composition);
  assert.equal(compact.materials.find(material => material.id === 'w').overallRotation, 0.2);
});

test('overall center reuses BC final drawing coordinates when available', () => {
  const asset = makeAsset('Cloth', 'Resolved', { DynamicGroupName: 'DynamicCloth', Layer: [{
    Name: 'Base', Priority: 1, HasImage: true, LockLayer: false,
    DrawingWidth: 100, DrawingHeight: 80, DrawingLeft: 10, DrawingTop: 20,
  }] });
  const { api } = load({ assets: [asset], globals: {
    CommonDrawComputeDrawingCoordinates: (_character, _asset, layer, groupName) => {
      assert.equal(groupName, 'DynamicCloth');
      assert.equal(layer.DrawingLeft, 10);
      return { X: 300, Y: 400 };
    },
  } });
  const raw = { materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Resolved' }], layers: [{
    materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Resolved', sourceLayer: 'Base', sourceLayerIndex: 0,
    priority: 1, offsetX: 0, offsetY: 0, opacity: 1,
  }] };
  const center = api.computeDefaultOverallCenter(api.normalizeComposition(raw));
  assert.equal(center.x, 350);
  assert.equal(center.y, 440);
});

test('overall center uses the union bounds of every layer in one material', () => {
  const asset = makeAsset('Cloth', 'MultiLayer', { Layer: [
    { Name: 'Base', Priority: 1, HasImage: true, LockLayer: false, DrawingWidth: 100, DrawingHeight: 80, DrawingLeft: 10, DrawingTop: 20 },
    { Name: 'Trim', Priority: 2, HasImage: true, LockLayer: false, DrawingWidth: 20, DrawingHeight: 40, DrawingLeft: 200, DrawingTop: -10 },
  ] });
  const { api } = load({ assets: [asset] });
  const raw = {
    materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'MultiLayer' }],
    layers: [
      { materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'MultiLayer', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1 },
      { materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'MultiLayer', sourceLayer: 'Trim', sourceLayerIndex: 1, priority: 2, offsetX: 10, offsetY: 5, opacity: 1 },
    ],
  };
  const center = api.computeDefaultOverallCenter(api.normalizeComposition(raw));
  // Union: left=10, top=-5, right=230, bottom=100.
  assert.equal(center.x, 120);
  assert.equal(center.y, 47.5);
});

test('overall pivot remains fixed under combined rotation and scale', () => {
  const { api } = load();
  const pivot = api.transformPointAroundOverallPivot(100, 100, 100, 100, Math.PI / 2, 2, 10, -5);
  assert.equal(pivot.x, 110);
  assert.equal(pivot.y, 95);
  const point = api.transformPointAroundOverallPivot(103, 104, 100, 100, Math.PI / 2, 2, 10, -5);
  assert.equal(point.x, 102);
  assert.equal(point.y, 101);
});

test('overall center follows the final Mirror and Invert canvas space', () => {
  const asset = makeAsset('Cloth', 'Mirrored', { Layer: [{
    Name: 'Base', Priority: 1, HasImage: true, LockLayer: false,
    DrawingWidth: 100, DrawingHeight: 80, DrawingLeft: 10, DrawingTop: 20,
  }] });
  const { api } = load({ assets: [asset] });
  const raw = {
    materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Mirrored', sourceProperty: { Mirror: true, Invert: true } }],
    layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Mirrored', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1 }],
  };
  const normalized = api.normalizeComposition(raw);
  const center = api.computeDefaultOverallCenter(normalized, undefined, 'm');
  // Normal rect [10, 110] × [20, 100] becomes [390, 490] × [1000, 1080]
  // with the R130 GLDrawImage mirror/invert formulas and a 550px canvas.
  assert.equal(center.x, 440);
  assert.equal(center.y, 1040);
});

test('remote snapshots carry per-material and per-layer transforms without center fields', () => {
  const asset = makeAsset();
  const { api } = load({ assets: [asset] });
  api.setActiveCompositionForTest({ materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', colors: [], overallRotation: 0.2, overallScale: 1.25, overallOffsetX: 4, overallOffsetY: -3 }], layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1, rotation: 0.4, scale: 1.5 }] });
  const snapshot = api.buildLocalRemoteSnapshot();
  assert.equal(snapshot.m[0].r, 0.2);
  assert.equal(snapshot.m[0].s, 1.25);
  assert.equal(snapshot.m[0].x, 4);
  assert.equal(snapshot.m[0].y, -3);
  assert.equal(snapshot.l[0].r, 0.4);
  assert.equal(snapshot.l[0].s, 1.5);
  assert.equal(Object.hasOwn(snapshot, 'or'), false);
  assert.equal(Object.hasOwn(snapshot, 'os'), false);
  assert.equal(Object.hasOwn(snapshot, 'ox'), false);
  assert.equal(Object.hasOwn(snapshot, 'oy'), false);
  assert.deepEqual(api.validateRemoteSnapshot(snapshot), snapshot);
});

test('remote rendering resolves the automatic center on the receiving side', () => {
  const asset = makeAsset('Cloth', 'Wide', { Width: 400, Height: 100, Layer: [{ Name: 'Base', Priority: 1, HasImage: true, LockLayer: false, DrawingWidth: 400, DrawingHeight: 100, DrawingLeft: {}, DrawingTop: {} }] });
  const remote = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const { api } = load({ assets: [asset], characters: [remote] });
  const snapshot = api.validateRemoteSnapshot({ v: 1, m: [{ g: 'Cloth', a: 'Wide', c: [], r: 0.2 }], l: [{ m: 0, n: 'Base', i: 0, p: 1, x: 0, y: 0, o: 1 }] });
  const groups = api.buildRemoteSyntheticItems(remote, snapshot);
  assert.equal(groups[0].overall.centerX, 200);
  assert.equal(groups[0].overall.centerY, 50);
});

test('render callbacks keep local and overall transform layers separate', () => {
  const asset = makeAsset();
  const remote = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const value = { v: 1, m: [{ g: 'Cloth', a: 'Dress', c: [], r: 0.2, s: 1.25, x: 4, y: -3 }], l: [{ m: 0, n: 'Base', i: 0, p: 1, x: 0, y: 0, o: 1, r: 0.4, s: 1.5 }] };
  const { api } = load({ assets: [asset], characters: [remote] });
  const canonical = api.canonicalRemoteSnapshot(value);
  const publication = api.setRemotePublication(7, { session: 'session_7', revision: 1, hash: 'hash_A', uncompressedBytes: canonical.length, compressedBytes: 1, count: 1 }).publication;
  api.acceptRemoteSnapshot(7, publication, value, canonical);
  api.setRemotePrefsForTest({ receivingEnabled: true });
  api.cacheOverallLayerGeometry({
    __coeGeometryCharacter: remote,
    __coeGeometryMaterialId: 'remote:7:0',
    __coeGeometryLayerKey: '0:0',
  }, 0, 0, 0, 400, 800, 550);
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

test('runtime texture geometry replaces the nonexistent R130 asset dimensions for overall center', () => {
  const { api } = load();
  const character = { MemberNumber: 7 };
  const identity = { __coeGeometryCharacter: character, __coeGeometryMaterialId: 'm' };
  api.cacheOverallLayerGeometry({ ...identity, __coeGeometryLayerKey: 'base', Mirror: false, Invert: false }, 10, 20, 0, 400, 800, 1100);
  api.cacheOverallLayerGeometry({ ...identity, __coeGeometryLayerKey: 'trim', Mirror: false, Invert: false }, 500, -10, 0, 200, 100, 1100);
  let center = api.cachedOverallCenter(character, 'm');
  assert.equal(center.x, 355);
  assert.equal(center.y, 405);
  // Blink's second-half offset and placeholder 1x1 textures must not corrupt the stable base geometry.
  api.cacheOverallLayerGeometry({ ...identity, __coeGeometryLayerKey: 'base', __coeGeometryIsBlink: true }, 10, 20, 500, 999, 999, 1100);
  api.cacheOverallLayerGeometry({ ...identity, __coeGeometryLayerKey: 'base' }, 10, 20, 0, 1, 1, 1100);
  center = api.cachedOverallCenter(character, 'm');
  assert.equal(center.x, 355);
  assert.equal(center.y, 405);
});

test('overall transform input writes the current material and survives compact round-trip', () => {
  const asset = makeAsset();
  const { api } = load({ assets: [asset] });
  const material = { id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress' };
  const composition = { materials: [material], layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1 }] };
  api.setEditingForTest(composition);
  assert.equal(api.applyOverallTransformField('m', 'rotation', 30), true);
  assert.equal(api.applyOverallTransformField('m', 'scale', 1.5), true);
  assert.equal(api.applyOverallTransformField('m', 'offsetX', 100), true);
  assert.equal(api.applyOverallTransformField('m', 'offsetY', 50), true);
  const current = composition.materials[0];
  assert.equal(current.overallRotation, Math.PI / 6);
  assert.equal(current.overallScale, 1.5);
  assert.equal(current.overallOffsetX, 100);
  assert.equal(current.overallOffsetY, 50);
  const restored = api.normalizeComposition(api.compactCompositionForStorage(composition));
  assert.equal(restored.materials[0].overallRotation, Math.PI / 6);
  assert.equal(restored.materials[0].overallScale, 1.5);
  assert.equal(restored.materials[0].overallOffsetX, 100);
  assert.equal(restored.materials[0].overallOffsetY, 50);
});

test('overall center follows R130 PoseRecord group moves and BodyStyle DrawOffset', () => {
  const asset = makeAsset('Cloth', 'PoseDress', { DynamicGroupName: 'DynamicCloth', Layer: [{ Name: 'Base', Priority: 1, HasImage: true, LockLayer: false, DrawingWidth: 100, DrawingHeight: 80, DrawingLeft: { Kneel: 10 }, DrawingTop: { Kneel: 20 } }] });
  const player = { AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', DrawPose: ['Kneel'], Appearance: [], AppearanceLayers: [], ExtensionSettings: {} };
  const { api } = load({ assets: [asset], player, globals: {
    PoseRecord: { Kneel: { MovePosition: [{ Group: 'Other', X: 99, Y: 99 }, { Group: 'DynamicCloth', X: 7, Y: 9 }] } },
    CanvasUpperOverflow: 11,
    InventoryGet: () => ({ Asset: { DrawOffset: [{ Group: 'DynamicCloth', Asset: 'PoseDress', Layer: ['Base'], X: 3, Y: 4 }] } }),
  } });
  const composition = api.normalizeComposition({ materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'PoseDress' }], layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'PoseDress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 5, offsetY: -5, opacity: 1 }] });
  const center = api.computeDefaultOverallCenter(composition, player);
  assert.equal(center.x, 75);
  assert.equal(center.y, 79);
});

test('local-only geometry changes do not schedule a redundant character refresh', () => {
  let refreshes = 0;
  const player = { AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [], AppearanceLayers: [], ExtensionSettings: {} };
  const { api } = load({ player, globals: { CharacterRefresh() { refreshes++; } } });
  api.cacheOverallLayerGeometry({
    __coeGeometryCharacter: player, __coeGeometryMaterialId: 'local', __coeGeometryLayerKey: '0:0', Rotation: 0.2,
  }, 0, 0, 0, 100, 100, 550);
  assert.equal(refreshes, 0);
  api.cacheOverallLayerGeometry({
    __coeGeometryCharacter: player, __coeGeometryMaterialId: 'overall', __coeGeometryLayerKey: '0:0', OverallRotation: 0.2,
  }, 0, 0, 0, 100, 100, 550);
  assert.equal(refreshes, 1);
});

test('live editor transforms reuse refs, visual proxies and one lightweight frame refresh', () => {
  const asset = makeAsset();
  const composition = { materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', colors: [] }], layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1 }] };
  let queuedFrame;
  let frameRequests = 0;
  let canvasBuilds = 0;
  let canvasLoads = 0;
  let fullRefreshes = 0;
  const env = load({ assets: [asset], globals: {
    requestAnimationFrame(callback) { frameRequests++; queuedFrame = callback; return 1; },
    CharacterAppearanceBuildCanvas() { canvasBuilds++; },
    CharacterLoadCanvas() { canvasLoads++; },
    CharacterRefresh() { fullRefreshes++; },
  } });
  env.api.setEditingForTest(composition);
  const first = env.api.buildLocalSyntheticItems(env.player);
  const second = env.api.buildLocalSyntheticItems(env.player);
  assert.equal(first[0].drawable[0].ref, composition.layers[0]);
  assert.equal(first[0].item.Asset, second[0].item.Asset);

  const hooks = {};
  env.api.installHooksForTest({ hookFunction(name, _priority, fn) { hooks[name] = fn; } });
  env.player.AppearanceLayers = hooks.CharacterAppearanceSortLayers([env.player], () => []);
  composition.layers[0].rotation = 0.4;
  env.api.requestCharacterRefresh(env.player, 'visual');
  env.api.requestCharacterRefresh(env.player, 'visual');
  assert.equal(frameRequests, 1);
  queuedFrame();
  assert.equal(canvasBuilds, 1);
  assert.equal(canvasLoads, 0);
  assert.equal(fullRefreshes, 0);
});

test('neutral material transforms skip default center traversal and preview serialization', () => {
  const asset = makeAsset();
  const composition = { materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', colors: [] }], layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1 }] };
  let coordinateCalls = 0;
  let encoderCalls = 0;
  class CountingEncoder {
    encode(text) { encoderCalls++; return Buffer.from(text); }
  }
  const env = load({ assets: [asset], globals: {
    TextEncoder: CountingEncoder,
    CommonDrawComputeDrawingCoordinates() { coordinateCalls++; return { X: 0, Y: 0 }; },
  } });
  env.api.setEditingForTest(composition);
  const neutral = env.api.resolveRenderableOverallTransform(composition, env.player, composition.materials[0]);
  assert.equal(neutral.rotation, 0);
  assert.equal(coordinateCalls, 0);
  composition.materials[0].overallRotation = 0.4;
  const pending = env.api.resolveRenderableOverallTransform(composition, env.player, composition.materials[0]);
  assert.equal(pending.rotation, 0);
  assert.equal(pending.pendingCenter, true);
  assert.equal(coordinateCalls, 1);
  delete composition.materials[0].overallRotation;
  env.api.buildLocalSyntheticItems(env.player);
  assert.equal(encoderCalls, 1);
});

test('materials sharing one source asset keep distinct CommonDraw identities', () => {
  const asset = makeAsset();
  const composition = {
    materials: [
      { id: 'red', sourceGroup: 'Cloth', sourceAsset: 'Dress', colors: ['#ff0000'] },
      { id: 'blue', sourceGroup: 'Cloth', sourceAsset: 'Dress', colors: ['#0000ff'] },
    ],
    layers: [
      { materialId: 'red', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1 },
      { materialId: 'blue', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 2, offsetX: 0, offsetY: 0, opacity: 1 },
    ],
  };
  const env = load({ assets: [asset] });
  env.api.setEditingForTest(composition);
  const groups = env.api.buildLocalSyntheticItems(env.player);
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0].item.Asset, groups[1].item.Asset);
  assert.equal(groups[0].item.Color[0], '#ff0000');
  assert.equal(groups[1].item.Color[0], '#0000ff');
});

test('closing the editor preserves queued remote character refreshes', () => {
  let queuedFrame;
  const refreshed = [];
  const remote = { MemberNumber: 7 };
  const env = load({ characters: [remote], globals: {
    requestAnimationFrame(callback) { queuedFrame = callback; return 1; },
    cancelAnimationFrame() { throw new Error('shared remote frame must remain queued'); },
    CharacterRefresh(character) { refreshed.push(character); },
  } });
  env.api.setEditingForTest({ materials: [], layers: [] });
  env.api.requestCharacterRefresh(env.player, 'visual');
  env.api.requestCharacterRefresh(remote, 'full');
  env.api.closeUI();
  queuedFrame();
  assert.deepEqual(refreshed, [remote]);
});

test('stale editor refs fall back to a structural canvas rebuild', () => {
  const asset = makeAsset();
  const composition = { materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', colors: [] }], layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1 }] };
  let queuedFrame;
  let canvasBuilds = 0;
  let canvasLoads = 0;
  const env = load({ assets: [asset], globals: {
    requestAnimationFrame(callback) { queuedFrame = callback; return 1; },
    CharacterAppearanceBuildCanvas() { canvasBuilds++; },
    CharacterLoadCanvas() { canvasLoads++; },
  } });
  env.api.setEditingForTest(composition);
  const hooks = {};
  env.api.installHooksForTest({ hookFunction(name, _priority, fn) { hooks[name] = fn; } });
  env.player.AppearanceLayers = hooks.CharacterAppearanceSortLayers([env.player], () => []);
  composition.layers = composition.layers.map(layer => ({ ...layer, rotation: 0.2 }));
  env.api.requestCharacterRefresh(env.player, 'visual');
  queuedFrame();
  assert.equal(canvasBuilds, 0);
  assert.equal(canvasLoads, 1);
});

test('GLDrawImage hook runs after image URL normalization and leaves ordinary no-transform layers on the original path', () => {
  let textureLoads = 0;
  let originalDraws = 0;
  const env = load({ globals: {
    GLDrawImage() {}, m4: {},
    GLDrawLoadImage() { textureLoads++; return { width: 100, height: 80 }; },
  } });
  const hooks = {};
  env.api.installHooksForTest({ hookFunction(name, priority, fn) { hooks[name] = { priority, fn }; } });

  assert.equal(hooks.GLDrawImage.priority, -1);
  const gl = { canvas: { height: 550 } };
  const result = hooks.GLDrawImage.fn([
    '@nomap/Assets/Female3DCG/Eyes/Eyes5.png', gl, 0, 0, {}, 0,
  ], () => { originalDraws++; return 'drawn'; });

  assert.equal(result, 'drawn');
  assert.equal(originalDraws, 1);
  assert.equal(textureLoads, 0);
});

test('GLDrawImage hook receives a normalized @nomap path before synthetic geometry texture lookup', () => {
  const loadedUrls = [];
  const env = load({ globals: {
    GLDrawImage() {}, m4: {},
    GLDrawLoadImage(_gl, url) { loadedUrls.push(url); return { width: 100, height: 80 }; },
  } });
  const hooks = {};
  env.api.installHooksForTest({ hookFunction(name, priority, fn) { hooks[name] = { priority, fn }; } });

  const imageMappingNoMapHook = {
    priority: 0,
    fn(args, next) {
      if (typeof args[0] === 'string' && args[0].startsWith('@nomap/')) args[0] = args[0].substring(7);
      return next(args);
    },
  };
  const chain = [imageMappingNoMapHook, hooks.GLDrawImage].sort((a, b) => b.priority - a.priority);
  const invoke = (index, args) => index < chain.length
    ? chain[index].fn(args, nextArgs => invoke(index + 1, nextArgs))
    : 'drawn';
  const gl = { canvas: { height: 550 } };
  const result = invoke(0, [
    '@nomap/Assets/Female3DCG/Cloth/Dress.png', gl, 0, 0, {
      __coeGeometryCharacter: env.player,
      __coeGeometryMaterialId: 'm',
      __coeGeometryLayerKey: '0:0',
    }, 0,
  ]);

  assert.equal(result, 'drawn');
  assert.deepEqual(loadedUrls, ['Assets/Female3DCG/Cloth/Dress.png']);
});

test('GLDrawImage transform hook retries after initialization race and recovers after overwrite', () => {
  let retry;
  const original = () => {};
  const m4 = {
    orthographic: () => ({}), translate: matrix => matrix, scale: matrix => matrix,
    zRotate: matrix => matrix, multiply: matrix => matrix, zRotation: () => ({}),
  };
  const env = load({ globals: {
    GLDrawImage: original, m4, GLDrawLoadImage: () => ({ width: 100, height: 80 }),
    setInterval: callback => { retry = callback; return 1; },
  } });
  const hooks = {};
  env.api.installHooksForTest({ hookFunction(name, _priority, fn) { hooks[name] = fn; } });
  assert.equal(env.sandbox.GLDrawImage._coeTransformWrapped, true);
  const replacement = () => {};
  env.sandbox.GLDrawImage = replacement;
  retry();
  assert.equal(env.sandbox.GLDrawImage._coeTransformWrapped, true);
  assert.equal(env.sandbox.GLDrawImage._coeTransformOriginal, undefined);
  const program = { u_matrix: {} };
  const colorMasks = [];
  let matrixDraws = 0;
  const gl = {
    COLOR_WRITEMASK: 'mask', CURRENT_PROGRAM: 'program', TRIANGLES: 'triangles', canvas: { width: 500, height: 550 },
    getParameter(value) { return value === 'mask' ? [true, true, true, true] : program; },
    colorMask(...value) { colorMasks.push(value); }, uniformMatrix4fv() {}, drawArrays() { matrixDraws++; },
    getUniformLocation() { return {}; },
  };
  hooks.GLDrawImage(['texture.png', gl, 0, 0, { OverallOffsetX: 10 }, 0], args => replacement(...args));
  assert.ok(colorMasks.some(value => value.join(',') === 'false,false,false,false'));
  assert.equal(matrixDraws, 1);
});

test('editor preview replaces a removable formal asset without recording formal-item-conflict', () => {
  const asset = makeAsset();
  const player = { AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [{ Asset: asset, Color: ['Default'], Property: {} }], AppearanceLayers: [], ExtensionSettings: {} };
  const env = load({ assets: [asset], player });
  env.api.setEditingForTest({ materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress' }], layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1 }] });
  const hooks = {};
  env.api.installHooksForTest({ hookFunction(name, _priority, fn) { hooks[name] = fn; } });
  const sorted = hooks.CharacterAppearanceSortLayers([player], () => []);
  player.AppearanceLayers = sorted;
  let previewAppearance;
  hooks.CommonDrawAppearanceBuild([player, {}], args => { previewAppearance = args[0].Appearance; });
  assert.ok(previewAppearance.some(item => item.__coeMaterialId));
  assert.equal(previewAppearance.some(item => item.Asset === asset), false);
  assert.equal(player.Appearance[0].Asset, asset);
  assert.equal(env.api.statusSnapshot().skippedMaterials.some(item => item.reason === 'formal-item-conflict'), false);
});
