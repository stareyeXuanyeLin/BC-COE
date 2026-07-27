const test = require('node:test');
const assert = require('node:assert/strict');
const { load, snapshot } = require('./helpers');

function state(api, overrides = {}) {
  return api.serializeRemoteEnvelope({ t: 'STATE', s: 'remote_session', r: 1, h: 'remote_hash', z: 100, sharing: true, ...overrides });
}

test('Hidden handler validates the real sender and internally consumes damaged protocol messages', () => {
  const sender = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const { api } = load({ characters: [sender] });
  assert.equal(api.onRemoteMessage({ Type: 'Hidden', Sender: 9, Content: state(api) }), true);
  assert.equal(api.getRemoteStoreForTest().peers.size, 0);
  assert.equal(api.onRemoteMessage({ Type: 'Hidden', Sender: 7, Content: 'COE_RVS/4|{' }), true);
  assert.equal(api.getRemoteStoreForTest().stats.messagesRejected, 2);
  assert.equal(api.onRemoteMessage({ Type: 'Chat', Sender: 7, Content: 'hello' }), false);
});

test('self broadcast echo is ignored', () => {
  const player = { AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [], AppearanceLayers: [], ExtensionSettings: {} };
  const { api } = load({ player, characters: [player] });
  assert.equal(api.onRemoteMessage({ Type: 'Hidden', Sender: 1, Content: state(api) }), true);
  assert.equal(api.getRemoteStoreForTest().stats.messagesReceived, 0);
});

test('STATE hello reply occurs once and does not ping-pong', () => {
  const sender = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const env = load({ characters: [sender] });
  env.api.setLocalRemoteStateForTest({ session: 'local_session', revision: 0, hash: '', canonical: '', snapshot: null });
  env.api.onRemoteMessage({ Type: 'Hidden', Sender: 7, Content: state(env.api) });
  const first = env.sent.length;
  env.api.onRemoteMessage({ Type: 'Hidden', Sender: 7, Content: state(env.api) });
  assert.equal(first, 1);
  assert.equal(env.sent.length, first);
});

test('matching requested CHUNK sequence is validated, hashed and accepted', async () => {
  const sender = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const { api } = load({ characters: [sender] });
  const canonical = api.canonicalRemoteSnapshot(snapshot());
  const hash = await api.sha256Base64Url(canonical);
  const request = { requestId: 'request_A', session: 'session_A', revision: 1, hash };
  api.setPendingRequest(7, request);
  const chunks = api.splitRemoteData(api.encodeRemoteText(canonical));
  for (let index = 0; index < chunks.length; index++) {
    await api.handleRemoteEnvelope(sender, { t: 'CHUNK', ...request, index, count: chunks.length, data: chunks[index] }, api.getRemoteStoreForTest().roomGeneration);
  }
  const accepted = api.getRemoteStoreForTest().activeSnapshots.get(7);
  assert.equal(accepted.hash, hash);
  assert.equal(accepted.snapshot.l.length, 1);
  assert.equal(api.pendingRequestFor(7), null);
});

test('CLEAR only removes the matching sender state', async () => {
  const a = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const b = { MemberNumber: 8, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const { api } = load({ characters: [a, b] });
  api.setRemotePeer(7, { session: 'session_A', revision: 1, hash: 'hash_A', size: 1, sharing: true });
  api.setRemotePeer(8, { session: 'session_B', revision: 1, hash: 'hash_B', size: 1, sharing: true });
  await api.handleRemoteEnvelope(a, { t: 'CLEAR', s: 'session_A' }, api.getRemoteStoreForTest().roomGeneration);
  assert.equal(api.getRemoteStoreForTest().peers.has(8), true);
  assert.equal(api.getRemoteStoreForTest().peers.has(7), true);
  assert.equal(api.getRemoteStoreForTest().activeSnapshots.has(7), false);
});
