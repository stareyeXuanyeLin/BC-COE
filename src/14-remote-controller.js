  const REMOTE_PREFS_PREFIX = "BC.CustomOutfitEditor.RemotePrefs.v1";
  let remotePrefs = { sharingEnabled: false, receivingEnabled: false };
  let localPeerSessionId = "";
  let localRemoteRevision = 0;
  let localRemoteHash = "";
  let localRemoteCanonical = "";
  let localRemoteSnapshot = null;
  let localRemoteBuildToken = 0;
  let localRemoteStateTimer = 0;
  let localRemoteLastStateKey = "";
  let localRemotePreviouslyShared = false;

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

  function setRemotePrefs(next) {
    const previous = remotePrefs;
    remotePrefs = { sharingEnabled: next.sharingEnabled === true, receivingEnabled: next.receivingEnabled === true };
    saveRemotePrefs();
    if (!remotePrefs.receivingEnabled && previous.receivingEnabled) {
      for (const memberNumber of [...remoteStore.activeSnapshots.keys()]) {
        remoteStore.activeSnapshots.delete(memberNumber);
        const character = remoteRoomMember(memberNumber);
        if (character) CharacterRefresh(character, false, false);
      }
      remoteStore.pendingRequests.clear();
      remoteStore.assemblies.clear();
      remoteStore.totalBytes = 0;
      syntheticByCharacter = new WeakMap();
    } else if (remotePrefs.receivingEnabled && !previous.receivingEnabled) {
      for (const [memberNumber, peer] of remoteStore.peers) maybeRequestRemoteSnapshot(memberNumber, peer);
    }
    if (!remotePrefs.sharingEnabled && previous.sharingEnabled) sendRemoteClear();
    scheduleLocalRemoteBuild(true);
    return { ...remotePrefs };
  }

  function buildLocalRemoteSnapshot() {
    if (!activeComposition) return { v: 1, m: [], l: [] };
    const composition = normalizeComposition(activeComposition);
    const visibleMaterials = [];
    const materialIndexes = new Map();
    const layers = [];
    for (const material of composition.materials) {
      if (material.hidden || (material.wearGroup && !isTagEquipped(globalThis.Player, material.wearGroup))) continue;
      const refs = composition.layers.filter(ref => ref.materialId === material.id && !ref.hidden);
      if (!refs.length) continue;
      const index = visibleMaterials.length;
      materialIndexes.set(material.id, index);
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
        var snapshotLayer = { m: index, n: ref.sourceLayer == null ? null : ref.sourceLayer, i: Number.isInteger(ref.sourceLayerIndex) ? ref.sourceLayerIndex : 0, p: ref.priority, x: ref.offsetX, y: ref.offsetY, o: ref.opacity };
        if (typeof ref.rotation === "number" && ref.rotation !== 0) snapshotLayer.r = ref.rotation;
        if (typeof ref.scale === "number" && Math.abs(ref.scale - 1) > 0.001) snapshotLayer.s = ref.scale;
        if (ref.mirrorX === true) snapshotLayer.h = true;
        if (ref.mirrorY === true) snapshotLayer.v = true;
        layers.push(snapshotLayer);
      }
    }
    return validateRemoteSnapshot({ v: 1, m: visibleMaterials, l: layers });
  }

  function scheduleLocalRemoteBuild(forceState = false) {
    if (localRemoteStateTimer) {
      clearTimeout(localRemoteStateTimer);
      remoteStore.timers.delete(localRemoteStateTimer);
    }
    const generation = remoteStore.roomGeneration;
    const token = ++localRemoteBuildToken;
    localRemoteStateTimer = scheduleRemoteTimer(() => {
      localRemoteStateTimer = 0;
      updateLocalRemoteSnapshot(generation, token, forceState).catch(error => {
        remoteDiagnostic("local-build-failed", null, error?.message || error);
        if (localRemotePreviouslyShared) sendRemoteClear();
      });
    }, 500);
  }

  async function updateLocalRemoteSnapshot(generation = remoteStore.roomGeneration, token = ++localRemoteBuildToken, forceState = false) {
    let snapshot;
    try { snapshot = buildLocalRemoteSnapshot(); }
    catch (error) {
      toast(`远端共享已暂停：${error.message}`, "warn");
      throw error;
    }
    const canonical = canonicalRemoteSnapshot(snapshot);
    const hash = snapshot.l.length ? await sha256Base64Url(canonical) : "";
    if (generation !== remoteStore.roomGeneration || token !== localRemoteBuildToken) return false;
    const changed = hash !== localRemoteHash;
    if (changed) localRemoteRevision++;
    localRemoteSnapshot = snapshot;
    localRemoteCanonical = canonical;
    localRemoteHash = hash;
    if (!snapshot.l.length) {
      if (localRemotePreviouslyShared) sendRemoteClear();
      sendRemoteState(null, true);
      return true;
    }
    if (remotePrefs.sharingEnabled) {
      localRemotePreviouslyShared = true;
      sendRemoteState(null, forceState || changed);
    } else if (forceState) sendRemoteState(null, true);
    return true;
  }

  function currentRemoteStateEnvelope() {
    const sharing = remotePrefs.sharingEnabled && !!localRemoteHash && !!localRemoteSnapshot?.l.length;
    return { t: "STATE", s: localPeerSessionId, r: localRemoteRevision, h: sharing ? localRemoteHash : "", z: sharing ? utf8Bytes(localRemoteCanonical) : 0, sharing };
  }

  function sendRemoteState(target = null, force = false) {
    if (!localPeerSessionId) return;
    const envelope = currentRemoteStateEnvelope();
    const key = `${target ?? "*"}|${envelope.s}|${envelope.r}|${envelope.h}|${envelope.sharing}`;
    if (!force && key === localRemoteLastStateKey) return;
    if (target == null) localRemoteLastStateKey = key;
    enqueueRemoteEnvelope(envelope, target);
  }

  function sendRemoteClear() {
    if (!localPeerSessionId) return;
    enqueueRemoteEnvelope({ t: "CLEAR", s: localPeerSessionId });
    localRemotePreviouslyShared = false;
    localRemoteLastStateKey = "";
  }

  function maybeRequestRemoteSnapshot(memberNumber, peer) {
    if (!remotePrefs.receivingEnabled || !peer.sharing || !peer.hash || peer.size > REMOTE_LIMITS.snapshotBytes) return false;
    const active = remoteStore.activeSnapshots.get(memberNumber);
    if (active?.identity === remoteIdentity(memberNumber, peer.session) && active.revision === peer.revision && active.hash === peer.hash) return false;
    const pending = pendingRequestFor(memberNumber);
    if (pending && pending.session === peer.session && pending.revision === peer.revision && pending.hash === peer.hash) return false;
    const pendingIsStale = !!pending;
    if (pendingIsStale) {
      clearPendingRequest(memberNumber, pending.requestId);
      remoteStore.assemblies.delete(remotePeerKey(memberNumber));
    }
    const now = remoteNow();
    if (!pendingIsStale && now - (remoteStore.requestTimes.get(memberNumber) || 0) < 5000) return false;
    const request = { requestId: remoteRandomId(9), session: peer.session, revision: peer.revision, hash: peer.hash, retries: 0 };
    setPendingRequest(memberNumber, request);
    remoteStore.requestTimes.set(memberNumber, now);
    enqueueRemoteEnvelope({ t: "REQUEST", requestId: request.requestId, session: request.session, revision: request.revision, hash: request.hash }, memberNumber);
    scheduleRemoteRequestTimeout(memberNumber, request, remoteStore.roomGeneration);
    return true;
  }

  function scheduleRemoteRequestTimeout(memberNumber, request, generation) {
    scheduleRemoteTimer(() => {
      if (generation !== remoteStore.roomGeneration) return;
      const pending = pendingRequestFor(memberNumber);
      if (!pending || pending.requestId !== request.requestId) return;
      remoteStore.assemblies.delete(memberNumber);
      if (pending.retries >= 1) {
        clearPendingRequest(memberNumber, pending.requestId);
        remoteDiagnostic("request-timeout", memberNumber);
        return;
      }
      const retry = { ...pending, requestId: remoteRandomId(9), retries: pending.retries + 1 };
      setPendingRequest(memberNumber, retry);
      enqueueRemoteEnvelope({ t: "REQUEST", requestId: retry.requestId, session: retry.session, revision: retry.revision, hash: retry.hash }, memberNumber);
      scheduleRemoteRequestTimeout(memberNumber, retry, generation);
    }, 12000);
  }

  async function handleRemoteEnvelope(sender, envelope, generation) {
    if (generation !== remoteStore.roomGeneration) return;
    const memberNumber = Number(sender.MemberNumber);
    if (envelope.t === "STATE") {
      const previous = getRemotePeer(memberNumber);
      const result = setRemotePeer(memberNumber, { session: envelope.s, revision: envelope.r, hash: envelope.h, size: envelope.z, sharing: envelope.sharing });
      const identity = remoteIdentity(memberNumber, envelope.s);
      if (result.isNewSession) {
        const active = remoteStore.activeSnapshots.get(memberNumber);
        if (active) remoteStore.totalBytes -= active.bytes;
        remoteStore.activeSnapshots.delete(memberNumber);
        clearPendingRequest(memberNumber);
        remoteStore.assemblies.delete(memberNumber);
        syntheticByCharacter = new WeakMap();
        if (active) CharacterRefresh(sender, false, false);
      }
      if (!remoteStore.helloReplied.has(identity)) {
        remoteStore.helloReplied.add(identity);
        sendRemoteState(memberNumber, true);
      }
      if (!envelope.sharing) {
        const active = remoteStore.activeSnapshots.get(memberNumber);
        if (active) remoteStore.totalBytes -= active.bytes;
        remoteStore.activeSnapshots.delete(memberNumber);
        clearPendingRequest(memberNumber);
        remoteStore.assemblies.delete(memberNumber);
        if (active) CharacterRefresh(sender, false, false);
      } else if (!previous || result.isNewSession || previous.revision !== envelope.r || previous.hash !== envelope.h || previous.sharing !== envelope.sharing) maybeRequestRemoteSnapshot(memberNumber, result.peer);
      return;
    }
    if (envelope.t === "CLEAR") {
      const peer = getRemotePeer(memberNumber);
      if (peer && peer.session !== envelope.s) throw new Error("remote-clear-session");
      if (peer) { peer.sharing = false; peer.size = 0; }
      const previous = remoteStore.activeSnapshots.get(memberNumber);
      if (previous) remoteStore.totalBytes -= previous.bytes;
      remoteStore.activeSnapshots.delete(memberNumber);
      clearPendingRequest(memberNumber);
      syntheticByCharacter = new WeakMap();
      CharacterRefresh(sender, false, false);
      return;
    }
    if (envelope.t === "REQUEST") {
      if (!remotePrefs.sharingEnabled || envelope.session !== localPeerSessionId || envelope.revision !== localRemoteRevision || envelope.hash !== localRemoteHash || !localRemoteCanonical) return;
      const now = remoteNow();
      if (now - (remoteStore.responseTimes.get(memberNumber) || 0) < 10000) return;
      remoteStore.responseTimes.set(memberNumber, now);
      const chunks = splitRemoteData(encodeRemoteText(localRemoteCanonical));
      chunks.forEach((data, index) => enqueueRemoteEnvelope({ t: "CHUNK", requestId: envelope.requestId, session: localPeerSessionId, revision: localRemoteRevision, hash: localRemoteHash, index, count: chunks.length, data }, memberNumber, { earliest: now + index * 400 }));
      return;
    }
    const assembled = addRemoteChunk(memberNumber, envelope);
    if (assembled.status !== "complete") return;
    const canonical = decodeRemoteText(assembled.encoded);
    if (utf8Bytes(canonical) > REMOTE_LIMITS.snapshotBytes) throw new Error("remote-decoded-budget");
    let parsed;
    try { parsed = JSON.parse(canonical); } catch (_) { throw new Error("snapshot-json"); }
    const snapshot = validateRemoteSnapshot(parsed);
    const normalizedCanonical = JSON.stringify(snapshot);
    if (normalizedCanonical !== canonical) throw new Error("snapshot-not-canonical");
    const hash = await sha256Base64Url(canonical);
    if (generation !== remoteStore.roomGeneration) return;
    const pending = pendingRequestFor(memberNumber);
    if (!pending || pending.requestId !== envelope.requestId || hash !== pending.hash || hash !== envelope.hash) throw new Error("snapshot-hash");
    acceptRemoteSnapshot(memberNumber, remoteIdentity(memberNumber, envelope.session), snapshot, canonical);
    syntheticByCharacter = new WeakMap();
    CharacterRefresh(sender, false, false);
  }

  function installRemoteLifecycleHooks() {
    modApi.hookFunction("ChatRoomSync", 1000, (args, next) => {
      cancelRemoteTransport();
      resetRemoteRoom();
      const generation = remoteStore.roomGeneration;
      const result = next(args);
      Promise.resolve(result).then(() => { if (generation === remoteStore.roomGeneration) scheduleLocalRemoteBuild(true); }).catch(() => {});
      return result;
    });
    modApi.hookFunction("ChatRoomSyncMemberJoin", 1000, (args, next) => {
      const result = next(args);
      const memberNumber = Number(args[0]?.SourceMemberNumber ?? args[0]?.MemberNumber ?? args[0]);
      const generation = remoteStore.roomGeneration;
      scheduleRemoteTimer(() => { if (generation === remoteStore.roomGeneration && Number.isInteger(memberNumber)) sendRemoteState(memberNumber, true); }, 100 + Math.floor(Math.random() * 401));
      return result;
    });
    modApi.hookFunction("ChatRoomSyncMemberLeave", 1000, (args, next) => {
      const memberNumber = Number(args[0]?.SourceMemberNumber ?? args[0]?.MemberNumber ?? args[0]);
      const result = next(args);
      if (Number.isInteger(memberNumber)) clearRemoteMember(memberNumber);
      return result;
    });
    modApi.hookFunction("ChatRoomLeave", 1000, (args, next) => { cancelRemoteTransport(); resetRemoteRoom(); return next(args); });
    modApi.hookFunction("ServerDisconnect", 1000, (args, next) => {
      captureSetReconnectIntent();
      invalidateSetPreviewCache();
      cancelRemoteTransport();
      resetRemoteRoom();
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
    localRemoteSnapshot = null;
    if (!installRemoteMessageHandler()) throw new Error("remote-message-handler-unavailable");
    scheduleLocalRemoteBuild(true);
  }
