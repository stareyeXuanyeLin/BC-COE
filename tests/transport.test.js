const test = require('node:test');
const assert = require('node:assert/strict');
const { load, snapshot, makeAsset } = require('./helpers');

async function payload(api, value = snapshot()) {
  const canonical = api.canonicalRemoteSnapshot(value);
  const hash = await api.sha256Base64Url(canonical);
  const compressed = await api.encodeRemoteText(canonical);
  const chunks = api.splitRemoteData(compressed.encoded);
  return { value, canonical, hash, encoded: compressed.encoded, compressedBytes: compressed.compressedBytes, chunks };
}

function advertise(data, overrides = {}) {
  return { t: 'A', s: 'session_A', r: 1, h: data.hash, u: Buffer.byteLength(data.canonical), z: data.compressedBytes, n: data.chunks.length, ...overrides };
}

test('remote message handler registration is idempotent', () => {
  let registrations = 0;
  const { api } = load({ globals: {
    ChatRoomRegisterMessageHandler(handler) {
      registrations++;
      assert.equal(typeof handler.Callback, 'function');
    },
  } });
  assert.equal(api.installRemoteMessageHandler(), true);
  assert.equal(api.installRemoteMessageHandler(), true);
  assert.equal(registrations, 1);
});

test('remote controller tolerates a late message-handler API and retries in the background', () => {
  let retryTimer = null;
  let registrations = 0;
  const env = load({ globals: {
    setInterval(fn, delay) { retryTimer = { fn, delay, cleared: false }; return retryTimer; },
    clearInterval(timer) { if (timer) timer.cleared = true; },
  } });
  assert.equal(env.api.initializeRemoteController(), false);
  assert.equal(retryTimer.delay, 1000);
  env.sandbox.ChatRoomRegisterMessageHandler = handler => { registrations++; assert.equal(typeof handler.Callback, 'function'); };
  retryTimer.fn();
  assert.equal(registrations, 1);
  assert.equal(retryTimer.cleared, true);
  assert.equal(env.api.installRemoteMessageHandler(), true);
});

test('Hidden handler validates the server sender and consumes damaged RVP messages', () => {
  const sender = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const { api } = load({ characters: [sender] });
  const discover = api.serializeRemoteEnvelope({ t: 'D', s: 'remote_session', rx: true, e: 'gz' });
  assert.equal(api.onRemoteMessage({ Type: 'Hidden', Sender: 9, Content: discover }), true);
  assert.equal(api.getRemoteStoreForTest().discoveries.size, 0);
  assert.equal(api.onRemoteMessage({ Type: 'Hidden', Sender: 7, Content: 'COE_RVP/1|{' }), true);
  assert.equal(api.getRemoteStoreForTest().stats.messagesRejected, 2);
  assert.equal(api.onRemoteMessage({ Type: 'Chat', Sender: 7, Content: 'hello' }), false);
});

test('self broadcast reflection is ignored', () => {
  const player = { AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [], AppearanceLayers: [], ExtensionSettings: {} };
  const { api } = load({ player, characters: [player] });
  const discover = api.serializeRemoteEnvelope({ t: 'D', s: 'local_session', rx: true, e: 'gz' });
  assert.equal(api.onRemoteMessage({ Type: 'Hidden', Sender: 1, Content: discover }), true);
  assert.equal(api.getRemoteStoreForTest().stats.messagesReceived, 0);
});

