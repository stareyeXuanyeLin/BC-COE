const test = require('node:test');
const assert = require('node:assert/strict');
const { load, snapshot } = require('./helpers');

function publication(api, member = 7, hash = 'hash_A', count = 2) {
  return api.setRemotePublication(member, {
    session: 'session_A', revision: 1, hash,
    uncompressedBytes: 100, compressedBytes: 6, count,
  }).publication;
}

function chunk(index, data, count = 2, hash = 'hash_A') {
  return { t: 'X', s: 'session_A', r: 1, h: hash, i: index, n: count, d: data };
}

test('publication data reassembles out of order and ignores identical duplicates', () => {
  const { api } = load();
  publication(api);
  assert.equal(api.addRemoteDataChunk(7, chunk(1, 'BBB')).status, 'partial');
  const duplicate = api.addRemoteDataChunk(7, chunk(1, 'BBB'));
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.charged, 0);
  const complete = api.addRemoteDataChunk(7, chunk(0, 'AAA'));
  assert.equal(complete.status, 'complete');
  assert.equal(complete.encoded, 'AAABBB');
});

test('conflicting publication data discards only that object assembly', () => {
  const { api } = load();
  publication(api);
  api.addRemoteDataChunk(7, chunk(0, 'AAA'));
  assert.throws(() => api.addRemoteDataChunk(7, chunk(0, 'XXX')), /chunk-conflict/);
  assert.equal(api.getRemoteStoreForTest().assemblies.size, 0);
});

test('data without a matching advertisement is rejected and stale assemblies expire', () => {
  const { api } = load();
  assert.throws(() => api.addRemoteDataChunk(7, chunk(0, 'AAA')), /unsolicited/);
  publication(api);
  api.addRemoteDataChunk(7, chunk(0, 'AAA'), 1000);
  assert.deepEqual(Array.from(api.missingRemoteDataIndexes(7, 'hash_A')), [1]);
  assert.equal(api.expireRemoteAssemblies(32001), 1);
  assert.equal(api.getRemoteStoreForTest().stats.chunksExpired, 1);
});

test('members remain isolated and generation reset invalidates room publications', () => {
  const { api } = load();
  publication(api, 7, 'hash_A', 1);
  api.setRemotePublication(8, { session: 'session_B', revision: 1, hash: 'hash_B', uncompressedBytes: 10, compressedBytes: 5, count: 1 });
  assert.equal(api.getRemoteStoreForTest().publications.size, 2);
  api.clearRemoteMember(7);
  assert.equal(api.getRemoteStoreForTest().publications.has(7), false);
  assert.equal(api.getRemoteStoreForTest().publications.has(8), true);
  const generation = api.getRemoteStoreForTest().roomGeneration;
  api.resetRemoteRoomForTest();
  assert.equal(api.getRemoteStoreForTest().roomGeneration, generation + 1);
  assert.equal(api.getRemoteStoreForTest().publications.size, 0);
});

test('verified objects are cached by hash and can activate another publication without reassembly', () => {
  const { api } = load();
  const canonical = api.canonicalRemoteSnapshot(snapshot());
  const first = publication(api, 7, 'shared_hash', 1);
  api.acceptRemoteSnapshot(7, first, snapshot(), canonical);
  const second = api.setRemotePublication(8, { session: 'session_B', revision: 1, hash: 'shared_hash', uncompressedBytes: canonical.length, compressedBytes: 5, count: 1 }).publication;
  assert.ok(api.activateCachedRemoteObject(8, second));
  assert.equal(api.getRemoteStoreForTest().objectCache.size, 1);
  assert.equal(api.getRemoteStoreForTest().activeSnapshots.size, 2);
});
