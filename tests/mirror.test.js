const test = require('node:test');
const assert = require('node:assert/strict');
const { load, makeAsset } = require('./helpers');

function mirroredComposition(asset = makeAsset()) {
  return {
    materials: [{
      id: 'm', sourceGroup: asset.Group.Name, sourceAsset: asset.Name, colors: [],
      overallRotation: 0.2, overallScale: 1.25, overallMirrorX: true, overallMirrorY: true,
    }],
    layers: [{
      materialId: 'm', sourceGroup: asset.Group.Name, sourceAsset: asset.Name,
      sourceLayer: 'Base', sourceLayerIndex: 0, priority: 10,
      offsetX: 0, offsetY: 0, opacity: 1,
      rotation: 0.4, scale: 1.5, mirrorX: true, mirrorY: true,
    }],
  };
}

test('mirror fields normalize and survive compact storage only when enabled', () => {
  const asset = makeAsset();
  const { api } = load({ assets: [asset] });
  const compact = api.compactCompositionForStorage(mirroredComposition(asset));
  assert.equal(compact.version, 6);
  assert.equal(compact.materials[0].overallMirrorX, true);
  assert.equal(compact.materials[0].overallMirrorY, true);
  assert.equal(compact.layers[0].mirrorX, true);
  assert.equal(compact.layers[0].mirrorY, true);

  const restored = api.normalizeComposition(compact);
  assert.equal(restored.materials[0].overallMirrorX, true);
  assert.equal(restored.materials[0].overallMirrorY, true);
  assert.equal(restored.layers[0].mirrorX, true);
  assert.equal(restored.layers[0].mirrorY, true);

  const neutral = api.compactCompositionForStorage({
    materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', overallMirrorX: false, overallMirrorY: 'yes' }],
    layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 10, offsetX: 0, offsetY: 0, opacity: 1, mirrorX: false, mirrorY: 1 }],
  });
  assert.equal(Object.hasOwn(neutral.materials[0], 'overallMirrorX'), false);
  assert.equal(Object.hasOwn(neutral.materials[0], 'overallMirrorY'), false);
  assert.equal(Object.hasOwn(neutral.layers[0], 'mirrorX'), false);
  assert.equal(Object.hasOwn(neutral.layers[0], 'mirrorY'), false);
});

test('in-place material mirrors keep the pivot fixed and reflect layer centers around it', () => {
  const { api } = load();
  const pivot = api.transformPointAroundOverallPivotAxes(250, 275, 250, 275, 0, -1, 1, 12, -8);
  assert.equal(pivot.x, 262);
  assert.equal(pivot.y, 267);
  const horizontal = api.transformPointAroundOverallPivotAxes(180, 300, 250, 275, 0, -1, 1);
  assert.equal(horizontal.x, 320);
  assert.equal(horizontal.y, 300);
  const vertical = api.transformPointAroundOverallPivotAxes(180, 300, 250, 275, 0, 1, -1);
  assert.equal(vertical.x, 180);
  assert.equal(vertical.y, 250);
});

test('synthetic layer properties carry local and material mirror levels separately', () => {
  const asset = makeAsset();
  const { api, player } = load({ assets: [asset] });
  api.setEditingForTest(mirroredComposition(asset));
  const groups = api.buildLocalSyntheticItems(player);
  assert.equal(groups.length, 1);
  const property = groups[0].item.Property;
  assert.equal(property.MirrorX, true);
  assert.equal(property.MirrorY, true);
  // The authoritative material center is learned at draw time, so overall
  // mirrors intentionally wait for the geometry cache before becoming visible.
  assert.equal(property.OverallMirrorX, undefined);
  assert.equal(property.OverallMirrorY, undefined);
});

