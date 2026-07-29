  const SET_PROPERTY_DENIED_KEYS = Object.freeze(new Set([
    "__proto__", "prototype", "constructor", "Expression", "ExpressionTrigger", "ExpressionGroup",
    "LockedBy", "LockMemberNumber", "LockMemberNumberList", "LockPickSeed", "Password", "CombinationNumber",
    "MemberNumberList", "ItemMemberNumber", "RemoveTimer", "ChangeTimer", "Timer", "Craft", "Difficulty",
  ]));

  function sanitizeSetPropertyValue(value, depth = 0, budget = { keys: 0, maxKeys: 96 }) {
    if (value == null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Math.abs(value) > 1000000000) throw new Error("set-property-number");
      return value;
    }
    if (typeof value === "string") {
      if (value.length > 500) throw new Error("set-property-string");
      return value;
    }
    if (depth >= 4) throw new Error("set-property-depth");
    if (Array.isArray(value)) {
      if (value.length > 64) throw new Error("set-property-array");
      return value.map(entry => sanitizeSetPropertyValue(entry, depth + 1, budget));
    }
    if (Object.prototype.toString.call(value) !== "[object Object]") throw new Error("set-property-not-plain");
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SET_PROPERTY_DENIED_KEYS.has(key)) continue;
      // BC uses both an empty string and localized layer names as keys for
      // DrawingLeft/DrawingTop/OverridePriority records. They are valid data,
      // so only length and prototype-pollution names are restricted here.
      if (typeof key !== "string" || key.length > 80 || SET_PROPERTY_DENIED_KEYS.has(key)) throw new Error("set-property-key");
      budget.keys++;
      if (budget.keys > (Number.isInteger(budget.maxKeys) ? budget.maxKeys : 96)) throw new Error("set-property-keys");
      output[key] = sanitizeSetPropertyValue(entry, depth + 1, budget);
    }
    return output;
  }

  function sanitizeSetLayerOrigin(value) {
    if (Object.prototype.toString.call(value) !== "[object Object]") throw new Error("set-layer-origin-not-plain");
    const output = {};
    const entries = Object.entries(value);
    if (entries.length > 32) throw new Error("set-layer-origin-keys");
    for (const [poseName, coordinate] of entries) {
      if (poseName.length > 80 || SET_PROPERTY_DENIED_KEYS.has(poseName)) throw new Error("set-layer-origin-key");
      if (typeof coordinate !== "number" || !Number.isFinite(coordinate) || Math.abs(coordinate) > 1000000000) {
        throw new Error("set-layer-origin-coordinate");
      }
      output[poseName] = coordinate;
    }
    return output;
  }

  function sanitizeSetLayerOverrides(value) {
    if (!Array.isArray(value) || value.length > 64) throw new Error("set-layer-overrides-array");
    // LSCG stores per-layer translation as absolute coordinates indexed by
    // Asset.Layer position. Keep array indexes stable while accepting only the
    // two fields consumed by its BeforeDraw hook.
    return value.map(entry => {
      if (Object.prototype.toString.call(entry) !== "[object Object]") return {};
      const output = {};
      for (const field of ["DrawingLeft", "DrawingTop"]) {
        if (!Object.prototype.hasOwnProperty.call(entry, field)) continue;
        try { output[field] = sanitizeSetLayerOrigin(entry[field]); }
        catch (_) { /* drop only the malformed axis */ }
      }
      return output;
    });
  }

  function sanitizeSetProperty(value) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return {};
    const output = {};
    // Preserve the BC appearance-difference fields individually. A malformed
    // optional field must not erase a valid TypeRecord or Drawing offset.
    const allowed = new Set(["Type", "TypeRecord", "DrawingLeft", "DrawingTop", "OverridePriority", "Opacity", "Tint", "LayerOverrides"]);
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (SET_PROPERTY_DENIED_KEYS.has(key)) continue;
      try { output[key] = key === "LayerOverrides" ? sanitizeSetLayerOverrides(value[key]) : sanitizeSetPropertyValue(value[key]); }
      catch (_) { /* drop only the malformed field */ }
    }
    // Per-field structure limits keep parsing bounded. Capacity is enforced on
    // the complete set and wardrobe so a legitimate complex item is not
    // silently discarded merely because it owns many drawable layers.
    return output;
  }

  function normalizeAppearanceBundle(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const group = typeof raw.group === "string" ? raw.group.slice(0, 64) : "";
    const asset = typeof raw.asset === "string" ? raw.asset.slice(0, 80) : "";
    if (!group || !asset || asset === TAG_ASSET_NAME) return null;
    const color = sanitizeColor(raw.color);
    const property = sanitizeSetProperty(raw.property);
    return { group, asset, color, property };
  }

  function compactAppearanceBundle(bundle) {
    const normalized = normalizeAppearanceBundle(bundle);
    if (!normalized) return null;
    const output = { group: normalized.group, asset: normalized.asset };
    if (!(normalized.color === "Default" || (Array.isArray(normalized.color) && normalized.color.length === 0))) output.color = normalized.color;
    if (Object.keys(normalized.property).length) output.property = normalized.property;
    return output;
  }

  function normalizeSet(raw, options = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const appearance = [];
    const appearanceGroups = new Set();
    for (const entry of Array.isArray(raw.appearance) ? raw.appearance.slice(0, MAX_SET_APPEARANCE_ITEMS) : []) {
      const bundle = normalizeAppearanceBundle(entry);
      if (!bundle || appearanceGroups.has(bundle.group)) continue;
      appearanceGroups.add(bundle.group);
      appearance.push(bundle);
    }
    const customOutfits = [];
    const customSlots = new Set();
    for (const entry of Array.isArray(raw.customOutfits) ? raw.customOutfits.slice(0, MAX_SET_CUSTOM_OUTFITS) : []) {
      const slotGroup = typeof entry?.slotGroup === "string" ? entry.slotGroup.slice(0, 64) : "";
      const schemeId = typeof entry?.schemeId === "string" ? entry.schemeId.slice(0, 100) : "";
      if (!slotGroup || !schemeId || customSlots.has(slotGroup)) continue;
      if (options.validSchemeIds && !options.validSchemeIds.has(schemeId) && options.keepDangling !== true) continue;
      customSlots.add(slotGroup);
      customOutfits.push({ slotGroup, schemeId });
    }
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id.slice(0, 100) : uid(),
      slot: Number.isInteger(raw.slot) && raw.slot >= 0 && raw.slot < MAX_SETS ? raw.slot : null,
      name: String(raw.name || "未命名套装").slice(0, 60),
      appearance,
      customOutfits,
    };
  }

  function compactSetForStorage(raw, options = {}) {
    const normalized = normalizeSet(raw, options);
    if (!normalized) throw new Error("invalid-set");
    const compact = {
      id: normalized.id,
      name: normalized.name,
      appearance: normalized.appearance.map(compactAppearanceBundle).filter(Boolean),
      customOutfits: normalized.customOutfits.map(entry => ({ slotGroup: entry.slotGroup, schemeId: entry.schemeId })),
    };
    if (Number.isInteger(normalized.slot)) compact.slot = normalized.slot;
    if (utf8Bytes(compact) > MAX_SET_BYTES) throw new Error("set-byte-budget");
    return compact;
  }

  function assertStoredSetPropertySafe(value, depth = 0) {
    if (value == null || typeof value !== "object") return;
    if (depth > 6) throw new Error("set-property-depth");
    for (const [key, entry] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("set-property-pollution");
      assertStoredSetPropertySafe(entry, depth + 1);
    }
  }

  function validateStoredSetProperty(value) {
    const property = value == null ? {} : value;
    assertStoredSetPropertySafe(property);
    // A fully populated 64-layer LSCG record can contain more than four
    // thousand pose-coordinate keys. Its dedicated 64-layer/32-pose schema is
    // the authoritative structural bound; set and wardrobe budgets enforce
    // aggregate capacity without imposing an arbitrary per-item cutoff.
    sanitizeSetPropertyValue(property, 0, { keys: 0, maxKeys: 5000 });
  }

  function validateStoredSetShape(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw wardrobeMigrationError("invalid-set", "衣柜包含无效的套装");
    if (typeof raw.id !== "string" || !raw.id) throw wardrobeMigrationError("invalid-set-id", "套装 ID 无效");
    if (raw.slot != null && (!Number.isInteger(raw.slot) || raw.slot < 0 || raw.slot >= MAX_SETS)) throw wardrobeMigrationError("invalid-set-storage-slot", "套装储存格无效");
    if (!Array.isArray(raw.appearance) || !Array.isArray(raw.customOutfits)) throw wardrobeMigrationError("invalid-set-shape", "套装缺少外观或自定义服装列表");
    if (raw.appearance.length > MAX_SET_APPEARANCE_ITEMS) throw wardrobeMigrationError("too-many-set-appearance", `套装外观超过 ${MAX_SET_APPEARANCE_ITEMS} 件`);
    if (raw.customOutfits.length > MAX_SET_CUSTOM_OUTFITS) throw wardrobeMigrationError("too-many-set-outfits", `套装自定义服装超过 ${MAX_SET_CUSTOM_OUTFITS} 件`);
    const groups = new Set();
    for (const entry of raw.appearance) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.group !== "string" || typeof entry.asset !== "string") {
        throw wardrobeMigrationError("invalid-set-appearance", "套装包含无效的外观项目");
      }
      if (groups.has(entry.group)) throw wardrobeMigrationError("duplicate-set-group", "套装包含重复的外观部位");
      groups.add(entry.group);
      try { validateStoredSetProperty(entry.property); }
      catch (_) { throw wardrobeMigrationError("invalid-set-property", "套装包含不安全的外观 Property"); }
    }
    const slots = new Set();
    for (const entry of raw.customOutfits) {
      if (!entry || typeof entry !== "object" || typeof entry.slotGroup !== "string" || typeof entry.schemeId !== "string") {
        throw wardrobeMigrationError("invalid-set-reference", "套装包含无效的自定义服装引用");
      }
      if (slots.has(entry.slotGroup)) throw wardrobeMigrationError("duplicate-set-slot", "套装包含重复的自定义服装部位");
      slots.add(entry.slotGroup);
    }
    if (utf8Bytes(raw) > MAX_SET_BYTES) throw wardrobeMigrationError("set-byte-budget", "套装超过安全容量限制");
  }

  function validateSetReferences(set, data = wardrobe) {
    const validIds = new Set((data?.schemes || []).map(entry => entry.id));
    return (set?.customOutfits || []).filter(entry => !validIds.has(entry.schemeId)).map(entry => ({ ...entry }));
  }

  function findSetsReferencingScheme(schemeId, data = wardrobe) {
    return (data?.sets || []).filter(set => set.customOutfits?.some(entry => entry.schemeId === schemeId));
  }

  function captureAppearanceForSet(character = globalThis.Player, data = wardrobe) {
    const appearance = [];
    const customOutfits = [];
    const anomalies = [];
    const groups = new Set();
    const customSlots = new Set();
    const equipped = new Set(data?.equippedIds || []);
    const schemeBySlot = new Map((data?.schemes || [])
      .filter(scheme => equipped.has(scheme.id))
      .map(scheme => [schemeSlotGroup(scheme), scheme]));
    for (const item of character?.Appearance || []) {
      const asset = item?.Asset;
      const group = asset?.Group?.Name;
      if (!group || asset?.Group?.Category !== "Appearance") continue;
      if (asset.Name === TAG_ASSET_NAME) {
        const scheme = schemeBySlot.get(group);
        if (!scheme) { anomalies.push({ type: "orphan-tag", slotGroup: group }); continue; }
        if (!customSlots.has(group)) {
          customSlots.add(group);
          customOutfits.push({ slotGroup: group, schemeId: scheme.id });
        }
        continue;
      }
      if (groups.has(group)) { anomalies.push({ type: "duplicate-group", group }); continue; }
      groups.add(group);
      appearance.push({ group, asset: asset.Name, color: sanitizeColor(item.Color), property: sanitizeSetProperty(item.Property) });
    }
    return { appearance, customOutfits, anomalies };
  }

  function captureCurrentSet(name, character = globalThis.Player, data = wardrobe, slot = null) {
    const captured = captureAppearanceForSet(character, data);
    const set = normalizeSet({ id: uid(), slot, name, appearance: captured.appearance, customOutfits: captured.customOutfits }, {
      validSchemeIds: new Set((data?.schemes || []).map(entry => entry.id)),
    });
    compactSetForStorage(set, { validSchemeIds: new Set((data?.schemes || []).map(entry => entry.id)) });
    return { set, anomalies: captured.anomalies };
  }

  function prepareSetAppearanceProperty(asset, rawProperty) {
    const property = sanitizeSetProperty(rawProperty);
    // BC normalizes ExtendedItem DrawingLeft/DrawingTop records against the
    // current Asset layer table. Use that parser when available while keeping
    // the sanitized fallback for test harnesses and older BC builds.
    if (typeof globalThis.ExtendedItemParseProperties === "function") {
      try { return ExtendedItemParseProperties(asset, property) || property; }
      catch (_) { /* retain the safe serialized property */ }
    }
    return property;
  }

  function buildSetApplyPlan(set, character = globalThis.Player, data = wardrobe) {
    const normalized = normalizeSet(set, { validSchemeIds: new Set((data?.schemes || []).map(entry => entry.id)), keepDangling: true });
    if (!normalized) throw new Error("invalid-set");
    const missingAppearance = [];
    const missingSchemes = [];
    const appearance = [];
    const storedGroups = new Set(normalized.appearance.map(bundle => bundle.group));
    const expressions = new Map((character?.Appearance || []).map(item => [item?.Asset?.Group?.Name, item?.Property?.Expression]).filter(([, value]) => value != null));
    // Keep the character's currently valid required body/face Appearance items
    // as a compatibility fallback when an older set was saved without them.
    // Clothing and AllowNone groups are intentionally excluded so old clothes
    // cannot leak into a complete set application.
    for (const item of character?.Appearance || []) {
      const group = item?.Asset?.Group;
      if (!group?.Name || group.Category !== "Appearance" || group.AllowNone === true || group.Clothing === true || storedGroups.has(group.Name)) continue;
      appearance.push({ Asset: item.Asset, Color: cloneJSON(item.Color), Property: prepareSetAppearanceProperty(item.Asset, item.Property) });
      storedGroups.add(group.Name);
    }
    for (const bundle of normalized.appearance) {
      const asset = typeof globalThis.AssetGet === "function" ? AssetGet(character?.AssetFamily || "Female3DCG", bundle.group, bundle.asset) : null;
      if (!asset || asset.Group?.Category !== "Appearance" || asset.Name === TAG_ASSET_NAME) {
        missingAppearance.push({ group: bundle.group, asset: bundle.asset });
        continue;
      }
      const property = prepareSetAppearanceProperty(asset, bundle.property);
      if (expressions.has(bundle.group)) property.Expression = cloneJSON(expressions.get(bundle.group));
      appearance.push({ Asset: asset, Color: cloneJSON(bundle.color), Property: property });
    }
    const schemeById = new Map((data?.schemes || []).map(entry => [entry.id, entry]));
    const equippedIds = [];
    const occupied = new Set();
    for (const reference of normalized.customOutfits) {
      const scheme = schemeById.get(reference.schemeId);
      if (!scheme || schemeSlotGroup(scheme) !== reference.slotGroup || occupied.has(reference.slotGroup)) {
        missingSchemes.push({ ...reference });
        continue;
      }
      let tag = typeof globalThis.AssetGet === "function" ? AssetGet(character?.AssetFamily || "Female3DCG", reference.slotGroup, TAG_ASSET_NAME) : null;
      if (!tag && typeof registerTagAssets === "function") {
        registerTagAssets();
        tag = AssetGet(character?.AssetFamily || "Female3DCG", reference.slotGroup, TAG_ASSET_NAME);
      }
      if (!tag) { missingSchemes.push({ ...reference, reason: "tag-missing" }); continue; }
      const existingIndex = appearance.findIndex(item => item.Asset?.Group?.Name === reference.slotGroup);
      if (existingIndex >= 0) appearance.splice(existingIndex, 1);
      appearance.push({ Asset: tag, Color: "Default", Property: {} });
      occupied.add(reference.slotGroup);
      equippedIds.push(scheme.id);
    }
    return { setId: normalized.id, appearance, equippedIds, missingAppearance, missingSchemes };
  }
