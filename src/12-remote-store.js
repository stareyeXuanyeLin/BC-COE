  function createRemoteStats() {
    return { messagesSent: 0, messagesReceived: 0, messagesRejected: 0, rateLimited: 0, chunksExpired: 0, bytesSent: 0, bytesReceived: 0, remoteMaterialsSkipped: 0 };
  }

  function createRemoteStore() {
    return {
      roomGeneration: 0,
      peers: new Map(), pendingRequests: new Map(), assemblies: new Map(), activeSnapshots: new Map(),
      senderBuckets: new Map(), roomBucket: null, responseTimes: new Map(), requestTimes: new Map(),
      helloReplied: new Set(), timers: new Set(), diagnostics: [], stats: createRemoteStats(), totalBytes: 0,
    };
  }

  let remoteStore = createRemoteStore();

  function remoteNow() { return Date.now(); }

  function scheduleRemoteTimer(callback, delay) {
    let timer = 0;
    timer = setTimeout(() => {
      remoteStore.timers.delete(timer);
      callback();
    }, delay);
    remoteStore.timers.add(timer);
    // Node test timers support unref; browser timer ids simply ignore this.
    timer?.unref?.();
    return timer;
  }

  function remoteDiagnostic(kind, sender = null, detail = null) {
    remoteStore.diagnostics.push({ at: remoteNow(), kind: String(kind).slice(0, 40), sender: Number.isInteger(sender) ? sender : null, detail: detail == null ? null : String(detail).slice(0, 120) });
    if (remoteStore.diagnostics.length > 100) remoteStore.diagnostics.splice(0, remoteStore.diagnostics.length - 100);
  }

  function resetRemoteRoom() {
    for (const timer of remoteStore.timers) clearTimeout(timer);
    const nextGeneration = remoteStore.roomGeneration + 1;
    remoteStore = createRemoteStore();
    remoteStore.roomGeneration = nextGeneration;
    syntheticByCharacter = new WeakMap();
    return nextGeneration;
  }

  function remoteBucketConsume(holder, key, capacity, refillPerSecond, now = remoteNow()) {
    let bucket = key == null ? holder.roomBucket : holder.senderBuckets.get(key);
    if (!bucket) bucket = { tokens: capacity, at: now };
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.at) * refillPerSecond / 1000);
    bucket.at = now;
    const accepted = bucket.tokens >= 1;
    if (accepted) bucket.tokens -= 1;
    if (key == null) holder.roomBucket = bucket;
    else holder.senderBuckets.set(key, bucket);
    return accepted;
  }

  function acceptRemoteInboundRate(sender, now = remoteNow()) {
    const senderOk = remoteBucketConsume(remoteStore, sender, 12, 2, now);
    const roomOk = remoteBucketConsume(remoteStore, null, 30, 5, now);
    if (!senderOk || !roomOk) remoteStore.stats.rateLimited++;
    return senderOk && roomOk;
  }

  function remotePeerKey(memberNumber) { return Number(memberNumber); }

  function getRemotePeer(memberNumber) { return remoteStore.peers.get(remotePeerKey(memberNumber)) || null; }

  function setRemotePeer(memberNumber, state) {
    const key = remotePeerKey(memberNumber);
    if (!remoteStore.peers.has(key) && remoteStore.peers.size >= 10) throw new Error("remote-peer-limit");
    const previous = remoteStore.peers.get(key);
    if (previous?.session === state.session) {
      if (state.revision < previous.revision) throw new Error("remote-stale-revision");
      if (state.revision === previous.revision && previous.sharing && state.sharing && state.hash !== previous.hash) throw new Error("remote-revision-hash-conflict");
    }
    const peer = { memberNumber: key, session: state.session, revision: state.revision, hash: state.hash, size: state.size, sharing: state.sharing === true, seenAt: remoteNow() };
    remoteStore.peers.set(key, peer);
    return { peer, isNewSession: !previous || previous.session !== peer.session };
  }

  function remoteIdentity(memberNumber, session) { return `${remoteStore.roomGeneration}:${memberNumber}:${session}`; }

  function pendingRequestFor(memberNumber) { return remoteStore.pendingRequests.get(remotePeerKey(memberNumber)) || null; }

  function setPendingRequest(memberNumber, request) {
    remoteStore.pendingRequests.set(remotePeerKey(memberNumber), { ...request, createdAt: remoteNow(), retries: request.retries || 0, generation: remoteStore.roomGeneration });
  }

  function clearPendingRequest(memberNumber, requestId = null) {
    const key = remotePeerKey(memberNumber);
    const pending = remoteStore.pendingRequests.get(key);
    if (pending && (requestId == null || pending.requestId === requestId)) remoteStore.pendingRequests.delete(key);
  }

  function assemblyKey(memberNumber) { return remotePeerKey(memberNumber); }

  function addRemoteChunk(memberNumber, envelope, now = remoteNow()) {
    const key = assemblyKey(memberNumber);
    const pending = pendingRequestFor(key);
    if (!pending || pending.generation !== remoteStore.roomGeneration || pending.requestId !== envelope.requestId || pending.session !== envelope.session || pending.revision !== envelope.revision || pending.hash !== envelope.hash) throw new Error("remote-unsolicited-chunk");
    let assembly = remoteStore.assemblies.get(key);
    if (!assembly) {
      if (remoteStore.assemblies.size >= 4) throw new Error("remote-assembly-room-limit");
      assembly = { requestId: envelope.requestId, session: envelope.session, revision: envelope.revision, hash: envelope.hash, count: envelope.count, parts: new Map(), encodedBytes: 0, startedAt: now, generation: remoteStore.roomGeneration };
      remoteStore.assemblies.set(key, assembly);
      const generation = remoteStore.roomGeneration;
      const requestId = envelope.requestId;
      scheduleRemoteTimer(() => {
        if (generation !== remoteStore.roomGeneration) return;
        const current = remoteStore.assemblies.get(key);
        if (current?.requestId === requestId && remoteNow() - current.startedAt >= 20000) {
          remoteStore.assemblies.delete(key);
          remoteStore.stats.chunksExpired++;
        }
      }, 20000);
    }
    if (assembly.requestId !== envelope.requestId || assembly.count !== envelope.count || assembly.hash !== envelope.hash) {
      remoteStore.assemblies.delete(key);
      throw new Error("remote-assembly-conflict");
    }
    if (envelope.index >= assembly.count) throw new Error("remote-chunk-index");
    const existing = assembly.parts.get(envelope.index);
    if (existing != null) {
      if (existing === envelope.data) return { status: "duplicate", charged: 0 };
      remoteStore.assemblies.delete(key);
      throw new Error("remote-chunk-conflict");
    }
    assembly.parts.set(envelope.index, envelope.data);
    assembly.encodedBytes += envelope.data.length;
    if (assembly.encodedBytes > REMOTE_LIMITS.chunks * REMOTE_LIMITS.chunkData) {
      remoteStore.assemblies.delete(key);
      throw new Error("remote-assembly-budget");
    }
    if (assembly.parts.size !== assembly.count) return { status: "partial", charged: envelope.data.length };
    const encoded = Array.from({ length: assembly.count }, (_, index) => assembly.parts.get(index)).join("");
    remoteStore.assemblies.delete(key);
    return { status: "complete", charged: envelope.data.length, encoded };
  }

  function expireRemoteAssemblies(now = remoteNow()) {
    let expired = 0;
    for (const [key, assembly] of remoteStore.assemblies) {
      if (now - assembly.startedAt > 20000) {
        remoteStore.assemblies.delete(key);
        expired++;
      }
    }
    remoteStore.stats.chunksExpired += expired;
    return expired;
  }

  function acceptRemoteSnapshot(memberNumber, identity, snapshot, canonical) {
    const key = remotePeerKey(memberNumber);
    const bytes = utf8Bytes(canonical);
    const previous = remoteStore.activeSnapshots.get(key);
    const nextTotal = remoteStore.totalBytes - (previous?.bytes || 0) + bytes;
    if (nextTotal > 262144) throw new Error("remote-room-byte-budget");
    const pending = pendingRequestFor(key);
    remoteStore.activeSnapshots.set(key, { identity, session: pending?.session || null, revision: pending?.revision ?? null, hash: pending?.hash || null, snapshot, canonical, bytes, acceptedAt: remoteNow() });
    remoteStore.totalBytes = nextTotal;
    clearPendingRequest(key);
    return snapshot;
  }

  function clearRemoteMember(memberNumber) {
    const key = remotePeerKey(memberNumber);
    const previous = remoteStore.activeSnapshots.get(key);
    if (previous) remoteStore.totalBytes -= previous.bytes;
    remoteStore.peers.delete(key);
    remoteStore.pendingRequests.delete(key);
    remoteStore.assemblies.delete(key);
    remoteStore.activeSnapshots.delete(key);
    remoteStore.senderBuckets.delete(key);
    remoteStore.responseTimes.delete(key);
    remoteStore.requestTimes.delete(key);
    for (const identity of remoteStore.helloReplied) if (identity.includes(`:${key}:`)) remoteStore.helloReplied.delete(identity);
    syntheticByCharacter = new WeakMap();
  }

  function remoteSnapshotForCharacter(character) {
    const memberNumber = Number(character?.MemberNumber);
    if (!Number.isInteger(memberNumber)) return null;
    return remoteStore.activeSnapshots.get(memberNumber)?.snapshot || null;
  }
