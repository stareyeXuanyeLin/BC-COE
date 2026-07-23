  const ECHO_EXPECTED_VERSION = "1.129.4";
  const ECHO_MANIFEST = Object.freeze({
    // Runtime fingerprints must be captured from the actual 1.129.4 build before
    // an entry can become safe. Empty signatures intentionally fail closed.
    "Shoes/鱼嘴高跟鞋": { class: "A", signature: null, adapterId: "echo-static" },
    "Bra/女仆胸罩": { class: "A", signature: null, adapterId: "echo-static" },
  });
  const ECHO_DENY_TUPLES = new Set([
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

  function echoRuntimeInfo() {
    let tag = null;
    let mod = null;
    try {
      const mods = typeof globalThis.bcModSdk?.getModsInfo === "function" ? bcModSdk.getModsInfo() : [];
      mod = mods.find(info => /echo-clothing-ext|Echo.*服装|服装拓展/i.test(`${info?.name || ""} ${info?.fullName || ""} ${info?.repository || ""}`)) || null;
      const tagApi = globalThis.CharacterTag;
      if (tagApi && typeof tagApi.get === "function" && globalThis.Player) {
        for (const name of [mod?.name, "Echo的服装拓展", "echo-clothing-ext", "服装拓展"].filter(Boolean)) {
          tag = tagApi.get(Player, name);
          if (tag) break;
        }
      }
    } catch (_) { /* fail closed */ }
    const version = typeof tag?.version === "string" ? tag.version : typeof mod?.version === "string" ? mod.version : null;
    const detected = !!tag || !!mod || (globalThis.Asset || []).some(asset => ECHO_MANIFEST[`${asset?.Group?.Name}/${asset?.Name}`] || ECHO_DENY_TUPLES.has(`${asset?.Group?.Name}/${asset?.Name}`));
    // This editor only renders on the local Player and never syncs synthetic items.
    // A registered Echo runtime is sufficient evidence that the local Player may use
    // its already-loaded assets; CharacterTag remains an additional positive signal.
    return { detected, version, verified: version === ECHO_EXPECTED_VERSION, authorization: tag || mod ? "allowed" : "unknown" };
  }

  function hasFunctionalNonImageLayer(asset) {
    return (asset?.Layer || []).some(layer => !layer?.HasImage && (layer?.Alpha?.length || layer?.GroupAlpha?.length || layer?.TextureMask || layer?.CreateLayerTypes?.length || layer?.AllowTypes));
  }

  function analyzeSourceAsset(asset, context = {}) {
    if (!asset?.Group?.Name || !asset?.Name) {
      return { provider: "unknown-mod", providerVersion: null, signature: null, adapterId: "unsupported", compatibility: "unsupported", reasons: ["asset-missing"], authorization: "unknown" };
    }
    const tuple = `${asset.Group.Name}/${asset.Name}`;
    const manifest = ECHO_MANIFEST[tuple];
    const echo = echoRuntimeInfo();
    const explicitEcho = !!manifest || ECHO_DENY_TUPLES.has(tuple) || context.provider === "echo";
    const customSignals = asset.Group?.Family !== "Female3DCG" || asset.__mod || asset.Custom || asset.Group?.Custom || /[^\x00-\x7F]/.test(`${asset.Group.Name}/${asset.Name}`) || /_Luzi(?:$|_)/.test(`${asset.Group.Name}/${asset.Name}`);
    // Echo 1.129.4 registers many assets whose only stable runtime fingerprint is a
    // Chinese/internal custom name. Once the exact Echo runtime is detected, treat
    // those custom assets as Echo candidates instead of rejecting all of them as an
    // unknown provider. Dynamic and semantic capability checks still fail closed.
    const echoCandidate = explicitEcho || (echo.detected && customSignals);
    const customUnknown = !echoCandidate && customSignals;
    const provider = echoCandidate ? "echo" : customUnknown ? "unknown-mod" : "vanilla";
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
    if (ECHO_DENY_TUPLES.has(tuple)) reasons.push("manifest-denied");
    if (provider === "unknown-mod") reasons.push("unknown-provider");
    if (provider === "echo" && !echo.verified) reasons.push(echo.version ? "echo-version-mismatch" : "echo-version-unknown");
    if (provider === "echo" && echo.authorization !== "allowed") reasons.push("authorization-unknown");
    const signature = stableFingerprint({
      group: asset.Group.Name, name: asset.Name, dynamic: [dynamicBefore, dynamicAfter, dynamicScript],
      semantics: SEMANTIC_FIELDS.filter(key => asset[key] != null),
      layers: (asset.Layer || []).map(layer => ({ Name: layer.Name ?? null, Priority: layer.Priority, HasImage: !!layer.HasImage, LockLayer: !!layer.LockLayer, ParentGroup: layer.ParentGroup, PoseMapping: layer.PoseMapping, AllowTypes: layer.AllowTypes, CreateLayerTypes: layer.CreateLayerTypes, Alpha: layer.Alpha, GroupAlpha: layer.GroupAlpha, TextureMask: layer.TextureMask })),
    });
    // A null signature means no pinned signature is available yet, not that a static
    // asset must be permanently unusable. If a signature is pinned, enforce it.
    if (provider === "echo" && manifest?.signature && manifest.signature !== signature) reasons.push("signature-unverified");
    const hardFailure = reasons.some(reason => ["not-wearable-appearance", "no-static-image-layer", "dynamic-before-draw", "dynamic-after-draw", "dynamic-script-draw", "functional-non-image-layer", "webgl-or-canvas", "formal-appearance-semantics", "manifest-denied", "unknown-provider"].includes(reason));
    const unverified = !hardFailure && reasons.some(reason => /unknown|mismatch|unverified/.test(reason));
    const compatibility = hardFailure ? "unsupported" : unverified ? "unverified" : extended ? "limited" : "safe";
    const adapterId = compatibility === "unsupported" || compatibility === "unverified" ? "unsupported" : (manifest?.adapterId || (provider === "echo" ? (extended ? "echo-typed-static" : "echo-static") : "vanilla-static"));
    return {
      provider, providerVersion: provider === "echo" ? echo.version : null, signature, adapterId, compatibility, reasons,
      requiredPropertyKeys: extended ? ["Type", "TypeRecord"] : [],
      hasDynamicBeforeDraw: dynamicBefore, hasDynamicAfterDraw: dynamicAfter, hasDynamicScriptDraw: dynamicScript,
      hasFunctionalNonImageLayer: functionalNonImage, requiresWebGL, requiresFormalItem: appearanceSemantics || extended,
      usesCustomGroup, hasAppearanceSemantics: appearanceSemantics, hasPassiveAppearanceSemantics: passiveAppearanceSemantics,
      authorization: provider === "echo" ? echo.authorization : "allowed",
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