test('publication transport submits a complete DATA batch synchronously to BC without plugin timers', () => {
  const timers = [];
  const env = load({ globals: { setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; } } });
  const chunks = Array.from({ length: 9 }, (_, index) => `part${index}`);
  assert.equal(env.api.enqueueRemoteDataBatch({ s: 'session_A', r: 1, h: 'hash_A' }, chunks), 9);
  assert.equal(env.sent.length, 9);
  assert.equal(timers.length, 0);
  assert.ok(env.sent.every(entry => entry.packet.Target === undefined));
  assert.deepEqual(env.sent.map(entry => env.api.parseRemoteContent(entry.packet.Content).i), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('a non-inline advertisement emits one shared WANT and duplicate advertisements do not repeat it', async () => {
  const sender = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const env = load({ characters: [sender] });
  const data = await payload(env.api);
  env.api.setRemotePrefsForTest({ sharingEnabled: false, receivingEnabled: true });
  await env.api.handleRemoteEnvelope(sender, advertise(data), env.api.getRemoteStoreForTest().roomGeneration);
  await env.api.handleRemoteEnvelope(sender, advertise(data), env.api.getRemoteStoreForTest().roomGeneration);
  assert.equal(env.sent.length, 1);
  const want = env.api.parseRemoteContent(env.sent[0].packet.Content);
  assert.deepEqual({ t: want.t, o: want.o, h: want.h }, { t: 'W', o: 7, h: data.hash });
  assert.equal(env.sent[0].packet.Target, undefined);
});

test('the first WANT broadcasts one cached publication and cohort duplicates do not copy it per receiver', async () => {
  const a = { MemberNumber: 7, Appearance: [] };
  const b = { MemberNumber: 8, Appearance: [] };
  const env = load({ characters: [a, b] });
  const data = await payload(env.api);
  env.api.setRemotePrefsForTest({ sharingEnabled: true, receivingEnabled: true });
  env.api.setLocalRemoteStateForTest({ session: 'local_session', revision: 3, hash: data.hash, canonical: data.canonical, encoded: data.encoded, compressedBytes: data.compressedBytes, chunks: data.chunks, snapshot: data.value });
  const want = { t: 'W', o: 1, s: 'local_session', r: 3, h: data.hash };
  await env.api.handleRemoteEnvelope(a, want, env.api.getRemoteStoreForTest().roomGeneration);
  const afterFirst = env.sent.length;
  await env.api.handleRemoteEnvelope(b, want, env.api.getRemoteStoreForTest().roomGeneration);
  assert.equal(afterFirst, data.chunks.length);
  assert.equal(env.sent.length, afterFirst);
  assert.ok(env.sent.every(entry => entry.packet.Target === undefined));
});

test('inline ADVERTISE is decompressed, hashed, cached and activated without WANT', async () => {
  const sender = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const env = load({ characters: [sender] });
  const data = await payload(env.api);
  assert.equal(data.chunks.length, 1);
  env.api.setRemotePrefsForTest({ sharingEnabled: false, receivingEnabled: true });
  await env.api.handleRemoteEnvelope(sender, advertise(data, { d: data.encoded }), env.api.getRemoteStoreForTest().roomGeneration);
  assert.equal(env.sent.length, 0);
  assert.equal(env.api.getRemoteStoreForTest().activeSnapshots.get(7).hash, data.hash);
  assert.equal(env.api.getRemoteStoreForTest().objectCache.size, 1);
});

test('broadcast DATA accepts out-of-order chunks and activates the advertised object', async () => {
  const sender = { MemberNumber: 7, Appearance: [], AppearanceLayers: [], AssetFamily: 'Female3DCG' };
  const env = load({ characters: [sender] });
  const large = snapshot();
  large.l = Array.from({ length: 80 }, (_, index) => ({ ...large.l[0], i: index, n: `Layer${index}`, x: index * 3 }));
  const data = await payload(env.api, large);
  env.api.setRemotePrefsForTest({ sharingEnabled: false, receivingEnabled: true });
  await env.api.handleRemoteEnvelope(sender, advertise(data), env.api.getRemoteStoreForTest().roomGeneration);
  env.sent.length = 0;
  for (let index = data.chunks.length - 1; index >= 0; index--) {
    await env.api.handleRemoteEnvelope(sender, { t: 'X', s: 'session_A', r: 1, h: data.hash, i: index, n: data.chunks.length, d: data.chunks[index] }, env.api.getRemoteStoreForTest().roomGeneration);
  }
  assert.equal(env.api.getRemoteStoreForTest().activeSnapshots.get(7).hash, data.hash);
  assert.equal(env.api.getRemoteStoreForTest().activeSnapshots.get(7).snapshot.l.length, 80);
});

test('a cached object activates a later publication without emitting WANT', async () => {
  const a = { MemberNumber: 7, Appearance: [] };
  const b = { MemberNumber: 8, Appearance: [] };
  const env = load({ characters: [a, b] });
  const data = await payload(env.api);
  env.api.setRemotePrefsForTest({ sharingEnabled: false, receivingEnabled: true });
  await env.api.handleRemoteEnvelope(a, advertise(data, { d: data.encoded }), env.api.getRemoteStoreForTest().roomGeneration);
  await env.api.handleRemoteEnvelope(b, advertise(data, { s: 'session_B' }), env.api.getRemoteStoreForTest().roomGeneration);
  assert.equal(env.sent.length, 0);
  assert.equal(env.api.getRemoteStoreForTest().activeSnapshots.get(8).hash, data.hash);
  assert.equal(env.api.getRemoteStoreForTest().stats.cacheHits, 1);
});

test('REVOKE removes only the matching publisher binding', async () => {
  const a = { MemberNumber: 7, Appearance: [] };
  const b = { MemberNumber: 8, Appearance: [] };
  const env = load({ characters: [a, b] });
  env.api.setRemotePublication(7, { session: 'session_A', revision: 1, hash: 'hash_A', uncompressedBytes: 10, compressedBytes: 5, count: 1 });
  env.api.setRemotePublication(8, { session: 'session_B', revision: 1, hash: 'hash_B', uncompressedBytes: 10, compressedBytes: 5, count: 1 });
  await env.api.handleRemoteEnvelope(a, { t: 'R', s: 'session_A', r: 1 }, env.api.getRemoteStoreForTest().roomGeneration);
  assert.equal(env.api.getRemoteStoreForTest().publications.has(7), false);
  assert.equal(env.api.getRemoteStoreForTest().publications.has(8), true);
});

test('DISCOVER records capability and receives a targeted current advertisement without ping-pong', async () => {
  const sender = { MemberNumber: 7, Appearance: [] };
  const env = load({ characters: [sender] });
  const data = await payload(env.api);
  env.api.setRemotePrefsForTest({ sharingEnabled: true, receivingEnabled: true });
  env.api.setLocalRemoteStateForTest({ session: 'local_session', revision: 1, hash: data.hash, canonical: data.canonical, encoded: data.encoded, compressedBytes: data.compressedBytes, chunks: data.chunks, snapshot: data.value });
  await env.api.handleRemoteEnvelope(sender, { t: 'D', s: 'peer_session', rx: true, e: 'gz' }, env.api.getRemoteStoreForTest().roomGeneration);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].packet.Target, 7);
  assert.equal(env.api.parseRemoteContent(env.sent[0].packet.Content).t, 'A');
});

