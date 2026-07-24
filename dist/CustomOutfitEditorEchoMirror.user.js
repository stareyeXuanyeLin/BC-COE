// ==UserScript==
// @name         Bondage Club - Custom Outfit Editor
// @namespace    https://github.com/stareyeXuanyeLin/BC-COE
// @version      1.0.0
// @description  制作中（WIP）。仓库公开仅便于 Tampermonkey 引用，不建议使用。
// @author       凡尘 / 佩菈
// @match        https://www.bondageprojects.com/R*/*
// @match        https://bondageprojects.com/R*/*
// @match        https://www.bondageprojects.elementfx.com/R*/*
// @match        https://bondageprojects.elementfx.com/R*/*
// @match        https://bondage-europe.com/R*/*
// @match        https://www.bondage-europe.com/R*/*
// @match        https://bondage-asia.com/club/R*/*
// @match        https://www.bondage-asia.com/club/R*/*
// @match        http://localhost:*/*
// @run-at       document-end
// @grant        none
// @downloadURL  https://cdn.jsdelivr.net/gh/stareyeXuanyeLin/BC-COE@main/dist/CustomOutfitEditorEchoMirror.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/stareyeXuanyeLin/BC-COE@main/dist/CustomOutfitEditorEchoMirror.user.js
// ==/UserScript==

