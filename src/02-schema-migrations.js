  function wardrobeMigrationError(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
  }

  function readWardrobeSchemaVersion(raw) {
    if (raw?.schemaVersion == null) return 0;
    if (!Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 0) {
      throw wardrobeMigrationError("invalid-schema-version", "衣柜结构版本无效");
    }
    return raw.schemaVersion;
  }

  function validateStoredWardrobeShape(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw wardrobeMigrationError("wardrobe-root", "衣柜数据根节点无效");
    }
    if (!Array.isArray(raw.schemes) || !Array.isArray(raw.equippedIds)) {
      throw wardrobeMigrationError("wardrobe-shape", "衣柜缺少方案列表或启用列表");
    }
    const schemaVersion = readWardrobeSchemaVersion(raw);
    if (schemaVersion >= 2 && !Array.isArray(raw.sets)) {
      throw wardrobeMigrationError("wardrobe-sets-shape", "衣柜缺少套装列表");
    }
    if (Array.isArray(raw.sets) && raw.sets.length > MAX_SETS) {
      throw wardrobeMigrationError("too-many-sets", `套装衣柜超过 ${MAX_SETS} 套`);
    }
    const setIds = new Set();
    const setSlots = new Set();
    for (const set of Array.isArray(raw.sets) ? raw.sets : []) {
      validateStoredSetShape(set);
      if (setIds.has(set.id)) throw wardrobeMigrationError("duplicate-set-id", "衣柜包含重复的套装 ID");
      if (schemaVersion >= 3) {
        if (!Number.isInteger(set.slot) || set.slot < 0 || set.slot >= MAX_SETS) throw wardrobeMigrationError("invalid-set-storage-slot", "套装储存格无效");
        if (setSlots.has(set.slot)) throw wardrobeMigrationError("duplicate-set-storage-slot", "衣柜包含重复的套装储存格");
        setSlots.add(set.slot);
      }
      setIds.add(set.id);
    }
    if (raw.schemes.length > MAX_SCHEMES) {
      throw wardrobeMigrationError("too-many-schemes", `衣柜服装超过 ${MAX_SCHEMES} 套`);
    }
    const schemeIds = new Set();
    for (const scheme of raw.schemes) {
      if (!scheme || typeof scheme !== "object" || Array.isArray(scheme)) {
        throw wardrobeMigrationError("invalid-scheme", "衣柜包含无效的服装方案");
      }
      if (typeof scheme.id === "string" && scheme.id) {
        if (schemeIds.has(scheme.id)) throw wardrobeMigrationError("duplicate-scheme-id", "衣柜包含重复的方案 ID");
        schemeIds.add(scheme.id);
      }
      const composition = scheme.composition;
      if (!composition || typeof composition !== "object" || Array.isArray(composition)) {
        throw wardrobeMigrationError("invalid-composition", "衣柜包含无效的服装数据");
      }
      if (composition.version != null && (!Number.isInteger(Number(composition.version)) || Number(composition.version) > COMPOSITION_VERSION)) {
        throw wardrobeMigrationError("newer-outfit-schema", "衣柜包含由更新版本创建的服装");
      }
      if (Array.isArray(composition.layers) && composition.layers.length > MAX_LAYERS) {
        throw wardrobeMigrationError("too-many-layers", `服装图层超过 ${MAX_LAYERS} 个`);
      }
      if (Array.isArray(composition.recycle) && composition.recycle.length > MAX_LAYERS) {
        throw wardrobeMigrationError("too-many-recycled-layers", `服装回收区图层超过 ${MAX_LAYERS} 个`);
      }
      if (Array.isArray(composition.materials) && composition.materials.length > MAX_LAYERS) {
        throw wardrobeMigrationError("too-many-materials", `服装素材超过 ${MAX_LAYERS} 件`);
      }
    }
  }

  const WARDROBE_MIGRATIONS = Object.freeze({
    1: raw => {
      if (raw.version != null && (!Number.isInteger(Number(raw.version)) || Number(raw.version) < 0)) {
        throw wardrobeMigrationError("invalid-legacy-version", "旧衣柜版本无效");
      }
      if (Number(raw.version || 0) > LEGACY_WARDROBE_VERSION) {
        throw wardrobeMigrationError("newer-legacy-schema", "旧格式衣柜由更新版本的插件创建");
      }
      return {
        schemaVersion: 1,
        schemes: cloneJSON(raw.schemes),
        equippedIds: cloneJSON(raw.equippedIds),
      };
    },
    2: raw => ({
      schemaVersion: 2,
      schemes: cloneJSON(raw.schemes),
      sets: [],
      equippedIds: cloneJSON(raw.equippedIds),
    }),
    3: raw => ({
      schemaVersion: 3,
      schemes: cloneJSON(raw.schemes),
      sets: (raw.sets || []).slice(0, MAX_SETS).map((set, slot) => ({ ...cloneJSON(set), slot })),
      equippedIds: cloneJSON(raw.equippedIds),
    }),
  });

  function migrateWardrobeData(raw) {
    validateStoredWardrobeShape(raw);
    const fromVersion = readWardrobeSchemaVersion(raw);
    if (fromVersion > WARDROBE_SCHEMA_VERSION) {
      throw wardrobeMigrationError("newer-schema", "衣柜数据需要更新版本的插件");
    }

    let current = cloneJSON(raw);
    let version = fromVersion;
    while (version < WARDROBE_SCHEMA_VERSION) {
      const targetVersion = version + 1;
      const migrate = WARDROBE_MIGRATIONS[targetVersion];
      if (typeof migrate !== "function") {
        throw wardrobeMigrationError("missing-migration", `缺少衣柜 v${version} 到 v${targetVersion} 的迁移器`);
      }
      current = migrate(current);
      if (!current || current.schemaVersion !== targetVersion) {
        throw wardrobeMigrationError("invalid-migration-result", `衣柜 v${targetVersion} 迁移结果无效`);
      }
      version = targetVersion;
    }

    validateStoredWardrobeShape(current);
    const storedSchemeIds = new Set(current.schemes.map(entry => entry.id));
    const missingSetReferences = (current.sets || []).reduce((count, set) => count + set.customOutfits.filter(entry => !storedSchemeIds.has(entry.schemeId)).length, 0);
    const normalized = normalizeWardrobe(current, { validateReferences: false });
    const compact = compactWardrobeForStorage(normalized, { validateReferences: false });
    if (compact.schemaVersion !== WARDROBE_SCHEMA_VERSION) {
      throw wardrobeMigrationError("invalid-current-schema", "衣柜迁移后的结构版本无效");
    }
    return {
      data: normalizeWardrobe(compact, { validateReferences: false }),
      compact,
      migrated: fromVersion !== WARDROBE_SCHEMA_VERSION,
      fromVersion,
      toVersion: WARDROBE_SCHEMA_VERSION,
      missingSetReferences,
    };
  }