test('NACK repair broadcasts only requested cached chunk indexes', async () => {
  const sender = { MemberNumber: 7, Appearance: [] };
  const env = load({ characters: [sender] });
  const data = await payload(env.api);
  const chunks = data.chunks.length >= 3 ? data.chunks : ['a', 'b', 'c'];
  env.api.setRemotePrefsForTest({ sharingEnabled: true, receivingEnabled: true });
  env.api.setLocalRemoteStateForTest({ session: 'local_session', revision: 1, hash: data.hash, canonical: data.canonical, encoded: chunks.join(''), compressedBytes: data.compressedBytes, chunks, snapshot: data.value });
  await env.api.handleRemoteEnvelope(sender, { t: 'N', o: 1, s: 'local_session', r: 1, h: data.hash, m: [0, 2] }, env.api.getRemoteStoreForTest().roomGeneration);
  assert.deepEqual(env.sent.map(entry => env.api.parseRemoteContent(entry.packet.Content).i), [0, 2]);
  assert.equal(env.api.getRemoteStoreForTest().stats.repairsSent, 2);
});

test('published DATA has a bounded object-level allowance including one repair round', () => {
  const { api } = load();
  api.setRemotePublication(7, { session: 'session_A', revision: 1, hash: 'hash_A', uncompressedBytes: 10, compressedBytes: 5, count: 2 });
  const data = { t: 'X', s: 'session_A', r: 1, h: 'hash_A', i: 0, n: 2, d: 'a' };
  for (let index = 0; index < 8; index++) assert.equal(api.acceptPublishedRemoteData(7, data), true);
  assert.equal(api.acceptPublishedRemoteData(7, data), false);
});

