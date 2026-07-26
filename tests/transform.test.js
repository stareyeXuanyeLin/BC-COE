const test = require('node:test');
const assert = require('node:assert/strict');
const { load, makeAsset } = require('./helpers');

test('layer pivot is optional, shared by rotation and scale, and survives storage', () => {
  const asset = makeAsset();
  const { api } = load({ assets: [asset] });
  const base = { materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress' }], layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1 }] };
  const untouched = api.compactCompositionForStorage(base);
  assert.equal(Object.hasOwn(untouched.layers[0], 'pivotX'), false);
  assert.equal(Object.hasOwn(untouched.layers[0], 'pivotY'), false);
  const custom = api.compactCompositionForStorage({ ...base, layers: [{ ...base.layers[0], pivotX: -0.25, pivotY: 1.75, rotation: 0.5, scale: 1.5 }] });
  assert.equal(custom.layers[0].pivotX, -0.25);
  assert.equal(custom.layers[0].pivotY, 1.75);
  assert.equal(api.normalizeLayerTransform({ pivotX: 'bad', pivotY: Infinity }).pivotX, undefined);
  assert.equal(api.normalizeLayerTransform({ pivotX: -99, pivotY: 99 }).pivotX, -10);
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
  const pivot = api.computeDefaultOverallPivot(api.normalizeComposition(raw), player);
  assert.equal(pivot.x, 85);
  assert.equal(pivot.y, 75);
  assert.equal(api.resolveNumericOrigin({ Default: 10, Kneel: 30 }, player), 30);
  assert.equal(api.resolveNumericOrigin({ Default: 10 }, player), 10);
  assert.equal(api.resolveNumericOrigin({ Kneel: Infinity }, player, 7), 7);
});

test('absolute pivot geometry maps CSS-scaled canvas points and inverse transforms', () => {
  const { api } = load();
  const canvas = { width: 1000, height: 600, getBoundingClientRect: () => ({ left: 10, top: 20, width: 500, height: 300 }) };
  const canvasPoint = api.canvasPointFromClient(260, 170, canvas);
  assert.equal(canvasPoint.x, 500);
  assert.equal(canvasPoint.y, 300);
  const geometry = { drawX: 100, drawY: 50, textureWidth: 200, textureHeight: 100, mirror: false, invert: false };
  const centerPivot = api.computeAbsoluteLayerPivot({ x: 200, y: 100 }, geometry, { pivotX: 0.5, pivotY: 0.5 });
  assert.equal(centerPivot.x, 0.5);
  assert.equal(centerPivot.y, 0.5);
  const rotatedPivot = api.computeAbsoluteLayerPivot({ x: 50, y: 100 }, { ...geometry, drawX: 0, drawY: 0, textureWidth: 100, textureHeight: 100 }, { pivotX: 0.5, pivotY: 0.5, rotation: Math.PI / 2, scale: 1 });
  assert.ok(Math.abs(rotatedPivot.x - 1) < 1e-9);
  assert.ok(Math.abs(rotatedPivot.y - 0.5) < 1e-9);
  const mirroredPivot = api.computeAbsoluteLayerPivot({ x: 600, y: 100 }, { ...geometry, drawX: 700, mirror: true }, { pivotX: 0.5, pivotY: 0.5 });
  assert.equal(mirroredPivot.x, 0.5);
  assert.equal(mirroredPivot.y, 0.5);
  const overallPoint = api.computeAbsoluteOverallPivot({ x: 60, y: 170 }, { pivotX: 50, pivotY: 50, rotation: Math.PI / 2, scale: 2, offsetX: 10, offsetY: 20 });
  assert.ok(Math.abs(overallPoint.x - 100) < 1e-9);
  assert.ok(Math.abs(overallPoint.y - 50) < 1e-9);
});

test('overall transform stays at composition level and defaults to the largest visible layer', () => {
  const wide = makeAsset('Cloth', 'Wide', { Width: 400, Height: 100, Layer: [{ Name: 'Base', Priority: 1, HasImage: true, LockLayer: false, DrawingWidth: 400, DrawingHeight: 100, DrawingLeft: {}, DrawingTop: {} }] });
  const small = makeAsset('Cloth', 'Small', { Width: 50, Height: 50, Layer: [{ Name: 'Base', Priority: 2, HasImage: true, LockLayer: false, DrawingWidth: 50, DrawingHeight: 50, DrawingLeft: {}, DrawingTop: {} }] });
  const { api } = load({ assets: [wide, small] });
  const composition = { materials: [{ id: 'w', sourceGroup: 'Cloth', sourceAsset: 'Wide' }, { id: 's', sourceGroup: 'Cloth', sourceAsset: 'Small' }], layers: [
    { materialId: 'w', sourceGroup: 'Cloth', sourceAsset: 'Wide', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1 },
    { materialId: 's', sourceGroup: 'Cloth', sourceAsset: 'Small', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 2, offsetX: 0, offsetY: 0, opacity: 1 },
  ], overallRotation: 0.2, layersExtra: 'discarded' };
  const normalized = api.normalizeComposition(composition);
  const defaultPivot = api.computeDefaultOverallPivot(normalized);
  assert.equal(defaultPivot.x, 200);
  assert.equal(defaultPivot.y, 50);
  assert.equal(normalized.layersExtra, undefined);
  const resolved = api.resolveOverallTransform(normalized);
  assert.equal(resolved.rotation, 0.2);
  assert.equal(resolved.scale, 1);
  assert.equal(resolved.offsetX, 0);
  assert.equal(resolved.offsetY, 0);
  assert.equal(resolved.pivotX, 200);
  assert.equal(resolved.pivotY, 50);
  assert.equal(resolved.customPivot, false);
  const compact = api.compactCompositionForStorage({ ...composition, overallPivotX: 200, overallPivotY: 50 });
  assert.equal(compact.overallPivotX, 200);
  assert.equal(compact.overallPivotY, 50);
});

test('remote snapshot carries both local and overall pivots without flattening angles', () => {
  const asset = makeAsset();
  const { api } = load({ assets: [asset] });
  api.setActiveCompositionForTest({ overallRotation: 0.2, overallScale: 1.25, overallPivotX: 42, overallPivotY: 55, materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', colors: [] }], layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1, rotation: 0.4, scale: 1.5, pivotX: 0.2, pivotY: 0.8 }] });
  const snapshot = api.buildLocalRemoteSnapshot();
  assert.equal(snapshot.or, 0.2);
  assert.equal(snapshot.os, 1.25);
  assert.equal(snapshot.px, 42);
  assert.equal(snapshot.py, 55);
  assert.equal(snapshot.l[0].r, 0.4);
  assert.equal(snapshot.l[0].s, 1.5);
  assert.equal(snapshot.l[0].px, 0.2);
  assert.equal(snapshot.l[0].py, 0.8);
  assert.deepEqual(api.validateRemoteSnapshot(snapshot), snapshot);
});

test('new remote snapshots pin the sender default overall pivot', () => {
  const asset = makeAsset('Cloth', 'Pinned', { Width: 400, Height: 100, Layer: [{ Name: 'Base', Priority: 1, HasImage: true, LockLayer: false, DrawingWidth: 400, DrawingHeight: 100, DrawingLeft: { Default: 20 }, DrawingTop: { Default: 30 } }] });
  const { api } = load({ assets: [asset] });
  api.setActiveCompositionForTest({ materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Pinned', colors: [] }], layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Pinned', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 1, offsetX: 0, offsetY: 0, opacity: 1 }] });
  const value = api.buildLocalRemoteSnapshot();
  assert.equal(value.px, 220);
  assert.equal(value.py, 80);
});

test('legacy remote snapshots without explicit pivot still use receiver fallback', () => {
  const asset = makeAsset('Cloth', 'Wide', { Width: 400, Height: 100, Layer: [{ Name: 'Base', Priority: 1, HasImage: true, LockLayer: false, DrawingWidth: 400, DrawingHeight: 100, DrawingLeft: {}, DrawingTop: {} }] });
  const remote = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const { api } = load({ assets: [asset], characters: [remote] });
  const snapshot = api.validateRemoteSnapshot({ v: 1, or: 0.2, m: [{ g: 'Cloth', a: 'Wide', c: [] }], l: [{ m: 0, n: 'Base', i: 0, p: 1, x: 0, y: 0, o: 1 }] });
  const groups = api.buildRemoteSyntheticItems(remote, snapshot);
  assert.equal(groups[0].overall.pivotX, 200);
  assert.equal(groups[0].overall.pivotY, 50);
});

test('render callbacks keep local and overall transform layers separate', () => {
  const asset = makeAsset();
  const remote = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const value = { v: 1, or: 0.2, os: 1.25, ox: 4, oy: -3, px: 42, py: 55, m: [{ g: 'Cloth', a: 'Dress', c: [] }], l: [{ m: 0, n: 'Base', i: 0, p: 1, x: 0, y: 0, o: 1, r: 0.4, s: 1.5, px: 0.2, py: 0.8 }] };
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
  assert.equal(seen[0].PivotX, 0.2);
  assert.equal(seen[0].PivotY, 0.8);
  assert.equal(seen[0].OverallRotation, 0.2);
  assert.equal(seen[0].OverallScale, 1.25);
  assert.equal(seen[0].OverallPivotX, 42);
  assert.equal(seen[0].OverallPivotY, 55);
});
