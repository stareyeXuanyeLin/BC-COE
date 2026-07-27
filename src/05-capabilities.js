  const THIRD_PARTY_DENY_TUPLES = new Set([
    "Cloth/交领右衽", "ItemMisc/监控机器人", "BodyCosplay/幽灵", "Shoes/洞洞鞋", "Shoes/玛丽珍皮鞋",
  ]);
  const WEBGL_NAME_PATTERN = /(监控机器人|便携乳泵|牛奶贩卖机|淫纹|触手|shader|webgl)/i;
  // Hide/Block/Effect are ordinary metadata on a large part of the vanilla wardrobe.
  // COE copies only image layers and deliberately does not emulate those formal-item
  // effects, so their presence is informational rather than a reason to disable an asset.
  const PASSIVE_SEMANTIC_FIELDS = ["Hide", "HideItem", "Block", "Effect"];
  const ACTIVE_SEMANTIC_FIELDS = ["SetPose", "OverrideHeight", "HeightModifier", "FixedPosition"];
  const SEMANTIC_FIELDS = [...PASSIVE_SEMANTIC_FIELDS, ...ACTIVE_SEMANTIC_FIELDS];

  function stableFingerprint(value) {
    const seen = new WeakSet();
    const normalize = input => {
      if (input == null || typeof input !== "object") return typeof input === "function" ? "[function]" : input;
      if (seen.has(input)) return "[cycle]";
      seen.add(input);
      if (Array.isArray(input)) return input.map(normalize);
      return Object.fromEntries(Object.keys(input).sort().filter(key => !["Description", "Value", "InventoryPath"].includes(key)).map(key => [key, normalize(input[key])]));
    };
    const text = JSON.stringify(normalize(value));
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function hasFunctionalNonImageLayer(asset) {
    return (asset?.Layer || []).some(layer => !layer?.HasImage && (layer?.Alpha?.length || layer?.GroupAlpha?.length || layer?.TextureMask || layer?.CreateLayerTypes?.length || layer?.AllowTypes));
  }

  function analyzeSourceAsset(asset, context = {}) {
    if (!asset?.Group?.Name || !asset?.Name) {
      return { provider: "third-party", providerVersion: null, signature: null, adapterId: "unsupported", compatibility: "unsupported", reasons: ["asset-missing"], authorization: "unknown" };
    }
    const tuple = `${asset.Group.Name}/${asset.Name}`;
    const customSignals = context.provider === "third-party" || asset.Group?.Family !== "Female3DCG" || asset.__mod || asset.Custom || asset.Group?.Custom || /[^\x00-\x7F]/.test(`${asset.Group.Name}/${asset.Name}`) || /_Luzi(?:$|_)/.test(`${asset.Group.Name}/${asset.Name}`);
    const provider = customSignals ? "third-party" : "vanilla";
    const reasons = [];
    const dynamicBefore = !!asset.DynamicBeforeDraw;
    const dynamicAfter = !!asset.DynamicAfterDraw;
    const dynamicScript = !!asset.DynamicScriptDraw;
    const functionalNonImage = hasFunctionalNonImageLayer(asset);
    const hasSemanticValue = key => asset[key] != null && (!Array.isArray(asset[key]) || asset[key].length);
    const passiveAppearanceSemantics = PASSIVE_SEMANTIC_FIELDS.some(hasSemanticValue);
    const appearanceSemantics = ACTIVE_SEMANTIC_FIELDS.some(hasSemanticValue);
    const extended = !!asset.Archetype || !!asset.Extended || !!asset.AssetArchetype || (asset.Layer || []).some(layer => layer?.CreateLayerTypes?.length || layer?.AllowTypes);
    const requiresWebGL = WEBGL_NAME_PATTERN.test(tuple) || !!asset.__requiresWebGL;
    const usesCustomGroup = asset.Group?.Family !== "Female3DCG" || asset.Group?.Custom === true;
    if (!asset.Wear || asset.IsLock || asset.Group.Category !== "Appearance") reasons.push("not-wearable-appearance");
    if (!(asset.Layer || []).some(isDrawableLayer)) reasons.push("no-static-image-layer");
    if (dynamicBefore) reasons.push("dynamic-before-draw");
    if (dynamicAfter) reasons.push("dynamic-after-draw");
    if (dynamicScript) reasons.push("dynamic-script-draw");
    if (functionalNonImage) reasons.push("functional-non-image-layer");
    if (requiresWebGL) reasons.push("webgl-or-canvas");
    if (appearanceSemantics) reasons.push("formal-appearance-semantics");
    if (THIRD_PARTY_DENY_TUPLES.has(tuple)) reasons.push("manifest-denied");
    const signature = stableFingerprint({
      group: asset.Group.Name, name: asset.Name, dynamic: [dynamicBefore, dynamicAfter, dynamicScript],
      semantics: SEMANTIC_FIELDS.filter(key => asset[key] != null),
      layers: (asset.Layer || []).map(layer => ({ Name: layer.Name ?? null, Priority: layer.Priority, HasImage: !!layer.HasImage, LockLayer: !!layer.LockLayer, ParentGroup: layer.ParentGroup, PoseMapping: layer.PoseMapping, AllowTypes: layer.AllowTypes, CreateLayerTypes: layer.CreateLayerTypes, Alpha: layer.Alpha, GroupAlpha: layer.GroupAlpha, TextureMask: layer.TextureMask })),
    });
    const hardFailure = reasons.some(reason => ["not-wearable-appearance", "no-static-image-layer", "dynamic-before-draw", "dynamic-after-draw", "dynamic-script-draw", "functional-non-image-layer", "webgl-or-canvas", "formal-appearance-semantics", "manifest-denied"].includes(reason));
    const compatibility = hardFailure ? "unsupported" : extended ? "limited" : "safe";
    const adapterId = compatibility === "unsupported" ? "unsupported" : extended ? "typed-static" : "static";
    return {
      provider, providerVersion: null, signature, adapterId, compatibility, reasons,
      requiredPropertyKeys: extended ? ["Type", "TypeRecord"] : [],
      hasDynamicBeforeDraw: dynamicBefore, hasDynamicAfterDraw: dynamicAfter, hasDynamicScriptDraw: dynamicScript,
      hasFunctionalNonImageLayer: functionalNonImage, requiresWebGL, requiresFormalItem: appearanceSemantics || extended,
      usesCustomGroup, hasAppearanceSemantics: appearanceSemantics, hasPassiveAppearanceSemantics: passiveAppearanceSemantics,
      authorization: "allowed",
    };
  }

  function analyzeAssetCached(asset, context) {
    if (!asset || context?.noCache) return analyzeSourceAsset(asset, context);
    let result = capabilityCache.get(asset);
    if (!result) {
      result = Object.freeze(analyzeSourceAsset(asset, context));
      capabilityCache.set(asset, result);
    }
    return result;
  }
