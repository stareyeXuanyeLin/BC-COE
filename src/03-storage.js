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
      if (parsed.version != null && Number(parsed.version) > WARDROBE_VERSION) return { status: "unsupported", raw: value, data: null, error: "newer-schema" };
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

  function exchangeError(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
  }

  function encodeUTF8Base64(text) {
    const bytes = typeof TextEncoder === "function"
      ? new TextEncoder().encode(text)
      : Uint8Array.from(unescape(encodeURIComponent(text)), character => character.charCodeAt(0));
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  function decodeUTF8Base64(value) {
    let binary;
    try { binary = atob(value); }
    catch (_) { throw exchangeError("invalid-base64", "服装字符串的 Base64 内容已损坏"); }
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    try {
      if (typeof TextDecoder === "function") return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      let encoded = "";
      for (const byte of bytes) encoded += `%${byte.toString(16).padStart(2, "0")}`;
      return decodeURIComponent(encoded);
    } catch (_) {
      throw exchangeError("invalid-utf8", "服装字符串不是有效的 UTF-8 数据");
    }
  }

  function validateOutfitPayloadShape(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw exchangeError("outfit-root", "服装数据根节点无效");
    if (payload.version != null && Number(payload.version) > COMPOSITION_VERSION) throw exchangeError("newer-outfit-schema", "该服装由更新版本的 COE 导出");
    if (Array.isArray(payload.layers) && payload.layers.length > MAX_LAYERS) throw exchangeError("too-many-layers", `服装图层超过 ${MAX_LAYERS} 个`);
    if (Array.isArray(payload.recycle) && payload.recycle.length > MAX_LAYERS) throw exchangeError("too-many-recycled-layers", `服装回收区图层超过 ${MAX_LAYERS} 个`);
    if (Array.isArray(payload.materials) && payload.materials.length > MAX_LAYERS) throw exchangeError("too-many-materials", `服装素材超过 ${MAX_LAYERS} 件`);
    const materialIds = new Set();
    for (const material of Array.isArray(payload.materials) ? payload.materials : []) {
      if (!material || typeof material !== "object") continue;
      if (typeof material.id === "string" && material.id) {
        if (materialIds.has(material.id)) throw exchangeError("duplicate-material-id", "服装包含重复的素材 ID");
        materialIds.add(material.id);
      }
    }
  }

  function createOutfitExchangeString(composition) {
    const payload = compactCompositionForStorage(composition);
    const envelope = {
      format: OUTFIT_EXCHANGE_FORMAT,
      formatVersion: EXCHANGE_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      pluginVersion: VERSION,
      payload,
    };
    const json = JSON.stringify(envelope);
    if (globalThis.LZString?.compressToBase64) {
      const compressed = LZString.compressToBase64(json);
      if (typeof compressed === "string" && compressed) return `COE-OUTFIT:${EXCHANGE_FORMAT_VERSION}:lz:${compressed}`;
    }
    return `COE-OUTFIT:${EXCHANGE_FORMAT_VERSION}:b64:${encodeUTF8Base64(json)}`;
  }

  function parseOutfitExchangeString(value) {
    const input = String(value ?? "").trim();
    if (!input) throw exchangeError("empty-outfit-string", "请先粘贴服装字符串");
    if (input.length > MAX_OUTFIT_EXCHANGE_CHARS) throw exchangeError("outfit-string-too-large", "服装字符串超过安全长度限制");
    const match = /^COE-OUTFIT:(\d+):(lz|b64):([A-Za-z0-9+/=_-]+)$/.exec(input);
    if (!match) throw exchangeError("invalid-outfit-prefix", "这不是有效的 COE 单件服装字符串");
    const formatVersion = Number(match[1]);
    if (formatVersion > EXCHANGE_FORMAT_VERSION) throw exchangeError("newer-exchange-format", "该服装字符串需要更新版本的 COE");
    if (formatVersion !== EXCHANGE_FORMAT_VERSION) throw exchangeError("unsupported-exchange-format", "不支持该服装字符串格式版本");
    let json;
    if (match[2] === "lz") {
      if (typeof globalThis.LZString?.decompressFromBase64 !== "function") throw exchangeError("lz-not-ready", "压缩组件尚未加载，请稍后重试");
      try { json = LZString.decompressFromBase64(match[3]); }
      catch (_) { throw exchangeError("invalid-compressed-outfit", "服装字符串的压缩内容已损坏"); }
      if (typeof json !== "string" || !json) throw exchangeError("invalid-compressed-outfit", "服装字符串的压缩内容已损坏");
    } else {
      json = decodeUTF8Base64(match[3].replace(/-/g, "+").replace(/_/g, "/"));
    }
    if (utf8Bytes(json) > MAX_SCHEME_BYTES + 16384) throw exchangeError("outfit-payload-too-large", "服装数据超过安全容量限制");
    let envelope;
    try { envelope = JSON.parse(json); }
    catch (_) { throw exchangeError("invalid-outfit-json", "服装字符串中的 JSON 已损坏"); }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || envelope.format !== OUTFIT_EXCHANGE_FORMAT) {
      throw exchangeError("wrong-exchange-kind", "字符串内容不是 COE 单件服装");
    }
    if (Number(envelope.formatVersion) !== EXCHANGE_FORMAT_VERSION) throw exchangeError("exchange-version-mismatch", "服装字符串的格式版本不一致");
    validateOutfitPayloadShape(envelope.payload);
    const unfiltered = normalizeComposition(envelope.payload, { validateReferences: false });
    if (!VANILLA_CLOTHING_SLOT_GROUPS.has(unfiltered.slotGroup)) throw exchangeError("invalid-slot-group", "服装使用了不受支持的服装格子");
    compactCompositionForStorage(unfiltered);
    const available = normalizeComposition(envelope.payload);
    const missingLayers = Math.max(0, unfiltered.layers.length - available.layers.length);
    const missingRecycle = Math.max(0, unfiltered.recycle.length - available.recycle.length);
    if (unfiltered.layers.length > 0 && available.layers.length === 0) throw exchangeError("all-assets-missing", "当前环境缺少这件服装使用的全部素材");
    return {
      composition: available,
      metadata: {
        createdAt: typeof envelope.createdAt === "string" ? envelope.createdAt.slice(0, 40) : null,
        pluginVersion: typeof envelope.pluginVersion === "string" ? envelope.pluginVersion.slice(0, 24) : null,
      },
      missingLayers,
      missingRecycle,
    };
  }

  function createWardrobeExchangeDocument(data = wardrobe) {
    const payload = compactWardrobeForStorage(data);
    return {
      format: WARDROBE_EXCHANGE_FORMAT,
      formatVersion: EXCHANGE_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      pluginVersion: VERSION,
      gameVersion: String(globalThis.GameVersion || globalThis.CurrentVersion || "unknown").slice(0, 40),
      owner: {
        accountName: String(globalThis.Player?.AccountName || globalThis.Player?.Name || "Player").slice(0, 80),
        memberNumber: Number.isInteger(globalThis.Player?.MemberNumber) ? globalThis.Player.MemberNumber : null,
      },
      payload,
    };
  }

  function parseWardrobeExchangeDocument(text) {
    let json = String(text ?? "");
    if (json.charCodeAt(0) === 0xfeff) json = json.slice(1);
    if (!json.trim()) throw exchangeError("empty-wardrobe-file", "衣柜文件为空");
    if (utf8Bytes(json) > MAX_WARDROBE_FILE_BYTES) throw exchangeError("wardrobe-file-too-large", "衣柜文件超过 1 MiB 安全限制");
    let envelope;
    try { envelope = JSON.parse(json); }
    catch (_) { throw exchangeError("invalid-wardrobe-json", "衣柜文件不是有效的 JSON"); }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || envelope.format !== WARDROBE_EXCHANGE_FORMAT) {
      throw exchangeError("wrong-exchange-kind", "文件内容不是 COE 衣柜备份");
    }
    const formatVersion = Number(envelope.formatVersion);
    if (formatVersion > EXCHANGE_FORMAT_VERSION) throw exchangeError("newer-exchange-format", "该衣柜文件需要更新版本的 COE");
    if (formatVersion !== EXCHANGE_FORMAT_VERSION) throw exchangeError("unsupported-exchange-format", "不支持该衣柜文件格式版本");
    const payload = envelope.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw exchangeError("wardrobe-root", "衣柜数据根节点无效");
    if (payload.version != null && Number(payload.version) > WARDROBE_VERSION) throw exchangeError("newer-wardrobe-schema", "该衣柜由更新版本的 COE 导出");
    if (Array.isArray(payload.schemes) && payload.schemes.length > MAX_SCHEMES) throw exchangeError("too-many-schemes", `衣柜服装超过 ${MAX_SCHEMES} 套`);
    const schemeIds = new Set();
    let missingLayers = 0;
    let affectedSchemes = 0;
    for (const scheme of Array.isArray(payload.schemes) ? payload.schemes : []) {
      if (typeof scheme?.id !== "string" || !scheme.id) throw exchangeError("invalid-scheme-id", "衣柜包含无效的方案 ID");
      if (schemeIds.has(scheme.id)) throw exchangeError("duplicate-scheme-id", "衣柜包含重复的方案 ID");
      schemeIds.add(scheme.id);
      validateOutfitPayloadShape(scheme.composition);
      const unfiltered = normalizeComposition(scheme.composition, { validateReferences: false });
      if (!VANILLA_CLOTHING_SLOT_GROUPS.has(unfiltered.slotGroup)) throw exchangeError("invalid-slot-group", `服装「${unfiltered.name}」使用了不受支持的服装格子`);
      const available = normalizeComposition(scheme.composition);
      const schemeMissing = Math.max(0, unfiltered.layers.length - available.layers.length)
        + Math.max(0, unfiltered.recycle.length - available.recycle.length);
      if (schemeMissing) affectedSchemes++;
      missingLayers += schemeMissing;
    }
    const normalized = normalizeWardrobe(payload);
    compactWardrobeForStorage(normalized);
    return {
      wardrobe: normalized,
      missingLayers,
      affectedSchemes,
      metadata: {
        createdAt: typeof envelope.createdAt === "string" ? envelope.createdAt.slice(0, 40) : null,
        pluginVersion: typeof envelope.pluginVersion === "string" ? envelope.pluginVersion.slice(0, 24) : null,
        accountName: typeof envelope.owner?.accountName === "string" ? envelope.owner.accountName.slice(0, 80) : null,
        memberNumber: Number.isInteger(envelope.owner?.memberNumber) ? envelope.owner.memberNumber : null,
      },
    };
  }

  function sanitizeFilenamePart(value, fallback) {
    let output = String(value ?? "").replace(/[<>:\"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim();
    if (!output) output = fallback;
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(output)) output = `_${output}`;
    return output.slice(0, 80);
  }

  function localTimestamp(date = new Date()) {
    const part = value => String(value).padStart(2, "0");
    return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
  }

  function wardrobeExportFilename(date = new Date()) {
    const accountName = sanitizeFilenamePart(globalThis.Player?.AccountName || globalThis.Player?.Name, "Player");
    const memberNumber = Number.isInteger(globalThis.Player?.MemberNumber) ? String(globalThis.Player.MemberNumber) : "unknown";
    return `${accountName}_${memberNumber}_${localTimestamp(date)}.coe-wardrobe.json`;
  }
