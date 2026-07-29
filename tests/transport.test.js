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

test('self broadcast reflection is ignored', () => {
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

test('snapshot transport sends the first eight chunks synchronously without timer pacing', () => {
  const { api, sent } = load();
  const chunks = Array.from({ length: 8 }, (_, index) => `part${index}`);
  api.enqueueRemoteSnapshotBatch({ requestId: 'request_A', session: 'session_A', revision: 1, hash: 'hash_A' }, chunks, 7);
  assert.equal(sent.length, 8);
  const envelopes = sent.map(entry => api.parseRemoteContent(entry.packet.Content));
  assert.deepEqual(envelopes.map(entry => entry.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(envelopes.every(entry => entry.t === 'CHUNK' && entry.count === 8));
});

test('large snapshot transport schedules one later burst instead of one timer per chunk', () => {
  const timers = [];
  let nextTimer = 0;
  const env = load({ globals: {
    setTimeout(fn, delay) { const timer = { id: ++nextTimer, fn, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
  } });
  const chunks = Array.from({ length: 9 }, (_, index) => `part${index}`);
  env.api.enqueueRemoteSnapshotBatch({ requestId: 'request_A', session: 'session_A', revision: 1, hash: 'hash_A' }, chunks, 7);
  assert.equal(env.sent.length, 8);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 250);
  timers[0].fn();
  assert.equal(env.sent.length, 9);
  assert.equal(env.api.parseRemoteContent(env.sent[8].packet.Content).index, 8);
});

test('control message preempts a delayed snapshot burst', () => {
  const timers = [];
  const env = load({ globals: {
    setTimeout(fn, delay) { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
  } });
  const chunks = Array.from({ length: 9 }, (_, index) => `part${index}`);
  env.api.enqueueRemoteSnapshotBatch({ requestId: 'request_A', session: 'session_A', revision: 1, hash: 'hash_A' }, chunks, 7);
  env.api.enqueueRemoteEnvelope({ t: 'CLEAR', s: 'session_A' }, 7);
  assert.equal(timers[0].cleared, true);
  assert.deepEqual(env.sent.slice(8).map(entry => env.api.parseRemoteContent(entry.packet.Content).t), ['CLEAR', 'CHUNK']);
});

test('a solicited snapshot has a dedicated chunk budget independent of control rate', () => {
  const { api } = load();
  const request = { requestId: 'request_A', session: 'session_A', revision: 1, hash: 'hash_A' };
  api.setPendingRequest(7, request);
  for (let index = 0; index < 36; index++) {
    assert.equal(api.acceptRequestedRemoteChunk(7, { t: 'CHUNK', ...request, index: 0, count: 1, data: 'a' }), true);
  }
  assert.equal(api.acceptRequestedRemoteChunk(7, { t: 'CHUNK', ...request, index: 0, count: 1, data: 'a' }), false);
});

test('REQUEST uses cached chunks and sends a small snapshot in one synchronous burst', async () => {
  const sender = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const env = load({ characters: [sender] });
  const canonical = env.api.canonicalRemoteSnapshot(snapshot());
  const hash = await env.api.sha256Base64Url(canonical);
  env.api.setRemotePrefsForTest({ sharingEnabled: true, receivingEnabled: true });
  env.api.setLocalRemoteStateForTest({ session: 'session_A', revision: 1, hash, canonical, snapshot: snapshot() });
  await env.api.handleRemoteEnvelope(sender, { t: 'REQUEST', requestId: 'request_A', session: 'session_A', revision: 1, hash }, env.api.getRemoteStoreForTest().roomGeneration);
  const cached = env.api.getLocalRemoteStateForTest().chunks;
  assert.equal(env.sent.length, cached.length);
  assert.ok(env.sent.length > 0 && env.sent.length <= 8);
  assert.ok(env.sent.every(entry => env.api.parseRemoteContent(entry.packet.Content).t === 'CHUNK'));
});

test('member join announces cached STATE immediately without a random timer', () => {
  const env = load();
  const hooks = {};
  env.api.setLocalRemoteStateForTest({ session: 'session_A', revision: 0, hash: '', canonical: '', snapshot: { v: 1, m: [], l: [] } });
  env.api.installAllHooksForTest({ hookFunction(name, _priority, fn) { hooks[name] = fn; } });
  hooks.ChatRoomSyncMemberJoin([{ SourceMemberNumber: 7 }], () => undefined);
  assert.equal(env.sent.length, 1);
  const envelope = env.api.parseRemoteContent(env.sent[0].packet.Content);
  assert.equal(envelope.t, 'STATE');
  assert.equal(env.sent[0].packet.Target, 7);
});
