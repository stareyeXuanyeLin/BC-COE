  function packWardrobe(data) {
    const compact = compactWardrobeForStorage(normalizeWardrobe(data));
    const json = JSON.stringify(compact);
    try {
      if (globalThis.LZString?.compressToUTF16) return `lz:${LZString.compressToUTF16(json)}`;
    } catch (error) {
      warn("压缩衣柜失败，改用 JSON", error);
    }
    return `json:${json}`;
  }

  function unpackWardrobeDetailed(value) {
    if (value == null || value === "") return { status: "absent", raw: value ?? null, data: null, error: null };
    if (typeof value !== "string") return { status: "unsupported", raw: value, data: null, error: "non-string-storage" };
    let json;
    if (value.startsWith("lz:")) {
      if (typeof globalThis.LZString?.decompressFromUTF16 !== "function") return { status: "deferred", raw: value, data: null, error: "lz-not-ready" };
      try { json = LZString.decompressFromUTF16(value.slice(3)); }
      catch (error) { return { status: "corrupt", raw: value, data: null, error: String(error?.message || error) }; }
      if (typeof json !== "string" || !json.trim()) return { status: "corrupt", raw: value, data: null, error: "lz-empty-result" };
      if (utf8Bytes(json) > MAX_WARDROBE_BYTES) return { status: "corrupt", raw: value, data: null, error: "wardrobe-byte-budget" };
    } else if (value.startsWith("json:")) {
      json = value.slice(5);
      if (!json.trim()) return { status: "corrupt", raw: value, data: null, error: "json-empty" };
      if (utf8Bytes(json) > MAX_WARDROBE_BYTES) return { status: "corrupt", raw: value, data: null, error: "wardrobe-byte-budget" };
    } else {
      return { status: "unsupported", raw: value, data: null, error: "unknown-prefix" };
    }
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root-not-object");
      if (parsed.version != null && Number(parsed.version) > 6) return { status: "unsupported", raw: value, data: null, error: "newer-schema" };
      return { status: "ok", raw: value, data: normalizeWardrobe(parsed), error: null };
    } catch (error) {
      return { status: "corrupt", raw: value, data: null, error: String(error?.message || error) };
    }
  }

  function accountStorageKey() {
    const accountId = globalThis.Player?.MemberNumber ?? globalThis.Player?.AccountName ?? "anonymous";
    return `${STORAGE_KEY}.${accountId}`;
  }

  function localSyncMarkerKey() {
    return `${accountStorageKey()}.sync`;
  }

  function storageFingerprint(value) {
    const text = String(value ?? "");
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      hash = Math.imul(hash ^ (code & 0xff), 0x01000193);
      hash = Math.imul(hash ^ (code >>> 8), 0x01000193);
    }
    return `${text.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function serverSyncMessageBytes(packed) {
    const update = { [`ExtensionSettings.${SETTINGS_KEY}`]: packed };
    // Engine.IO message packet "4" + Socket.IO event packet "2" + JSON event.
    return utf8Bytes(`42${JSON.stringify(["AccountUpdate", update])}`);
  }

  function readLocalSyncMarker() {
    try {
      const parsed = JSON.parse(localStorage.getItem(localSyncMarkerKey()) || "null");
      if (!parsed || parsed.version !== 1 || parsed.mode !== "local-only" || typeof parsed.fingerprint !== "string") return null;
      return parsed;
    } catch (_) { return null; }
  }

  function writeLocalSyncMarker(packed, reason, requestBytes) {
    const marker = {
      version: 1,
      mode: "local-only",
      reason: String(reason || "unknown").slice(0, 80),
      fingerprint: storageFingerprint(packed),
      requestBytes: Number.isFinite(requestBytes) ? requestBytes : null,
      maxRequestBytes: MAX_SERVER_SYNC_MESSAGE_BYTES,
    };
    try { localStorage.setItem(localSyncMarkerKey(), JSON.stringify(marker)); }
    catch (_) { /* privacy mode */ }
    return marker;
  }

  function clearLocalSyncMarker() {
    try { localStorage.removeItem(localSyncMarkerKey()); }
    catch (_) { /* privacy mode */ }
  }

  function readLocalWardrobeRaw() {
    try { return localStorage.getItem(accountStorageKey()); }
    catch (_) { return null; }
  }

  function loadWardrobe() {
    const serverRaw = globalThis.Player?.ExtensionSettings?.[SETTINGS_KEY] ?? null;
    const localRaw = readLocalWardrobeRaw();
    const server = unpackWardrobeDetailed(serverRaw);
    const local = unpackWardrobeDetailed(localRaw);
    const marker = readLocalSyncMarker();
    const markerMatchesLocal = local.status === "ok" && marker?.fingerprint === storageFingerprint(localRaw);
    const failures = [server, local].filter(result => ["deferred", "corrupt", "unsupported"].includes(result.status));
    const contentsDiffer = server.status === "ok" && local.status === "ok" && JSON.stringify(compactWardrobeForStorage(server.data)) !== JSON.stringify(compactWardrobeForStorage(local.data));
    const localOnly = markerMatchesLocal && (contentsDiffer || server.status !== "ok");
    const conflict = contentsDiffer && !localOnly;
    if (!contentsDiffer && marker) clearLocalSyncMarker();
    persistenceBlocked = failures.length > 0 || conflict;
    let selected = null;
    let source = null;
    if (localOnly) { selected = local.data; source = "local"; }
    else if (server.status === "ok") { selected = server.data; source = "server"; }
    else if (local.status === "ok") { selected = local.data; source = "local"; }
    else if (server.status === "absent" && local.status === "absent") { selected = normalizeWardrobe(null); source = "empty"; }
    wardrobeReadState = {
      status: failures[0]?.status || (conflict ? "conflict" : localOnly ? "local-only" : selected ? "ok" : "absent"),
      source, server: { status: server.status, error: server.error, raw: server.raw },
      local: { status: local.status, error: local.error, raw: local.raw }, conflict,
      sync: localOnly ? { mode: "local-only", reason: marker.reason, requestBytes: marker.requestBytes, maxRequestBytes: MAX_SERVER_SYNC_MESSAGE_BYTES } : null,
    };
    if (selected) wardrobe = selected;
    if (persistenceBlocked) {
      const message = conflict ? "服务器与本地衣柜内容冲突，已停止自动写回" : "衣柜数据暂不可安全读取，已停止写回";
      diagnostics.lastWarnings.push(message);
      warn(message, wardrobeReadState);
    }
    return wardrobeReadState;
  }

  function setLocalOnlyState(packed, serverState, localState, reason, requestBytes) {
    const marker = writeLocalSyncMarker(packed, reason, requestBytes);
    wardrobeReadState = {
      status: "local-only",
      source: "local",
      server: serverState,
      local: localState,
      conflict: false,
      sync: { mode: marker.mode, reason: marker.reason, requestBytes: marker.requestBytes, maxRequestBytes: marker.maxRequestBytes },
    };
  }

  function persistWardrobe(options = {}) {
    if (persistenceBlocked && options.force !== true) throw new Error(`wardrobe-write-blocked:${wardrobeReadState.status}`);
    const normalized = normalizeWardrobe(wardrobe);
    const packed = packWardrobe(normalized);
    const requestBytes = serverSyncMessageBytes(packed);
    wardrobe = normalized;

    let localError = null;
    try { localStorage.setItem(accountStorageKey(), packed); }
    catch (error) { localError = String(error?.message || error); }
    const localState = localError
      ? { status: "error", error: localError, raw: null }
      : { status: "ok", error: null, raw: packed };
    const previousServerRaw = globalThis.Player?.ExtensionSettings?.[SETTINGS_KEY] ?? null;
    const previousServer = unpackWardrobeDetailed(previousServerRaw);
    const serverState = { status: previousServer.status, error: previousServer.error, raw: previousServer.raw };

    if (requestBytes > MAX_SERVER_SYNC_MESSAGE_BYTES) {
      if (localError) throw new Error(`wardrobe-storage-unavailable:${localError}`);
      setLocalOnlyState(packed, serverState, localState, "server-byte-budget", requestBytes);
      const message = `衣柜同步请求 ${requestBytes} 字节，超过安全上限 ${MAX_SERVER_SYNC_MESSAGE_BYTES} 字节；已仅保存到本机`;
      if (!diagnostics.lastWarnings.includes(message)) diagnostics.lastWarnings.push(message);
      warn(message);
      toast(message, "warn");
      return packed;
    }

    if (!globalThis.Player || typeof globalThis.ServerPlayerExtensionSettingsSync !== "function") {
      if (localError) throw new Error(`wardrobe-storage-unavailable:${localError}`);
      setLocalOnlyState(packed, serverState, localState, "server-sync-unavailable", requestBytes);
      toast("服务器同步暂不可用，已保存到本机", "warn");
      return packed;
    }

    Player.ExtensionSettings ||= {};
    const hadPreviousServerValue = Object.prototype.hasOwnProperty.call(Player.ExtensionSettings, SETTINGS_KEY);
    try {
      Player.ExtensionSettings[SETTINGS_KEY] = packed;
      ServerPlayerExtensionSettingsSync(SETTINGS_KEY);
      clearLocalSyncMarker();
      wardrobeReadState = {
        status: "sync-sent",
        source: "user-save",
        server: { status: "sent", error: null, raw: packed },
        local: localState,
        conflict: false,
        sync: { mode: "server", reason: null, requestBytes, maxRequestBytes: MAX_SERVER_SYNC_MESSAGE_BYTES },
      };
    } catch (error) {
      if (hadPreviousServerValue) Player.ExtensionSettings[SETTINGS_KEY] = previousServerRaw;
      else delete Player.ExtensionSettings[SETTINGS_KEY];
      if (localError) throw error;
      setLocalOnlyState(packed, serverState, localState, "server-sync-error", requestBytes);
      warn("服务器衣柜同步失败；本地副本已保存", error);
      toast("服务器同步失败，已保存到本机", "warn");
    }
    return packed;
  }