(() => {
  "use strict";



  const MOD_NAME = "CustomOutfitEditor";
  const VERSION = "1.8.1";
  console.info(`[${MOD_NAME}] userscript injected`, location.href);
  const SETTINGS_KEY = "CustomOutfitEditor";
  const STORAGE_KEY = "BC.CustomOutfitEditor.v1";
  const STYLE_ID = "coe-style";
  const BUTTON_ID = "coe-entry-button";
  const ROOT_ID = "coe-root";
  const MAX_SCHEMES = 40;
  const MAX_LAYERS = 120;
  const MAX_MATERIAL_BYTES = 8192;
  const MAX_SCHEME_BYTES = 65536;
  const MAX_WARDROBE_BYTES = 262144;

  let modApi = null;
  let runtimeInstalled = false;
  let initialized = false;
  let uiMode = null;
  let editing = null;
  let editingId = null;
  let syntheticByCharacter = new WeakMap();
  let wardrobe = { version: 4, schemes: [], equippedIds: [] };
  let wardrobeReadState = { status: "absent", source: null, server: null, local: null, conflict: false };
  let persistenceBlocked = false;
  let duplicateInstance = false;
  let activeComposition = null;
  let capabilityCache = new WeakMap();
  let runtimeMaterialState = new Map();
  let diagnostics = {
    outboundSyntheticFiltered: 0,
    skippedMaterials: [],
    lastWarnings: [],
  };
  let previewTimer = 0;
  let previewPoseMapping = null;
  let editorAppearanceSnapshot = null;
  let editorPoseSnapshot = null;
  let layerNameCache = null;
  let layerNameCachePromise = null;
  let colorPickerSession = null;
  let colorPickerClosing = false;

  const log = (...args) => console.log(`[${MOD_NAME}]`, ...args);
  const warn = (...args) => console.warn(`[${MOD_NAME}]`, ...args);
  const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || 0));
  const cloneJSON = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const utf8Bytes = value => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : unescape(encodeURIComponent(text)).length;
  };
  const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const escapeHTML = (value) => String(value ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]);

  function toast(message, kind = "info") {
    const host = document.getElementById(ROOT_ID) || document.body;
    if (!host) return;
    const el = document.createElement("div");
    el.className = `coe-toast coe-${kind}`;
    el.textContent = message;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("coe-show"));
    setTimeout(() => {
      el.classList.remove("coe-show");
      setTimeout(() => el.remove(), 220);
    }, 2600);
  }



  function materialKey(group, asset) {
    return `${group}\u0000${asset}`;
  }

  function normalizeLayer(raw) {
    if (!raw || typeof raw !== "object") return null;
    const sourceGroup = typeof raw.sourceGroup === "string" ? raw.sourceGroup : "";
    const sourceAsset = typeof raw.sourceAsset === "string" ? raw.sourceAsset : "";
    if (!sourceGroup || !sourceAsset) return null;
    return {
      materialId: typeof raw.materialId === "string" && raw.materialId ? raw.materialId : null,
      sourceGroup,
      sourceAsset,
      sourceLayer: typeof raw.sourceLayer === "string" ? raw.sourceLayer : null,
      sourceLayerIndex: Number.isInteger(raw.sourceLayerIndex) ? raw.sourceLayerIndex : null,
      layerLabel: typeof raw.layerLabel === "string" ? raw.layerLabel : null,
      priority: clamp(raw.priority, -99, 99),
      defaultPriority: clamp(raw.defaultPriority == null ? raw.priority : raw.defaultPriority, -99, 99),
      offsetX: clamp(raw.offsetX, -1200, 1200),
      defaultOffsetX: clamp(raw.defaultOffsetX, -1200, 1200),
      offsetY: clamp(raw.offsetY, -1200, 1200),
      defaultOffsetY: clamp(raw.defaultOffsetY, -1200, 1200),
      opacity: clamp(raw.opacity == null ? 1 : raw.opacity, 0, 1),
      hidden: raw.hidden === true,
      color: typeof raw.color === "string" && raw.color.trim() ? raw.color.trim() : null,
      defaultOpacity: clamp(raw.defaultOpacity == null ? (raw.opacity == null ? 1 : raw.opacity) : raw.defaultOpacity, 0, 1),
      defaultColor: typeof raw.defaultColor === "string" && raw.defaultColor.trim() ? raw.defaultColor.trim() : null,
      sourceColor: sanitizeColor(raw.sourceColor),
      sourceProperty: sanitizeSourceProperty(raw.sourceProperty),
    };
  }

  function normalizeMaterial(raw) {
    if (!raw || typeof raw !== "object") return null;
    const sourceGroup = typeof raw.sourceGroup === "string" ? raw.sourceGroup : "";
    const sourceAsset = typeof raw.sourceAsset === "string" ? raw.sourceAsset : "";
    if (!sourceGroup || !sourceAsset) return null;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : uid(),
      sourceGroup,
      sourceAsset,
      label: typeof raw.label === "string" ? raw.label.slice(0, 80) : null,
      colors: sanitizeColorArray(raw.colors),
      defaultColors: sanitizeColorArray(raw.defaultColors),
      sourceColor: sanitizeColor(raw.sourceColor),
      sourceProperty: sanitizeSourceProperty(raw.sourceProperty),
      hidden: raw.hidden === true,
      collapsed: raw.collapsed === true,
    };
  }

  function normalizeComposition(raw) {
    const layers = Array.isArray(raw?.layers)
      ? raw.layers.slice(0, MAX_LAYERS).map(normalizeLayer).filter(Boolean)
      : [];
    const recycle = Array.isArray(raw?.recycle)
      ? raw.recycle.slice(0, MAX_LAYERS).map(normalizeLayer).filter(Boolean)
      : [];
    const materials = Array.isArray(raw?.materials)
      ? raw.materials.map(normalizeMaterial).filter(Boolean)
      : [];
    const byKey = new Map(materials.map(material => [materialKey(material.sourceGroup, material.sourceAsset), material]));
    const byId = new Map(materials.map(material => [material.id, material]));
    for (const layer of [...layers, ...recycle]) {
      let material = layer.materialId ? byId.get(layer.materialId) : null;
      if (!material) material = byKey.get(materialKey(layer.sourceGroup, layer.sourceAsset));
      if (!material) {
        const asset = typeof globalThis.AssetGet === "function"
          ? AssetGet(globalThis.Player?.AssetFamily || "Female3DCG", layer.sourceGroup, layer.sourceAsset)
          : null;
        const sourceColors = Array.isArray(layer.sourceColor) ? layer.sourceColor : asset?.DefaultColor;
        material = normalizeMaterial({
          sourceGroup: layer.sourceGroup,
          sourceAsset: layer.sourceAsset,
          label: asset?.Description || layer.sourceAsset,
          colors: sourceColors,
          defaultColors: asset?.DefaultColor,
          sourceColor: layer.sourceColor,
          sourceProperty: layer.sourceProperty,
        });
        materials.push(material);
        byKey.set(materialKey(material.sourceGroup, material.sourceAsset), material);
        byId.set(material.id, material);
      }
      layer.materialId = material.id;
      if (layer.color && typeof globalThis.AssetGet === "function") {
        const asset = AssetGet(globalThis.Player?.AssetFamily || "Female3DCG", layer.sourceGroup, layer.sourceAsset);
        const sourceLayer = asset && resolveSourceLayer(asset, layer);
        if (sourceLayer?.AllowColorize && Number.isInteger(sourceLayer.ColorIndex)) {
          if (!material.colors.length) material.colors = sanitizeColorArray(material.sourceColor);
          if (!material.colors.length) material.colors = sanitizeColorArray(asset.DefaultColor);
          while (material.colors.length <= sourceLayer.ColorIndex) material.colors.push(asset.DefaultColor?.[material.colors.length] || "Default");
          material.colors[sourceLayer.ColorIndex] = layer.color;
          layer.color = null;
        }
      }
    }
    const used = new Set([...layers, ...recycle].map(layer => layer.materialId));
    return {
      version: 3,
      name: String(raw?.name || "未命名方案").slice(0, 60),
      materials: materials.filter(material => used.has(material.id)),
      layers,
      recycle,
    };
  }

  function normalizeWardrobe(raw) {
    const list = Array.isArray(raw?.schemes) ? raw.schemes : [];
    const schemes = list.slice(0, MAX_SCHEMES).map(entry => ({
      id: typeof entry?.id === "string" ? entry.id : uid(),
      composition: normalizeComposition(entry?.composition),
    }));
    const validIds = new Set(schemes.map(entry => entry.id));
    const equippedIds = Array.isArray(raw?.equippedIds)
      ? raw.equippedIds.filter(id => typeof id === "string" && validIds.has(id))
      : [];
    return {
      version: 4,
      schemes,
      equippedIds: [...new Set(equippedIds)],
    };
  }

  function sanitizeColor(value) {
    if (typeof value === "string") return value.slice(0, 40);
    if (Array.isArray(value)) return value.slice(0, 40).map(item => typeof item === "string" ? item.slice(0, 40) : "Default");
    return "Default";
  }

  function sanitizeColorArray(value) {
    if (Array.isArray(value)) return value.slice(0, 40).map(item => typeof item === "string" ? item.slice(0, 40) : "Default");
    if (typeof value === "string") return [value.slice(0, 40)];
    return [];
  }

  function sanitizeSourceProperty(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const output = {};
    if (typeof value.Type === "string" && value.Type.length <= 40) output.Type = value.Type;
    if (typeof value.Mirror === "boolean") output.Mirror = value.Mirror;
    if (typeof value.Invert === "boolean") output.Invert = value.Invert;
    if (typeof value.Rotation === "number" && isFinite(value.Rotation) && value.Rotation !== 0)
      output.Rotation = clamp(value.Rotation, -Math.PI, Math.PI);
    if (typeof value.ScaleX === "number" && isFinite(value.ScaleX) && Math.abs(value.ScaleX - 1) > 0.001)
      output.ScaleX = clamp(value.ScaleX, 0.25, 3.0);
    if (typeof value.ScaleY === "number" && isFinite(value.ScaleY) && Math.abs(value.ScaleY - 1) > 0.001)
      output.ScaleY = clamp(value.ScaleY, 0.25, 3.0);
    if (value.TypeRecord && Object.getPrototypeOf(value.TypeRecord) === Object.prototype) {
      try { output.TypeRecord = sanitizePlainRecord(value.TypeRecord); } catch (_) { /* denied */ }
    }
    return output;
  }

  function compactLayerForStorage(layer) {
    const output = {
      materialId: layer.materialId,
      sourceGroup: layer.sourceGroup,
      sourceAsset: layer.sourceAsset,
      sourceLayer: layer.sourceLayer,
      sourceLayerIndex: layer.sourceLayerIndex,
      priority: layer.priority,
      offsetX: layer.offsetX,
      offsetY: layer.offsetY,
      opacity: layer.opacity,
    };
    if (layer.hidden) output.hidden = true;
    if (layer.color) output.color = layer.color;
    return output;
  }

  function compactMaterialForStorage(material) {
    const output = {
      id: material.id,
      sourceGroup: material.sourceGroup,
      sourceAsset: material.sourceAsset,
    };
    if (material.label) output.label = material.label;
    if (material.colors?.length) output.colors = material.colors;
    if (material.hidden) output.hidden = true;
    const property = sanitizeSourceProperty(material.sourceProperty);
    if (Object.keys(property).length) output.sourceProperty = property;
    return output;
  }

  function compactCompositionForStorage(composition) {
    const normalized = normalizeComposition(composition);
    const compact = {
      version: 3,
      name: normalized.name,
      materials: normalized.materials.map(compactMaterialForStorage),
      layers: normalized.layers.map(compactLayerForStorage),
    };
    if (normalized.recycle.length) compact.recycle = normalized.recycle.map(compactLayerForStorage);
    if (utf8Bytes(compact) > MAX_SCHEME_BYTES) throw new Error("scheme-byte-budget");
    return compact;
  }

  function compactWardrobeForStorage(data) {
    const normalized = normalizeWardrobe(data);
    const compact = {
      version: 4,
      schemes: normalized.schemes.map(entry => ({ id: entry.id, composition: compactCompositionForStorage(entry.composition) })),
      equippedIds: normalized.equippedIds,
    };
    if (utf8Bytes(compact) > MAX_WARDROBE_BYTES) throw new Error("wardrobe-byte-budget");
    return compact;
  }



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
    } else if (value.startsWith("json:")) {
      json = value.slice(5);
      if (!json.trim()) return { status: "corrupt", raw: value, data: null, error: "json-empty" };
    } else {
      return { status: "unsupported", raw: value, data: null, error: "unknown-prefix" };
    }
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root-not-object");
      if (parsed.version != null && Number(parsed.version) > 4) return { status: "unsupported", raw: value, data: null, error: "newer-schema" };
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



  function isLocalPlayer(character) {
    return !!character && character === globalThis.Player;
  }

  function getComposition(character) {
    if (!isLocalPlayer(character)) return null;
    if (uiMode === "editor" && editing) return editing;
    return activeComposition;
  }

  function isEditorRemovableAsset(asset) {
    const group = asset?.Group;
    if (!group || group.Category !== "Appearance" || group.AllowNone !== true) return false;
    const name = group.Name || "";
    const protectedNames = /^(Body|Head|Hair|Eyes|Eyebrows|Mouth|Nose|Ears|Hands|Height|Blush|Emoticon)/;
    return !protectedNames.test(name);
  }

  function shiftOrigin(origin, offset) {
    if (!origin || typeof origin !== "object") return origin;
    const shifted = {};
    for (const [key, value] of Object.entries(origin)) shifted[key] = (Number(value) || 0) + offset;
    return shifted;
  }

  function resolveSourceLayer(asset, ref) {
    if (!asset?.Layer?.length) return null;
    if (Number.isInteger(ref.sourceLayerIndex) && asset.Layer[ref.sourceLayerIndex]) {
      const candidate = asset.Layer[ref.sourceLayerIndex];
      if (ref.sourceLayer == null || candidate.Name === ref.sourceLayer) return candidate;
    }
    if (ref.sourceLayer != null) return asset.Layer.find(layer => layer.Name === ref.sourceLayer) || null;
    return asset.Layer.find(layer => layer.Name == null) || asset.Layer[0] || null;
  }

  function isDrawableLayer(layer) {
    return !!layer?.HasImage && !layer.LockLayer;
  }

  function getMaterialAssets(query = "") {
    const q = query.trim().toLowerCase();
    return (globalThis.Asset || []).filter(asset => {
      if (!asset?.Wear || asset.IsLock) return false;
      if (!asset.Layer?.some(isDrawableLayer)) return false;
      const text = `${asset.Group?.Name || ""} ${asset.Name || ""} ${asset.Description || ""}`.toLowerCase();
      return !q || text.includes(q);
    }).slice(0, 800);
  }



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
    if (typeof value.Rotation === "number" && isFinite(value.Rotation) && value.Rotation !== 0)
      output.Rotation = clamp(value.Rotation, -Math.PI, Math.PI);
    if (typeof value.ScaleX === "number" && isFinite(value.ScaleX) && Math.abs(value.ScaleX - 1) > 0.001)
      output.ScaleX = clamp(value.ScaleX, 0.25, 3.0);
    if (typeof value.ScaleY === "number" && isFinite(value.ScaleY) && Math.abs(value.ScaleY - 1) > 0.001)
      output.ScaleY = clamp(value.ScaleY, 0.25, 3.0);
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
      __coeVisualProxy: true,
      __coeSourceAsset: asset,
    };
    Object.defineProperty(proxy, "Asset", { value: asset, enumerable: false, configurable: false, writable: false });
    for (const key of ["DynamicBeforeDraw", "DynamicAfterDraw", "DynamicScriptDraw"]) {
      Object.defineProperty(proxy, key, { enumerable: true, configurable: false, get: () => false, set: () => {} });
    }
    return proxy;
  }

  function buildStaticSynthetic({ character, material, refs, asset, analysis }) {
    const drawable = refs.map(ref => ({ ref, sourceLayer: resolveSourceLayer(asset, ref) }))
      .filter(entry => isDrawableLayer(entry.sourceLayer))
      .sort((a, b) => (a.ref.sourceLayerIndex ?? asset.Layer.indexOf(a.sourceLayer)) - (b.ref.sourceLayerIndex ?? asset.Layer.indexOf(b.sourceLayer)));
    if (!drawable.length) throw new Error("no-drawable-layer");
    const visualAsset = createVisualAssetProxy(asset);
    const item = {
      Asset: visualAsset,
      Color: resolveMaterialColors(material, asset, refs),
      Property: sanitizeVisualProperty(material.sourceProperty || refs[0]?.sourceProperty || {}, analysis, asset),
      __coeMaterialId: material.id,
    };
    if (utf8Bytes({ material: compactMaterialForStorage(material), refs: refs.map(compactLayerForStorage) }) > MAX_MATERIAL_BYTES) throw new Error("material-byte-budget");
    return { material, item, drawable, analysis };
  }



  function normalizedMaterialColors(material, asset) {
    const count = Math.max(1, Number(asset?.ColorableLayerCount) || asset?.DefaultColor?.length || 1);
    let colors = sanitizeColorArray(material?.colors);
    if (!colors.length) colors = sanitizeColorArray(material?.sourceColor);
    if (!colors.length) colors = sanitizeColorArray(asset?.DefaultColor);
    if (!colors.length) colors = ["Default"];
    while (colors.length < count) colors.push(asset?.DefaultColor?.[colors.length] || colors[0] || "Default");
    return colors.slice(0, count);
  }

  function resolveMaterialColors(material, asset, refs) {
    const colors = normalizedMaterialColors(material, asset);
    for (const ref of refs) {
      if (!ref.color) continue;
      const sourceLayer = resolveSourceLayer(asset, ref);
      if (sourceLayer?.AllowColorize && Number.isInteger(sourceLayer.ColorIndex)) colors[sourceLayer.ColorIndex] = ref.color;
    }
    return colors;
  }

  function recordMaterialSkip(material, analysis, stage, reason) {
    const entry = { materialId: material?.id || null, group: material?.sourceGroup || null, asset: material?.sourceAsset || null, provider: analysis?.provider || null, providerVersion: analysis?.providerVersion || null, stage, reason: String(reason?.message || reason) };
    runtimeMaterialState.set(material?.id, { disabled: true, analysis: cloneJSON(analysis), reason: entry.reason });
    diagnostics.skippedMaterials.push(entry);
    diagnostics.skippedMaterials = diagnostics.skippedMaterials.slice(-100);
  }

  function buildLocalSyntheticItems(character) {
    const rawComposition = getComposition(character);
    if (!rawComposition || !isLocalPlayer(character)) return [];
    const composition = normalizeComposition(rawComposition);
    const materialMap = new Map(composition.materials.map(material => [material.id, material]));
    const groupedRefs = new Map();
    for (const ref of composition.layers) {
      if (ref.hidden) continue;
      const material = materialMap.get(ref.materialId);
      if (!material || material.hidden) continue;
      if (!groupedRefs.has(material.id)) groupedRefs.set(material.id, []);
      groupedRefs.get(material.id).push(ref);
    }
    const groups = [];
    runtimeMaterialState = new Map();
    for (let materialOrder = 0; materialOrder < composition.materials.length; materialOrder++) {
      const material = composition.materials[materialOrder];
      const refs = groupedRefs.get(material.id) || [];
      if (!refs.length || material.hidden) continue;
      let sourceAsset = null;
      let analysis = null;
      try {
        sourceAsset = AssetGet(character.AssetFamily || "Female3DCG", material.sourceGroup, material.sourceAsset);
        if (!sourceAsset) throw new Error("source-asset-missing");
        if ((character.Appearance || []).some(item => item?.Asset === sourceAsset)) throw new Error("formal-item-conflict");
        // Capability analysis is diagnostic only. Every loaded asset is projected to
        // inert static image layers; unsupported dynamic behavior is not invoked.
        analysis = analyzeAssetCached(sourceAsset);
        const group = buildStaticSynthetic({ character, material, refs, asset: sourceAsset, analysis });
        group.materialOrder = materialOrder;
        group.drawable.forEach((entry, sourceOrder) => { entry.sourceOrder = sourceOrder; });
        groups.push(group);
        runtimeMaterialState.set(material.id, { disabled: false, analysis: cloneJSON(analysis), reason: null });
      } catch (error) {
        recordMaterialSkip(material, analysis, "buildSynthetic", error);
      }
    }
    return groups;
  }

  // 从纹理 URL 解析出资产和图层，获取纹理原始宽高
  function resolveTextureDimensions(url) {
    try {
      // BC 纹理 URL 形如 ./Assets/Female3DCG/Group/Asset/Layer.png
      var parts = url.match(/(?:\.\/)?Assets\/([^/]+)\/([^/]+)\/(.+)\.(png|jpg)$/);
      if (!parts) return null;
      var family = parts[1];
      var groupName = parts[2];
      var rest = parts[3];
      var slashIdx = rest.lastIndexOf("/");
      var assetName = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
      var layerName = slashIdx >= 0 ? rest.slice(slashIdx + 1) : rest;
      var asset = AssetGet(family, groupName, assetName);
      if (!asset) return null;
      var layer = asset.Layer ? asset.Layer.find(function(l) { return l.Name === layerName || l.Image === layerName; }) : null;
      if (!layer) return null;
      return { w: layer.DrawingWidth || asset.Width || 100, h: layer.DrawingHeight || asset.Height || 100 };
    } catch (_) { return null; }
  }

  // 合成图层的变换参数渲染穿线
  function installTransformRenderHooks() {
    // --- ExtendedItemGetDrawingOptions hook ---
    // 为 COE 合成 item 注入 Mirror/Invert（BC 原生消费）以及 Rotation/ScaleX/ScaleY（供 GLDrawImage 包装消费）
    try {
      if (typeof modApi.hookFunction === "function") {
        modApi.hookFunction("ExtendedItemGetDrawingOptions", 5, function(args, next) {
          var item = args[0];
          var base = next(args) || {};
          if (!item || !item.__coeMaterialId) return base;
          var p = item.Property || {};
          base.Mirror = p.Mirror === true;
          base.Invert = p.Invert === true;
          // 只传递非缺省值，保持 drawOptions 精简
          if (typeof p.Rotation === "number" && p.Rotation !== 0) base.Rotation = p.Rotation;
          if (typeof p.ScaleX === "number" && Math.abs(p.ScaleX - 1) > 0.001) base.ScaleX = p.ScaleX;
          if (typeof p.ScaleY === "number" && Math.abs(p.ScaleY - 1) > 0.001) base.ScaleY = p.ScaleY;
          return base;
        });
      }
    } catch (_) { /* ExtendedItemGetDrawingOptions hook 不可用；Mirror/Invert 以默认行为 fallback */ }

    // --- GLDrawImage 包装：加入旋转和缩放的矩阵变换 ---
    try {
      if (typeof GLDrawImage !== "function" || typeof m4 !== "object") return;
      var _gldrawOriginal = GLDrawImage;
      GLDrawImage = function coeGLDrawImage(url, gl, dstX, dstY, options, offsetX) {
        try {
          var opts = options || {};
        var rotation = opts.Rotation;
        var scaleX = opts.ScaleX;
        var scaleY = opts.ScaleY;

        // 无变换时直接走原始函数，保持零开销
        // 条件：rotation 为 falsy（0/undefined），且 ScaleX/ScaleY 为 undefined
        if (!rotation && scaleX == null && scaleY == null) {
          return _gldrawOriginal.call(window, url, gl, dstX, dstY, options, offsetX);
        }

        // --- 变换绘制 ---
        // 策略：先用原始函数完成纹理绑定/着色器选择/透明度等 uniform 设置，
        // 然后在同一 program 下用自定义矩阵覆盖 u_matrix 并再次绘制。
        //
        // ⚠️ 已知限制：当图层 opacity < 1 时，二次绘制会在原始位置留下透明度残影
        // （原始绘制 + 变换绘制各渲染一次，低透明度叠加后两个位置都可见）。
        // 优化方案：在调用原始函数前通过 gl.colorMask 禁止颜色输出，
        // 让原始绘制只产生副作用（纹理绑定、uniform 设置）但不输出颜色。
        // 然后恢复 colorMask 后用自定义矩阵绘制。
        var colorMaskSaved;
        try {
          colorMaskSaved = gl.getParameter(gl.COLOR_WRITEMASK);
          gl.colorMask(false, false, false, false);
          _gldrawOriginal.call(window, url, gl, dstX, dstY, options, offsetX);
        } finally {
          if (colorMaskSaved) gl.colorMask(colorMaskSaved[0], colorMaskSaved[1], colorMaskSaved[2], colorMaskSaved[3]);
        }

        // 解析纹理尺寸
        var dim = resolveTextureDimensions(url);
        if (!dim) return;
        var texW = dim.w, texH = dim.h;
        var cx = texW / 2, cy = texH / 2;
        var sx = typeof scaleX === "number" ? scaleX : 1;
        var sy = typeof scaleY === "number" ? scaleY : 1;
        var off = typeof offsetX === "number" ? offsetX : 0;
        var mirror = opts.Mirror === true;
        var invert = opts.Invert === true;

        var program = gl.getParameter(gl.CURRENT_PROGRAM);
        if (!program) return;

        // 获取 u_matrix 位置。BC 的 GLDraw 在 program 上缓存了此位置，
        // 但用 gl.getUniformLocation 更健壮，不依赖内部实现。
        var uMatrix = program.u_matrix || gl.getUniformLocation(program, "u_matrix");
        if (!uMatrix) return;

        var matrix = m4.orthographic(0, gl.canvas.width, gl.canvas.height, 0, -1, 1);
        matrix = m4.translate(matrix, dstX + off + cx, dstY + cy, 0);
        if (rotation) {
          // BC 的 m4 库可能用 zRotate 命名，标准 gl-matrix 用 rotateZ。
          // 优先用 zRotate（BC 原生），否则 fallback 到标准路径。
          matrix = typeof m4.zRotate === "function"
            ? m4.zRotate(matrix, rotation)
            : m4.multiply(matrix, m4.zRotation(rotation));
        }
        matrix = m4.scale(matrix, sx, sy, 1);
        matrix = m4.translate(matrix, -cx, -cy, 0);
        matrix = m4.scale(matrix, (mirror ? -1 : 1) * texW, (invert ? -1 : 1) * texH, 1);

        gl.uniformMatrix4fv(uMatrix, false, matrix);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        } catch (_coeTransformErr) {
          // 任何异常不传播到 BC 绘制循环，降级为原始绘制
          try { _gldrawOriginal.call(window, url, gl, dstX, dstY, options, offsetX); } catch (_e2) {}
        }
      };
      GLDrawImage._coeTransformWrapped = true;
    } catch (_) { /* GLDrawImage 包装失败，Rotation/Scale 渲染不可用 */ }
  }

  // Backward-compatible internal alias used by the local editor tests/API.
  const buildSyntheticItems = buildLocalSyntheticItems;

  function buildRemoteSyntheticItems(character, snapshot) {
    if (!character || isLocalPlayer(character) || !snapshot) return [];
    const memberNumber = Number(character.MemberNumber);
    const refsByMaterial = new Map();
    for (const layer of snapshot.l || []) {
      if (!refsByMaterial.has(layer.m)) refsByMaterial.set(layer.m, []);
      refsByMaterial.get(layer.m).push({
        materialId: `remote:${memberNumber}:${layer.m}`,
        sourceGroup: snapshot.m[layer.m]?.g,
        sourceAsset: snapshot.m[layer.m]?.a,
        sourceLayer: layer.n,
        sourceLayerIndex: layer.i,
        priority: layer.p,
        offsetX: layer.x,
        offsetY: layer.y,
        opacity: layer.o,
        hidden: false,
      });
    }
    const groups = [];
    for (let materialOrder = 0; materialOrder < (snapshot.m || []).length; materialOrder++) {
      const compact = snapshot.m[materialOrder];
      const refs = refsByMaterial.get(materialOrder) || [];
      if (!refs.length) continue;
      const material = { id: `remote:${memberNumber}:${materialOrder}`, sourceGroup: compact.g, sourceAsset: compact.a, colors: compact.c, sourceProperty: compact.p || {}, hidden: false };
      let analysis = null;
      try {
        const sourceAsset = AssetGet(character.AssetFamily || "Female3DCG", compact.g, compact.a);
        if (!sourceAsset) throw new Error("source-asset-missing");
        if ((character.Appearance || []).some(item => item?.Asset === sourceAsset)) throw new Error("formal-item-conflict");
        // Network refs must bind to the exact local image layer index. A supplied
        // name is an additional consistency check, never a fallback selector.
        for (const ref of refs) {
          const sourceLayer = sourceAsset.Layer?.[ref.sourceLayerIndex];
          if (!sourceLayer || (ref.sourceLayer != null && sourceLayer.Name !== ref.sourceLayer)) throw new Error("source-layer-mismatch");
          if (!isDrawableLayer(sourceLayer)) throw new Error("source-layer-not-drawable");
        }
        analysis = analyzeAssetCached(sourceAsset);
        const group = buildStaticSynthetic({ character, material, refs, asset: sourceAsset, analysis });
        group.materialOrder = materialOrder;
        group.drawable.forEach((entry, sourceOrder) => { entry.sourceOrder = sourceOrder; });
        groups.push(group);
      } catch (error) {
        remoteStore.stats.remoteMaterialsSkipped++;
        remoteDiagnostic("remote-material-skipped", memberNumber, `${compact.g}/${compact.a}:${error?.message || error}`);
      }
    }
    return groups;
  }

  function stableInsertSyntheticLayers(baseLayers, syntheticLayers) {
    if (!Array.isArray(baseLayers) || !syntheticLayers?.length) return baseLayers;
    try {
      const orderedSynthetic = syntheticLayers.slice().sort((a, b) => {
        if (a.Priority !== b.Priority) return a.Priority - b.Priority;
        const am = a.__coeSyntheticLayer;
        const bm = b.__coeSyntheticLayer;
        return (am.materialOrder - bm.materialOrder) || (am.sourceOrder - bm.sourceOrder);
      });
      const output = baseLayers.slice();
      for (const layer of orderedSynthetic) {
        let index = output.length;
        for (let cursor = 0; cursor < output.length; cursor++) {
          if ((Number(output[cursor]?.Priority) || 0) > (Number(layer.Priority) || 0)) { index = cursor; break; }
        }
        output.splice(index, 0, layer);
      }
      return output;
    } catch (error) {
      warn("stableInsert 失败，返回原图层", error);
      return baseLayers;
    }
  }

  function makeSyntheticLayers(groups) {
    const candidates = [];
    for (const group of groups) {
      const materialLayers = [];
      try {
        for (const entry of group.drawable) {
          const ref = entry.ref;
          const visualLayer = createVisualLayerProxy(entry.sourceLayer);
          materialLayers.push({
            ...visualLayer,
            Asset: group.item.Asset,
            Priority: clamp(ref.priority, -99, 99),
            __coeSyntheticLayer: {
              item: group.item, ref, sourceLayer: visualLayer,
              sourceLayerIndex: ref.sourceLayerIndex ?? group.item.Asset.Layer.indexOf(entry.sourceLayer),
              materialOrder: group.materialOrder, sourceOrder: entry.sourceOrder,
            },
          });
        }
        candidates.push(...materialLayers);
      } catch (error) {
        recordMaterialSkip(group.material, group.analysis, "buildLayers", error);
      }
    }
    return candidates;
  }

  function installRenderHooks() {
    modApi.hookFunction("ChatRoomRun", 1000, (args, next) => {
      try {
        if (ChatRoomActiveView == null && typeof ChatRoomRefreshActiveView === "function") ChatRoomRefreshActiveView();
        if (ChatRoomActiveView == null) return;
      } catch (error) {
        warn("聊天室视图尚未就绪，本帧绘制已跳过", error);
        return;
      }
      return next(args);
    });

    modApi.hookFunction("ServerAppearanceBundle", 1000, (args, next) => {
      if (Array.isArray(args[0])) {
        const before = args[0].length;
        args[0] = args[0].filter(item => !item?.__coeMaterialId);
        diagnostics.outboundSyntheticFiltered += before - args[0].length;
      }
      return next(args);
    });

    // bcModSdk 1.2.0 calls higher priorities first. Echo's local snapshot does not
    // hook CharacterAppearanceSortLayers; priority 0 therefore wraps only the
    // verified downstream chain without assuming an arbitrary "late" number.
    modApi.hookFunction("CharacterAppearanceSortLayers", 0, (args, next) => {
      const character = args[0];
      const baseLayers = next(args) || [];
      if (isLocalPlayer(character)) {
        const workingBase = baseLayers;
        const groups = buildLocalSyntheticItems(character);
        syntheticByCharacter.set(character, groups);
        if (!groups.length) return workingBase;
        try {
          return stableInsertSyntheticLayers(workingBase, makeSyntheticLayers(groups));
        } catch (error) {
          warn("构建本地自定义图层失败，本次绘制已跳过", error);
          syntheticByCharacter.set(character, []);
          return baseLayers;
        }
      }
      const snapshot = remotePrefs.receivingEnabled ? remoteSnapshotForCharacter(character) : null;
      if (!snapshot) return baseLayers;
      const groups = buildRemoteSyntheticItems(character, snapshot);
      syntheticByCharacter.set(character, groups);
      if (!groups.length) return baseLayers;
      try {
        return stableInsertSyntheticLayers(baseLayers, makeSyntheticLayers(groups));
      } catch (error) {
        remoteDiagnostic("remote-render-failed", Number(character?.MemberNumber), error?.message || error);
        syntheticByCharacter.set(character, []);
        return baseLayers;
      }
    });

    modApi.hookFunction("CommonDrawAppearanceBuild", 10, (args, next) => {
      const character = args[0];
      const groups = syntheticByCharacter.get(character) || [];
      if (!groups.length) return next(args);
      const originalAppearance = character.Appearance;
      const originalLayers = character.AppearanceLayers;
      try {
        character.Appearance = groups.map(group => group.item).concat(originalAppearance || []);
        character.AppearanceLayers = (originalLayers || []).map(layer => {
          const marker = layer.__coeSyntheticLayer;
          if (!marker) return layer;
          const ref = marker.ref;
          const source = marker.sourceLayer;
          return {
            ...source, Asset: marker.item.Asset, Priority: clamp(ref.priority, -99, 99),
            Opacity: clamp(ref.opacity, 0, 1), MinOpacity: 0, MaxOpacity: 1,
            DrawingLeft: shiftOrigin(source.DrawingLeft, ref.offsetX),
            DrawingTop: shiftOrigin(source.DrawingTop, ref.offsetY),
            __coeSyntheticLayer: marker,
          };
        });
        return next(args);
      } finally {
        character.Appearance = originalAppearance;
        character.AppearanceLayers = originalLayers;
      }
    });

    installTransformRenderHooks();
  }



  function injectStyle() {
    document.getElementById(STYLE_ID)?.remove();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.dataset.coeVersion = VERSION;
    style.textContent = `
#${BUTTON_ID}{position:fixed;left:18px;top:18px;z-index:99980;min-width:176px;border:2px solid #111;border-radius:8px;background:linear-gradient(#fff,#cfeaff);color:#102333;padding:9px 14px;font:700 15px/1.2 system-ui;box-shadow:0 3px 0 #111,0 9px 24px #0008;cursor:pointer}#${BUTTON_ID}:hover{filter:brightness(1.07);transform:translateY(-1px)}
#${ROOT_ID}{position:fixed;inset:0;z-index:99990;background:transparent;color:#111;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;box-sizing:border-box;pointer-events:none}#${ROOT_ID} *{box-sizing:border-box}#${ROOT_ID} button,#${ROOT_ID} input,#${ROOT_ID} select{font:inherit}.coe-panel{position:absolute;inset:0;background:transparent;pointer-events:none}.coe-head{position:absolute;left:0;right:0;top:0;height:72px;display:flex;align-items:center;gap:14px;padding:9px 18px;border-bottom:2px solid #111;background:linear-gradient(180deg,#f6fbff 0,#c4dbe9 100%);color:#132333;box-shadow:0 3px 12px #0008;pointer-events:auto;z-index:3}.coe-brand{display:flex;align-items:center;gap:11px;min-width:0;flex:1}.coe-brand-mark{display:grid;place-items:center;width:42px;height:42px;flex:none;border:2px solid #142535;border-radius:50%;background:#fff;color:#24658e;font-size:22px}.coe-head h2{margin:0;font-size:20px;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.coe-build{display:block;margin-top:3px;color:#496479;font:600 11px/1.2 ui-monospace,Consolas,monospace}.coe-body{position:absolute;right:0;top:72px;bottom:0;width:48%;min-width:560px;padding:12px;overflow:auto;border-left:2px solid #111;background:#d8d8d8f2;box-shadow:-6px 0 18px #0008;pointer-events:auto}.coe-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.coe-head .coe-actions{justify-content:flex-end}.coe-btn{border:2px solid #111923;border-radius:6px;background:linear-gradient(#fff,#c4d2dc);color:#152432;padding:7px 11px;font-weight:700;box-shadow:0 2px 0 #070b0f;cursor:pointer}.coe-btn:hover{filter:brightness(1.07)}.coe-btn:active{transform:translateY(1px);box-shadow:0 1px 0 #070b0f}.coe-primary{background:linear-gradient(#b8e9ff,#54b6eb);color:#071a27}.coe-danger{background:linear-gradient(#ffd0d8,#e67689);color:#32101a}.coe-muted{color:#536b7d}.coe-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.coe-card{border:2px solid #555;border-radius:7px;padding:11px;background:#f4f4f4;color:#142331;box-shadow:0 2px 5px #0003}.coe-card h3{margin:0 0 5px;font-size:16px}.coe-card-title{display:flex;align-items:center;gap:8px}.coe-card-title h3{flex:1}.coe-card.coe-equipped{border:3px solid #1889c8;background:#e0f3ff;box-shadow:0 0 0 2px #8bd2f7 inset}.coe-equipped-badge{display:inline-block;padding:3px 7px;border-radius:4px;background:#d5d5d5;color:#555;font-size:11px}.coe-card.coe-equipped .coe-equipped-badge{background:#1889c8;color:#fff}.coe-wardrobe-summary{margin-bottom:10px;padding:8px 10px;border:1px solid #677b88;border-radius:5px;background:#eef5f9;color:#233b4b;font-size:12px}.coe-remote-prefs{display:grid;gap:7px;margin-bottom:10px;padding:10px;border:2px solid #52758b;border-radius:7px;background:#e7f4fb}.coe-remote-prefs h3{margin:0 0 2px}.coe-remote-prefs label{display:flex;align-items:center;gap:7px;font-weight:700}.coe-remote-prefs input{width:17px;height:17px}.coe-remote-prefs p{margin:2px 0 0;color:#3f5c6d;font-size:11px}.coe-empty{text-align:center;padding:48px 18px;color:#536b7d}
.coe-editor{height:100%;min-height:0}.coe-editor-tools{height:100%;min-height:0;display:grid;grid-template-rows:auto auto minmax(0,1fr);border:2px solid #555;border-radius:6px;background:#ededed;overflow:hidden}.coe-scheme-bar{padding:9px 11px;border-bottom:1px solid #777;background:#f7f7f7}.coe-field{display:flex;align-items:center;gap:8px}.coe-field label{font-weight:700;white-space:nowrap}.coe-field input,.coe-field select,.coe-search{min-width:0;border:1px solid #667c8c;border-radius:5px;background:#fff;color:#111;padding:7px 9px;outline:none}.coe-field input:focus,.coe-search:focus{border-color:#2699dc;box-shadow:0 0 0 2px #4bb9f044}.coe-title-input{width:100%;font-size:16px!important}.coe-tool-tabs{display:flex;gap:6px;padding:7px;border-bottom:1px solid #777;background:#c9c9c9}.coe-tool-tabs .coe-btn{flex:1;padding:6px 9px}.coe-tool-content{min-height:0;overflow:auto;padding:9px}.coe-editor-section{margin-bottom:11px}.coe-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 7px}.coe-section-head h3{margin:0;font-size:14px}.coe-badge{display:inline-flex;align-items:center;min-height:21px;padding:2px 7px;border:1px solid #688296;border-radius:999px;background:#e4f2fb;color:#24516c;font-size:11px}.coe-pose-groups{display:grid;gap:7px}.coe-pose-group{border:1px solid #777;border-radius:6px;padding:7px;background:#fafafa}.coe-pose-group h4{margin:0 0 6px;color:#222;font-size:12px}.coe-pose-buttons{display:flex;flex-wrap:wrap;gap:5px}.coe-pose-buttons .coe-btn{padding:4px 7px;font-size:12px}.coe-pose-buttons button.coe-active{background:linear-gradient(#b8e9ff,#54b6eb);border-color:#116c9d}.coe-hint{padding:7px 9px;border:1px solid #708798;border-radius:6px;background:#e4edf4;color:#233b4b;font-size:11px}.coe-divider{height:1px;background:#888;margin:10px 0}.coe-layer-list{display:flex;flex-direction:column;gap:7px}.coe-layer{border:1px solid #777;border-radius:6px;padding:8px;background:#fafafa}.coe-layer.coe-hidden{opacity:.55}.coe-layer.coe-recycled{opacity:.7;border-style:dashed}.coe-layer-top{display:flex;gap:6px;align-items:center;margin-bottom:7px}.coe-drag-handle{color:#667;cursor:grab}.coe-layer-name{font-weight:700;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.coe-layer-top .coe-btn{padding:4px 6px;font-size:11px}.coe-controls{display:grid;grid-template-columns:repeat(5,minmax(62px,1fr));gap:6px}.coe-controls label{display:flex;flex-direction:column;color:#333;font-size:10px}.coe-controls input{margin-top:3px;width:100%;min-width:0;border:1px solid #777;border-radius:4px;background:#fff;color:#111;padding:5px}.coe-color-choice{display:flex;align-items:center;gap:5px;margin-top:3px;width:100%;min-width:0;height:29px;padding:3px 5px;border:1px solid #667;border-radius:4px;background:#fff;color:#111;cursor:pointer}.coe-color-choice:hover{border-color:#168cca;background:#eaf7ff}.coe-color-choice:disabled{cursor:not-allowed;opacity:.55}.coe-color-swatch{width:18px;height:18px;flex:none;border:1px solid #555;border-radius:3px;background-color:#fff;background-image:linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%);background-size:8px 8px;background-position:0 0,0 4px,4px -4px,-4px 0}.coe-color-swatch::after{display:block;width:100%;height:100%;border-radius:2px;background:var(--coe-color,#fff);content:""}.coe-color-choice code{min-width:0;overflow:hidden;color:inherit;font:700 10px/1.2 ui-monospace,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.coe-material-editor{border:2px solid #666;border-radius:7px;background:#e4e4e4;overflow:hidden}.coe-material-editor+.coe-material-editor{margin-top:9px}.coe-material-editor.coe-hidden{opacity:.58}.coe-material-editor.coe-recycled{border-style:dashed}.coe-material-editor-head{display:flex;align-items:center;gap:7px;padding:8px;background:#d0d0d0;border-bottom:1px solid #777}.coe-material-identity{display:flex;flex:1;min-width:0;flex-direction:column}.coe-material-identity strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.coe-material-identity .coe-muted{font-size:10px}.coe-collapse{width:25px;height:25px;border:0;background:transparent;cursor:pointer}.coe-overall-color{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:700}.coe-overall-color .coe-color-choice{width:auto;max-width:104px;margin-top:0}.coe-material-editor-layers{display:flex;flex-direction:column;gap:7px;padding:7px}.coe-material-editor.coe-collapsed .coe-material-editor-head{border-bottom:0}.coe-recycle-row{display:flex;align-items:center;gap:8px;padding:5px 7px;border:1px solid #888;border-radius:5px;background:#fafafa}.coe-recycle-row span{flex:1}
.coe-material-picker{display:grid;grid-template-rows:auto minmax(0,1fr);height:100%;min-height:0}.coe-material-toolbar{position:sticky;top:-9px;z-index:2;padding:0 0 9px;background:#ededed}.coe-search{width:100%}.coe-materials{display:flex;flex-direction:column;gap:11px;min-height:0}.coe-material-group-title{position:sticky;top:38px;z-index:1;margin:0 0 6px;padding:5px 7px;border-radius:4px;background:#c9c9c9;color:#111;font-size:13px}.coe-material-group{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.coe-material{display:flex;flex-direction:column;align-items:stretch;gap:4px;min-width:0;min-height:136px;border:1px solid #777;border-radius:5px;background:#fafafa;padding:6px;text-align:center;color:#111;cursor:pointer}.coe-material:hover{border-color:#168cca;background:#e2f4ff}.coe-material:disabled{cursor:not-allowed;filter:grayscale(.7);opacity:.58}.coe-material.coe-cap-safe{border-color:#268a52}.coe-material.coe-cap-limited{border-color:#c38b13}.coe-material.coe-cap-unverified,.coe-material.coe-cap-unsupported{border-color:#a34b56}.coe-material img{width:100%;height:96px;object-fit:contain;border-radius:4px;background:#eee}.coe-material strong{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px}.coe-material .coe-muted{font-size:10px}.coe-toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,14px);opacity:0;z-index:100010;background:#e8f4fc;color:#142331;border:2px solid #182735;border-radius:8px;padding:9px 15px;box-shadow:0 7px 22px #0009;transition:.2s;pointer-events:none}.coe-toast.coe-show{transform:translate(-50%,0);opacity:1}.coe-toast.coe-error{background:#ffd3dc}.coe-toast.coe-warn{background:#ffe4a8}
.coe-owned-color-picker{background:linear-gradient(180deg,#f7fbfe 0,#d5e1e8 100%)!important;border:2px solid #172631!important;border-radius:8px;box-shadow:0 8px 28px #000a!important}
@media(max-width:1250px){.coe-body{width:50%;min-width:500px}.coe-grid{grid-template-columns:1fr}.coe-material-group{grid-template-columns:repeat(3,minmax(0,1fr))}.coe-controls{grid-template-columns:repeat(3,minmax(70px,1fr))}}
@media(max-width:800px){.coe-body{width:58%;min-width:0}.coe-head{height:80px;align-items:flex-start}.coe-body{top:80px}.coe-build{display:none}.coe-material-group{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
    document.head.appendChild(style);
  }

  function updateEntryButton() {
    if (!initialized || !document.body) return;
    const isEditingSelf = !globalThis.CharacterAppearanceSelection || globalThis.CharacterAppearanceSelection === globalThis.Player;
    const shouldShow = globalThis.CurrentScreen === "Appearance" && !document.getElementById(ROOT_ID) && isEditingSelf;
    let button = document.getElementById(BUTTON_ID);
    if (shouldShow && !button) {
      button = document.createElement("button");
      button.id = BUTTON_ID;
      button.setAttribute("screen-generated", "Appearance");
      button.dataset.coeBuild = VERSION;
      button.textContent = "✦ 自定义服装设计";
      button.title = `${MOD_NAME} v${VERSION}`;
      button.addEventListener("click", openWardrobe);
      document.body.appendChild(button);
    } else if (!shouldShow && button) button.remove();
  }

  function rootShell(title, actions = "") {
    closeUI();
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.dataset.coeVersion = VERSION;
    root.innerHTML = `<section class="coe-panel"><header class="coe-head"><div class="coe-brand"><span class="coe-brand-mark">✦</span><div><h2>${escapeHTML(title)}</h2><span class="coe-build">${MOD_NAME} v${escapeHTML(VERSION)} · Appearance Workspace</span></div></div><div class="coe-actions">${actions}</div></header><main class="coe-body"></main></section>`;
    root.addEventListener("mousedown", event => event.stopPropagation());
    root.addEventListener("mouseup", event => event.stopPropagation());
    root.addEventListener("click", event => {
      event.stopPropagation();
      if (event.target.closest('[data-action="close"]')) closeUI();
    });
    document.body.appendChild(root);
    updateEntryButton();
    return root.querySelector(".coe-body");
  }

  function cloneAppearanceItems(items) {
    return (items || []).map(item => ({ Asset: item.Asset, Color: cloneJSON(item.Color), Property: cloneJSON(item.Property) }));
  }

  function beginEditorPreview() {
    if (!globalThis.Player || editorAppearanceSnapshot) return;
    // The snapshot is read-only and is used only for source colors/properties.
    // v1.5.2 never replaces Player.Appearance during preview.
    editorAppearanceSnapshot = cloneAppearanceItems(Player.Appearance);
    editorPoseSnapshot = cloneJSON(Player.ActivePoseMapping || {});
    CharacterRefresh(Player, false, false);
  }

  function restoreEditorAppearance() {
    if (!globalThis.Player || !editorAppearanceSnapshot) return;
    if (editorPoseSnapshot) Player.ActivePoseMapping = editorPoseSnapshot;
    editorAppearanceSnapshot = null;
    editorPoseSnapshot = null;
    uiMode = null;
    CharacterRefresh(Player, false, false);
  }

  function closeUI() {
    closeOwnedColorPicker();
    restoreEditorAppearance();
    document.getElementById(ROOT_ID)?.remove();
    if (previewTimer) cancelAnimationFrame(previewTimer);
    previewTimer = 0;
    uiMode = null;
    editing = null;
    editingId = null;
    previewPoseMapping = null;
    setTimeout(updateEntryButton, 0);
  }

  function renderEditor(body) {
    body.innerHTML = `<div class="coe-editor"><aside class="coe-editor-tools"><div class="coe-scheme-bar"><div class="coe-field"><label for="coe-name">方案</label><input id="coe-name" class="coe-title-input" maxlength="60" value="${escapeHTML(editing.name)}"></div></div><nav class="coe-tool-tabs"><button class="coe-btn coe-primary" data-tool="layers">图层与姿势</button><button class="coe-btn" data-tool="materials">＋ 添加素材</button></nav><div class="coe-tool-content"></div></aside></div>`;
    body.querySelector("#coe-name").addEventListener("input", event => { editing.name = event.target.value.slice(0, 60); });
    const tools = body.querySelector(".coe-editor-tools");
    tools.querySelector('[data-tool="layers"]').addEventListener("click", () => renderEditorTools(tools));
    tools.querySelector('[data-tool="materials"]').addEventListener("click", openMaterialPicker);
    renderEditorTools(tools);
  }

  function renderEditorTools(host) {
    const content = host.querySelector(".coe-tool-content");
    host.querySelectorAll("[data-tool]").forEach(button => button.classList.toggle("coe-primary", button.dataset.tool === "layers"));
    content.innerHTML = `<section class="coe-editor-section"><div class="coe-section-head"><h3>角色姿势</h3><span class="coe-badge">编辑预览</span></div><div class="coe-pose-groups"></div></section><div class="coe-hint">编辑预览只在绘制阶段隐藏可移除衣物，不会修改或同步真实 Appearance。图层固定按原素材顺序排列。</div><div class="coe-divider"></div><div class="coe-layer-list"></div>`;
    renderPoseControls(content.querySelector(".coe-pose-groups"));
    const layerList = content.querySelector(".coe-layer-list");
    renderLayerList(layerList);
    ensureLayerNameCache();
    layerNameCachePromise?.then(() => { if (document.body.contains(layerList)) renderLayerList(layerList); });
  }

  function refreshPreview() {
    if (uiMode !== "editor" || !editorAppearanceSnapshot || !globalThis.Player) return;
    CharacterRefresh(Player, false, false);
  }

  function refreshPreviewLoop() {
    if (previewTimer) cancelAnimationFrame(previewTimer);
    previewTimer = requestAnimationFrame(() => {
      previewTimer = 0;
      if (uiMode === "editor" && document.getElementById(ROOT_ID)) refreshPreview();
    });
  }



  function compositionStats(composition) {
    const layers = composition?.layers || [];
    return { layers: layers.length, assets: new Set(layers.map(layer => `${layer.sourceGroup}/${layer.sourceAsset}`)).size };
  }

  function ensureEquippedIds() {
    wardrobe.equippedIds = Array.isArray(wardrobe.equippedIds) ? [...new Set(wardrobe.equippedIds)] : [];
    const validIds = new Set(wardrobe.schemes.map(scheme => scheme.id));
    wardrobe.equippedIds = wardrobe.equippedIds.filter(id => validIds.has(id));
    return wardrobe.equippedIds;
  }

  function combinedEquippedComposition() {
    const equipped = new Set(ensureEquippedIds());
    const selected = wardrobe.schemes.filter(scheme => equipped.has(scheme.id));
    const materials = [];
    const layers = [];
    for (const scheme of selected) {
      const composition = normalizeComposition(scheme.composition);
      const idMap = new Map();
      for (const material of composition.materials) {
        const nextId = `${scheme.id}:${material.id}`;
        idMap.set(material.id, nextId);
        materials.push({ ...cloneJSON(material), id: nextId });
      }
      for (const layer of composition.layers) {
        if (layers.length >= MAX_LAYERS) break;
        layers.push({ ...cloneJSON(layer), materialId: idMap.get(layer.materialId) || layer.materialId });
      }
    }
    return normalizeComposition({
      name: selected.map(scheme => scheme.composition.name).join(" + ") || "已装备方案",
      materials,
      layers,
      recycle: [],
    });
  }

  function refreshLocalComposition() {
    if (!globalThis.Player) return;
    try {
      CharacterRefresh(Player, false, false);
    } catch (error) {
      warn("刷新本地自定义服装失败", error);
    }
  }

  function syncEquippedSchemes() {
    const equippedIds = ensureEquippedIds();
    activeComposition = equippedIds.length ? combinedEquippedComposition() : null;
    refreshLocalComposition();
    if (typeof scheduleLocalRemoteBuild === "function") scheduleLocalRemoteBuild();
    return true;
  }

  function ensureWardrobeWritable() {
    if (!persistenceBlocked) return true;
    toast(`衣柜只读保护：${wardrobeReadState.status}`, "error");
    return false;
  }

  function openWardrobe() {
    restoreEditorAppearance();
    loadWardrobe();
    ensureEquippedIds();
    syncEquippedSchemes();
    const body = rootShell("自定义服装衣柜", '<button class="coe-btn coe-primary" data-action="new">＋ 新建方案</button><button class="coe-btn" data-action="unequip-all">全部卸下</button><button class="coe-btn" data-action="close">关闭</button>');
    uiMode = "wardrobe";
    const root = document.getElementById(ROOT_ID);
    root.classList.add("coe-wardrobe-root");
    root.querySelector('[data-action="new"]').addEventListener("click", () => openEditor({ version: 2, name: "新方案", layers: [], recycle: [] }, null));
    root.querySelector('[data-action="unequip-all"]').addEventListener("click", () => {
      if (!ensureWardrobeWritable()) return;
      wardrobe.equippedIds = [];
      persistWardrobe();
      syncEquippedSchemes();
      renderWardrobe(body);
    });
    renderWardrobe(body);
  }

  function renderRemotePreferences(body) {
    const panel = document.createElement("section");
    panel.className = "coe-remote-prefs";
    panel.innerHTML = `<h3>同房间静态外观共享</h3><label><input type="checkbox" data-remote-sharing ${remotePrefs.sharingEnabled ? "checked" : ""}> 向同房间 COE Remote 用户共享当前外观</label><label><input type="checkbox" data-remote-receiving ${remotePrefs.receivingEnabled ? "checked" : ""}> 显示同房间 COE Remote 用户的外观</label><p>只共享当前启用外观的静态视觉描述，不共享衣柜或图片；对方也必须安装兼容插件。动态、WebGL 和物品功能不会同步，对方缺少素材时会局部缺失。</p>`;
    const commit = () => setRemotePrefs({ sharingEnabled: panel.querySelector("[data-remote-sharing]").checked, receivingEnabled: panel.querySelector("[data-remote-receiving]").checked });
    panel.querySelector("[data-remote-sharing]").addEventListener("change", commit);
    panel.querySelector("[data-remote-receiving]").addEventListener("change", commit);
    body.appendChild(panel);
  }

  function renderWardrobe(body) {
    body.innerHTML = "";
    ensureEquippedIds();
    const equipped = new Set(wardrobe.equippedIds);
    const summary = document.createElement("div");
    summary.className = "coe-wardrobe-summary";
    summary.textContent = persistenceBlocked
      ? `衣柜处于只读保护：${wardrobeReadState.status}。请先通过诊断 API 导出原始数据，当前不会覆盖存储。`
      : equipped.size
      ? `当前在本地显示 ${equipped.size} 套方案。每套方案都可以独立启用或停用，不会写入角色 Appearance。`
      : "当前没有启用自定义方案。方案只在本地显示，不会上传到账号或聊天室 Appearance。";
    body.appendChild(summary);
    renderRemotePreferences(body);
    if (!wardrobe.schemes.length) {
      body.insertAdjacentHTML("beforeend", '<div class="coe-empty"><h3>衣柜还是空的</h3><p>点击顶部“新建方案”，从游戏已经加载的服装中选取图层。</p></div>');
      return;
    }
    const grid = document.createElement("div");
    grid.className = "coe-grid";
    for (const scheme of wardrobe.schemes) {
      const stats = compositionStats(scheme.composition);
      const isEquipped = equipped.has(scheme.id);
      const card = document.createElement("article");
      card.className = `coe-card${isEquipped ? " coe-equipped" : ""}`;
      card.innerHTML = `<div class="coe-card-title"><h3>${escapeHTML(scheme.composition.name)}</h3><span class="coe-equipped-badge">${isEquipped ? "已装备" : "未装备"}</span></div><p class="coe-muted">图层 ${stats.layers} · 素材 ${stats.assets} 件</p><div class="coe-actions"><button class="coe-btn ${isEquipped ? "coe-danger" : "coe-primary"}" data-toggle>${isEquipped ? "停用" : "启用"}</button><button class="coe-btn" data-edit>编辑</button><button class="coe-btn coe-danger" data-delete>删除</button></div>`;
      card.querySelector("[data-toggle]").addEventListener("click", () => {
        if (!ensureWardrobeWritable()) return;
        if (isEquipped) wardrobe.equippedIds = wardrobe.equippedIds.filter(id => id !== scheme.id);
        else wardrobe.equippedIds.push(scheme.id);
        syncEquippedSchemes();
        persistWardrobe();
        renderWardrobe(body);
      });
      card.querySelector("[data-edit]").addEventListener("click", () => openEditor(scheme.composition, scheme.id));
      card.querySelector("[data-delete]").addEventListener("click", () => {
        if (!ensureWardrobeWritable()) return;
        if (!confirm(`删除方案「${scheme.composition.name}」？此操作无法撤销。`)) return;
        wardrobe.schemes = wardrobe.schemes.filter(entry => entry.id !== scheme.id);
        wardrobe.equippedIds = wardrobe.equippedIds.filter(id => id !== scheme.id);
        persistWardrobe();
        syncEquippedSchemes();
        renderWardrobe(body);
      });
      grid.appendChild(card);
    }
    body.appendChild(grid);
  }

  function applyComposition(composition) {
    if (!globalThis.Player) return false;
    activeComposition = normalizeComposition(composition);
    refreshLocalComposition();
    if (typeof scheduleLocalRemoteBuild === "function") scheduleLocalRemoteBuild();
    return true;
  }



  function ensureLayerNameCache() {
    if (layerNameCachePromise || typeof TextCache === "undefined") return;
    layerNameCachePromise = TextCache.buildAsync(`Assets/${globalThis.Player?.AssetFamily || "Female3DCG"}/LayerNames.csv`)
      .then(cache => { layerNameCache = cache; return cache; })
      .catch(error => { warn("图层本地化名称加载失败", error); return null; });
  }

  function getLayerLabel(asset, layer) {
    ensureLayerNameCache();
    const raw = layer?.Name ?? "";
    const key = `${asset?.DynamicGroupName || asset?.Group?.Name || ""}${asset?.Name || ""}${raw}`;
    return layerNameCache?.cache?.[key] || raw || "默认图层";
  }

  function getLayerLabelByRef(ref) {
    const asset = AssetGet(globalThis.Player?.AssetFamily || "Female3DCG", ref.sourceGroup, ref.sourceAsset);
    const layer = asset && Number.isInteger(ref.sourceLayerIndex) ? asset.Layer[ref.sourceLayerIndex] : asset?.Layer?.find(item => item.Name === ref.sourceLayer);
    return asset && layer ? getLayerLabel(asset, layer) : null;
  }

  function materialAsset(material) {
    return material ? AssetGet(globalThis.Player?.AssetFamily || "Female3DCG", material.sourceGroup, material.sourceAsset) : null;
  }

  function ensureMaterialColors(material, asset) {
    material.colors = normalizedMaterialColors(material, asset);
    if (!Array.isArray(material.defaultColors) || !material.defaultColors.length) material.defaultColors = sanitizeColorArray(asset?.DefaultColor);
    return material.colors;
  }

  function displayHexColor(value, fallback = "#ffffff") {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  }

  function normalizePickerColor(value, fallback = "Default") {
    if (value === "Default") return "Default";
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
      return `#${trimmed.slice(1).split("").map(char => char + char).join("")}`.toUpperCase();
    }
    return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toUpperCase() : fallback;
  }

  function updateColorChoice(button, color, swatchFallback, label = color) {
    if (!button) return;
    const swatch = button.querySelector(".coe-color-swatch");
    const code = button.querySelector("code");
    if (swatch) swatch.style.setProperty("--coe-color", displayHexColor(color, swatchFallback));
    if (code) code.textContent = label;
  }

  function unloadOwnedColorPicker(root = null) {
    if (colorPickerClosing) return;
    const picker = root || document.getElementById("color-picker");
    if (!picker && typeof globalThis.ColorPickerUnload !== "function") return;
    colorPickerClosing = true;
    try {
      const unload = typeof globalThis.ColorPickerUnload === "function" ? globalThis.ColorPickerUnload : null;
      unload?.();
    } catch (error) {
      warn("关闭原版颜色选择器失败", error);
    } finally {
      colorPickerClosing = false;
    }
    const remaining = document.getElementById("color-picker");
    if (remaining && (remaining === picker || remaining.classList.contains("coe-owned-color-picker"))) remaining.remove();
  }

  function closeOwnedColorPicker() {
    const session = colorPickerSession;
    const picker = session?.root || document.getElementById("color-picker");
    // session 可能已在原版 onExit 中被清空，但带有 COE 标记的残留节点仍需卸载。
    if (!session && !(picker?.classList.contains("coe-owned-color-picker"))) return;
    session?.finish();
    unloadOwnedColorPicker(picker);
  }

  async function openGameColorPicker({ heading, currentColor, defaultColor, onAccept }) {
    const init = typeof globalThis.ColorPickerInit === "function" ? globalThis.ColorPickerInit : null;
    if (!init) return false;
    if (colorPickerSession) return true;
    const existing = document.getElementById("color-picker");
    if (existing && !existing.hidden) {
      toast("请先完成当前颜色编辑", "warn");
      return true;
    }

    const initialColor = typeof currentColor === "string" ? currentColor : "Default";
    const resetColor = typeof defaultColor === "string" ? defaultColor : "Default";
    const session = {
      root: null,
      previousZIndex: "",
      closed: false,
      finish() {
        if (session.closed) return;
        session.closed = true;
        if (session.root) {
          session.root.style.zIndex = session.previousZIndex;
          session.root.classList.remove("coe-owned-color-picker");
        }
        if (colorPickerSession === session) colorPickerSession = null;
      },
    };
    colorPickerSession = session;

    try {
      const root = await init({
        heading,
        colorState: {
          colors: [initialColor],
          defaultColors: [resetColor],
          opacity: [1],
          defaultOpacity: [1],
          editOpacity: false,
        },
        onInput: () => null,
        onExit: ({ colors }, save) => {
          const selected = normalizePickerColor(colors?.[0], initialColor);
          session.finish();
          // 原版关闭回调不会保证清理 #color-picker，主动卸载并清除残留节点。
          unloadOwnedColorPicker(session.root || document.getElementById("color-picker"));
          if (!save || uiMode !== "editor" || !editing || typeof onAccept !== "function") return;
          try { onAccept(selected); } catch (error) { warn("应用颜色失败", error); toast("颜色没有应用成功", "error"); }
        },
      });
      if (session.closed) {
        unloadOwnedColorPicker(session.root || document.getElementById("color-picker"));
        return true;
      }
      session.root = root || document.getElementById("color-picker");
      if (session.root) {
        session.previousZIndex = session.root.style.zIndex;
        session.root.style.zIndex = "100020";
        session.root.classList.add("coe-owned-color-picker");
      }
      return true;
    } catch (error) {
      session.finish();
      unloadOwnedColorPicker(session.root || document.getElementById("color-picker"));
      warn("原版颜色选择器打开失败", error);
      return false;
    }
  }

  async function chooseColor(options) {
    if (await openGameColorPicker(options)) return;
    const promptFn = typeof globalThis.prompt === "function" ? globalThis.prompt : null;
    if (!promptFn) {
      toast("当前游戏版本未提供颜色选择器", "warn");
      return;
    }
    const input = promptFn("输入颜色代码（#RRGGBB）或 Default", options.currentColor || "Default");
    if (input == null) return;
    const selected = normalizePickerColor(input, null);
    if (!selected) {
      toast("颜色代码无效，请使用 #RRGGBB", "warn");
      return;
    }
    options.onAccept?.(selected);
  }

  function groupLayersByMaterial(layers) {
    const grouped = new Map();
    for (const layer of layers) {
      if (!grouped.has(layer.materialId)) grouped.set(layer.materialId, []);
      grouped.get(layer.materialId).push(layer);
    }
    return grouped;
  }

  function renderLayerList(list) {
    list.innerHTML = "";
    editing = normalizeComposition(editing);
    if (!editing.layers.length && !editing.recycle.length) {
      list.innerHTML = '<div class="coe-empty"><p>还没有素材。点击“添加素材”。</p></div>';
      return;
    }
    const activeByMaterial = groupLayersByMaterial(editing.layers);
    for (const material of editing.materials) {
      const layers = (activeByMaterial.get(material.id) || []).sort((a, b) => (a.sourceLayerIndex ?? 0) - (b.sourceLayerIndex ?? 0));
      if (!layers.length) continue;
      list.appendChild(renderMaterialGroup(material, layers, list));
    }
    if (editing.recycle.length) {
      const title = document.createElement("h3");
      title.textContent = "已清除图层";
      list.appendChild(title);
      const recycledByMaterial = groupLayersByMaterial(editing.recycle);
      for (const material of editing.materials) {
        const layers = recycledByMaterial.get(material.id) || [];
        if (!layers.length) continue;
        const group = document.createElement("section");
        group.className = "coe-material-editor coe-recycled";
        group.innerHTML = `<div class="coe-material-editor-head"><strong>${escapeHTML(material.label || material.sourceAsset)}</strong><span class="coe-muted">${layers.length} 个已清除图层</span><button class="coe-btn coe-primary" data-restore-all>全部还原</button></div><div class="coe-material-editor-layers"></div>`;
        group.querySelector("[data-restore-all]").addEventListener("click", () => {
          editing.layers.push(...layers);
          editing.recycle = editing.recycle.filter(layer => layer.materialId !== material.id);
          refreshPreviewLoop();
          renderLayerList(list);
        });
        const host = group.querySelector(".coe-material-editor-layers");
        layers.sort((a, b) => (a.sourceLayerIndex ?? 0) - (b.sourceLayerIndex ?? 0)).forEach(layer => {
          const row = document.createElement("div");
          row.className = "coe-recycle-row";
          row.innerHTML = `<span>${escapeHTML(layer.layerLabel || getLayerLabelByRef(layer) || layer.sourceLayer || "默认图层")}</span><button class="coe-btn" data-restore>还原</button>`;
          row.querySelector("[data-restore]").addEventListener("click", () => {
            editing.recycle = editing.recycle.filter(item => item !== layer);
            editing.layers.push(layer);
            refreshPreviewLoop();
            renderLayerList(list);
          });
          host.appendChild(row);
        });
        list.appendChild(group);
      }
    }
  }

  function renderMaterialGroup(material, layers, list) {
    const asset = materialAsset(material);
    const colors = ensureMaterialColors(material, asset);
    const defaultHex = displayHexColor(asset?.DefaultColor?.[0], "#ffffff");
    const uniform = colors.every(color => color === colors[0]);
    const overallColor = displayHexColor(uniform ? colors[0] : colors.find(color => /^#[0-9a-f]{6}$/i.test(color)), defaultHex);
    const group = document.createElement("section");
    group.className = `coe-material-editor${material.hidden ? " coe-hidden" : ""}${material.collapsed ? " coe-collapsed" : ""}`;
    const overallLabel = uniform ? colors[0] : "多种颜色";
    var sp = material.sourceProperty || {};
    var rotDeg = Math.round(((sp.Rotation || 0) * 180 / Math.PI) * 100) / 100;
    var scaleXVal = typeof sp.ScaleX === "number" ? sp.ScaleX : 1;
    var scaleYVal = typeof sp.ScaleY === "number" ? sp.ScaleY : 1;
    group.innerHTML = `<div class="coe-material-editor-head"><button class="coe-collapse" type="button" data-collapse>${material.collapsed ? "▶" : "▼"}</button><div class="coe-material-identity"><strong>${escapeHTML(material.label || asset?.Description || material.sourceAsset)}</strong><span class="coe-muted">${escapeHTML(material.sourceGroup)} · ${layers.length} 层</span></div><label class="coe-overall-color">整体颜色<button type="button" class="coe-color-choice" data-overall-color title="使用游戏原版颜色选择器统一修改所有可着色颜色槽"><span class="coe-color-swatch"></span><code>${escapeHTML(overallLabel)}</code></button></label><button class="coe-btn" data-hide-material>${material.hidden ? "显示" : "隐藏"}</button><button class="coe-btn" data-reset-material>整件默认</button><button class="coe-btn coe-danger" data-remove-material>移除素材</button></div><div class="coe-material-transform"><label>旋转<input type="number" step="1" min="-180" max="180" data-transform="rotation" value="${rotDeg}">°</label><label>缩放 X<input type="number" step="0.05" min="0.25" max="3" data-transform="scalex" value="${scaleXVal}"></label><label>缩放 Y<input type="number" step="0.05" min="0.25" max="3" data-transform="scaley" value="${scaleYVal}"></label></div><div class="coe-material-editor-layers"></div>`;
    updateColorChoice(group.querySelector("[data-overall-color]"), overallColor, defaultHex, overallLabel);
    group.querySelector("[data-collapse]").addEventListener("click", () => {
      material.collapsed = !material.collapsed;
      renderLayerList(list);
    });
    group.querySelector("[data-overall-color]").addEventListener("click", () => {
      chooseColor({
        heading: `${material.label || asset?.Description || material.sourceAsset} · 整体颜色`,
        currentColor: overallColor,
        defaultColor: "Default",
        onAccept: value => {
          const count = Math.max(1, Number(asset?.ColorableLayerCount) || colors.length);
          material.colors = Array(count).fill(value);
          layers.forEach(layer => { layer.color = null; });
          refreshPreviewLoop();
          renderLayerList(list);
        },
      });
    });
    group.querySelector("[data-hide-material]").addEventListener("click", () => {
      material.hidden = !material.hidden;
      refreshPreviewLoop();
      renderLayerList(list);
    });
    group.querySelector("[data-reset-material]").addEventListener("click", () => {
      material.colors = sanitizeColorArray(material.defaultColors?.length ? material.defaultColors : asset?.DefaultColor);
      layers.forEach(layer => {
        layer.priority = layer.defaultPriority;
        layer.offsetX = layer.defaultOffsetX;
        layer.offsetY = layer.defaultOffsetY;
        layer.opacity = layer.defaultOpacity;
        layer.color = null;
        layer.hidden = false;
      });
      // 重置变换参数
      if (material.sourceProperty) {
        delete material.sourceProperty.Rotation;
        delete material.sourceProperty.ScaleX;
        delete material.sourceProperty.ScaleY;
      }
      refreshPreviewLoop();
      renderLayerList(list);
    });

    // 变换参数输入监听
    group.querySelectorAll("[data-transform]").forEach(function(input) {
      input.addEventListener("input", function() {
        var raw = parseFloat(this.value);
        if (isNaN(raw)) return;
        if (!material.sourceProperty) material.sourceProperty = {};
        var key = this.dataset.transform;
        if (key === "rotation") {
          raw = clamp(raw, -180, 180);
          raw = Math.round(raw);
          material.sourceProperty.Rotation = raw * Math.PI / 180;
          this.value = raw;
        } else if (key === "scalex") {
          raw = clamp(raw, 0.25, 3.0);
          material.sourceProperty.ScaleX = raw;
          this.value = raw;
        } else if (key === "scaley") {
          raw = clamp(raw, 0.25, 3.0);
          material.sourceProperty.ScaleY = raw;
          this.value = raw;
        }
        refreshPreviewLoop();
      });
    });
    group.querySelector("[data-remove-material]").addEventListener("click", () => {
      const materialId = material.id;
      // 移除代表撤销当前方案对整件素材的选择：启用图层、已清除图层和素材记录都要一起移除。
      // 原始 BC Asset 不受影响，之后仍可从素材选择器重新添加。
      editing.layers = editing.layers.filter(layer => layer.materialId !== materialId);
      editing.recycle = editing.recycle.filter(layer => layer.materialId !== materialId);
      editing.materials = editing.materials.filter(item => item.id !== materialId);
      refreshPreviewLoop();
      renderLayerList(list);
    });
    if (!material.collapsed) renderMaterialLayerCards(group.querySelector(".coe-material-editor-layers"), material, layers, asset, list);
    return group;
  }

  function renderMaterialLayerCards(host, material, layers, asset, list) {
    layers.forEach((layer, layerIndex) => {
      const sourceLayer = resolveSourceLayer(asset, layer);
      const layerName = layer.layerLabel || getLayerLabelByRef(layer) || layer.sourceLayer || `默认图层 #${layer.sourceLayerIndex ?? 0}`;
      const colorIndex = sourceLayer?.ColorIndex ?? 0;
      const canColor = !!sourceLayer?.AllowColorize;
      const colorValue = displayHexColor(material.colors[colorIndex], displayHexColor(asset?.DefaultColor?.[colorIndex], "#ffffff"));
      const card = document.createElement("article");
      card.className = `coe-layer${layer.hidden ? " coe-hidden" : ""}`;
      card.innerHTML = `<div class="coe-layer-top"><span class="coe-layer-name" title="${escapeHTML(`${layer.sourceGroup}/${layer.sourceAsset}/${layerName}`)}">${escapeHTML(layerName)}</span>${sourceLayer?.ColorGroup ? `<span class="coe-badge">颜色组：${escapeHTML(sourceLayer.ColorGroup)}</span>` : ""}<button type="button" class="coe-btn" data-hide>${layer.hidden ? "显示" : "隐藏"}</button><button type="button" class="coe-btn" data-copy>复制</button><button type="button" class="coe-btn" data-reset>本层默认</button><button type="button" class="coe-btn coe-danger" data-remove>清除</button></div><div class="coe-controls"><label>图层位置<input type="number" min="-99" max="99" step="1" data-key="priority" value="${layer.priority}"></label><label>偏移 X<input type="number" min="-1200" max="1200" step="1" data-key="offsetX" value="${layer.offsetX}"></label><label>偏移 Y<input type="number" min="-1200" max="1200" step="1" data-key="offsetY" value="${layer.offsetY}"></label><label>透明度<input type="number" min="0" max="1" step="0.05" data-key="opacity" value="${layer.opacity}"></label><label>图层颜色<button type="button" class="coe-color-choice" data-layer-color="${layerIndex}" ${canColor ? "" : "disabled"} title="${canColor ? `使用游戏原版颜色选择器编辑颜色槽 ${colorIndex}` : "原版将此图层标记为不可着色"}"><span class="coe-color-swatch"></span><code>${escapeHTML(material.colors[colorIndex] || "Default")}</code></button></label></div>`;
      updateColorChoice(card.querySelector("[data-layer-color]"), material.colors[colorIndex] || "Default", colorValue);
      card.querySelector("[data-hide]").addEventListener("click", () => {
        layer.hidden = !layer.hidden;
        refreshPreviewLoop();
        renderLayerList(list);
      });
      card.querySelector("[data-reset]").addEventListener("click", () => {
        layer.priority = layer.defaultPriority;
        layer.offsetX = layer.defaultOffsetX;
        layer.offsetY = layer.defaultOffsetY;
        layer.opacity = layer.defaultOpacity;
        layer.hidden = false;
        layer.color = null;
        if (canColor) material.colors[colorIndex] = material.defaultColors?.[colorIndex] || asset?.DefaultColor?.[colorIndex] || "Default";
        refreshPreviewLoop();
        renderLayerList(list);
      });
      card.querySelector("[data-copy]").addEventListener("click", () => {
        var copy = Object.assign({}, layer);
        copy.layerLabel = (layer.layerLabel || getLayerLabelByRef(layer) || layer.sourceLayer || "默认图层") + "_copy";
        var idx = editing.layers.indexOf(layer);
        editing.layers.splice(idx + 1, 0, copy);
        refreshPreviewLoop();
        renderLayerList(list);
      });
      card.querySelector("[data-remove]").addEventListener("click", () => {
        editing.layers = editing.layers.filter(item => item !== layer);
        editing.recycle.push(layer);
        refreshPreviewLoop();
        renderLayerList(list);
      });
      card.querySelectorAll("[data-key]").forEach(input => input.addEventListener("input", () => {
        const key = input.dataset.key;
        if (key === "opacity") layer[key] = clamp(input.value, 0, 1);
        else if (key === "priority") layer[key] = clamp(input.value, -99, 99);
        else layer[key] = clamp(input.value, -1200, 1200);
        input.value = layer[key];
        refreshPreviewLoop();
      }));
      const colorButton = card.querySelector("[data-layer-color]");
      colorButton?.addEventListener("click", () => {
        if (!canColor) return;
        chooseColor({
          heading: `${material.label || asset?.Description || material.sourceAsset} · ${layerName}`,
          currentColor: material.colors[colorIndex] || "Default",
          defaultColor: material.defaultColors?.[colorIndex] || asset?.DefaultColor?.[colorIndex] || "Default",
          onAccept: value => {
            material.colors[colorIndex] = value;
            layer.color = null;
            refreshPreviewLoop();
            renderLayerList(list);
          },
        });
      });
      host.appendChild(card);
    });
  }

  function openMaterialPicker() {
    const root = document.getElementById(ROOT_ID);
    const host = root?.querySelector(".coe-editor-tools");
    const content = host?.querySelector(".coe-tool-content");
    if (!host || !content) return;
    host.querySelectorAll("[data-tool]").forEach(button => button.classList.toggle("coe-primary", button.dataset.tool === "materials"));
    content.innerHTML = '<div class="coe-material-picker"><div class="coe-material-toolbar"><input class="coe-search" type="search" placeholder="搜索装备格或服装名称……"></div><div class="coe-materials"></div></div>';
    const search = content.querySelector(".coe-search");
    const list = content.querySelector(".coe-materials");
    const render = () => renderMaterials(list, search.value);
    search.addEventListener("input", render);
    ensureLayerNameCache();
    render();
    layerNameCachePromise?.then(() => { if (document.body.contains(list)) render(); });
    search.focus();
  }

  function renderMaterials(list, query) {
    list.innerHTML = "";
    const assets = getMaterialAssets(query);
    if (!assets.length) { list.innerHTML = '<div class="coe-empty">没有匹配的已加载素材。</div>'; return; }
    const groups = new Map();
    for (const asset of assets) {
      const groupName = asset.Group?.Description || asset.Group?.Name || "未分类";
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName).push(asset);
    }
    for (const [groupName, groupAssets] of groups) {
      const section = document.createElement("section");
      section.className = "coe-material-section";
      section.innerHTML = `<h3 class="coe-material-group-title">${escapeHTML(groupName)}</h3>`;
      const grid = document.createElement("div");
      grid.className = "coe-material-group";
      for (const asset of groupAssets) {
        const drawable = asset.Layer.filter(isDrawableLayer);
        const button = document.createElement("button");
        button.className = "coe-material";
        button.title = "提取该素材的静态图片层；动画、脚本和物品功能不会复制";
        const previewPath = typeof globalThis.AssetGetPreviewPath === "function"
          ? `./${AssetGetPreviewPath(asset)}/${encodeURIComponent(asset.Name)}.png`
          : `./Assets/${asset.Group?.Family || "Female3DCG"}/${asset.DynamicGroupName || asset.Group?.Name}/Preview/${encodeURIComponent(asset.Name)}.png`;
        button.innerHTML = `<img loading="lazy" src="${escapeHTML(previewPath)}" alt=""><span><strong>${escapeHTML(asset.Description || asset.Name)}</strong><br><span class="coe-muted">${drawable.length} 层 · 静态提取</span></span>`;
        button.addEventListener("click", () => addAssetLayers(asset));
        grid.appendChild(button);
      }
      section.appendChild(grid);
      list.appendChild(section);
    }
  }

  function addAssetLayers(asset) {
    if (editing.layers.length >= MAX_LAYERS) { toast(`最多允许 ${MAX_LAYERS} 个图层`, "warn"); return; }
    const worn = (editorAppearanceSnapshot || globalThis.Player?.Appearance || []).find(item => item.Asset === asset);
    let material = editing.materials.find(item => item.sourceGroup === asset.Group.Name && item.sourceAsset === asset.Name);
    if (!material) {
      const sourceColor = sanitizeColor(worn?.Color ?? asset.DefaultColor ?? "Default");
      material = normalizeMaterial({
        sourceGroup: asset.Group.Name,
        sourceAsset: asset.Name,
        label: asset.Description || asset.Name,
        colors: Array.isArray(sourceColor) ? sourceColor : asset.DefaultColor?.map(() => sourceColor),
        defaultColors: asset.DefaultColor,
        sourceColor,
        sourceProperty: sanitizeSourceProperty(worn?.Property),
      });
      editing.materials.push(material);
    }
    ensureMaterialColors(material, asset);
    let added = 0;
    asset.Layer.forEach((layer, sourceLayerIndex) => {
      if (!isDrawableLayer(layer) || editing.layers.length >= MAX_LAYERS) return;
      const duplicate = editing.layers.some(ref => ref.materialId === material.id && ref.sourceLayerIndex === sourceLayerIndex);
      if (duplicate) return;
      const defaultOpacity = layer.Opacity ?? 1;
      editing.layers.push(normalizeLayer({ materialId: material.id, sourceGroup: asset.Group.Name, sourceAsset: asset.Name, sourceLayer: layer.Name, sourceLayerIndex, layerLabel: getLayerLabel(asset, layer), priority: layer.Priority, defaultPriority: layer.Priority, offsetX: 0, offsetY: 0, defaultOffsetX: 0, defaultOffsetY: 0, opacity: defaultOpacity, defaultOpacity, color: null, defaultColor: null, sourceColor: material.sourceColor, sourceProperty: material.sourceProperty }));
      added++;
    });
    refreshPreviewLoop();
    toast(added ? `已添加「${material.label || asset.Name}」的 ${added} 个图层` : "这些图层已经在方案中", added ? "info" : "warn");
  }

  function saveEditing() {
    if (!ensureWardrobeWritable()) return;
    editing = normalizeComposition(editing);
    if (!editing.name.trim()) editing.name = "未命名方案";
    const existingIndex = editingId ? wardrobe.schemes.findIndex(scheme => scheme.id === editingId) : -1;
    const entry = { id: editingId || uid(), composition: cloneJSON(editing) };
    if (existingIndex >= 0) wardrobe.schemes[existingIndex] = entry;
    else {
      if (wardrobe.schemes.length >= MAX_SCHEMES) { toast(`衣柜最多保存 ${MAX_SCHEMES} 套方案`, "warn"); return; }
      wardrobe.schemes.unshift(entry);
      editingId = entry.id;
    }
    wardrobe.equippedIds = [...new Set([...(wardrobe.equippedIds || []), entry.id])];
    persistWardrobe();
    restoreEditorAppearance();
    syncEquippedSchemes();
    toast(`已保存「${editing.name}」并在本地启用`);
    openWardrobe();
  }

  function openEditor(composition, id) {
    // rootShell() closes the current wardrobe UI and clears editor state, so prepare
    // the new state first and assign it only after the new shell has been created.
    const nextEditing = normalizeComposition(cloneJSON(composition));
    const nextEditingId = id;
    previewPoseMapping = cloneJSON(globalThis.Player?.ActivePoseMapping || {});
    const actions = '<button class="coe-btn" data-action="back">← 衣柜</button><button class="coe-btn" data-action="add">＋ 添加素材</button><button class="coe-btn coe-primary" data-action="save">保存并启用</button>';
    const body = rootShell("自定义服装编辑器", actions);
    editing = nextEditing;
    editingId = nextEditingId;
    uiMode = "editor";
    const root = document.getElementById(ROOT_ID);
    root.classList.add("coe-editor-root");
    renderEditor(body);
    beginEditorPreview();
    root.querySelector('[data-action="back"]')?.addEventListener("click", openWardrobe);
    root.querySelector('[data-action="add"]')?.addEventListener("click", openMaterialPicker);
    root.querySelector('[data-action="save"]')?.addEventListener("click", saveEditing);
    refreshPreviewLoop();
  }

  function renderPoseControls(host) {
    host.innerHTML = "";
    const poseTable = typeof PoseFemale3DCG !== "undefined" ? PoseFemale3DCG : globalThis.PoseFemale3DCG;
    const poses = Array.isArray(poseTable)
      ? poseTable.filter(pose => pose.AllowMenu || pose.AllowMenuTransient)
      : [];
    const categories = ["BodyFull", "BodyLower", "BodyUpper", "BodyHands"];
    const labels = { BodyFull: "整体姿势", BodyLower: "腿部姿势", BodyUpper: "上身姿势", BodyHands: "手部姿势" };
    for (const category of categories) {
      const available = poses.filter(pose => pose.Category === category);
      if (!available.length) continue;
      const group = document.createElement("section");
      group.className = "coe-pose-group";
      group.innerHTML = `<h4>${labels[category] || category}</h4><div class="coe-pose-buttons"></div>`;
      const buttons = group.querySelector(".coe-pose-buttons");
      for (const pose of available) {
        const button = document.createElement("button");
        button.className = "coe-btn";
        button.textContent = pose.Description || pose.Name;
        button.title = pose.Name;
        if (previewPoseMapping?.[category] === pose.Name) button.classList.add("coe-active");
        button.addEventListener("click", () => {
          setPreviewPose(pose.Name);
          renderPoseControls(host);
        });
        buttons.appendChild(button);
      }
      host.appendChild(group);
    }
  }

  function setPreviewPose(poseName) {
    try {
      if (typeof globalThis.PoseSetActive !== "function" || !globalThis.Player) return;
      PoseSetActive(Player, poseName || null, true, false);
      previewPoseMapping = cloneJSON(Player.ActivePoseMapping || {});
      CharacterRefresh(Player, false, false);
    } catch (error) {
      warn("姿势切换失败", error);
      toast("当前角色无法切换到该姿势", "warn");
    }
  }



  const REMOTE_PROTOCOL = "COE_RVS/2";
  const REMOTE_PREFIX = `${REMOTE_PROTOCOL}|`;
  const REMOTE_LIMITS = Object.freeze({
    content: 1800, chunkData: 1200, chunks: 32, snapshotBytes: 32768,
    materialBytes: 8192, materials: 32, layers: 120, string: 64, color: 40,
  });
  const REMOTE_TYPES = new Set(["STATE", "REQUEST", "CHUNK", "CLEAR"]);
  const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

  function remotePlainObject(value) {
    if (!value || Object.prototype.toString.call(value) !== "[object Object]") return false;
    const proto = Object.getPrototypeOf(value);
    // JSON values created in another realm (tests/iframes) still have a plain
    // Object prototype whose own prototype is null. Class instances do not.
    return proto === null || proto === Object.prototype || (Object.getPrototypeOf(proto) === null && proto.constructor?.name === "Object");
  }

  function remoteAssertTree(value, depth = 0, seen = new Set()) {
    if (value == null || typeof value === "boolean" || typeof value === "string") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("remote-number");
      return;
    }
    if (depth > 3) throw new Error("remote-depth");
    if (typeof value !== "object" || seen.has(value)) throw new Error("remote-object");
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 120) throw new Error("remote-array");
      for (const entry of value) remoteAssertTree(entry, depth, seen);
    } else {
      if (!remotePlainObject(value)) throw new Error("remote-not-plain");
      const keys = Object.keys(value);
      if (keys.length > 128) throw new Error("remote-keys");
      for (const key of keys) {
        if (POLLUTION_KEYS.has(key)) throw new Error("remote-pollution");
        if (key.length > 40) throw new Error("remote-key-length");
        remoteAssertTree(value[key], depth + 1, seen);
      }
    }
    seen.delete(value);
  }

  function remoteString(value, name, max = REMOTE_LIMITS.string, pattern = null) {
    if (typeof value !== "string" || !value || value.length > max || (pattern && !pattern.test(value))) throw new Error(`remote-${name}`);
    return value;
  }

  function remoteInteger(value, name, min = 0, max = 0x7fffffff) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`remote-${name}`);
    return value;
  }

  function normalizeRemoteNumber(value, min, max) {
    if (!Number.isFinite(value)) throw new Error("snapshot-number");
    const bounded = Math.min(max, Math.max(min, value));
    const rounded = Math.round(bounded * 10000) / 10000;
    return Object.is(rounded, -0) ? 0 : rounded;
  }

  function validateRemoteProperty(value) {
    if (value == null) return undefined;
    if (!remotePlainObject(value)) throw new Error("snapshot-property");
    const allowed = new Set(["Type", "Mirror", "Invert", "Rotation", "ScaleX", "ScaleY", "TypeRecord"]);
    const output = {};
    for (const key of Object.keys(value)) {
      if (!allowed.has(key) || POLLUTION_KEYS.has(key)) throw new Error("snapshot-property-key");
    }
    if (value.Type != null) output.Type = remoteString(value.Type, "property-type", 40);
    if (value.Mirror != null) {
      if (typeof value.Mirror !== "boolean") throw new Error("snapshot-property-mirror");
      output.Mirror = value.Mirror;
    }
    if (value.Invert != null) {
      if (typeof value.Invert !== "boolean") throw new Error("snapshot-property-invert");
      output.Invert = value.Invert;
    }
    if (value.Rotation != null) {
      if (typeof value.Rotation !== "number" || !Number.isFinite(value.Rotation)) throw new Error("snapshot-property-rotation");
      output.Rotation = normalizeRemoteNumber(value.Rotation, -Math.PI, Math.PI);
    }
    if (value.ScaleX != null) {
      if (typeof value.ScaleX !== "number" || !Number.isFinite(value.ScaleX)) throw new Error("snapshot-property-scalex");
      output.ScaleX = normalizeRemoteNumber(value.ScaleX, 0.25, 3.0);
    }
    if (value.ScaleY != null) {
      if (typeof value.ScaleY !== "number" || !Number.isFinite(value.ScaleY)) throw new Error("snapshot-property-scaley");
      output.ScaleY = normalizeRemoteNumber(value.ScaleY, 0.25, 3.0);
    }
    if (value.TypeRecord != null) output.TypeRecord = sanitizePlainRecord(value.TypeRecord);
    return Object.keys(output).length ? output : undefined;
  }

  function validateRemoteSnapshot(value) {
    remoteAssertTree(value);
    if (!remotePlainObject(value) || value.v !== 1 || !Array.isArray(value.m) || !Array.isArray(value.l)) throw new Error("snapshot-root");
    if (value.m.length > REMOTE_LIMITS.materials || value.l.length > REMOTE_LIMITS.layers) throw new Error("snapshot-count");
    for (const key of Object.keys(value)) if (!new Set(["v", "m", "l"]).has(key)) throw new Error("snapshot-root-key");
    const materials = value.m.map(material => {
      if (!remotePlainObject(material)) throw new Error("snapshot-material");
      for (const key of Object.keys(material)) if (!new Set(["g", "a", "c", "p"]).has(key)) throw new Error("snapshot-material-key");
      const output = { g: remoteString(material.g, "group"), a: remoteString(material.a, "asset") };
      if (!Array.isArray(material.c) || material.c.length > 40) throw new Error("snapshot-colors");
      output.c = material.c.map(color => remoteString(color, "color", REMOTE_LIMITS.color));
      const property = validateRemoteProperty(material.p);
      if (property) output.p = property;
      return output;
    });
    const layers = value.l.map(layer => {
      if (!remotePlainObject(layer)) throw new Error("snapshot-layer");
      for (const key of Object.keys(layer)) if (!new Set(["m", "n", "i", "p", "x", "y", "o"]).has(key)) throw new Error("snapshot-layer-key");
      const output = {
        m: remoteInteger(layer.m, "material-index", 0, Math.max(0, materials.length - 1)),
        n: layer.n == null ? null : remoteString(layer.n, "layer-name"),
        i: remoteInteger(layer.i, "layer-index", 0, 999),
        p: normalizeRemoteNumber(layer.p, -99, 99),
        x: normalizeRemoteNumber(layer.x, -1200, 1200),
        y: normalizeRemoteNumber(layer.y, -1200, 1200),
        o: normalizeRemoteNumber(layer.o, 0, 1),
      };
      return output;
    });
    const snapshot = { v: 1, m: materials, l: layers };
    const canonical = JSON.stringify(snapshot);
    if (utf8Bytes(canonical) > REMOTE_LIMITS.snapshotBytes) throw new Error("snapshot-byte-budget");
    for (let index = 0; index < materials.length; index++) {
      const refs = layers.filter(layer => layer.m === index);
      if (utf8Bytes({ m: materials[index], l: refs }) > REMOTE_LIMITS.materialBytes) throw new Error("snapshot-material-budget");
    }
    return snapshot;
  }

  function canonicalRemoteSnapshot(value) {
    return JSON.stringify(validateRemoteSnapshot(value));
  }

  async function sha256Base64Url(text) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error("crypto-subtle-unavailable");
    const bytes = new TextEncoder().encode(text);
    const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
    return bytesToBase64Url(digest);
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlToBytes(value, maxBytes = REMOTE_LIMITS.snapshotBytes) {
    remoteString(value, "base64url", Math.ceil(maxBytes * 4 / 3) + 4, /^[A-Za-z0-9_-]+$/);
    const estimated = Math.floor(value.length * 3 / 4);
    if (estimated > maxBytes) throw new Error("remote-decoded-budget");
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
    let binary;
    try { binary = atob(padded); } catch (_) { throw new Error("remote-base64url"); }
    if (binary.length > maxBytes) throw new Error("remote-decoded-budget");
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  function encodeRemoteText(text) {
    return bytesToBase64Url(new TextEncoder().encode(text));
  }

  function decodeRemoteText(value) {
    return new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(value));
  }

  function splitRemoteData(value) {
    remoteString(value, "chunk-source", REMOTE_LIMITS.chunks * REMOTE_LIMITS.chunkData, /^[A-Za-z0-9_-]+$/);
    const chunks = [];
    for (let index = 0; index < value.length; index += REMOTE_LIMITS.chunkData) chunks.push(value.slice(index, index + REMOTE_LIMITS.chunkData));
    if (!chunks.length || chunks.length > REMOTE_LIMITS.chunks) throw new Error("remote-chunk-count");
    return chunks;
  }

  function validateRemoteEnvelope(value) {
    remoteAssertTree(value);
    if (!remotePlainObject(value) || !REMOTE_TYPES.has(value.t)) throw new Error("remote-envelope");
    const allowed = value.t === "STATE" ? new Set(["t", "s", "r", "h", "z", "sharing"])
      : value.t === "CLEAR" ? new Set(["t", "s"])
      : value.t === "REQUEST" ? new Set(["t", "requestId", "session", "revision", "hash"])
      : new Set(["t", "requestId", "session", "revision", "hash", "index", "count", "data"]);
    for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error("remote-envelope-key");
    if (value.t === "STATE") {
      if (typeof value.sharing !== "boolean") throw new Error("remote-sharing");
      const state = { t: "STATE", s: remoteString(value.s, "session", 32, /^[A-Za-z0-9_-]+$/), r: remoteInteger(value.r, "revision"), h: value.h === "" ? "" : remoteString(value.h, "hash", 64, /^[A-Za-z0-9_-]+$/), z: remoteInteger(value.z, "size", 0, REMOTE_LIMITS.snapshotBytes), sharing: value.sharing };
      if (state.sharing !== (!!state.h && state.z > 0)) throw new Error("remote-state-consistency");
      return state;
    }
    if (value.t === "CLEAR") return { t: "CLEAR", s: remoteString(value.s, "session", 32, /^[A-Za-z0-9_-]+$/) };
    if (value.t === "REQUEST") return { t: "REQUEST", requestId: remoteString(value.requestId, "request-id", 32, /^[A-Za-z0-9_-]+$/), session: remoteString(value.session, "session", 32, /^[A-Za-z0-9_-]+$/), revision: remoteInteger(value.revision, "revision"), hash: remoteString(value.hash, "hash", 64, /^[A-Za-z0-9_-]+$/) };
    const chunk = { t: "CHUNK", requestId: remoteString(value.requestId, "request-id", 32, /^[A-Za-z0-9_-]+$/), session: remoteString(value.session, "session", 32, /^[A-Za-z0-9_-]+$/), revision: remoteInteger(value.revision, "revision"), hash: remoteString(value.hash, "hash", 64, /^[A-Za-z0-9_-]+$/), index: remoteInteger(value.index, "chunk-index", 0, REMOTE_LIMITS.chunks - 1), count: remoteInteger(value.count, "chunk-count", 1, REMOTE_LIMITS.chunks), data: remoteString(value.data, "chunk-data", REMOTE_LIMITS.chunkData, /^[A-Za-z0-9_-]+$/) };
    if (chunk.index >= chunk.count) throw new Error("remote-chunk-index");
    return chunk;
  }

  function parseRemoteContent(content) {
    if (typeof content !== "string" || content.length > REMOTE_LIMITS.content || !content.startsWith(REMOTE_PREFIX)) throw new Error("remote-content");
    let parsed;
    try { parsed = JSON.parse(content.slice(REMOTE_PREFIX.length)); } catch (_) { throw new Error("remote-json"); }
    return validateRemoteEnvelope(parsed);
  }

  function serializeRemoteEnvelope(envelope) {
    const content = REMOTE_PREFIX + JSON.stringify(validateRemoteEnvelope(envelope));
    if (content.length > REMOTE_LIMITS.content) throw new Error("remote-content-budget");
    return content;
  }



  function createRemoteStats() {
    return { messagesSent: 0, messagesReceived: 0, messagesRejected: 0, rateLimited: 0, chunksExpired: 0, bytesSent: 0, bytesReceived: 0, remoteMaterialsSkipped: 0 };
  }

  function createRemoteStore() {
    return {
      roomGeneration: 0,
      peers: new Map(), pendingRequests: new Map(), assemblies: new Map(), activeSnapshots: new Map(),
      senderBuckets: new Map(), roomBucket: null, responseTimes: new Map(), requestTimes: new Map(),
      helloReplied: new Set(), timers: new Set(), diagnostics: [], stats: createRemoteStats(), totalBytes: 0,
    };
  }

  let remoteStore = createRemoteStore();

  function remoteNow() { return Date.now(); }

  function scheduleRemoteTimer(callback, delay) {
    let timer = 0;
    timer = setTimeout(() => {
      remoteStore.timers.delete(timer);
      callback();
    }, delay);
    remoteStore.timers.add(timer);
    // Node test timers support unref; browser timer ids simply ignore this.
    timer?.unref?.();
    return timer;
  }

  function remoteDiagnostic(kind, sender = null, detail = null) {
    remoteStore.diagnostics.push({ at: remoteNow(), kind: String(kind).slice(0, 40), sender: Number.isInteger(sender) ? sender : null, detail: detail == null ? null : String(detail).slice(0, 120) });
    if (remoteStore.diagnostics.length > 100) remoteStore.diagnostics.splice(0, remoteStore.diagnostics.length - 100);
  }

  function resetRemoteRoom() {
    for (const timer of remoteStore.timers) clearTimeout(timer);
    const nextGeneration = remoteStore.roomGeneration + 1;
    remoteStore = createRemoteStore();
    remoteStore.roomGeneration = nextGeneration;
    syntheticByCharacter = new WeakMap();
    return nextGeneration;
  }

  function remoteBucketConsume(holder, key, capacity, refillPerSecond, now = remoteNow()) {
    let bucket = key == null ? holder.roomBucket : holder.senderBuckets.get(key);
    if (!bucket) bucket = { tokens: capacity, at: now };
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.at) * refillPerSecond / 1000);
    bucket.at = now;
    const accepted = bucket.tokens >= 1;
    if (accepted) bucket.tokens -= 1;
    if (key == null) holder.roomBucket = bucket;
    else holder.senderBuckets.set(key, bucket);
    return accepted;
  }

  function acceptRemoteInboundRate(sender, now = remoteNow()) {
    const senderOk = remoteBucketConsume(remoteStore, sender, 12, 2, now);
    const roomOk = remoteBucketConsume(remoteStore, null, 30, 5, now);
    if (!senderOk || !roomOk) remoteStore.stats.rateLimited++;
    return senderOk && roomOk;
  }

  function remotePeerKey(memberNumber) { return Number(memberNumber); }

  function getRemotePeer(memberNumber) { return remoteStore.peers.get(remotePeerKey(memberNumber)) || null; }

  function setRemotePeer(memberNumber, state) {
    const key = remotePeerKey(memberNumber);
    if (!remoteStore.peers.has(key) && remoteStore.peers.size >= 10) throw new Error("remote-peer-limit");
    const previous = remoteStore.peers.get(key);
    if (previous?.session === state.session) {
      if (state.revision < previous.revision) throw new Error("remote-stale-revision");
      if (state.revision === previous.revision && previous.sharing && state.sharing && state.hash !== previous.hash) throw new Error("remote-revision-hash-conflict");
    }
    const peer = { memberNumber: key, session: state.session, revision: state.revision, hash: state.hash, size: state.size, sharing: state.sharing === true, seenAt: remoteNow() };
    remoteStore.peers.set(key, peer);
    return { peer, isNewSession: !previous || previous.session !== peer.session };
  }

  function remoteIdentity(memberNumber, session) { return `${remoteStore.roomGeneration}:${memberNumber}:${session}`; }

  function pendingRequestFor(memberNumber) { return remoteStore.pendingRequests.get(remotePeerKey(memberNumber)) || null; }

  function setPendingRequest(memberNumber, request) {
    remoteStore.pendingRequests.set(remotePeerKey(memberNumber), { ...request, createdAt: remoteNow(), retries: request.retries || 0, generation: remoteStore.roomGeneration });
  }

  function clearPendingRequest(memberNumber, requestId = null) {
    const key = remotePeerKey(memberNumber);
    const pending = remoteStore.pendingRequests.get(key);
    if (pending && (requestId == null || pending.requestId === requestId)) remoteStore.pendingRequests.delete(key);
  }

  function assemblyKey(memberNumber) { return remotePeerKey(memberNumber); }

  function addRemoteChunk(memberNumber, envelope, now = remoteNow()) {
    const key = assemblyKey(memberNumber);
    const pending = pendingRequestFor(key);
    if (!pending || pending.generation !== remoteStore.roomGeneration || pending.requestId !== envelope.requestId || pending.session !== envelope.session || pending.revision !== envelope.revision || pending.hash !== envelope.hash) throw new Error("remote-unsolicited-chunk");
    let assembly = remoteStore.assemblies.get(key);
    if (!assembly) {
      if (remoteStore.assemblies.size >= 4) throw new Error("remote-assembly-room-limit");
      assembly = { requestId: envelope.requestId, session: envelope.session, revision: envelope.revision, hash: envelope.hash, count: envelope.count, parts: new Map(), encodedBytes: 0, startedAt: now, generation: remoteStore.roomGeneration };
      remoteStore.assemblies.set(key, assembly);
      const generation = remoteStore.roomGeneration;
      const requestId = envelope.requestId;
      scheduleRemoteTimer(() => {
        if (generation !== remoteStore.roomGeneration) return;
        const current = remoteStore.assemblies.get(key);
        if (current?.requestId === requestId && remoteNow() - current.startedAt >= 20000) {
          remoteStore.assemblies.delete(key);
          remoteStore.stats.chunksExpired++;
        }
      }, 20000);
    }
    if (assembly.requestId !== envelope.requestId || assembly.count !== envelope.count || assembly.hash !== envelope.hash) {
      remoteStore.assemblies.delete(key);
      throw new Error("remote-assembly-conflict");
    }
    if (envelope.index >= assembly.count) throw new Error("remote-chunk-index");
    const existing = assembly.parts.get(envelope.index);
    if (existing != null) {
      if (existing === envelope.data) return { status: "duplicate", charged: 0 };
      remoteStore.assemblies.delete(key);
      throw new Error("remote-chunk-conflict");
    }
    assembly.parts.set(envelope.index, envelope.data);
    assembly.encodedBytes += envelope.data.length;
    if (assembly.encodedBytes > REMOTE_LIMITS.chunks * REMOTE_LIMITS.chunkData) {
      remoteStore.assemblies.delete(key);
      throw new Error("remote-assembly-budget");
    }
    if (assembly.parts.size !== assembly.count) return { status: "partial", charged: envelope.data.length };
    const encoded = Array.from({ length: assembly.count }, (_, index) => assembly.parts.get(index)).join("");
    remoteStore.assemblies.delete(key);
    return { status: "complete", charged: envelope.data.length, encoded };
  }

  function expireRemoteAssemblies(now = remoteNow()) {
    let expired = 0;
    for (const [key, assembly] of remoteStore.assemblies) {
      if (now - assembly.startedAt > 20000) {
        remoteStore.assemblies.delete(key);
        expired++;
      }
    }
    remoteStore.stats.chunksExpired += expired;
    return expired;
  }

  function acceptRemoteSnapshot(memberNumber, identity, snapshot, canonical) {
    const key = remotePeerKey(memberNumber);
    const bytes = utf8Bytes(canonical);
    const previous = remoteStore.activeSnapshots.get(key);
    const nextTotal = remoteStore.totalBytes - (previous?.bytes || 0) + bytes;
    if (nextTotal > 262144) throw new Error("remote-room-byte-budget");
    const pending = pendingRequestFor(key);
    remoteStore.activeSnapshots.set(key, { identity, session: pending?.session || null, revision: pending?.revision ?? null, hash: pending?.hash || null, snapshot, canonical, bytes, acceptedAt: remoteNow() });
    remoteStore.totalBytes = nextTotal;
    clearPendingRequest(key);
    return snapshot;
  }

  function clearRemoteMember(memberNumber) {
    const key = remotePeerKey(memberNumber);
    const previous = remoteStore.activeSnapshots.get(key);
    if (previous) remoteStore.totalBytes -= previous.bytes;
    remoteStore.peers.delete(key);
    remoteStore.pendingRequests.delete(key);
    remoteStore.assemblies.delete(key);
    remoteStore.activeSnapshots.delete(key);
    remoteStore.senderBuckets.delete(key);
    remoteStore.responseTimes.delete(key);
    remoteStore.requestTimes.delete(key);
    for (const identity of remoteStore.helloReplied) if (identity.includes(`:${key}:`)) remoteStore.helloReplied.delete(identity);
    syntheticByCharacter = new WeakMap();
  }

  function remoteSnapshotForCharacter(character) {
    const memberNumber = Number(character?.MemberNumber);
    if (!Number.isInteger(memberNumber)) return null;
    return remoteStore.activeSnapshots.get(memberNumber)?.snapshot || null;
  }



  let remoteSendQueue = [];
  let remoteSendTimer = 0;
  let remoteSendTokens = 2;
  let remoteSendTokenAt = 0;
  let remoteMessageHandlerDispose = null;

  function remoteRoomMember(memberNumber) {
    return (globalThis.ChatRoomCharacter || []).find(character => Number(character?.MemberNumber) === Number(memberNumber)) || null;
  }

  function cancelRemoteTransport() {
    remoteSendQueue = [];
    if (remoteSendTimer) {
      clearTimeout(remoteSendTimer);
      remoteStore.timers.delete(remoteSendTimer);
    }
    remoteSendTimer = 0;
  }

  function enqueueRemoteEnvelope(envelope, target = null, options = {}) {
    const content = serializeRemoteEnvelope(envelope);
    remoteSendQueue.push({ content, target: Number.isInteger(target) ? target : null, generation: remoteStore.roomGeneration, earliest: Math.max(remoteNow(), Number(options.earliest) || 0) });
    pumpRemoteSendQueue();
  }

  function pumpRemoteSendQueue() {
    if (remoteSendTimer || !remoteSendQueue.length) return;
    const now = remoteNow();
    if (!remoteSendTokenAt) remoteSendTokenAt = now;
    remoteSendTokens = Math.min(2, remoteSendTokens + Math.max(0, now - remoteSendTokenAt) * 2.5 / 1000);
    remoteSendTokenAt = now;
    while (remoteSendQueue.length && remoteSendQueue[0].generation !== remoteStore.roomGeneration) remoteSendQueue.shift();
    if (!remoteSendQueue.length) return;
    const entry = remoteSendQueue[0];
    const delay = Math.max(entry.earliest - now, remoteSendTokens >= 1 ? 0 : Math.ceil((1 - remoteSendTokens) / 2.5 * 1000));
    if (delay > 0) {
      remoteSendTimer = scheduleRemoteTimer(() => { remoteSendTimer = 0; pumpRemoteSendQueue(); }, delay);
      return;
    }
    remoteSendQueue.shift();
    remoteSendTokens -= 1;
    try {
      const packet = { Type: "Hidden", Content: entry.content };
      if (entry.target != null) packet.Target = entry.target;
      ServerSend("ChatRoomChat", packet);
      remoteStore.stats.messagesSent++;
      remoteStore.stats.bytesSent += utf8Bytes(entry.content);
    } catch (error) {
      remoteDiagnostic("send-failed", entry.target, error?.message || error);
    }
    if (remoteSendQueue.length) {
      remoteSendTimer = scheduleRemoteTimer(() => { remoteSendTimer = 0; pumpRemoteSendQueue(); }, 0);
    }
  }

  function onRemoteMessage(data) {
    try {
      if (data?.Type !== "Hidden" || typeof data.Content !== "string" || !data.Content.startsWith(REMOTE_PREFIX)) return false;
      if (data.Content.length > REMOTE_LIMITS.content) {
        remoteStore.stats.messagesRejected++;
        return true;
      }
      const senderNumber = Number(data.Sender);
      const sender = Number.isInteger(senderNumber) ? remoteRoomMember(senderNumber) : null;
      if (!sender || Number(sender.MemberNumber) !== senderNumber) {
        remoteStore.stats.messagesRejected++;
        return true;
      }
      if (senderNumber === Number(globalThis.Player?.MemberNumber)) return true;
      if (!acceptRemoteInboundRate(senderNumber)) {
        remoteStore.stats.messagesRejected++;
        return true;
      }
      let envelope;
      try { envelope = parseRemoteContent(data.Content); }
      catch (error) {
        remoteStore.stats.messagesRejected++;
        remoteDiagnostic("invalid-envelope", senderNumber, error?.message || error);
        return true;
      }
      remoteStore.stats.messagesReceived++;
      remoteStore.stats.bytesReceived += utf8Bytes(data.Content);
      Promise.resolve(handleRemoteEnvelope(sender, envelope, remoteStore.roomGeneration)).catch(error => {
        remoteStore.stats.messagesRejected++;
        remoteDiagnostic("handler-rejected", senderNumber, error?.message || error);
      });
      return true;
    } catch (error) {
      try { remoteStore.stats.messagesRejected++; remoteDiagnostic("callback-failed", Number(data?.Sender), error?.message || error); } catch (_) { /* never escape BC loop */ }
      return typeof data?.Content === "string" && data.Content.startsWith(REMOTE_PREFIX);
    }
  }

  function installRemoteMessageHandler() {
    if (typeof globalThis.ChatRoomRegisterMessageHandler !== "function" || remoteMessageHandlerDispose) return false;
    remoteMessageHandlerDispose = ChatRoomRegisterMessageHandler({ Description: "COE Remote visual snapshot protocol", Priority: -50, Callback: onRemoteMessage }) || true;
    return true;
  }



  const REMOTE_PREFS_PREFIX = "BC.CustomOutfitEditor.RemotePrefs.v1";
  let remotePrefs = { sharingEnabled: false, receivingEnabled: false };
  let localPeerSessionId = "";
  let localRemoteRevision = 0;
  let localRemoteHash = "";
  let localRemoteCanonical = "";
  let localRemoteSnapshot = null;
  let localRemoteBuildToken = 0;
  let localRemoteStateTimer = 0;
  let localRemoteLastStateKey = "";
  let localRemotePreviouslyShared = false;

  function remoteRandomId(bytes = 12) {
    const data = new Uint8Array(bytes);
    if (!globalThis.crypto?.getRandomValues) throw new Error("crypto-random-unavailable");
    crypto.getRandomValues(data);
    return bytesToBase64Url(data);
  }

  function remotePrefsKey() {
    const accountId = globalThis.Player?.MemberNumber ?? globalThis.Player?.AccountName ?? "anonymous";
    return `${REMOTE_PREFS_PREFIX}.${accountId}`;
  }

  function loadRemotePrefs() {
    try {
      const value = JSON.parse(localStorage.getItem(remotePrefsKey()) || "null");
      remotePrefs = { sharingEnabled: value?.sharingEnabled === true, receivingEnabled: value?.receivingEnabled === true };
    } catch (_) { remotePrefs = { sharingEnabled: false, receivingEnabled: false }; }
    return { ...remotePrefs };
  }

  function saveRemotePrefs() {
    try { localStorage.setItem(remotePrefsKey(), JSON.stringify({ sharingEnabled: remotePrefs.sharingEnabled === true, receivingEnabled: remotePrefs.receivingEnabled === true })); } catch (_) { /* privacy mode */ }
  }

  function setRemotePrefs(next) {
    const previous = remotePrefs;
    remotePrefs = { sharingEnabled: next.sharingEnabled === true, receivingEnabled: next.receivingEnabled === true };
    saveRemotePrefs();
    if (!remotePrefs.receivingEnabled && previous.receivingEnabled) {
      for (const memberNumber of [...remoteStore.activeSnapshots.keys()]) {
        remoteStore.activeSnapshots.delete(memberNumber);
        const character = remoteRoomMember(memberNumber);
        if (character) CharacterRefresh(character, false, false);
      }
      remoteStore.pendingRequests.clear();
      remoteStore.assemblies.clear();
      remoteStore.totalBytes = 0;
      syntheticByCharacter = new WeakMap();
    } else if (remotePrefs.receivingEnabled && !previous.receivingEnabled) {
      for (const [memberNumber, peer] of remoteStore.peers) maybeRequestRemoteSnapshot(memberNumber, peer);
    }
    if (!remotePrefs.sharingEnabled && previous.sharingEnabled) sendRemoteClear();
    scheduleLocalRemoteBuild(true);
    return { ...remotePrefs };
  }

  function buildLocalRemoteSnapshot() {
    if (!activeComposition) return { v: 1, m: [], l: [] };
    const composition = normalizeComposition(activeComposition);
    const visibleMaterials = [];
    const materialIndexes = new Map();
    const layers = [];
    for (const material of composition.materials) {
      if (material.hidden) continue;
      const refs = composition.layers.filter(ref => ref.materialId === material.id && !ref.hidden);
      if (!refs.length) continue;
      const index = visibleMaterials.length;
      materialIndexes.set(material.id, index);
      const compact = { g: material.sourceGroup, a: material.sourceAsset, c: sanitizeColorArray(material.colors) };
      const property = sanitizeSourceProperty(material.sourceProperty);
      if (Object.keys(property).length) compact.p = property;
      visibleMaterials.push(compact);
      for (const ref of refs) {
        layers.push({ m: index, n: ref.sourceLayer == null ? null : ref.sourceLayer, i: Number.isInteger(ref.sourceLayerIndex) ? ref.sourceLayerIndex : 0, p: ref.priority, x: ref.offsetX, y: ref.offsetY, o: ref.opacity });
      }
    }
    return validateRemoteSnapshot({ v: 1, m: visibleMaterials, l: layers });
  }

  function scheduleLocalRemoteBuild(forceState = false) {
    if (localRemoteStateTimer) {
      clearTimeout(localRemoteStateTimer);
      remoteStore.timers.delete(localRemoteStateTimer);
    }
    const generation = remoteStore.roomGeneration;
    const token = ++localRemoteBuildToken;
    localRemoteStateTimer = scheduleRemoteTimer(() => {
      localRemoteStateTimer = 0;
      updateLocalRemoteSnapshot(generation, token, forceState).catch(error => {
        remoteDiagnostic("local-build-failed", null, error?.message || error);
        if (localRemotePreviouslyShared) sendRemoteClear();
      });
    }, 500);
  }

  async function updateLocalRemoteSnapshot(generation = remoteStore.roomGeneration, token = ++localRemoteBuildToken, forceState = false) {
    let snapshot;
    try { snapshot = buildLocalRemoteSnapshot(); }
    catch (error) {
      toast(`远端共享已暂停：${error.message}`, "warn");
      throw error;
    }
    const canonical = canonicalRemoteSnapshot(snapshot);
    const hash = snapshot.l.length ? await sha256Base64Url(canonical) : "";
    if (generation !== remoteStore.roomGeneration || token !== localRemoteBuildToken) return false;
    const changed = hash !== localRemoteHash;
    if (changed) localRemoteRevision++;
    localRemoteSnapshot = snapshot;
    localRemoteCanonical = canonical;
    localRemoteHash = hash;
    if (!snapshot.l.length) {
      if (localRemotePreviouslyShared) sendRemoteClear();
      sendRemoteState(null, true);
      return true;
    }
    if (remotePrefs.sharingEnabled) {
      localRemotePreviouslyShared = true;
      sendRemoteState(null, forceState || changed);
    } else if (forceState) sendRemoteState(null, true);
    return true;
  }

  function currentRemoteStateEnvelope() {
    const sharing = remotePrefs.sharingEnabled && !!localRemoteHash && !!localRemoteSnapshot?.l.length;
    return { t: "STATE", s: localPeerSessionId, r: localRemoteRevision, h: sharing ? localRemoteHash : "", z: sharing ? utf8Bytes(localRemoteCanonical) : 0, sharing };
  }

  function sendRemoteState(target = null, force = false) {
    if (!localPeerSessionId) return;
    const envelope = currentRemoteStateEnvelope();
    const key = `${target ?? "*"}|${envelope.s}|${envelope.r}|${envelope.h}|${envelope.sharing}`;
    if (!force && key === localRemoteLastStateKey) return;
    if (target == null) localRemoteLastStateKey = key;
    enqueueRemoteEnvelope(envelope, target);
  }

  function sendRemoteClear() {
    if (!localPeerSessionId) return;
    enqueueRemoteEnvelope({ t: "CLEAR", s: localPeerSessionId });
    localRemotePreviouslyShared = false;
    localRemoteLastStateKey = "";
  }

  function maybeRequestRemoteSnapshot(memberNumber, peer) {
    if (!remotePrefs.receivingEnabled || !peer.sharing || !peer.hash || peer.size > REMOTE_LIMITS.snapshotBytes) return false;
    const active = remoteStore.activeSnapshots.get(memberNumber);
    if (active?.identity === remoteIdentity(memberNumber, peer.session) && active.revision === peer.revision && active.hash === peer.hash) return false;
    const pending = pendingRequestFor(memberNumber);
    if (pending && pending.session === peer.session && pending.revision === peer.revision && pending.hash === peer.hash) return false;
    const now = remoteNow();
    if (now - (remoteStore.requestTimes.get(memberNumber) || 0) < 5000) return false;
    const request = { requestId: remoteRandomId(9), session: peer.session, revision: peer.revision, hash: peer.hash, retries: 0 };
    setPendingRequest(memberNumber, request);
    remoteStore.requestTimes.set(memberNumber, now);
    enqueueRemoteEnvelope({ t: "REQUEST", requestId: request.requestId, session: request.session, revision: request.revision, hash: request.hash }, memberNumber);
    scheduleRemoteRequestTimeout(memberNumber, request, remoteStore.roomGeneration);
    return true;
  }

  function scheduleRemoteRequestTimeout(memberNumber, request, generation) {
    scheduleRemoteTimer(() => {
      if (generation !== remoteStore.roomGeneration) return;
      const pending = pendingRequestFor(memberNumber);
      if (!pending || pending.requestId !== request.requestId) return;
      remoteStore.assemblies.delete(memberNumber);
      if (pending.retries >= 1) {
        clearPendingRequest(memberNumber, pending.requestId);
        remoteDiagnostic("request-timeout", memberNumber);
        return;
      }
      const retry = { ...pending, requestId: remoteRandomId(9), retries: pending.retries + 1 };
      setPendingRequest(memberNumber, retry);
      enqueueRemoteEnvelope({ t: "REQUEST", requestId: retry.requestId, session: retry.session, revision: retry.revision, hash: retry.hash }, memberNumber);
      scheduleRemoteRequestTimeout(memberNumber, retry, generation);
    }, 12000);
  }

  async function handleRemoteEnvelope(sender, envelope, generation) {
    if (generation !== remoteStore.roomGeneration) return;
    const memberNumber = Number(sender.MemberNumber);
    if (envelope.t === "STATE") {
      const previous = getRemotePeer(memberNumber);
      const result = setRemotePeer(memberNumber, { session: envelope.s, revision: envelope.r, hash: envelope.h, size: envelope.z, sharing: envelope.sharing });
      const identity = remoteIdentity(memberNumber, envelope.s);
      if (result.isNewSession) {
        const active = remoteStore.activeSnapshots.get(memberNumber);
        if (active) remoteStore.totalBytes -= active.bytes;
        remoteStore.activeSnapshots.delete(memberNumber);
        clearPendingRequest(memberNumber);
        remoteStore.assemblies.delete(memberNumber);
        syntheticByCharacter = new WeakMap();
        if (active) CharacterRefresh(sender, false, false);
      }
      if (!remoteStore.helloReplied.has(identity)) {
        remoteStore.helloReplied.add(identity);
        sendRemoteState(memberNumber, true);
      }
      if (!envelope.sharing) {
        const active = remoteStore.activeSnapshots.get(memberNumber);
        if (active) remoteStore.totalBytes -= active.bytes;
        remoteStore.activeSnapshots.delete(memberNumber);
        clearPendingRequest(memberNumber);
        remoteStore.assemblies.delete(memberNumber);
        if (active) CharacterRefresh(sender, false, false);
      } else if (!previous || result.isNewSession || previous.revision !== envelope.r || previous.hash !== envelope.h) maybeRequestRemoteSnapshot(memberNumber, result.peer);
      return;
    }
    if (envelope.t === "CLEAR") {
      const peer = getRemotePeer(memberNumber);
      if (peer && peer.session !== envelope.s) throw new Error("remote-clear-session");
      if (peer) { peer.sharing = false; peer.size = 0; }
      const previous = remoteStore.activeSnapshots.get(memberNumber);
      if (previous) remoteStore.totalBytes -= previous.bytes;
      remoteStore.activeSnapshots.delete(memberNumber);
      clearPendingRequest(memberNumber);
      syntheticByCharacter = new WeakMap();
      CharacterRefresh(sender, false, false);
      return;
    }
    if (envelope.t === "REQUEST") {
      if (!remotePrefs.sharingEnabled || envelope.session !== localPeerSessionId || envelope.revision !== localRemoteRevision || envelope.hash !== localRemoteHash || !localRemoteCanonical) return;
      const now = remoteNow();
      if (now - (remoteStore.responseTimes.get(memberNumber) || 0) < 10000) return;
      remoteStore.responseTimes.set(memberNumber, now);
      const chunks = splitRemoteData(encodeRemoteText(localRemoteCanonical));
      chunks.forEach((data, index) => enqueueRemoteEnvelope({ t: "CHUNK", requestId: envelope.requestId, session: localPeerSessionId, revision: localRemoteRevision, hash: localRemoteHash, index, count: chunks.length, data }, memberNumber, { earliest: now + index * 400 }));
      return;
    }
    const assembled = addRemoteChunk(memberNumber, envelope);
    if (assembled.status !== "complete") return;
    const canonical = decodeRemoteText(assembled.encoded);
    if (utf8Bytes(canonical) > REMOTE_LIMITS.snapshotBytes) throw new Error("remote-decoded-budget");
    let parsed;
    try { parsed = JSON.parse(canonical); } catch (_) { throw new Error("snapshot-json"); }
    const snapshot = validateRemoteSnapshot(parsed);
    const normalizedCanonical = JSON.stringify(snapshot);
    if (normalizedCanonical !== canonical) throw new Error("snapshot-not-canonical");
    const hash = await sha256Base64Url(canonical);
    if (generation !== remoteStore.roomGeneration) return;
    const pending = pendingRequestFor(memberNumber);
    if (!pending || pending.requestId !== envelope.requestId || hash !== pending.hash || hash !== envelope.hash) throw new Error("snapshot-hash");
    acceptRemoteSnapshot(memberNumber, remoteIdentity(memberNumber, envelope.session), snapshot, canonical);
    syntheticByCharacter = new WeakMap();
    CharacterRefresh(sender, false, false);
  }

  function installRemoteLifecycleHooks() {
    modApi.hookFunction("ChatRoomSync", 1000, (args, next) => {
      cancelRemoteTransport();
      resetRemoteRoom();
      const generation = remoteStore.roomGeneration;
      const result = next(args);
      Promise.resolve(result).then(() => { if (generation === remoteStore.roomGeneration) scheduleLocalRemoteBuild(true); }).catch(() => {});
      return result;
    });
    modApi.hookFunction("ChatRoomSyncMemberJoin", 1000, (args, next) => {
      const result = next(args);
      const memberNumber = Number(args[0]?.SourceMemberNumber ?? args[0]?.MemberNumber ?? args[0]);
      const generation = remoteStore.roomGeneration;
      scheduleRemoteTimer(() => { if (generation === remoteStore.roomGeneration && Number.isInteger(memberNumber)) sendRemoteState(memberNumber, true); }, 100 + Math.floor(Math.random() * 401));
      return result;
    });
    modApi.hookFunction("ChatRoomSyncMemberLeave", 1000, (args, next) => {
      const memberNumber = Number(args[0]?.SourceMemberNumber ?? args[0]?.MemberNumber ?? args[0]);
      const result = next(args);
      if (Number.isInteger(memberNumber)) clearRemoteMember(memberNumber);
      return result;
    });
    for (const name of ["ChatRoomLeave", "ServerDisconnect"]) modApi.hookFunction(name, 1000, (args, next) => { cancelRemoteTransport(); resetRemoteRoom(); return next(args); });
    modApi.hookFunction("CharacterLoadOnline", 1000, (args, next) => { const result = next(args); syntheticByCharacter = new WeakMap(); return result; });
  }

  function initializeRemoteController() {
    loadRemotePrefs();
    localPeerSessionId = remoteRandomId(12);
    localRemoteRevision = 0;
    localRemoteHash = "";
    localRemoteCanonical = "";
    localRemoteSnapshot = null;
    installRemoteMessageHandler();
    scheduleLocalRemoteBuild(true);
  }



  function countCapabilities() {
    const counts = { supportedAssetCount: 0, limitedAssetCount: 0, unsupportedAssetCount: 0, unverifiedAssetCount: 0 };
    for (const asset of globalThis.Asset || []) {
      if (!asset?.Wear || asset.IsLock || asset.Group?.Category !== "Appearance") continue;
      const result = analyzeAssetCached(asset);
      if (result.compatibility === "safe") counts.supportedAssetCount++;
      else if (result.compatibility === "limited") counts.limitedAssetCount++;
      else if (result.compatibility === "unverified") counts.unverifiedAssetCount++;
      else counts.unsupportedAssetCount++;
    }
    return counts;
  }

  function statusSnapshot() {
    const echo = echoRuntimeInfo();
    return cloneJSON({
      installed: runtimeInstalled,
      active: initialized && !duplicateInstance,
      duplicateInstance,
      version: VERSION,
      bcVersion: String(globalThis.GameVersion || globalThis.CurrentVersion || "R130"),
      echoDetected: echo.detected,
      echoVersion: echo.version,
      echoVersionVerified: echo.verified,
      authorizationStatus: echo.authorization,
      ...countCapabilities(),
      activeMaterialCount: runtimeMaterialState.size,
      skippedMaterials: diagnostics.skippedMaterials,
      lastWarnings: diagnostics.lastWarnings.slice(-20),
      outboundSyntheticFiltered: diagnostics.outboundSyntheticFiltered,
      remoteProtocol: REMOTE_PROTOCOL,
      sharingEnabled: remotePrefs.sharingEnabled,
      receivingEnabled: remotePrefs.receivingEnabled,
      roomGeneration: remoteStore.roomGeneration,
      remotePeers: remoteStore.peers.size,
      activeRemoteCompositions: remoteStore.activeSnapshots.size,
      messagesSent: remoteStore.stats.messagesSent,
      messagesReceived: remoteStore.stats.messagesReceived,
      messagesRejected: remoteStore.stats.messagesRejected,
      rateLimited: remoteStore.stats.rateLimited,
      chunksExpired: remoteStore.stats.chunksExpired,
      bytesSent: remoteStore.stats.bytesSent,
      bytesReceived: remoteStore.stats.bytesReceived,
      remoteMaterialsSkipped: remoteStore.stats.remoteMaterialsSkipped,
      wardrobeRead: {
        status: wardrobeReadState.status,
        source: wardrobeReadState.source,
        conflict: wardrobeReadState.conflict,
        serverStatus: wardrobeReadState.server?.status || null,
        localStatus: wardrobeReadState.local?.status || null,
        persistenceBlocked,
      },
    });
  }

  function analyzeAssetByName(group, assetName) {
    const asset = typeof globalThis.AssetGet === "function" ? AssetGet(globalThis.Player?.AssetFamily || "Female3DCG", group, assetName) : null;
    return cloneJSON(analyzeSourceAsset(asset, { noCache: true }));
  }

  function exportDiagnostics() {
    return cloneJSON({
      generatedAt: new Date().toISOString(),
      status: statusSnapshot(),
      runtimeMaterials: [...runtimeMaterialState.entries()],
      storage: {
        server: { status: wardrobeReadState.server?.status, error: wardrobeReadState.server?.error, rawLength: typeof wardrobeReadState.server?.raw === "string" ? wardrobeReadState.server.raw.length : 0 },
        local: { status: wardrobeReadState.local?.status, error: wardrobeReadState.local?.error, rawLength: typeof wardrobeReadState.local?.raw === "string" ? wardrobeReadState.local.raw.length : 0 },
      },
    });
  }

  function exposeAPI() {
    globalThis.CustomOutfitEditor = Object.freeze({
      version: VERSION,
      open: openWardrobe,
      apply: composition => applyComposition(composition),
      getCurrent: () => cloneJSON(getComposition(globalThis.Player)),
      exportWardrobe: () => packWardrobe(wardrobe),
      exportRawStorage: () => cloneJSON({ server: wardrobeReadState.server?.raw ?? null, local: wardrobeReadState.local?.raw ?? null }),
      importWardrobe: packed => {
        const result = unpackWardrobeDetailed(packed);
        if (result.status !== "ok") throw new Error(`无效的衣柜数据:${result.status}`);
        packWardrobe(result.data); // validate compact serializer and budgets before mutation
        const previous = wardrobe;
        try {
          wardrobe = result.data;
          persistenceBlocked = false; // explicit import is user-authorized replacement
          persistWardrobe({ force: true });
          syncEquippedSchemes();
        } catch (error) {
          wardrobe = previous;
          throw error;
        }
      },
      status: statusSnapshot,
      analyzeAsset: analyzeAssetByName,
      exportDiagnostics,
    });
  }

  function detectDuplicateInstance() {
    const api = globalThis.CustomOutfitEditor;
    const domDuplicate = !!document.getElementById(ROOT_ID) || !!document.getElementById(BUTTON_ID) || !!document.getElementById(STYLE_ID);
    if (!api && !domDuplicate) return false;
    duplicateInstance = true;
    const message = `[${MOD_NAME}] 检测到另一份 Custom Outfit Editor。COE-Echo Remote 已停止安装，请只启用一个版本。`;
    console.error(message);
    try { if (!globalThis.__coeDuplicateWarningShown) { globalThis.__coeDuplicateWarningShown = true; alert(message); } } catch (_) { /* console warning remains */ }
    return true;
  }

  function initialize() {
    if (!globalThis.bcModSdk || typeof globalThis.AssetGet !== "function" || !globalThis.Player) return;
    if (!runtimeInstalled) {
      if (detectDuplicateInstance()) return;
      try {
        modApi = bcModSdk.registerMod({ name: MOD_NAME, fullName: "自定义服装编辑器 Echo Remote", version: VERSION }, { allowReplace: false });
        installRenderHooks();
        installRemoteLifecycleHooks();
        injectStyle();
        runtimeInstalled = true;
      } catch (error) {
        duplicateInstance = /already|duplicate|registered|replace/i.test(String(error?.message || error));
        warn(duplicateInstance ? "检测到同名 Mod，COE-Echo Remote 已停止安装" : "安全 Hook 安装失败，将继续等待游戏加载", error);
        try { modApi?.unload(); } catch (_) { /* ignore */ }
        modApi = null;
        return;
      }
    }
    if (initialized || !Player.AccountName || !Number.isFinite(Player.MemberNumber)) return;
    try {
      const readState = loadWardrobe();
      if (readState.status === "deferred") return;
      syncEquippedSchemes();
      initializeRemoteController();
      exposeAPI();
      initialized = true;
      setInterval(updateEntryButton, 600);
      updateEntryButton();
      log(`Remote Edition v${VERSION} 已加载；远端静态视觉同步默认关闭，可在衣柜中分别启用共享与接收`);
    } catch (error) {
      warn("账号数据初始化失败，将继续等待", error);
    }
  }

  if (globalThis.__COE_TEST_MODE__) {
    globalThis.__COE_TEST_API__ = {
      normalizeWardrobe, compactWardrobeForStorage, packWardrobe, unpackWardrobeDetailed,
      stableInsertSyntheticLayers, coeAssetLayerSort: stableInsertSyntheticLayers, analyzeSourceAsset, sanitizePlainRecord,
      buildSyntheticItems, buildLocalSyntheticItems, buildRemoteSyntheticItems, makeSyntheticLayers, statusSnapshot,
      isDrawableLayer, normalizedMaterialColors, normalizePickerColor, validateRemoteSnapshot, canonicalRemoteSnapshot, sha256Base64Url,
      parseRemoteContent, serializeRemoteEnvelope, encodeRemoteText, decodeRemoteText, splitRemoteData,
      createRemoteStore, setRemotePeer, setPendingRequest, pendingRequestFor, addRemoteChunk, expireRemoteAssemblies,
      acceptRemoteSnapshot, clearRemoteMember, onRemoteMessage, handleRemoteEnvelope, buildLocalRemoteSnapshot, updateLocalRemoteSnapshot,
      getRemoteStoreForTest: () => remoteStore,
      getLocalRemoteStateForTest: () => ({ session: localPeerSessionId, revision: localRemoteRevision, hash: localRemoteHash, canonical: localRemoteCanonical, snapshot: localRemoteSnapshot, buildToken: localRemoteBuildToken }),
      resetRemoteRoomForTest: resetRemoteRoom,
      setRemotePrefsForTest: value => { remotePrefs = { sharingEnabled: value?.sharingEnabled === true, receivingEnabled: value?.receivingEnabled === true }; },
      setLocalRemoteStateForTest: value => { localPeerSessionId = value.session; localRemoteRevision = value.revision; localRemoteHash = value.hash; localRemoteCanonical = value.canonical; localRemoteSnapshot = value.snapshot; localRemoteBuildToken = value.buildToken ?? localRemoteBuildToken; },
      setActiveCompositionForTest: value => { activeComposition = value; },
      setEditingForTest: value => { editing = value; uiMode = value ? "editor" : null; },
      installHooksForTest: api => { modApi = api; installRenderHooks(); },
      installAllHooksForTest: api => { modApi = api; installRenderHooks(); installRemoteLifecycleHooks(); },
    };
  } else {
    const initTimer = setInterval(() => {
      initialize();
      if (initialized || duplicateInstance) clearInterval(initTimer);
    }, 500);
    window.addEventListener("load", initialize);
  }
})();



