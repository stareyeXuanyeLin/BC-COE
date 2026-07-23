const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');

function chunk(requestId, index, data, count = 2) {
  return { t: 'CHUNK', requestId, session: 'session_A', revision: 1, hash: 'hash_A', index, count, data };
}

function pending(api, member = 7, requestId = 'request_A') {
  api.setPendingRequest(member, { requestId, session: 'session_A', revision: 1, hash: 'hash_A' });
}

test('out-of-order chunks reassemble and duplicate chunks are not charged twice', () => {
  const { api } = load();
  pending(api);
  assert.equal(api.addRemoteChunk(7, chunk('request_A', 1, 'BBB')).status, 'partial');
  const duplicate = api.addRemoteChunk(7, chunk('request_A', 1, 'BBB'));
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.charged, 0);
  const complete = api.addRemoteChunk(7, chunk('request_A', 0, 'AAA'));
  assert.equal(complete.status, 'complete');
  assert.equal(complete.encoded, 'AAABBB');
});

test('conflicting duplicate discards the whole assembly', () => {
  const { api } = load();
  pending(api);
  api.addRemoteChunk(7, chunk('request_A', 0, 'AAA'));
  assert.throws(() => api.addRemoteChunk(7, chunk('request_A', 0, 'XXX')), /chunk-conflict/);
  assert.equal(api.getRemoteStoreForTest().assemblies.size, 0);
});

test('unsolicited chunks are rejected and assemblies expire', () => {
  const { api } = load();
  assert.throws(() => api.addRemoteChunk(7, chunk('request_A', 0, 'AAA')), /unsolicited/);
  pending(api);
  api.addRemoteChunk(7, chunk('request_A', 0, 'AAA'), 1000);
  assert.equal(api.expireRemoteAssemblies(22000), 1);
  assert.equal(api.getRemoteStoreForTest().stats.chunksExpired, 1);
});

test('members remain isolated and generation reset invalidates all room state', () => {
  const { api } = load();
  api.setRemotePeer(7, { session: 'session_A', revision: 1, hash: 'hash_A', size: 10, sharing: true });
  api.setRemotePeer(8, { session: 'session_B', revision: 1, hash: 'hash_B', size: 10, sharing: true });
  assert.equal(api.getRemoteStoreForTest().peers.size, 2);
  api.clearRemoteMember(7);
  assert.equal(api.getRemoteStoreForTest().peers.has(7), false);
  assert.equal(api.getRemoteStoreForTest().peers.has(8), true);
  const generation = api.getRemoteStoreForTest().roomGeneration;
  api.resetRemoteRoomForTest();
  assert.equal(api.getRemoteStoreForTest().roomGeneration, generation + 1);
  assert.equal(api.getRemoteStoreForTest().peers.size, 0);
});
