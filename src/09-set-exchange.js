  function assertSafeExchangeValue(value, depth = 0, budget = { keys: 0 }) {
    if (value == null || typeof value === "boolean" || typeof value === "string") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw exchangeError("non-finite-value", "套装包含无效数字");
      return;
    }
    if (depth > 10) throw exchangeError("exchange-depth", "套装数据嵌套过深");
    if (Array.isArray(value)) {
      if (value.length > 200) throw exchangeError("exchange-array", "套装数组超过安全限制");
      value.forEach(entry => assertSafeExchangeValue(entry, depth + 1, budget));
      return;
    }
    if (Object.prototype.toString.call(value) !== "[object Object]") throw exchangeError("exchange-object", "套装包含无效对象");
    for (const [key, entry] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw exchangeError("pollution-key", "套装包含危险字段");
      budget.keys++;
      if (budget.keys > 4000) throw exchangeError("exchange-keys", "套装字段超过安全限制");
      assertSafeExchangeValue(entry, depth + 1, budget);
    }
  }

  function compositionSignature(composition) {
    const compact = compactCompositionForStorage(composition, { validateReferences: false });
    const canonical = cloneJSON(compact);
    delete canonical.name;
    return JSON.stringify(canonical);
  }

  function createSetExchangeString(setId, data = wardrobe) {
    const set = data.sets.find(entry => entry.id === setId);
    if (!set) throw exchangeError("set-not-found", "找不到要导出的套装");
    const schemeById = new Map(data.schemes.map(entry => [entry.id, entry]));
    const refs = new Map();
    const outfits = [];
    const customOutfits = [];
    for (const entry of set.customOutfits) {
      const scheme = schemeById.get(entry.schemeId);
      if (!scheme) continue;
      let ref = refs.get(scheme.id);
      if (!ref) {
        ref = `outfit-${refs.size + 1}`;
        refs.set(scheme.id, ref);
        outfits.push({ ref, composition: compactCompositionForStorage(scheme.composition) });
      }
      customOutfits.push({ slotGroup: entry.slotGroup, outfitRef: ref });
    }
    const payload = {
      set: {
        name: set.name,
        appearance: set.appearance.map(compactAppearanceBundle).filter(Boolean),
        customOutfits,
      },
      outfits,
    };
    const envelope = {
      format: SET_EXCHANGE_FORMAT,
      formatVersion: EXCHANGE_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      pluginVersion: VERSION,
      payload,
    };
    const json = JSON.stringify(envelope);
    if (utf8Bytes(json) > MAX_SET_EXCHANGE_BYTES) throw exchangeError("set-payload-too-large", "套装字符串超过安全容量限制");
    if (globalThis.LZString?.compressToBase64) {
      const compressed = LZString.compressToBase64(json);
      if (typeof compressed === "string" && compressed) return `COE-SET:${EXCHANGE_FORMAT_VERSION}:lz:${compressed}`;
    }
    return `COE-SET:${EXCHANGE_FORMAT_VERSION}:b64:${encodeUTF8Base64(json)}`;
  }

  function parseSetExchangeString(value) {
    const input = String(value ?? "").trim();
    if (!input) throw exchangeError("empty-set-string", "请先粘贴套装字符串");
    if (input.length > MAX_SET_EXCHANGE_CHARS) throw exchangeError("set-string-too-large", "套装字符串超过安全长度限制");
    const match = /^COE-SET:(\d+):(lz|b64):([A-Za-z0-9+/=_-]+)$/.exec(input);
    if (!match) throw exchangeError("invalid-set-prefix", "这不是有效的 COE 套装字符串");
    const formatVersion = Number(match[1]);
    if (formatVersion > EXCHANGE_FORMAT_VERSION) throw exchangeError("newer-exchange-format", "该套装字符串需要更新版本的 COE");
    if (formatVersion !== EXCHANGE_FORMAT_VERSION) throw exchangeError("unsupported-exchange-format", "不支持该套装字符串格式版本");
    let json;
    if (match[2] === "lz") {
      if (typeof globalThis.LZString?.decompressFromBase64 !== "function") throw exchangeError("lz-not-ready", "压缩组件尚未加载，请稍后重试");
      try { json = LZString.decompressFromBase64(match[3]); }
      catch (_) { throw exchangeError("invalid-compressed-set", "套装字符串的压缩内容已损坏"); }
      if (typeof json !== "string" || !json) throw exchangeError("invalid-compressed-set", "套装字符串的压缩内容已损坏");
    } else json = decodeUTF8Base64(match[3].replace(/-/g, "+").replace(/_/g, "/"));
    if (utf8Bytes(json) > MAX_SET_EXCHANGE_BYTES) throw exchangeError("set-payload-too-large", "套装数据超过安全容量限制");
    let envelope;
    try { envelope = JSON.parse(json); }
    catch (_) { throw exchangeError("invalid-set-json", "套装字符串中的 JSON 已损坏"); }
    assertSafeExchangeValue(envelope);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || envelope.format !== SET_EXCHANGE_FORMAT) {
      throw exchangeError("wrong-exchange-kind", "字符串内容不是 COE 套装");
    }
    if (Number(envelope.formatVersion) !== EXCHANGE_FORMAT_VERSION) throw exchangeError("exchange-version-mismatch", "套装字符串的格式版本不一致");
    const payload = envelope.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !payload.set || !Array.isArray(payload.outfits)) throw exchangeError("set-root", "套装数据根节点无效");
    if (payload.outfits.length > MAX_SET_CUSTOM_OUTFITS) throw exchangeError("too-many-set-outfits", `套装自定义服装超过 ${MAX_SET_CUSTOM_OUTFITS} 件`);
    const rawSet = payload.set;
    if (!Array.isArray(rawSet.appearance) || !Array.isArray(rawSet.customOutfits)) throw exchangeError("invalid-set-shape", "套装缺少外观或自定义服装列表");
    if (rawSet.appearance.length > MAX_SET_APPEARANCE_ITEMS) throw exchangeError("too-many-set-appearance", `套装外观超过 ${MAX_SET_APPEARANCE_ITEMS} 件`);
    const appearanceGroups = new Set();
    const appearance = rawSet.appearance.map(entry => {
      if (!entry || typeof entry.group !== "string" || typeof entry.asset !== "string" || entry.asset === TAG_ASSET_NAME) throw exchangeError("invalid-set-appearance", "套装包含无效外观项目");
      if (appearanceGroups.has(entry.group)) throw exchangeError("duplicate-set-group", "套装包含重复的外观部位");
      appearanceGroups.add(entry.group);
      if (entry.property != null) validateStoredSetProperty(entry.property);
      return normalizeAppearanceBundle(entry);
    });
    const outfitByRef = new Map();
    for (const entry of payload.outfits) {
      if (!entry || typeof entry.ref !== "string" || !entry.ref || outfitByRef.has(entry.ref)) throw exchangeError("duplicate-outfit-ref", "套装包含重复或无效的服装引用");
      validateOutfitPayloadShape(entry.composition);
      const composition = normalizeComposition(entry.composition, { validateReferences: false });
      if (!VANILLA_CLOTHING_SLOT_GROUPS.has(composition.slotGroup)) throw exchangeError("invalid-slot-group", `服装「${composition.name}」使用了不受支持的服装格子`);
      compactCompositionForStorage(composition, { validateReferences: false });
      outfitByRef.set(entry.ref, composition);
    }
    const slots = new Set();
    const customOutfits = rawSet.customOutfits.map(entry => {
      if (!entry || typeof entry.slotGroup !== "string" || typeof entry.outfitRef !== "string" || !outfitByRef.has(entry.outfitRef)) throw exchangeError("invalid-outfit-ref", "套装引用了不存在的自定义服装");
      if (slots.has(entry.slotGroup)) throw exchangeError("duplicate-set-slot", "套装包含重复的自定义服装部位");
      if (outfitByRef.get(entry.outfitRef).slotGroup !== entry.slotGroup) throw exchangeError("slot-reference-mismatch", "套装的自定义服装部位不一致");
      slots.add(entry.slotGroup);
      return { slotGroup: entry.slotGroup, outfitRef: entry.outfitRef };
    });
    return {
      set: { name: String(rawSet.name || "未命名套装").slice(0, 60), appearance, customOutfits },
      outfits: [...outfitByRef].map(([ref, composition]) => ({ ref, composition })),
      metadata: {
        createdAt: typeof envelope.createdAt === "string" ? envelope.createdAt.slice(0, 40) : null,
        pluginVersion: typeof envelope.pluginVersion === "string" ? envelope.pluginVersion.slice(0, 24) : null,
      },
    };
  }

  function buildSetImportPlan(parsed, data = wardrobe) {
    if (!parsed?.set || !Array.isArray(parsed.outfits)) throw exchangeError("invalid-set-plan", "套装导入计划无效");
    if (data.sets.length >= MAX_SETS) throw exchangeError("too-many-sets", `套装衣柜最多保存 ${MAX_SETS} 套`);
    const candidateSchemes = cloneJSON(data.schemes);
    const signatures = new Map(candidateSchemes.map(scheme => [compositionSignature(scheme.composition), scheme.id]));
    const refToId = new Map();
    const report = { appearanceImported: 0, appearanceMissing: 0, outfitsCreated: 0, outfitsReused: 0, outfitsSkipped: 0, missingLayers: 0 };
    for (const entry of parsed.outfits) {
      const unfiltered = normalizeComposition(entry.composition, { validateReferences: false });
      const available = normalizeComposition(entry.composition);
      report.missingLayers += Math.max(0, unfiltered.layers.length - available.layers.length) + Math.max(0, unfiltered.recycle.length - available.recycle.length);
      if (unfiltered.layers.length > 0 && available.layers.length === 0) { report.outfitsSkipped++; continue; }
      const signature = compositionSignature(available);
      let schemeId = signatures.get(signature);
      if (schemeId) report.outfitsReused++;
      else {
        if (candidateSchemes.length >= MAX_SCHEMES) throw exchangeError("too-many-schemes", `衣柜最多保存 ${MAX_SCHEMES} 套自定义服装`);
        const composition = cloneJSON(available);
        composition.name = uniqueImportedSchemeName(composition.name, { schemes: candidateSchemes });
        schemeId = uid();
        candidateSchemes.push({ id: schemeId, composition });
        signatures.set(signature, schemeId);
        report.outfitsCreated++;
      }
      refToId.set(entry.ref, schemeId);
    }
    const appearance = [];
    for (const bundle of parsed.set.appearance) {
      const asset = typeof globalThis.AssetGet === "function" ? AssetGet(globalThis.Player?.AssetFamily || "Female3DCG", bundle.group, bundle.asset) : null;
      if (!asset || asset.Group?.Category !== "Appearance" || asset.Name === TAG_ASSET_NAME) { report.appearanceMissing++; continue; }
      appearance.push(normalizeAppearanceBundle(bundle));
      report.appearanceImported++;
    }
    const customOutfits = parsed.set.customOutfits
      .filter(entry => refToId.has(entry.outfitRef))
      .map(entry => ({ slotGroup: entry.slotGroup, schemeId: refToId.get(entry.outfitRef) }));
    const set = normalizeSet({ id: uid(), name: uniqueSetName(parsed.set.name, data), appearance, customOutfits }, { validSchemeIds: new Set(candidateSchemes.map(entry => entry.id)) });
    const candidate = normalizeWardrobe({ ...data, schemes: candidateSchemes, sets: [set, ...data.sets], equippedIds: data.equippedIds }, { validateReferences: false });
    compactWardrobeForStorage(candidate);
    return { wardrobe: candidate, set, report };
  }

  function commitSetImportPlan(plan, options = {}) {
    if (!plan?.wardrobe || !plan?.set) throw exchangeError("invalid-set-plan", "套装导入计划无效");
    const previous = cloneJSON(wardrobe);
    try {
      compactWardrobeForStorage(plan.wardrobe);
      wardrobe = normalizeWardrobe(plan.wardrobe);
      (options.persist || persistWardrobe)();
      return { set: cloneJSON(plan.set), report: cloneJSON(plan.report) };
    } catch (error) {
      wardrobe = previous;
      throw error;
    }
  }
