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

  function readLocalWardrobeRaw() {
    try { return localStorage.getItem(accountStorageKey()); }
    catch (_) { return null; }
  }

  function loadWardrobe() {
    const serverRaw = globalThis.Player?.ExtensionSettings?.[SETTINGS_KEY] ?? null;
    const localRaw = readLocalWardrobeRaw();
    const server = unpackWardrobeDetailed(serverRaw);
    const local = unpackWardrobeDetailed(localRaw);
    const failures = [server, local].filter(result => ["deferred", "corrupt", "unsupported"].includes(result.status));
    const conflict = server.status === "ok" && local.status === "ok" && JSON.stringify(compactWardrobeForStorage(server.data)) !== JSON.stringify(compactWardrobeForStorage(local.data));
    persistenceBlocked = failures.length > 0 || conflict;
    let selected = null;
    let source = null;
    if (server.status === "ok") { selected = server.data; source = "server"; }
    else if (local.status === "ok") { selected = local.data; source = "local"; }
    else if (server.status === "absent" && local.status === "absent") { selected = normalizeWardrobe(null); source = "empty"; }
    wardrobeReadState = {
      status: failures[0]?.status || (conflict ? "conflict" : selected ? "ok" : "absent"),
      source, server: { status: server.status, error: server.error, raw: server.raw },
      local: { status: local.status, error: local.error, raw: local.raw }, conflict,
    };
    if (selected) wardrobe = selected;
    if (persistenceBlocked) {
      const message = conflict ? "服务器与本地衣柜内容冲突，已停止自动写回" : "衣柜数据暂不可安全读取，已停止写回";
      diagnostics.lastWarnings.push(message);
      warn(message, wardrobeReadState);
    }
    return wardrobeReadState;
  }

  function persistWardrobe(options = {}) {
    if (persistenceBlocked && options.force !== true) throw new Error(`wardrobe-write-blocked:${wardrobeReadState.status}`);
    const normalized = normalizeWardrobe(wardrobe);
    const packed = packWardrobe(normalized);
    wardrobe = normalized;
    try { localStorage.setItem(accountStorageKey(), packed); } catch (_) { /* privacy mode */ }
    try {
      if (globalThis.Player) {
        Player.ExtensionSettings ||= {};
        Player.ExtensionSettings[SETTINGS_KEY] = packed;
        wardrobeReadState = { status: "ok", source: "user-save", server: { status: "ok", raw: packed }, local: { status: "ok", raw: packed }, conflict: false };
        if (typeof globalThis.ServerPlayerExtensionSettingsSync === "function") ServerPlayerExtensionSettingsSync(SETTINGS_KEY);
      }
    } catch (error) {
      warn("服务器衣柜同步失败；本地副本已保存", error);
      toast("服务器同步失败，已保存到本机", "warn");
    }
    return packed;
  }