test('member join creates no protocol traffic until that member sends DISCOVER', () => {
  const env = load();
  const hooks = {};
  env.api.installAllHooksForTest({ hookFunction(name, _priority, fn) { hooks[name] = fn; } });
  hooks.ChatRoomSyncMemberJoin([{ SourceMemberNumber: 7 }], () => undefined);
  assert.equal(env.sent.length, 0);
});

test('dirty local publication is rebuilt before a DISCOVER response', async () => {
  const asset = makeAsset();
  const peer = { MemberNumber: 7, Appearance: [] };
  const env = load({ assets: [asset], characters: [peer] });
  env.api.setLocalRemoteStateForTest({ session: 'local_session', revision: 0, hash: '', canonical: '', encoded: '', compressedBytes: 0, chunks: [], snapshot: { v: 1, m: [], l: [] } });
  env.api.setActiveCompositionForTest({
    version: 6,
    materials: [{ id: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', colors: ['#fff'], sourceProperty: {} }],
    layers: [{ materialId: 'm', sourceGroup: 'Cloth', sourceAsset: 'Dress', sourceLayer: 'Base', sourceLayerIndex: 0, priority: 10, offsetX: 0, offsetY: 0, opacity: 1 }],
    recycle: [],
  });
  env.api.setRemotePrefsForTest({ sharingEnabled: true, receivingEnabled: true });
  env.api.scheduleLocalRemoteBuild();
  await env.api.handleRemoteEnvelope(peer, { t: 'D', s: 'peer_session', rx: true, e: 'gz' }, env.api.getRemoteStoreForTest().roomGeneration);
  const current = env.api.getLocalRemoteStateForTest();
  assert.equal(current.dirty, false);
  assert.ok(current.hash);
  assert.equal(env.sent.length, 1);
  assert.equal(env.api.parseRemoteContent(env.sent[0].packet.Content).t, 'A');
  assert.equal(env.sent[0].packet.Target, 7);
});

test('initial room hydration emits one DISCOVER and one current advertisement, with no per-member replies', async () => {
  const env = load();
  const hooks = {};
  const data = await payload(env.api);
  env.api.setRemotePrefsForTest({ sharingEnabled: true, receivingEnabled: true });
  env.api.setLocalRemoteStateForTest({ session: 'local_session', revision: 1, hash: data.hash, canonical: data.canonical, encoded: data.encoded, compressedBytes: data.compressedBytes, chunks: data.chunks, snapshot: data.value });
  env.api.installAllHooksForTest({ hookFunction(name, _priority, fn) { hooks[name] = fn; } });
  hooks.ChatRoomSync([], args => {
    hooks.ChatRoomSyncMemberJoin([{ SourceMemberNumber: 7 }], () => undefined);
    hooks.ChatRoomSyncMemberJoin([{ SourceMemberNumber: 8 }], () => undefined);
    return args;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(env.sent.map(entry => env.api.parseRemoteContent(entry.packet.Content).t), ['D', 'A']);
  assert.ok(env.sent.every(entry => entry.packet.Target === undefined));
});