test('local remote snapshots preserve both mirror levels with strict booleans', () => {
  const asset = makeAsset();
  const { api } = load({ assets: [asset] });
  api.setActiveCompositionForTest(mirroredComposition(asset));
  const snapshot = api.buildLocalRemoteSnapshot();
  assert.equal(snapshot.m[0].h, true);
  assert.equal(snapshot.m[0].v, true);
  assert.equal(snapshot.l[0].h, true);
  assert.equal(snapshot.l[0].v, true);
  assert.deepEqual(api.validateRemoteSnapshot(snapshot), snapshot);
  assert.throws(() => api.validateRemoteSnapshot({ ...snapshot, m: [{ ...snapshot.m[0], h: 1 }] }), /snapshot-material-h/);
  assert.throws(() => api.validateRemoteSnapshot({ ...snapshot, l: [{ ...snapshot.l[0], v: 'true' }] }), /snapshot-layer-v/);
});

test('render callbacks expose local and material in-place mirror options after center resolution', () => {
  const asset = makeAsset();
  const remote = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const value = { v: 1, m: [{ g: 'Cloth', a: 'Dress', c: [], h: true, v: true }], l: [{ m: 0, n: 'Base', i: 0, p: 10, x: 0, y: 0, o: 1, h: true, v: true }] };
  const { api } = load({ assets: [asset], characters: [remote] });
  const canonical = api.canonicalRemoteSnapshot(value);
  const publication = api.setRemotePublication(7, { session: 'session_7', revision: 1, hash: 'hash_A', uncompressedBytes: canonical.length, compressedBytes: 1, count: 1 }).publication;
  api.acceptRemoteSnapshot(7, publication, value, canonical);
  api.setRemotePrefsForTest({ receivingEnabled: true });
  api.cacheOverallLayerGeometry({
    __coeGeometryCharacter: remote,
    __coeGeometryMaterialId: 'remote:7:0',
    __coeGeometryLayerKey: '0:0',
  }, 0, 0, 0, 100, 80, 550);

  const hooks = {};
  api.installHooksForTest({ hookFunction(name, _priority, fn) { hooks[name] = fn; } });
  remote.AppearanceLayers = hooks.CharacterAppearanceSortLayers([remote], () => []);
  const seen = [];
  const callbacks = { clearRect() {}, clearRectBlink() {}, drawCanvas() {}, drawCanvasBlink() {}, drawImage(_src, _x, _y, options) { seen.push(options); }, drawImageBlink() {}, drawImageColorize() {}, drawImageColorizeBlink() {} };
  hooks.CommonDrawAppearanceBuild([remote, callbacks], args => {
    for (const layer of remote.AppearanceLayers) args[1].drawImage('Assets/Female3DCG/Cloth/Dress/Dress_Base.png', 0, 0, {});
  });
  assert.equal(seen[0].MirrorX, true);
  assert.equal(seen[0].MirrorY, true);
  assert.equal(seen[0].OverallMirrorX, true);
  assert.equal(seen[0].OverallMirrorY, true);
});

test('GL transform keeps material and layer mirror scales as separate matrix stages', () => {
  const scaleCalls = [];
  const m4 = {
    orthographic: () => ({}),
    translate: matrix => matrix,
    scale(matrix, x, y) { scaleCalls.push([x, y]); return matrix; },
    zRotate: matrix => matrix,
    multiply: matrix => matrix,
    zRotation: () => ({}),
  };
  const { api } = load({ globals: {
    GLDrawImage() {}, m4,
    GLDrawLoadImage: () => ({ width: 100, height: 80 }),
  } });
  const hooks = {};
  api.installHooksForTest({ hookFunction(name, _priority, fn) { hooks[name] = fn; } });
  const program = { u_matrix: {} };
  const gl = {
    COLOR_WRITEMASK: 'mask', CURRENT_PROGRAM: 'program', TRIANGLES: 'triangles', canvas: { width: 500, height: 550 },
    getParameter(value) { return value === 'mask' ? [true, true, true, true] : program; },
    colorMask() {}, uniformMatrix4fv() {}, drawArrays() {}, getUniformLocation() { return {}; },
  };
  hooks.GLDrawImage(['texture.png', gl, 0, 0, {
    MirrorX: true, MirrorY: false, OverallMirrorX: false, OverallMirrorY: true,
    OverallCenterX: 50, OverallCenterY: 40,
  }, 0], () => {});
  assert.deepEqual(scaleCalls.slice(0, 2), [[1, -1], [-1, 1]]);
  assert.deepEqual(scaleCalls.at(-1), [100, 80]);
});
