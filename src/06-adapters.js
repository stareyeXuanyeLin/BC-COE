  function sanitizePlainRecord(value, schemaKeys = null, depth = 0) {
    if (value == null) return {};
    if (depth > 2 || Object.prototype.toString.call(value) !== "[object Object]") throw new Error("property-not-plain");
    const entries = Object.entries(value);
    if (entries.length > 16) throw new Error("property-too-many-keys");
    const output = {};
    for (const [key, entry] of entries) {
      if (!/^[A-Za-z0-9_]{1,24}$/.test(key) || (schemaKeys && !schemaKeys.has(key))) throw new Error("property-key-denied");
      if (typeof entry === "boolean") output[key] = entry;
      else if (Number.isInteger(entry) && Math.abs(entry) <= 9999) output[key] = entry;
      else if (typeof entry === "string" && entry.length <= 40) output[key] = entry;
      else throw new Error("property-value-denied");
    }
    return output;
  }

  function sanitizeVisualProperty(value, _analysis, asset) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const output = {};
    if (typeof value.Mirror === "boolean") output.Mirror = value.Mirror;
    if (typeof value.Invert === "boolean") output.Invert = value.Invert;
    // Type/TypeRecord only select image variants. Preserve their small primitive
    // subset regardless of provider; malformed records simply fall back to defaults.
    if (typeof value.Type === "string" && value.Type.length <= 40) output.Type = value.Type;
    if (value.TypeRecord != null) {
      try {
        const keys = new Set((asset?.Layer || []).flatMap(layer => Array.isArray(layer.CreateLayerTypes) ? layer.CreateLayerTypes : []));
        output.TypeRecord = sanitizePlainRecord(value.TypeRecord, keys.size ? keys : null);
      } catch (_) { /* use the asset's default image variant */ }
    }
    return utf8Bytes(output) <= 1024 ? output : {};
  }

  function sanitizeVisualPoseMapping(mapping) {
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return mapping;
    // R130 removed some legacy pose names (notably LegsOpen), while older Echo
    // assets can still carry them. BC ignores those entries but warns on every
    // synthetic redraw, so strip only keys the current runtime does not know.
    if (typeof PoseRecord !== "object" || !PoseRecord) return mapping;
    const output = {};
    let changed = false;
    for (const [poseName, poseType] of Object.entries(mapping)) {
      if (Object.prototype.hasOwnProperty.call(PoseRecord, poseName)) output[poseName] = poseType;
      else changed = true;
    }
    return changed ? output : mapping;
  }

  function createVisualLayerProxy(layer) {
    const poseMapping = sanitizeVisualPoseMapping(layer?.PoseMapping);
    return poseMapping === layer?.PoseMapping ? { ...layer } : { ...layer, PoseMapping: poseMapping };
  }

  function createVisualAssetProxy(asset) {
    // COE is a static layer compositor, not a second formal item system. A shallow
    // proxy keeps image-path/pose/color metadata while preventing CommonDraw from
    // invoking the source asset's dynamic or ExtendedItem behavior on a synthetic item.
    // LSCG treats unregistered Asset-like objects as Items and reads `.Asset.Group`;
    // expose the source Asset through that compatibility shape without registering
    // the proxy globally. Its opacity hook also tries to enable DynamicBeforeDraw,
    // so inert dynamic flags deliberately ignore external writes.
    const proxy = {
      ...asset,
      Archetype: null,
      AssetArchetype: null,
      Extended: false,
      // A synthetic visual item must never re-activate formal appearance
      // semantics while BC computes its coordinates or effects.
      FixedPosition: undefined,
      SetPose: undefined,
      OverrideHeight: undefined,
      HeightModifier: undefined,
      Hide: [],
      HideItem: [],
      Block: [],
      Effect: [],
      __coeVisualProxy: true,
      __coeSourceAsset: asset,
    };
    Object.defineProperty(proxy, "Asset", { value: asset, enumerable: false, configurable: false, writable: false });
    for (const key of ["DynamicBeforeDraw", "DynamicAfterDraw", "DynamicScriptDraw"]) {
      Object.defineProperty(proxy, key, { enumerable: true, configurable: false, get: () => false, set: () => {} });
    }
    return proxy;
  }

  function buildStaticSynthetic({ character, material, refs, asset, analysis, overall = null }) {
    const drawable = refs.map(ref => ({ ref, sourceLayer: resolveSourceLayer(asset, ref) }))
      .filter(entry => isDrawableLayer(entry.sourceLayer))
      .sort((a, b) => (a.ref.sourceLayerIndex ?? asset.Layer.indexOf(a.sourceLayer)) - (b.ref.sourceLayerIndex ?? asset.Layer.indexOf(b.sourceLayer)));
    if (!drawable.length) throw new Error("no-drawable-layer");
    // Byte budget check 在拆分前对整个素材+所有引用做一次
    if (utf8Bytes({ material: compactMaterialForStorage(material), refs: refs.map(compactLayerForStorage) }) > MAX_MATERIAL_BYTES)
      throw new Error("material-byte-budget");
    const colors = resolveMaterialColors(material, asset, refs);
    const baseProperty = sanitizeVisualProperty(material.sourceProperty || {}, analysis, asset);
    // 每层生成独立的 Item，Property 各自携带该层的变换
    const results = drawable.map((entry, index) => {
      const { ref, sourceLayer } = entry;
      const visualAsset = createVisualAssetProxy(asset);
      const perLayerProperty = { ...baseProperty };
      if (typeof ref.rotation === "number" && isFinite(ref.rotation) && ref.rotation !== 0)
        perLayerProperty.Rotation = clamp(ref.rotation, -Math.PI, Math.PI);
      if (typeof ref.scale === "number" && isFinite(ref.scale) && Math.abs(ref.scale - 1) > 0.001)
        perLayerProperty.Scale = clamp(ref.scale, 0.25, 3.0);
      // 素材服装组整体变换参数注入
      if (overall) {
        if (typeof overall.rotation === "number" && overall.rotation !== 0)
          perLayerProperty.OverallRotation = clamp(overall.rotation, -Math.PI, Math.PI);
        if (typeof overall.scale === "number" && Math.abs(overall.scale - 1) > 0.001)
          perLayerProperty.OverallScale = clamp(overall.scale, 0.25, 3.0);
        if (typeof overall.offsetX === "number" && overall.offsetX !== 0)
          perLayerProperty.OverallOffsetX = clamp(overall.offsetX, -1200, 1200);
        if (typeof overall.offsetY === "number" && overall.offsetY !== 0)
          perLayerProperty.OverallOffsetY = clamp(overall.offsetY, -1200, 1200);
        perLayerProperty.OverallCenterX = overall.centerX;
        perLayerProperty.OverallCenterY = overall.centerY;
      }
      const item = {
        Asset: visualAsset,
        Color: colors,
        Property: perLayerProperty,
        __coeMaterialId: `${material.id}:${ref.sourceLayerIndex ?? index}`,
      };
      return { material, item, drawable: [{ ref, sourceLayer }], analysis, overall };
    });
    return results;
  }
