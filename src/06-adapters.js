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
    // R130 removed some legacy pose names (notably LegsOpen), while older third-party
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

  function noteLayerVisibilityFallback(asset, layer, reason) {
    const message = `素材图层判定回退：${asset?.Group?.Name || "?"}/${asset?.Name || "?"}/${layer?.Name || "默认层"}：${String(reason?.message || reason)}`;
    if (!diagnostics.lastWarnings.includes(message)) {
      diagnostics.lastWarnings.push(message);
      diagnostics.lastWarnings = diagnostics.lastWarnings.slice(-20);
    }
  }

  function sourceLayerVisible(character, layer, asset, sourceProperty) {
    const typeRecord = sourceProperty?.TypeRecord || null;
    // R130 centralizes AllowTypes, HideAs, pose and character-attribute checks in
    // this predicate. Reuse it before COE creates a visual proxy so an invalid
    // source layer never reaches CommonDraw or URL generation.
    if (typeof globalThis.CharacterAppearanceIsLayerVisible === "function") {
      try { return CharacterAppearanceIsLayerVisible(character, layer, asset, typeRecord) === true; }
      catch (error) {
        noteLayerVisibilityFallback(asset, layer, error);
        // Some third-party layers carry partial metadata that the full R130
        // predicate cannot inspect outside a formal worn item. Preserve the
        // important AllowTypes check when possible; unconditional static layers
        // are safe to keep instead of making the whole material disappear.
        if (!layer?.AllowTypes) return true;
      }
    }
    // Compatibility fallback for older runtimes. Conditional layers still use
    // BC's own modular type evaluator rather than reimplementing its AND/OR rules.
    if (!layer?.AllowTypes) return true;
    if (typeof globalThis.CharacterAppearanceAllowForTypes === "function") {
      try { return CharacterAppearanceAllowForTypes(layer.AllowTypes, typeRecord) === true; }
      catch (error) { noteLayerVisibilityFallback(asset, layer, error); }
    }
    return false;
  }

  function createVisualAssetProxy(asset, owner = asset) {
    const cached = visualAssetProxyCache.get(owner);
    if (cached) return cached;
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
    visualAssetProxyCache.set(owner, proxy);
    return proxy;
  }

  function buildStaticSynthetic({ character, material, refs, asset, analysis, overall = null }) {
    const sourceProperty = sanitizeVisualProperty(material.sourceProperty || {}, analysis, asset);
    const candidates = refs.map(ref => ({ ref, sourceLayer: resolveSourceLayer(asset, ref) }))
      .filter(entry => isDrawableLayer(entry.sourceLayer));
    let drawable = candidates.filter(entry => sourceLayerVisible(character, entry.sourceLayer, asset, sourceProperty));
    // Third-party Extended Items occasionally require formal-item state that a
    // static COE material deliberately does not instantiate. If every referenced
    // layer is rejected, retaining the user's explicitly selected static layers is
    // preferable to silently dropping the entire material. Partial matches remain
    // strictly filtered, so ordinary typed variants still use BC's exact result.
    if (!drawable.length && candidates.length && analysis?.provider === "third-party") {
      drawable = candidates;
      noteLayerVisibilityFallback(asset, null, "全部图层被条件判定拒绝，已保留显式选择的静态图层");
    }
    drawable.sort((a, b) => (a.ref.sourceLayerIndex ?? asset.Layer.indexOf(a.sourceLayer)) - (b.ref.sourceLayerIndex ?? asset.Layer.indexOf(b.sourceLayer)));
    if (!drawable.length) throw new Error("no-drawable-layer");
    // Byte budgets are enforced at persistence and remote-protocol boundaries.
    // Avoid serializing unchanged material data on every preview frame.
    const colors = resolveMaterialColors(material, asset, refs);
    const baseProperty = sourceProperty;
    // 每层生成独立的 Item，Property 各自携带该层的变换
    const results = drawable.map((entry, index) => {
      const { ref, sourceLayer } = entry;
      // CommonDraw resolves an Item by Asset object identity. Share the proxy only
      // inside one material; two materials using the same source Asset may carry
      // different colors and properties and therefore need distinct identities.
      const visualAsset = createVisualAssetProxy(asset, material);
      const perLayerProperty = { ...baseProperty };
      if (typeof ref.rotation === "number" && isFinite(ref.rotation) && ref.rotation !== 0)
        perLayerProperty.Rotation = clamp(ref.rotation, -Math.PI, Math.PI);
      if (typeof ref.scale === "number" && isFinite(ref.scale) && Math.abs(ref.scale - 1) > 0.001)
        perLayerProperty.Scale = clamp(ref.scale, 0.25, 3.0);
      if (ref.mirrorX === true) perLayerProperty.MirrorX = true;
      if (ref.mirrorY === true) perLayerProperty.MirrorY = true;
      // 素材服装组整体变换参数注入
      if (overall) {
        if (typeof overall.rotation === "number" && overall.rotation !== 0)
          perLayerProperty.OverallRotation = clamp(overall.rotation, -Math.PI, Math.PI);
        if (typeof overall.scale === "number" && Math.abs(overall.scale - 1) > 0.001)
          perLayerProperty.OverallScale = clamp(overall.scale, 0.25, 3.0);
        if (overall.mirrorX === true) perLayerProperty.OverallMirrorX = true;
        if (overall.mirrorY === true) perLayerProperty.OverallMirrorY = true;
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
