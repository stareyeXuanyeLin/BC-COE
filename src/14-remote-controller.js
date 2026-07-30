  const REMOTE_PREFS_PREFIX = "BC.CustomOutfitEditor.RemotePrefs.v1";
  const REMOTE_PUBLICATION_COHORT_MS = 2000;
  let remotePrefs = { sharingEnabled: false, receivingEnabled: false };
  let localPeerSessionId = "";
  let localRemoteRevision = 0;
  let localRemoteHash = "";
  let localRemoteCanonical = "";
  let localRemoteEncoded = "";
  let localRemoteCompressedBytes = 0;
  let localRemoteChunks = [];
  let localRemoteSnapshot = null;
  let localRemoteBuildToken = 0;
  let localRemoteStateTimer = 0;
  let localRemoteBuildInFlight = null;
  let localRemoteDirty = true;
  let localRemotePreviouslyShared = false;
  let remoteRoomSyncing = false;
  let localPublicationFlights = new Map();

  function remoteRandomId(bytes = 12) {
    const data = new Uint8Array(bytes);
    if (!globalThis.crypto?.getRandomValues) throw new Error("crypto-random-unavailable");
    crypto.getRandomValues(data);
    return bytesToBase64Url(data);
  }

  function remotePrefsKey() {
    const accountId = globalThis.Player?.MemberNumber ?? globalThis.Player?.AccountName ?? "anonymous";
    return `${REMOTE_PREFS_PREFIX}.${accountId}`;
  }

  function loadRemotePrefs() {
    try {
      const value = JSON.parse(localStorage.getItem(remotePrefsKey()) || "null");
      remotePrefs = { sharingEnabled: value?.sharingEnabled === true, receivingEnabled: value?.receivingEnabled === true };
    } catch (_) { remotePrefs = { sharingEnabled: false, receivingEnabled: false }; }
    return { ...remotePrefs };
  }

  function saveRemotePrefs() {
    try { localStorage.setItem(remotePrefsKey(), JSON.stringify({ sharingEnabled: remotePrefs.sharingEnabled === true, receivingEnabled: remotePrefs.receivingEnabled === true })); } catch (_) { /* privacy mode */ }
  }

  function clearActiveRemotePublications() {
    const members = [...remoteStore.activeSnapshots.keys()];
    remoteStore.activeSnapshots.clear();
    remoteStore.assemblies.clear();
    remoteStore.wantedObjects.clear();
    remoteStore.announcedWants.clear();
    remoteStore.wantRetryScheduled.clear();
    syntheticByCharacter = new WeakMap();
    for (const memberNumber of members) {
      const character = remoteRoomMember(memberNumber);
      if (character) CharacterRefresh(character, false, false);
    }
  }

  function setRemotePrefs(next) {
    const previous = remotePrefs;
    remotePrefs = { sharingEnabled: next.sharingEnabled === true, receivingEnabled: next.receivingEnabled === true };
    saveRemotePrefs();
    if (!remotePrefs.receivingEnabled && previous.receivingEnabled) clearActiveRemotePublications();
    if (remotePrefs.receivingEnabled && !previous.receivingEnabled) sendRemoteDiscover();
    if (!remotePrefs.sharingEnabled && previous.sharingEnabled) sendRemoteRevoke();
    scheduleLocalRemoteBuild(true);
    return { ...remotePrefs };
  }

  function buildLocalRemoteSnapshot() {
    if (!activeComposition) return { v: 1, m: [], l: [] };
    const composition = normalizeComposition(activeComposition);
    const visibleMaterials = [];
    const layers = [];
    for (const material of composition.materials) {
      if (material.hidden || (material.wearGroup && !isTagEquipped(globalThis.Player, material.wearGroup))) continue;
      const refs = composition.layers.filter(ref => ref.materialId === material.id && !ref.hidden);
      if (!refs.length) continue;
      const index = visibleMaterials.length;
      const compact = { g: material.sourceGroup, a: material.sourceAsset, c: sanitizeColorArray(material.colors) };
      if (material.wearGroup) compact.w = material.wearGroup;
      if (typeof material.overallRotation === "number") compact.r = material.overallRotation;
      if (typeof material.overallScale === "number") compact.s = material.overallScale;
      if (typeof material.overallOffsetX === "number") compact.x = material.overallOffsetX;
      if (typeof material.overallOffsetY === "number") compact.y = material.overallOffsetY;
      if (material.overallMirrorX === true) compact.h = true;
      if (material.overallMirrorY === true) compact.v = true;
      const property = sanitizeSourceProperty(material.sourceProperty);
      if (Object.keys(property).length) compact.p = property;
      visibleMaterials.push(compact);
      for (const ref of refs) {
        const layer = { m: index, n: ref.sourceLayer == null ? null : ref.sourceLayer, i: Number.isInteger(ref.sourceLayerIndex) ? ref.sourceLayerIndex : 0, p: ref.priority, x: ref.offsetX, y: ref.offsetY, o: ref.opacity };
        if (typeof ref.rotation === "number" && ref.rotation !== 0) layer.r = ref.rotation;
        if (typeof ref.scale === "number" && Math.abs(ref.scale - 1) > 0.001) layer.s = ref.scale;
        if (ref.mirrorX === true) layer.h = true;
        if (ref.mirrorY === true) layer.v = true;
        layers.push(layer);
      }
    }
    return validateRemoteSnapshot({ v: 1, m: visibleMaterials, l: layers });
  }

  function cancelLocalRemoteBuildTimer() {
    if (!localRemoteStateTimer) return;
    clearTimeout(localRemoteStateTimer);
    remoteStore.timers.delete(localRemoteStateTimer);
    localRemoteStateTimer = 0;
  }

  function recordLocalRemoteBuildFailure(error) {
    remoteDiagnostic("local-build-failed", null, error?.message || error);
    if (localRemotePreviouslyShared) sendRemoteRevoke();
  }

  function scheduleLocalRemoteBuild(forcePublication = false) {
    cancelLocalRemoteBuildTimer();
    localRemoteDirty = true;
    const generation = remoteStore.roomGeneration;
    const token = ++localRemoteBuildToken;
    localRemoteStateTimer = scheduleRemoteTimer(() => {
      localRemoteStateTimer = 0;
      const record = { generation, token, promise: null };
      record.promise = updateLocalRemoteSnapshot(generation, token, forcePublication).catch(error => {
        recordLocalRemoteBuildFailure(error);
        return false;
      }).finally(() => {
        if (localRemoteBuildInFlight === record) localRemoteBuildInFlight = null;
      });
      localRemoteBuildInFlight = record;
    }, 500);
  }

  function ensureFreshLocalRemoteSnapshot(generation) {
    if (generation !== remoteStore.roomGeneration) return Promise.resolve(false);
    if (!localRemoteDirty && localRemoteSnapshot !== null) return Promise.resolve(true);
    if (localRemoteBuildInFlight && localRemoteBuildInFlight.generation === generation && localRemoteBuildInFlight.token === localRemoteBuildToken) return localRemoteBuildInFlight.promise;
    const token = localRemoteStateTimer ? localRemoteBuildToken : ++localRemoteBuildToken;
    cancelLocalRemoteBuildTimer();
    const record = { generation, token, promise: null };
    record.promise = updateLocalRemoteSnapshot(generation, token, false, true).catch(error => {
      recordLocalRemoteBuildFailure(error);
      return false;
    }).finally(() => {
      if (localRemoteBuildInFlight === record) localRemoteBuildInFlight = null;
    });
    localRemoteBuildInFlight = record;
    return record.promise;
  }

  function currentRemoteAdvertiseEnvelope(includeInline = true) {
    if (!localRemoteHash || !localRemoteCanonical || !localRemoteChunks.length) return null;
    const envelope = {
      t: "A", s: localPeerSessionId, r: localRemoteRevision, h: localRemoteHash,
      u: utf8Bytes(localRemoteCanonical), z: localRemoteCompressedBytes, n: localRemoteChunks.length,
    };
    if (includeInline && localRemoteChunks.length === 1 && localRemoteEncoded.length <= REMOTE_LIMITS.inlineData) envelope.d = localRemoteEncoded;
    return envelope;
  }

  function sendRemoteDiscover() {
    if (!localPeerSessionId) return false;
    return enqueueRemoteEnvelope({ t: "D", s: localPeerSessionId, rx: remotePrefs.receivingEnabled, e: REMOTE_ENCODING });
  }

  function sendRemoteRevoke() {
    if (!localPeerSessionId) return false;
    localRemotePreviouslyShared = false;
    localPublicationFlights.clear();
    return enqueueRemoteEnvelope({ t: "R", s: localPeerSessionId, r: localRemoteRevision });
  }

  function sendLocalRemoteAdvertisement(target = null) {
    if (!remotePrefs.sharingEnabled) return false;
    const envelope = currentRemoteAdvertiseEnvelope(true);
    if (!envelope) return false;
    localRemotePreviouslyShared = true;
    return enqueueRemoteEnvelope(envelope, target);
  }

  function announceLocalRemotePublication(target = null, generation = remoteStore.roomGeneration) {
    if (generation !== remoteStore.roomGeneration) return Promise.resolve(false);
    if (!localRemoteDirty && localRemoteSnapshot !== null) return Promise.resolve(sendLocalRemoteAdvertisement(target));
    return ensureFreshLocalRemoteSnapshot(generation).then(updated => updated ? sendLocalRemoteAdvertisement(target) : false);
  }

  async function updateLocalRemoteSnapshot(generation = remoteStore.roomGeneration, token = ++localRemoteBuildToken, forcePublication = false, suppressPublication = false) {
    let snapshot;
    try { snapshot = buildLocalRemoteSnapshot(); }
    catch (error) {
      toast(`远端共享已暂停：${error.message}`, "warn");
      throw error;
    }
    const canonical = canonicalRemoteSnapshot(snapshot);
    let encoded = "";
    let compressedBytes = 0;
    let chunks = [];
    let hash = "";
    if (snapshot.l.length) {
      const compressed = await encodeRemoteText(canonical);
      encoded = compressed.encoded;
      compressedBytes = compressed.compressedBytes;
      chunks = splitRemoteData(encoded);
      hash = await sha256Base64Url(canonical);
    }
    if (generation !== remoteStore.roomGeneration || token !== localRemoteBuildToken) return false;
    const changed = hash !== localRemoteHash;
    if (changed) localRemoteRevision++;
    localRemoteSnapshot = snapshot;
    localRemoteCanonical = canonical;
    localRemoteEncoded = encoded;
    localRemoteCompressedBytes = compressedBytes;
    localRemoteChunks = chunks;
    localRemoteHash = hash;
    localRemoteDirty = false;
    if (changed) localPublicationFlights.clear();
    if (suppressPublication) return true;
    if (!snapshot.l.length) {
      if (localRemotePreviouslyShared) sendRemoteRevoke();
      return true;
    }
    if (remotePrefs.sharingEnabled && (changed || forcePublication)) sendLocalRemoteAdvertisement();
    return true;
  }

  function sendLocalRemoteData(target = null, indexes = null) {
    if (!remotePrefs.sharingEnabled || !localRemoteHash || !localRemoteChunks.length) return 0;
    return enqueueRemoteDataBatch({ s: localPeerSessionId, r: localRemoteRevision, h: localRemoteHash }, localRemoteChunks, target, indexes);
  }

  function respondToRemoteWant(requester, envelope) {
    if (envelope.o !== Number(globalThis.Player?.MemberNumber) || envelope.s !== localPeerSessionId || envelope.r !== localRemoteRevision || envelope.h !== localRemoteHash) return false;
    if (!remotePrefs.sharingEnabled || !localRemoteChunks.length) return false;
    const now = remoteNow();
    const previous = localPublicationFlights.get(envelope.h);
    if (!previous) {
      localPublicationFlights.set(envelope.h, { broadcastAt: now });
      sendLocalRemoteData();
      return true;
    }
    if (now - previous.broadcastAt <= REMOTE_PUBLICATION_COHORT_MS) return true;
    sendLocalRemoteData(Number(requester.MemberNumber));
    return true;
  }

  async function decodeAndAcceptRemotePublication(sender, publication, encoded, generation) {
    const canonical = await decodeRemoteText(encoded, publication.compressedBytes);
    if (generation !== remoteStore.roomGeneration) return false;
    if (utf8Bytes(canonical) !== publication.uncompressedBytes) throw new Error("remote-uncompressed-size");
    let parsed;
    try { parsed = JSON.parse(canonical); } catch (_) { throw new Error("snapshot-json"); }
    const snapshot = validateRemoteSnapshot(parsed);
    const normalizedCanonical = JSON.stringify(snapshot);
    if (normalizedCanonical !== canonical) throw new Error("snapshot-not-canonical");
    const hash = await sha256Base64Url(canonical);
    if (generation !== remoteStore.roomGeneration) return false;
    const current = getRemotePublication(sender.MemberNumber);
    if (!current || current.session !== publication.session || current.revision !== publication.revision || current.hash !== hash) throw new Error("snapshot-hash");
    acceptRemoteSnapshot(sender.MemberNumber, current, snapshot, canonical);
    clearRemoteDataBudget(sender.MemberNumber, hash);
    syntheticByCharacter = new WeakMap();
    CharacterRefresh(sender, false, false);
    return true;
  }

  function scheduleRemoteWantRetry(senderNumber, publication, generation) {
    const key = remoteObjectKey(senderNumber, publication.hash);
    if (remoteStore.wantRetryScheduled.has(key)) return;
    remoteStore.wantRetryScheduled.add(key);
    scheduleRemoteTimer(() => {
      remoteStore.wantRetryScheduled.delete(key);
      if (generation !== remoteStore.roomGeneration || !remotePrefs.receivingEnabled) return;
      const current = getRemotePublication(senderNumber);
      const active = remoteStore.activeSnapshots.get(senderNumber);
      if (!current || current.session !== publication.session || current.revision !== publication.revision || current.hash !== publication.hash) return;
      if (active?.hash === publication.hash || remoteStore.assemblies.has(key)) return;
      enqueueRemoteEnvelope({ t: "W", o: senderNumber, s: publication.session, r: publication.revision, h: publication.hash });
    }, 12000);
  }

  function scheduleRemoteAssemblyRepair(senderNumber, publication, generation) {
    const key = remoteObjectKey(senderNumber, publication.hash);
    const assembly = remoteStore.assemblies.get(key);
    if (!assembly || assembly.repairTimer) return;
    assembly.repairTimer = scheduleRemoteTimer(() => {
      if (generation !== remoteStore.roomGeneration) return;
      const current = remoteStore.assemblies.get(key);
      if (!current || current.repairAttempts >= 1) return;
      const missing = missingRemoteDataIndexes(senderNumber, publication.hash);
      if (!missing.length) return;
      current.repairAttempts++;
      enqueueRemoteEnvelope({ t: "N", o: senderNumber, s: publication.session, r: publication.revision, h: publication.hash, m: missing });
    }, 12000);
  }

  async function handleRemoteEnvelope(sender, envelope, generation) {
    if (generation !== remoteStore.roomGeneration) return;
    const memberNumber = Number(sender.MemberNumber);
    if (envelope.t === "D") {
      setRemoteDiscovery(memberNumber, { session: envelope.s, receiving: envelope.rx, encoding: envelope.e });
      if (envelope.rx) await announceLocalRemotePublication(memberNumber, generation);
      return;
    }
    if (envelope.t === "R") {
      if (revokeRemotePublication(memberNumber, envelope.s, envelope.r)) CharacterRefresh(sender, false, false);
      return;
    }
    if (envelope.t === "A") {
      const hadActive = remoteStore.activeSnapshots.has(memberNumber);
      const result = setRemotePublication(memberNumber, {
        session: envelope.s, revision: envelope.r, hash: envelope.h,
        uncompressedBytes: envelope.u, compressedBytes: envelope.z, count: envelope.n,
      });
      const publication = result.publication;
      if (!remotePrefs.receivingEnabled) return;
      if (activateCachedRemoteObject(memberNumber, publication)) {
        syntheticByCharacter = new WeakMap();
        CharacterRefresh(sender, false, false);
        return;
      }
      if (result.changedObject && hadActive) {
        syntheticByCharacter = new WeakMap();
        CharacterRefresh(sender, false, false);
      }
      markRemoteObjectWanted(memberNumber, publication.hash);
      if (envelope.d != null) {
        await decodeAndAcceptRemotePublication(sender, publication, envelope.d, generation);
        return;
      }
      if (noteRemoteWantAnnouncement(memberNumber, publication.hash)) {
        enqueueRemoteEnvelope({ t: "W", o: memberNumber, s: publication.session, r: publication.revision, h: publication.hash });
      }
      scheduleRemoteWantRetry(memberNumber, publication, generation);
      return;
    }
    if (envelope.t === "W") {
      if (envelope.o === Number(globalThis.Player?.MemberNumber)) {
        respondToRemoteWant(sender, envelope);
        return;
      }
      const publication = getRemotePublication(envelope.o);
      if (publication && publication.session === envelope.s && publication.revision === envelope.r && publication.hash === envelope.h) {
        markRemoteObjectWanted(envelope.o, envelope.h);
        noteRemoteWantAnnouncement(envelope.o, envelope.h);
        scheduleRemoteWantRetry(envelope.o, publication, generation);
      }
      return;
    }
    if (envelope.t === "N") {
      if (envelope.o !== Number(globalThis.Player?.MemberNumber) || envelope.s !== localPeerSessionId || envelope.r !== localRemoteRevision || envelope.h !== localRemoteHash) return;
      if (!remotePrefs.sharingEnabled) return;
      const sent = sendLocalRemoteData(null, envelope.m);
      if (sent) remoteStore.stats.repairsSent += sent;
      return;
    }
    const publication = getRemotePublication(memberNumber);
    if (!publication || !remotePrefs.receivingEnabled) return;
    const assembled = addRemoteDataChunk(memberNumber, envelope);
    if (assembled.status === "partial") {
      scheduleRemoteAssemblyRepair(memberNumber, publication, generation);
      return;
    }
    if (assembled.status !== "complete") return;
    await decodeAndAcceptRemotePublication(sender, publication, assembled.encoded, generation);
  }

  function installRemoteLifecycleHooks() {
    modApi.hookFunction("ChatRoomSync", 1000, (args, next) => {
      ensureRemoteMessageHandler();
      cancelRemoteTransport();
      resetRemoteRoom();
      localPublicationFlights = new Map();
      remoteRoomSyncing = true;
      const generation = remoteStore.roomGeneration;
      let result;
      try { result = next(args); }
      catch (error) { remoteRoomSyncing = false; throw error; }
      Promise.resolve(result).then(async () => {
        remoteRoomSyncing = false;
        if (generation !== remoteStore.roomGeneration) return;
        sendRemoteDiscover();
        await announceLocalRemotePublication(null, generation);
      }).catch(() => { remoteRoomSyncing = false; });
      return result;
    });
    modApi.hookFunction("ChatRoomSyncMemberJoin", 1000, (args, next) => next(args));
    modApi.hookFunction("ChatRoomSyncMemberLeave", 1000, (args, next) => {
      const memberNumber = Number(args[0]?.SourceMemberNumber ?? args[0]?.MemberNumber ?? args[0]);
      const result = next(args);
      if (Number.isInteger(memberNumber)) clearRemoteMember(memberNumber);
      return result;
    });
    modApi.hookFunction("ChatRoomLeave", 1000, (args, next) => { cancelRemoteTransport(); resetRemoteRoom(); localPublicationFlights = new Map(); return next(args); });
    modApi.hookFunction("ServerDisconnect", 1000, (args, next) => {
      captureSetReconnectIntent();
      invalidateSetPreviewCache();
      cancelRemoteTransport();
      resetRemoteRoom();
      localPublicationFlights = new Map();
      return next(args);
    });
    modApi.hookFunction("CharacterLoadOnline", 1000, (args, next) => {
      const result = next(args);
      invalidateSetPreviewCache();
      syntheticByCharacter = new WeakMap();
      if (result === globalThis.Player) scheduleSetReconnectRestore();
      return result;
    });
    modApi.hookFunction("CharacterRefresh", 1000, (args, next) => {
      const result = next(args);
      if (args[0] === globalThis.Player && activeComposition) scheduleLocalRemoteBuild();
      return result;
    });
  }

  function initializeRemoteController() {
    loadRemotePrefs();
    localPeerSessionId = remoteRandomId(12);
    localRemoteRevision = 0;
    localRemoteHash = "";
    localRemoteCanonical = "";
    localRemoteEncoded = "";
    localRemoteCompressedBytes = 0;
    localRemoteChunks = [];
    localRemoteSnapshot = null;
    localRemoteBuildInFlight = null;
    localRemoteDirty = true;
    remoteRoomSyncing = false;
    localPublicationFlights = new Map();
    const messageHandlerReady = ensureRemoteMessageHandler();
    scheduleLocalRemoteBuild(true);
    return messageHandlerReady;
  }
