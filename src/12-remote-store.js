  function createRemoteStats() {
    return { messagesSent: 0, messagesReceived: 0, messagesRejected: 0, rateLimited: 0, chunksExpired: 0, bytesSent: 0, bytesReceived: 0, remoteMaterialsSkipped: 0, publicationsAccepted: 0, cacheHits: 0, wantsSuppressed: 0, repairsSent: 0 };
  }

  function createRemoteStore() {
    const publications = new Map();
    return {
      roomGeneration: 0,
      peers: publications,
      publications,
      discoveries: new Map(),
      assemblies: new Map(),
      objectCache: new Map(),
      activeSnapshots: new Map(),
      wantedObjects: new Set(),
      announcedWants: new Set(),
      wantRetryScheduled: new Set(),
      dataMessageCounts: new Map(),
      senderBuckets: new Map(), roomBucket: null,
      timers: new Set(), diagnostics: [], stats: createRemoteStats(), totalBytes: 0,
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
    const roomOk = remoteBucketConsume(remoteStore, null, 40, 8, now);
    if (!senderOk || !roomOk) remoteStore.stats.rateLimited++;
    return senderOk && roomOk;
  }

  function remotePeerKey(memberNumber) { return Number(memberNumber); }
  function remoteObjectKey(memberNumber, hash) { return `${remotePeerKey(memberNumber)}:${hash}`; }
  function getRemotePublication(memberNumber) { return remoteStore.publications.get(remotePeerKey(memberNumber)) || null; }

  function setRemoteDiscovery(memberNumber, discovery) {
    const key = remotePeerKey(memberNumber);
    if (!remoteStore.discoveries.has(key) && remoteStore.discoveries.size >= 20) throw new Error("remote-peer-limit");
    const value = { memberNumber: key, session: discovery.session, receiving: discovery.receiving === true, encoding: discovery.encoding, seenAt: remoteNow() };
    remoteStore.discoveries.set(key, value);
    return value;
  }

  function setRemotePublication(memberNumber, state) {
    const key = remotePeerKey(memberNumber);
    if (!remoteStore.publications.has(key) && remoteStore.publications.size >= 20) throw new Error("remote-peer-limit");
    const previous = remoteStore.publications.get(key);
    if (previous?.session === state.session) {
      if (state.revision < previous.revision) throw new Error("remote-stale-revision");
      if (state.revision === previous.revision && state.hash !== previous.hash) throw new Error("remote-revision-hash-conflict");
      if (state.revision === previous.revision && (state.uncompressedBytes !== previous.uncompressedBytes || state.compressedBytes !== previous.compressedBytes || state.count !== previous.count)) throw new Error("remote-revision-metadata-conflict");
    }
    const publication = {
      memberNumber: key, session: state.session, revision: state.revision, hash: state.hash,
      uncompressedBytes: state.uncompressedBytes, compressedBytes: state.compressedBytes,
      count: state.count, seenAt: remoteNow(),
    };
    remoteStore.publications.set(key, publication);
    const changedSession = !previous || previous.session !== publication.session;
    const changedObject = changedSession || previous.revision !== publication.revision || previous.hash !== publication.hash;
    if (changedObject) {
      const active = remoteStore.activeSnapshots.get(key);
      if (active && active.hash !== publication.hash) remoteStore.activeSnapshots.delete(key);
      for (const assemblyKey of [...remoteStore.assemblies.keys()]) if (assemblyKey.startsWith(`${key}:`)) remoteStore.assemblies.delete(assemblyKey);
      for (const wanted of [...remoteStore.wantedObjects]) if (wanted.startsWith(`${key}:`)) remoteStore.wantedObjects.delete(wanted);
    }
    return { publication, changedSession, changedObject };
  }

  function publicationMatchesEnvelope(memberNumber, envelope) {
    const publication = getRemotePublication(memberNumber);
    return !!publication && publication.session === envelope.s && publication.revision === envelope.r && publication.hash === envelope.h && publication.count === envelope.n;
  }

  function markRemoteObjectWanted(memberNumber, hash) {
    const key = remoteObjectKey(memberNumber, hash);
    remoteStore.wantedObjects.add(key);
    return key;
  }

  function noteRemoteWantAnnouncement(memberNumber, hash) {
    const key = remoteObjectKey(memberNumber, hash);
    const existed = remoteStore.announcedWants.has(key);
    remoteStore.announcedWants.add(key);
    if (existed) remoteStore.stats.wantsSuppressed++;
    return !existed;
  }

  function hasRemoteObject(hash) { return remoteStore.objectCache.has(hash); }

  function addRemoteDataChunk(memberNumber, envelope, now = remoteNow()) {
    const member = remotePeerKey(memberNumber);
    if (!publicationMatchesEnvelope(member, envelope)) throw new Error("remote-unsolicited-data");
    const publication = getRemotePublication(member);
    const key = remoteObjectKey(member, envelope.h);
    let assembly = remoteStore.assemblies.get(key);
    if (!assembly) {
      if (remoteStore.assemblies.size >= 8) throw new Error("remote-assembly-room-limit");
      assembly = {
        memberNumber: member, session: envelope.s, revision: envelope.r, hash: envelope.h,
        count: envelope.n, compressedBytes: publication.compressedBytes,
        parts: new Map(), encodedChars: 0, startedAt: now, lastProgressAt: now,
        generation: remoteStore.roomGeneration, repairAttempts: 0,
      };
      remoteStore.assemblies.set(key, assembly);
    }
    if (assembly.session !== envelope.s || assembly.revision !== envelope.r || assembly.count !== envelope.n) {
      remoteStore.assemblies.delete(key);
      throw new Error("remote-assembly-conflict");
    }
    const existing = assembly.parts.get(envelope.i);
    if (existing != null) {
      if (existing === envelope.d) return { status: "duplicate", charged: 0, assembly };
      remoteStore.assemblies.delete(key);
      throw new Error("remote-chunk-conflict");
    }
    assembly.parts.set(envelope.i, envelope.d);
    assembly.encodedChars += envelope.d.length;
    assembly.lastProgressAt = now;
    if (assembly.encodedChars > Math.ceil(REMOTE_LIMITS.compressedBytes * 4 / 3) + 4) {
      remoteStore.assemblies.delete(key);
      throw new Error("remote-assembly-budget");
    }
    if (assembly.parts.size !== assembly.count) return { status: "partial", charged: envelope.d.length, assembly };
    const encoded = Array.from({ length: assembly.count }, (_, index) => assembly.parts.get(index)).join("");
    remoteStore.assemblies.delete(key);
    return { status: "complete", charged: envelope.d.length, encoded, assembly };
  }

  function missingRemoteDataIndexes(memberNumber, hash) {
    const assembly = remoteStore.assemblies.get(remoteObjectKey(memberNumber, hash));
    if (!assembly) return [];
    return Array.from({ length: assembly.count }, (_, index) => index).filter(index => !assembly.parts.has(index));
  }

  function expireRemoteAssemblies(now = remoteNow()) {
    let expired = 0;
    for (const [key, assembly] of remoteStore.assemblies) {
      if (now - assembly.lastProgressAt > 30000) {
        remoteStore.assemblies.delete(key);
        expired++;
      }
    }
    remoteStore.stats.chunksExpired += expired;
    return expired;
  }

  function cacheRemoteObject(hash, snapshot, canonical) {
    const bytes = utf8Bytes(canonical);
    const previous = remoteStore.objectCache.get(hash);
    const nextTotal = remoteStore.totalBytes - (previous?.bytes || 0) + bytes;
    if (nextTotal > 262144) throw new Error("remote-room-byte-budget");
    const object = { hash, snapshot, canonical, bytes, acceptedAt: remoteNow() };
    remoteStore.objectCache.set(hash, object);
    remoteStore.totalBytes = nextTotal;
    return object;
  }

  function activateRemoteObject(memberNumber, publication, object) {
    const key = remotePeerKey(memberNumber);
    remoteStore.activeSnapshots.set(key, {
      identity: `${remoteStore.roomGeneration}:${key}:${publication.session}`,
      session: publication.session, revision: publication.revision, hash: publication.hash,
      snapshot: object.snapshot, canonical: object.canonical, bytes: object.bytes, acceptedAt: remoteNow(),
    });
    remoteStore.wantedObjects.delete(remoteObjectKey(key, publication.hash));
    remoteStore.stats.publicationsAccepted++;
    return object.snapshot;
  }

  function activateCachedRemoteObject(memberNumber, publication) {
    const object = remoteStore.objectCache.get(publication.hash);
    if (!object) return null;
    remoteStore.stats.cacheHits++;
    return activateRemoteObject(memberNumber, publication, object);
  }

  function acceptRemoteSnapshot(memberNumber, publication, snapshot, canonical) {
    const object = cacheRemoteObject(publication.hash, snapshot, canonical);
    return activateRemoteObject(memberNumber, publication, object);
  }

  function revokeRemotePublication(memberNumber, session, revision = null) {
    const key = remotePeerKey(memberNumber);
    const publication = getRemotePublication(key);
    if (publication && publication.session !== session) throw new Error("remote-revoke-session");
    if (publication && revision != null && revision < publication.revision) return false;
    remoteStore.publications.delete(key);
    remoteStore.activeSnapshots.delete(key);
    for (const assemblyKey of [...remoteStore.assemblies.keys()]) if (assemblyKey.startsWith(`${key}:`)) remoteStore.assemblies.delete(assemblyKey);
    for (const wanted of [...remoteStore.wantedObjects]) if (wanted.startsWith(`${key}:`)) remoteStore.wantedObjects.delete(wanted);
    syntheticByCharacter = new WeakMap();
    return true;
  }

  function clearRemoteMember(memberNumber) {
    const key = remotePeerKey(memberNumber);
    remoteStore.publications.delete(key);
    remoteStore.discoveries.delete(key);
    remoteStore.activeSnapshots.delete(key);
    remoteStore.senderBuckets.delete(key);
    for (const collection of [remoteStore.assemblies, remoteStore.dataMessageCounts]) {
      for (const objectKey of [...collection.keys()]) if (objectKey.startsWith(`${key}:`)) collection.delete(objectKey);
    }
    for (const collection of [remoteStore.wantedObjects, remoteStore.announcedWants, remoteStore.wantRetryScheduled]) {
      for (const objectKey of [...collection]) if (objectKey.startsWith(`${key}:`)) collection.delete(objectKey);
    }
    syntheticByCharacter = new WeakMap();
  }

  function remoteSnapshotForCharacter(character) {
    const memberNumber = Number(character?.MemberNumber);
    if (!Number.isInteger(memberNumber)) return null;
    return remoteStore.activeSnapshots.get(memberNumber)?.snapshot || null;
  }
