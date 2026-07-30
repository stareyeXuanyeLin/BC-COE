// ==UserScript==
// @name         Bondage Club - Custom Outfit Editor（dev 测试版）
// @namespace    https://github.com/stareyeXuanyeLin/BC-COE
// @version      1.1.0
// @description  Custom Outfit Editor dev 测试版，自定义组合与同步已加载的服装素材。
// @author       林宣夜 ＆ 佩菈
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
// @downloadURL  https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/dev/dist/CustomOutfitEditor.user.js
// @updateURL    https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/dev/dist/CustomOutfitEditor.user.js
// ==/UserScript==

(() => {
  "use strict";



  const MOD_NAME = "CustomOutfitEditor";
  const VERSION = "1.1.0";
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
  // A typical full R130 Appearance bundle is well below 16 KiB. Keep each set
  // bounded at 64 KiB and mirror vanilla's two pages of twelve fixed wardrobe
  // slots. The measured AccountUpdate event remains authoritative and falls
  // back to local-only storage instead of truncating data.
  const MAX_SETS = 24;
  const SETS_PER_PAGE = 12;
  const MAX_SET_APPEARANCE_ITEMS = 80;
  const MAX_SET_CUSTOM_OUTFITS = 40;
  const MAX_SET_BYTES = 65536;
  const MAX_SET_EXCHANGE_CHARS = 500000;
  const MAX_SET_EXCHANGE_BYTES = 262144;
  const OUTFIT_EXCHANGE_FORMAT = "COE_OUTFIT";
  const SET_EXCHANGE_FORMAT = "COE_SET";
  const WARDROBE_EXCHANGE_FORMAT = "COE_WARDROBE";
  const EXCHANGE_FORMAT_VERSION = 1;
  const MAX_OUTFIT_EXCHANGE_CHARS = 200000;
  const MAX_WARDROBE_FILE_BYTES = 1048576;
  // The production BC server accepts at most 180,000 bytes per incoming
  // Socket.IO message. Keep a conservative reserve for Engine.IO/Socket.IO
  // framing and future protocol changes; the measured AccountUpdate event must
  // fit inside this smaller budget before server synchronization is attempted.
  const SERVER_SOCKET_MESSAGE_MAX_BYTES = 180000;
  const SERVER_SYNC_SAFETY_MARGIN_BYTES = 20000;
  const MAX_SERVER_SYNC_MESSAGE_BYTES = SERVER_SOCKET_MESSAGE_MAX_BYTES - SERVER_SYNC_SAFETY_MARGIN_BYTES;
  const TAG_ASSET_NAME = "COECustomOutfit";
  const TAG_PREVIEW_EMOTICON = "⋆｡ﾟ✶°☾⋆｡ﾟ";
  // R130 vanilla appearance groups explicitly marked as clothing/underwear.
  // Body decals and eye shadow are intentionally omitted because they are
  // cosmetic body features rather than removable clothing slots.
  const VANILLA_CLOTHING_SLOT_GROUPS = Object.freeze(new Set([
    "ClothOuter", "Cloth", "ClothAccessory", "Necklace", "Suit", "SuitLower", "ClothLower",
    "Bra", "Corset", "Panties", "Socks", "SocksRight", "SocksLeft", "AnkletRight", "AnkletLeft",
    "Garters", "Shoes", "Hat", "HairAccessory3", "HairAccessory1", "HairAccessory2", "Gloves",
    "HandAccessoryLeft", "HandAccessoryRight", "Bracelet", "Glasses", "Jewelry", "Mask",
    "TailStraps", "Wings",
  ]));

  let modApi = null;
  let runtimeInstalled = false;
  let initialized = false;
  let uiMode = null;
  let editing = null;
  let editingId = null;
  let syntheticByCharacter = new WeakMap();
  let previewCompositionByCharacter = new WeakMap();
  let wardrobe = { schemaVersion: 3, schemes: [], sets: [], equippedIds: [] };
  let wardrobeView = "outfits";
  let selectedSetSlot = null;
  let lastAppliedSetId = null;
  let reconnectSetId = null;
  let reconnectSetRestoreScheduled = false;
  let setWardrobePage = 0;
  let setPreviewGeneration = 0;
  let setPreviewQueue = [];
  let setPreviewRunning = false;
  let setPreviewCharacterSerial = 0;
  const setPreviewCache = new Map();
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
  let characterRefreshScheduled = false;
  let pendingCharacterRefreshes = new Map();
  let previewPoseMapping = null;
  let editorAppearanceSnapshot = null;
  let editorPoseSnapshot = null;
  let glTransformHookTarget = null;
  let glTransformHookWatch = 0;
  let visualAssetProxyCache = new WeakMap();
  let layerNameCache = null;
  let layerNameCachePromise = null;
  let colorPickerSession = null;
  let colorPickerClosing = false;
  // Only one layer or material-level target can own transform controls.
  let transformEditTarget = null;
  const expandedMaterialGroups = new Set();

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



  const COMPOSITION_VERSION = 6;
  const WARDROBE_SCHEMA_VERSION = 3;
  const LEGACY_WARDROBE_VERSION = 7;

  function materialKey(group, asset) {
    return `${group}\u0000${asset}`;
  }

  function optionalFiniteNumber(value, min, max) {
    return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : undefined;
  }

  function normalizeLayerTransform(raw) {
    const rotation = typeof raw.rotation === "number" && isFinite(raw.rotation) && raw.rotation !== 0
      ? clamp(raw.rotation, -Math.PI, Math.PI)
      : undefined;
    const scale = typeof raw.scale === "number" && isFinite(raw.scale) && Math.abs(raw.scale - 1) > 0.001
      ? clamp(raw.scale, 0.25, 3.0)
      : undefined;
    return {
      rotation,
      scale,
      mirrorX: raw.mirrorX === true ? true : undefined,
      mirrorY: raw.mirrorY === true ? true : undefined,
    };
  }

  function normalizeLegacyOverallTransform(raw) {
    if (!raw || Number(raw.version) >= COMPOSITION_VERSION) return null;
    return {
      overallRotation: typeof raw.overallRotation === "number" && isFinite(raw.overallRotation) && raw.overallRotation !== 0
        ? clamp(raw.overallRotation, -Math.PI, Math.PI) : undefined,
      overallScale: typeof raw.overallScale === "number" && isFinite(raw.overallScale) && Math.abs(raw.overallScale - 1) > 0.001
        ? clamp(raw.overallScale, 0.25, 3.0) : undefined,
      overallOffsetX: optionalFiniteNumber(raw.overallOffsetX, -1200, 1200),
      overallOffsetY: optionalFiniteNumber(raw.overallOffsetY, -1200, 1200),
    };
  }

  function normalizeLayer(raw) {
    if (!raw || typeof raw !== "object") return null;
    const sourceGroup = typeof raw.sourceGroup === "string" ? raw.sourceGroup : "";
    const sourceAsset = typeof raw.sourceAsset === "string" ? raw.sourceAsset : "";
    if (!sourceGroup || !sourceAsset) return null;
    const transform = normalizeLayerTransform(raw);
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
      rotation: transform.rotation,
      defaultRotation: undefined,
      scale: transform.scale,
      defaultScale: undefined,
      mirrorX: transform.mirrorX,
      mirrorY: transform.mirrorY,
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
      wearGroup: typeof raw.wearGroup === "string" && raw.wearGroup.length <= 64 ? raw.wearGroup : null,
      // These values belong to one source Asset and transform all of its image
      // layers together. They intentionally live on the material, never on the
      // composition, so two materials can be rotated independently.
      overallRotation: typeof raw.overallRotation === "number" && isFinite(raw.overallRotation) && raw.overallRotation !== 0
        ? clamp(raw.overallRotation, -Math.PI, Math.PI) : undefined,
      overallScale: typeof raw.overallScale === "number" && isFinite(raw.overallScale) && Math.abs(raw.overallScale - 1) > 0.001
        ? clamp(raw.overallScale, 0.25, 3.0) : undefined,
      overallOffsetX: optionalFiniteNumber(raw.overallOffsetX, -1200, 1200),
      overallOffsetY: optionalFiniteNumber(raw.overallOffsetY, -1200, 1200),
      overallMirrorX: raw.overallMirrorX === true ? true : undefined,
      overallMirrorY: raw.overallMirrorY === true ? true : undefined,
      hidden: raw.hidden === true,
      collapsed: raw.collapsed === true,
    };
  }

  function normalizeComposition(raw, options = {}) {
    let layers = Array.isArray(raw?.layers)
      ? raw.layers.slice(0, MAX_LAYERS).map(normalizeLayer).filter(Boolean)
      : [];
    let recycle = Array.isArray(raw?.recycle)
      ? raw.recycle.slice(0, MAX_LAYERS).map(normalizeLayer).filter(Boolean)
      : [];
    const materials = Array.isArray(raw?.materials)
      ? raw.materials.map(normalizeMaterial).filter(Boolean)
      : [];
    // Rebuild against the currently loaded Asset table. An exact layer index/name
    // match is required; silently binding a stale index to a similarly named layer
    // would make a saved transform affect the wrong image.
    const exactReference = layer => {
      if (typeof globalThis.AssetGet !== "function") return true;
      const asset = AssetGet(globalThis.Player?.AssetFamily || "Female3DCG", layer.sourceGroup, layer.sourceAsset);
      if (!asset) return false;
      if (!Number.isInteger(layer.sourceLayerIndex) && layer.sourceLayer == null) return !!asset.Layer?.some(isDrawableLayer);
      const candidate = Number.isInteger(layer.sourceLayerIndex) ? asset.Layer?.[layer.sourceLayerIndex] : asset.Layer?.find(item => item.Name === layer.sourceLayer);
      return !!candidate && isDrawableLayer(candidate) && (layer.sourceLayer == null || candidate.Name === layer.sourceLayer);
    };
    if (options.validateReferences !== false) {
      layers = layers.filter(exactReference);
      recycle = recycle.filter(exactReference);
    }
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
    const usedMaterials = materials.filter(material => used.has(material.id));
    // Composition schemas before v6 could carry one composition-wide transform.
    // Preserve it only for a single-material outfit, and never overwrite the
    // authoritative material-level value written by newer builds.
    const legacyOverall = normalizeLegacyOverallTransform(raw);
    if (legacyOverall && usedMaterials.length === 1) {
      const material = usedMaterials[0];
      for (const [key, value] of Object.entries(legacyOverall)) {
        if (typeof value === "number" && typeof material[key] !== "number") material[key] = value;
      }
    }
    return {
      version: COMPOSITION_VERSION,
      name: String(raw?.name || "未命名方案").slice(0, 60),
      slotGroup: typeof raw?.slotGroup === "string" && raw.slotGroup.length <= 64 ? raw.slotGroup : "Cloth",
      materials: usedMaterials,
      layers,
      recycle,
    };
  }

  function firstFinite(value, fallback = 0) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value && typeof value === "object") {
      for (const entry of Object.values(value)) if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    }
    return fallback;
  }

  function resolveNumericOrigin(origin, character, fallback = 0) {
    if (typeof origin === "number" && Number.isFinite(origin)) return origin;
    if (!origin || typeof origin !== "object") return fallback;
    const poses = Array.isArray(character?.DrawPose) ? character.DrawPose : [];
    for (const pose of poses) {
      if (typeof origin[pose] === "number" && Number.isFinite(origin[pose])) return origin[pose];
    }
    if (typeof origin.Default === "number" && Number.isFinite(origin.Default)) return origin.Default;
    return firstFinite(origin, fallback);
  }

  function sourceContentBounds(asset, sourceLayer) {
    const explicit = sourceLayer?.ContentBounds || sourceLayer?.AlphaBounds || sourceLayer?.VisibleBounds || asset?.ContentBounds;
    if (explicit && typeof explicit === "object") {
      const left = firstFinite(explicit.left ?? explicit.x, 0);
      const top = firstFinite(explicit.top ?? explicit.y, 0);
      const width = firstFinite(explicit.width ?? explicit.w, 0);
      const height = firstFinite(explicit.height ?? explicit.h, 0);
      if (width > 0 && height > 0) return { left, top, width, height };
    }
    const width = firstFinite(sourceLayer?.DrawingWidth ?? sourceLayer?.Width ?? asset?.Width, 100);
    const height = firstFinite(sourceLayer?.DrawingHeight ?? sourceLayer?.Height ?? asset?.Height, 100);
    return { left: firstFinite(sourceLayer?.DrawingLeft, 0), top: firstFinite(sourceLayer?.DrawingTop, 0), width: Math.max(1, width), height: Math.max(1, height) };
  }

  function resolveCoordinateVector(value, character, fallback = { x: 0, y: 0 }) {
    if (typeof value === "number" && Number.isFinite(value)) return { x: 0, y: value };
    if (!value || typeof value !== "object") return fallback;
    const poses = Array.isArray(character?.DrawPose) ? character.DrawPose : [];
    const candidates = [...poses, "Default"];
    for (const pose of candidates) {
      const entry = value[pose];
      if (typeof entry === "number" && Number.isFinite(entry)) return { x: 0, y: entry };
      if (entry && typeof entry === "object") {
        const x = firstFinite(entry.x ?? entry.X ?? entry.left ?? entry.Left, 0);
        const y = firstFinite(entry.y ?? entry.Y ?? entry.top ?? entry.Top, 0);
        if (Number.isFinite(x) || Number.isFinite(y)) return { x, y };
      }
    }
    return {
      x: firstFinite(value.x ?? value.X ?? value.left ?? value.Left, fallback.x),
      y: firstFinite(value.y ?? value.Y ?? value.top ?? value.Top, fallback.y),
    };
  }

  function resolveCoordinatePipelineOffset(asset, sourceLayer, character) {
    let x = 0;
    let y = 0;
    // CommonDraw uses DynamicGroupName for pose moves and body offsets. The
    // static Group name is only a fallback for older/custom assets without it.
    const groupName = asset?.DynamicGroupName || asset?.Group?.Name || "";
    const poseNames = Array.isArray(character?.DrawPose) ? character.DrawPose : [];
    const poseRecord = globalThis.PoseRecord;
    for (const poseName of poseNames) {
      const pose = poseRecord && typeof poseRecord === "object" ? poseRecord[poseName] : null;
      const move = Array.isArray(pose?.MovePosition)
        ? pose.MovePosition.find(entry => entry?.Group === groupName)
        : null;
      if (move) {
        x += firstFinite(move.X ?? move.x, 0);
        y += firstFinite(move.Y ?? move.y, 0);
      }
    }

    // This mirrors CommonDrawComputeDrawingCoordinates() in BC R130. Fixed
    // position assets use the character's height correction before the global
    // canvas overflow is added.
    if (asset?.FixedPosition || sourceLayer?.FixedPosition) {
      const inverted = typeof character?.IsInverted === "function"
        ? character.IsInverted() === true : character?.IsInverted === true;
      const currentY = resolveNumericOrigin(sourceLayer?.DrawingTop, character, 0) + y;
      if (inverted) {
        const heightRatio = firstFinite(character?.HeightRatio, 1) || 1;
        const appearanceYOffset = typeof globalThis.CharacterAppearanceYOffset === "function"
          ? firstFinite(globalThis.CharacterAppearanceYOffset(character, heightRatio, true), 0) : 0;
        y += -currentY + 1000 - (currentY + appearanceYOffset / heightRatio);
      } else {
        const heightRatio = firstFinite(character?.HeightRatio, 1);
        const heightModifier = firstFinite(character?.HeightModifier, 0);
        const proportion = firstFinite(character?.HeightRatioProportion, 0);
        y += heightModifier + (heightRatio ? (1000 * (1 - heightRatio) * (1 - proportion)) / heightRatio : 0);
      }
    }

    const upperOverflow = firstFinite(globalThis.CanvasUpperOverflow ?? character?.CanvasUpperOverflow, 0);
    y += upperOverflow;

    const bodyStyleItem = typeof globalThis.InventoryGet === "function"
      ? globalThis.InventoryGet(character, "BodyStyle") : null;
    const bodyStyle = bodyStyleItem?.Asset || character?.BodyStyle || globalThis.BodyStyle;
    const offsets = bodyStyle?.DrawOffset;
    const drawOffset = Array.isArray(offsets)
      ? offsets.find(offset => offset?.Group === groupName &&
        (offset.Asset === undefined || offset.Asset === asset?.Name) &&
        (offset.Layer === undefined || offset.Layer.includes?.(sourceLayer?.Name ?? "")))
      : null;
    if (drawOffset) {
      x += firstFinite(drawOffset.X ?? drawOffset.x, 0);
      y += firstFinite(drawOffset.Y ?? drawOffset.y, 0);
    }
    return { x, y };
  }

  function resolveOverallCanvasHeight(character) {
    const candidates = [
      globalThis.GLDrawCanvas?.height,
      globalThis.CanvasDrawHeight,
      character?.Canvas?.height,
      550,
    ];
    return candidates.find(value => Number.isFinite(value) && value > 0) || 550;
  }

  function resolveOverallLayerRect(composition, layer, character, material) {
    const asset = typeof globalThis.AssetGet === "function"
      ? AssetGet(character?.AssetFamily || globalThis.Player?.AssetFamily || "Female3DCG", layer.sourceGroup, layer.sourceAsset) : null;
    if (!asset) return null;
    const sourceLayer = typeof resolveSourceLayer === "function"
      ? resolveSourceLayer(asset, layer) : asset.Layer?.[layer.sourceLayerIndex] || asset.Layer?.[0];
    if (!isDrawableLayer(sourceLayer)) return null;

    const offsetX = Number.isFinite(layer.offsetX) ? layer.offsetX : 0;
    const offsetY = Number.isFinite(layer.offsetY) ? layer.offsetY : 0;
    const positionedLayer = {
      ...sourceLayer,
      DrawingLeft: typeof shiftOrigin === "function" ? shiftOrigin(sourceLayer.DrawingLeft, offsetX) : sourceLayer.DrawingLeft,
      DrawingTop: typeof shiftOrigin === "function" ? shiftOrigin(sourceLayer.DrawingTop, offsetY) : sourceLayer.DrawingTop,
    };
    const properties = material?.sourceProperty && typeof material.sourceProperty === "object"
      ? material.sourceProperty : {};
    let left;
    let top;
    const coordinateResolver = globalThis.CommonDrawComputeDrawingCoordinates;
    if (typeof coordinateResolver === "function" && character) {
      try {
        // Reuse BC's own coordinate pipeline whenever it is available. This keeps
        // pose moves, fixed-position correction, CanvasUpperOverflow and
        // BodyStyle.DrawOffset in the same coordinate space as GLDrawImage.
        const coordinates = coordinateResolver(
          character,
          asset,
          positionedLayer,
          asset.DynamicGroupName || asset.Group?.Name || "",
          properties,
        );
        left = Number(coordinates?.X);
        top = Number(coordinates?.Y);
      } catch (_) {
        left = undefined;
        top = undefined;
      }
    }
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      const pipeline = resolveCoordinatePipelineOffset(asset, sourceLayer, character);
      left = resolveNumericOrigin(sourceLayer.DrawingLeft, character, 0) + pipeline.x + offsetX;
      top = resolveNumericOrigin(sourceLayer.DrawingTop, character, 0) + pipeline.y + offsetY;
    }

    const width = Math.max(1, resolveNumericOrigin(
      sourceLayer.DrawingWidth ?? sourceLayer.Width ?? asset.Width, character, 100,
    ));
    const height = Math.max(1, resolveNumericOrigin(
      sourceLayer.DrawingHeight ?? sourceLayer.Height ?? asset.Height, character, 100,
    ));
    let right = left + width;
    let bottom = top + height;

    // GLDrawImage applies Mirror and Invert after CommonDraw has produced X/Y.
    // Convert the rectangle into that same final canvas space before combining
    // it with the other layers of the material.
    if (properties.Mirror === true) {
      const mirroredLeft = 500 - right;
      const mirroredRight = 500 - left;
      left = mirroredLeft;
      right = mirroredRight;
    }
    if (properties.Invert === true) {
      const canvasBottom = resolveOverallCanvasHeight(character) + 550;
      const invertedTop = canvasBottom - bottom;
      const invertedBottom = canvasBottom - top;
      top = invertedTop;
      bottom = invertedBottom;
    }
    return { left, top, right, bottom };
  }

  function computeDefaultOverallCenter(composition, character = globalThis.Player, materialId = null) {
    const material = materialId == null
      ? null : composition?.materials?.find(item => item.id === materialId) || null;
    let bounds = null;
    for (const layer of composition?.layers || []) {
      if (layer.hidden || (materialId != null && layer.materialId !== materialId)) continue;
      const rect = resolveOverallLayerRect(composition, layer, character, material);
      if (!rect) continue;
      if (!bounds) bounds = { ...rect };
      else {
        bounds.left = Math.min(bounds.left, rect.left);
        bounds.top = Math.min(bounds.top, rect.top);
        bounds.right = Math.max(bounds.right, rect.right);
        bounds.bottom = Math.max(bounds.bottom, rect.bottom);
      }
    }
    // Overall transform centers are expressed in composition/screen pixels. Use
    // the character canvas center as a stable empty-composition fallback.
    if (!bounds) return { x: 250, y: 275 };
    return {
      x: (bounds.left + bounds.right) / 2,
      y: (bounds.top + bounds.bottom) / 2,
    };
  }

  function resolveOverallTransform(composition, character = globalThis.Player, material = null) {
    const materialId = typeof material === "string" ? material : material?.id ?? null;
    const source = material && typeof material === "object" ? material : composition;
    const center = computeDefaultOverallCenter(composition, character, materialId);
    return {
      rotation: typeof source?.overallRotation === "number" ? source.overallRotation : 0,
      scale: typeof source?.overallScale === "number" ? source.overallScale : 1,
      offsetX: typeof source?.overallOffsetX === "number" ? source.overallOffsetX : 0,
      offsetY: typeof source?.overallOffsetY === "number" ? source.overallOffsetY : 0,
      mirrorX: source?.overallMirrorX === true,
      mirrorY: source?.overallMirrorY === true,
      centerX: center.x,
      centerY: center.y,
    };
  }

  function normalizeWardrobe(raw, options = {}) {
    const list = Array.isArray(raw?.schemes) ? raw.schemes : [];
    const schemes = list.slice(0, MAX_SCHEMES).map(entry => ({
      id: typeof entry?.id === "string" ? entry.id : uid(),
      composition: normalizeComposition(entry?.composition, options),
    }));
    const validIds = new Set(schemes.map(entry => entry.id));
    const schemeById = new Map(schemes.map(entry => [entry.id, entry]));
    const candidateIds = Array.isArray(raw?.equippedIds)
      ? [...new Set(raw.equippedIds.filter(id => typeof id === "string" && validIds.has(id)))]
      : [];
    const occupiedSlots = new Set();
    const equippedIds = candidateIds.filter(id => {
      const slotGroup = schemeById.get(id)?.composition?.slotGroup || "Cloth";
      if (occupiedSlots.has(slotGroup)) return false;
      occupiedSlots.add(slotGroup);
      return true;
    });
    const setIds = new Set();
    const setSlots = new Set();
    const sets = [];
    for (const rawSet of Array.isArray(raw?.sets) ? raw.sets.slice(0, MAX_SETS) : []) {
      const set = normalizeSet(rawSet, { validSchemeIds: validIds });
      if (!set || setIds.has(set.id)) continue;
      let slot = Number.isInteger(set.slot) && set.slot >= 0 && set.slot < MAX_SETS && !setSlots.has(set.slot) ? set.slot : null;
      if (slot == null) {
        slot = Array.from({ length: MAX_SETS }, (_, index) => index).find(index => !setSlots.has(index));
      }
      if (slot == null) break;
      set.slot = slot;
      setIds.add(set.id);
      setSlots.add(slot);
      sets.push(set);
    }
    sets.sort((a, b) => a.slot - b.slot);
    return {
      schemaVersion: WARDROBE_SCHEMA_VERSION,
      schemes,
      sets,
      equippedIds,
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
    if (typeof layer.rotation === "number" && layer.rotation !== 0) output.rotation = layer.rotation;
    if (typeof layer.scale === "number" && Math.abs(layer.scale - 1) > 0.001) output.scale = layer.scale;
    if (layer.mirrorX === true) output.mirrorX = true;
    if (layer.mirrorY === true) output.mirrorY = true;
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
    for (const key of ["overallRotation", "overallScale", "overallOffsetX", "overallOffsetY"]) {
      if (typeof material[key] === "number") output[key] = material[key];
    }
    if (material.overallMirrorX === true) output.overallMirrorX = true;
    if (material.overallMirrorY === true) output.overallMirrorY = true;
    if (material.hidden) output.hidden = true;
    const property = sanitizeSourceProperty(material.sourceProperty);
    if (Object.keys(property).length) output.sourceProperty = property;
    return output;
  }

  function compactCompositionForStorage(composition, options = {}) {
    const normalized = normalizeComposition(composition, options);
    const compact = {
      version: COMPOSITION_VERSION,
      name: normalized.name,
      slotGroup: normalized.slotGroup,
      materials: normalized.materials.map(compactMaterialForStorage),
      layers: normalized.layers.map(compactLayerForStorage),
    };
    if (normalized.recycle.length) compact.recycle = normalized.recycle.map(compactLayerForStorage);
    for (const material of compact.materials) {
      const refs = [...compact.layers, ...(compact.recycle || [])].filter(layer => layer.materialId === material.id);
      if (utf8Bytes({ material, refs }) > MAX_MATERIAL_BYTES) throw new Error("material-byte-budget");
    }
    if (utf8Bytes(compact) > MAX_SCHEME_BYTES) throw new Error("scheme-byte-budget");
    return compact;
  }

  function compactWardrobeForStorage(data, options = {}) {
    const normalized = normalizeWardrobe(data, options);
    const validSchemeIds = new Set(normalized.schemes.map(entry => entry.id));
    const compact = {
      schemaVersion: WARDROBE_SCHEMA_VERSION,
      schemes: normalized.schemes.map(entry => ({ id: entry.id, composition: compactCompositionForStorage(entry.composition, options) })),
      sets: normalized.sets.map(set => compactSetForStorage(set, { validSchemeIds })),
      equippedIds: normalized.equippedIds,
    };
    if (utf8Bytes(compact) > MAX_WARDROBE_BYTES) throw new Error("wardrobe-byte-budget");
    return compact;
  }



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



  function packWardrobe(data) {
    const compact = compactWardrobeForStorage(data, { validateReferences: false });
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
      const migration = migrateWardrobeData(parsed);
      return {
        status: "ok",
        raw: value,
        data: migration.data,
        error: null,
        migration: {
          migrated: migration.migrated,
          fromVersion: migration.fromVersion,
          toVersion: migration.toVersion,
        },
      };
    } catch (error) {
      const unsupportedCodes = new Set(["newer-schema", "newer-legacy-schema", "newer-outfit-schema"]);
      const status = unsupportedCodes.has(error?.code) ? "unsupported" : "corrupt";
      return { status, raw: value, data: null, error: error?.code || String(error?.message || error), migration: null };
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

  function migrationBackupKey(fromVersion) {
    return `${accountStorageKey()}.migration-backup.v${fromVersion}`;
  }

  function preserveMigrationBackup(result, source) {
    if (!result?.migration?.migrated || typeof result.raw !== "string") return null;
    const key = migrationBackupKey(result.migration.fromVersion);
    const fingerprint = storageFingerprint(result.raw);
    let existing = null;
    try { existing = JSON.parse(localStorage.getItem(key) || "null"); }
    catch (_) { /* replace malformed backup */ }
    if (existing?.fingerprint === fingerprint && existing?.raw === result.raw) return key;
    const backup = JSON.stringify({
      backupVersion: 1,
      source,
      fromSchemaVersion: result.migration.fromVersion,
      toSchemaVersion: result.migration.toVersion,
      createdAt: new Date().toISOString(),
      fingerprint,
      raw: result.raw,
    });
    try {
      localStorage.setItem(key, backup);
      if (localStorage.getItem(key) !== backup) throw new Error("backup-verification-failed");
    } catch (error) {
      throw wardrobeMigrationError("migration-backup-failed", `无法备份旧衣柜：${String(error?.message || error)}`);
    }
    return key;
  }

  function loadWardrobe() {
    const serverRaw = globalThis.Player?.ExtensionSettings?.[SETTINGS_KEY] ?? null;
    const localRaw = readLocalWardrobeRaw();
    const server = unpackWardrobeDetailed(serverRaw);
    const local = unpackWardrobeDetailed(localRaw);
    const marker = readLocalSyncMarker();
    const markerMatchesLocal = local.status === "ok" && marker?.fingerprint === storageFingerprint(localRaw);
    const failures = [server, local].filter(result => ["deferred", "corrupt", "unsupported"].includes(result.status));
    const contentsDiffer = server.status === "ok" && local.status === "ok" &&
      JSON.stringify(compactWardrobeForStorage(server.data, { validateReferences: false })) !==
      JSON.stringify(compactWardrobeForStorage(local.data, { validateReferences: false }));
    const localOnly = markerMatchesLocal && (contentsDiffer || server.status !== "ok");
    const conflict = contentsDiffer && !localOnly;
    if (!contentsDiffer && marker) clearLocalSyncMarker();
    persistenceBlocked = failures.length > 0 || conflict;
    let selected = null;
    let source = null;
    if (localOnly) { selected = local.data; source = "local"; }
    else if (server.status === "ok" && local.status === "ok" && !contentsDiffer && server.migration?.migrated && !local.migration?.migrated) {
      selected = local.data; source = "local";
    }
    else if (server.status === "ok") { selected = server.data; source = "server"; }
    else if (local.status === "ok") { selected = local.data; source = "local"; }
    else if (server.status === "absent" && local.status === "absent") { selected = normalizeWardrobe(null); source = "empty"; }
    const migrations = [
      ...(server.status === "ok" && server.migration?.migrated ? [{ source: "server", result: server }] : []),
      ...(local.status === "ok" && local.migration?.migrated ? [{ source: "local", result: local }] : []),
    ];
    wardrobeReadState = {
      status: failures[0]?.status || (conflict ? "conflict" : localOnly ? "local-only" : selected ? "ok" : "absent"),
      source,
      server: { status: server.status, error: server.error, raw: server.raw, migration: server.migration || null },
      local: { status: local.status, error: local.error, raw: local.raw, migration: local.migration || null },
      conflict,
      migration: migrations.length ? { status: "pending", fromVersion: Math.min(...migrations.map(entry => entry.result.migration.fromVersion)), toVersion: WARDROBE_SCHEMA_VERSION, backupKey: null } : null,
      sync: localOnly ? { mode: "local-only", reason: marker.reason, requestBytes: marker.requestBytes, maxRequestBytes: MAX_SERVER_SYNC_MESSAGE_BYTES } : null,
    };
    if (selected) wardrobe = selected;

    if (!persistenceBlocked && selected && migrations.length) {
      try {
        const preferred = migrations.find(entry => entry.source === source) || migrations[0];
        const backupKey = preserveMigrationBackup(preferred.result, preferred.source);
        persistWardrobe({ force: true, source: "migration", migration: { status: "completed", fromVersion: preferred.result.migration.fromVersion, toVersion: WARDROBE_SCHEMA_VERSION, backupKey } });
      } catch (error) {
        persistenceBlocked = true;
        wardrobeReadState.status = "migration-failed";
        wardrobeReadState.migration = {
          status: "failed",
          fromVersion: Math.min(...migrations.map(entry => entry.result.migration.fromVersion)),
          toVersion: WARDROBE_SCHEMA_VERSION,
          backupKey: null,
          error: error?.code || String(error?.message || error),
        };
        const message = "旧衣柜迁移写回失败，已保留原始数据并停止自动保存";
        diagnostics.lastWarnings.push(message);
        warn(message, error);
      }
    }

    if (persistenceBlocked && wardrobeReadState.status !== "migration-failed") {
      const message = conflict ? "服务器与本地衣柜内容冲突，已停止自动写回" : "衣柜数据暂不可安全读取，已停止写回";
      diagnostics.lastWarnings.push(message);
      warn(message, wardrobeReadState);
    }
    return wardrobeReadState;
  }

  function setLocalOnlyState(packed, serverState, localState, reason, requestBytes, options = {}) {
    const marker = writeLocalSyncMarker(packed, reason, requestBytes);
    wardrobeReadState = {
      status: "local-only",
      source: "local",
      server: serverState,
      local: localState,
      conflict: false,
      migration: options.migration || null,
      sync: { mode: marker.mode, reason: marker.reason, requestBytes: marker.requestBytes, maxRequestBytes: marker.maxRequestBytes },
    };
  }

  function persistWardrobe(options = {}) {
    if (persistenceBlocked && options.force !== true) throw new Error(`wardrobe-write-blocked:${wardrobeReadState.status}`);
    const normalized = normalizeWardrobe(wardrobe, { validateReferences: false });
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
      setLocalOnlyState(packed, serverState, localState, "server-byte-budget", requestBytes, options);
      const message = `衣柜同步请求 ${requestBytes} 字节，超过安全上限 ${MAX_SERVER_SYNC_MESSAGE_BYTES} 字节；已仅保存到本机`;
      if (!diagnostics.lastWarnings.includes(message)) diagnostics.lastWarnings.push(message);
      warn(message);
      toast(message, "warn");
      return packed;
    }

    if (!globalThis.Player || typeof globalThis.ServerPlayerExtensionSettingsSync !== "function") {
      if (localError) throw new Error(`wardrobe-storage-unavailable:${localError}`);
      setLocalOnlyState(packed, serverState, localState, "server-sync-unavailable", requestBytes, options);
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
        source: options.source || "user-save",
        server: { status: "sent", error: null, raw: packed },
        local: localState,
        conflict: false,
        migration: options.migration || null,
        sync: { mode: "server", reason: null, requestBytes, maxRequestBytes: MAX_SERVER_SYNC_MESSAGE_BYTES },
      };
    } catch (error) {
      if (hadPreviousServerValue) Player.ExtensionSettings[SETTINGS_KEY] = previousServerRaw;
      else delete Player.ExtensionSettings[SETTINGS_KEY];
      if (localError) throw error;
      setLocalOnlyState(packed, serverState, localState, "server-sync-error", requestBytes, options);
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
    const allAssetsMissing = unfiltered.layers.length > 0 && available.layers.length === 0;
    return {
      composition: available,
      metadata: {
        createdAt: typeof envelope.createdAt === "string" ? envelope.createdAt.slice(0, 40) : null,
        pluginVersion: typeof envelope.pluginVersion === "string" ? envelope.pluginVersion.slice(0, 24) : null,
      },
      missingLayers,
      missingRecycle,
      allAssetsMissing,
    };
  }

  function createWardrobeExchangeDocument(data = wardrobe) {
    const payload = compactWardrobeForStorage(data, { validateReferences: false });
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
    let migration;
    try { migration = migrateWardrobeData(payload); }
    catch (error) { throw exchangeError(error?.code || "wardrobe-migration-failed", error?.message || "衣柜数据迁移失败"); }
    const migratedPayload = migration.compact;
    const schemeIds = new Set();
    let missingLayers = 0;
    let affectedSchemes = 0;
    for (const scheme of migratedPayload.schemes) {
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
    const normalized = normalizeWardrobe(migratedPayload);
    compactWardrobeForStorage(normalized);
    return {
      wardrobe: normalized,
      missingLayers,
      affectedSchemes,
      missingSetReferences: migration.missingSetReferences || 0,
      migration: {
        migrated: migration.migrated,
        fromVersion: migration.fromVersion,
        toVersion: migration.toVersion,
      },
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



  function isLocalPlayer(character) {
    return !!character && character === globalThis.Player;
  }

  function isPreviewCompositionCharacter(character) {
    return !!character && previewCompositionByCharacter.has(character);
  }

  function getComposition(character) {
    const preview = character ? previewCompositionByCharacter.get(character) : null;
    if (preview) return preview;
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
    const delta = Number.isFinite(Number(offset)) ? Number(offset) : 0;
    if (typeof origin === "number") return Number.isFinite(origin) ? origin + delta : origin;
    if (!origin || typeof origin !== "object") return origin;
    const shifted = {};
    for (const [key, value] of Object.entries(origin)) {
      const numeric = Number(value);
      shifted[key] = Number.isFinite(numeric) ? numeric + delta : value;
    }
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
      if (!asset?.Wear || asset.IsLock || asset.Name === TAG_ASSET_NAME) return false;
      if (!asset.Layer?.some(isDrawableLayer)) return false;
      const text = `${asset.Group?.Name || ""} ${asset.Name || ""} ${asset.Description || ""}`.toLowerCase();
      return !q || text.includes(q);
    }).slice(0, 800);
  }

  function clothingSlotGroups() {
    const runtimeGroups = Array.isArray(globalThis.AssetGroup) ? globalThis.AssetGroup : [];
    const assetGroups = (globalThis.Asset || []).map(asset => asset?.Group).filter(Boolean);
    const unique = new Map();
    for (const group of [...runtimeGroups, ...assetGroups]) {
      if (!group?.Name || unique.has(group.Name)) continue;
      unique.set(group.Name, group);
    }
    return [...unique.values()]
      .filter(group => VANILLA_CLOTHING_SLOT_GROUPS.has(group.Name)
        && group.Category === "Appearance" && group.AllowNone === true
        && group.BodyCosplay !== true && (group.Clothing === true || group.Underwear === true))
      .sort((left, right) => String(left.Description || left.Name).localeCompare(String(right.Description || right.Name), "zh-CN"));
  }

  function clothingSlotGroup(groupName) {
    return clothingSlotGroups().find(group => group.Name === groupName) || null;
  }

  function clothingSlotLabel(groupName) {
    const group = clothingSlotGroup(groupName)
      || (globalThis.Asset || []).find(asset => asset?.Group?.Name === groupName)?.Group;
    return group?.Description || groupName || "服装";
  }

  function defaultClothingSlotGroup() {
    const groups = clothingSlotGroups();
    return groups.find(group => group.Name === "Cloth")?.Name || groups[0]?.Name || "Cloth";
  }

  function registerTagAssets() {
    if (typeof globalThis.AssetAdd !== "function" || typeof globalThis.AssetGet !== "function") return false;
    let registered = 0;
    for (const group of clothingSlotGroups()) {
      if (AssetGet("Female3DCG", group.Name, TAG_ASSET_NAME)) continue;
      const groupDef = globalThis.AssetFemale3DCG?.find(definition => definition?.Group === group.Name);
      if (!groupDef) {
        warn(`无法注册 ${group.Name} 标签服装：缺少原版格子定义`);
        continue;
      }
      const description = `自定义${clothingSlotLabel(group.Name)}`;
      AssetAdd(group, {
        Name: TAG_ASSET_NAME,
        Description: description,
        Value: 0,
        Wear: true,
        Visible: true,
        Random: false,
        AllowLock: false,
        DefaultColor: ["Default"],
        DynamicDescription: () => description,
        DynamicName: () => description,
        Layer: [{ Name: "Tag", HasImage: false, AllowColorize: false }],
      }, null, groupDef);
      const asset = AssetGet("Female3DCG", group.Name, TAG_ASSET_NAME);
      if (asset) {
        asset.Description = description;
        asset.DynamicDescription = () => description;
        asset.DynamicName = () => description;
        asset.__coeTagAsset = true;
        registered++;
      }
    }
    return registered > 0;
  }

  function tagItem(character, groupName) {
    if (!character || !groupName) return null;
    const item = typeof globalThis.InventoryGet === "function"
      ? InventoryGet(character, groupName)
      : character.Appearance?.find(entry => entry?.Asset?.Group?.Name === groupName) || null;
    return item?.Asset?.Name === TAG_ASSET_NAME ? item : null;
  }

  function isTagEquipped(character, groupName) {
    return !!tagItem(character, groupName);
  }

  function equipTagForGroup(groupName) {
    if (!globalThis.Player || !clothingSlotGroup(groupName)) return false;
    if (isTagEquipped(Player, groupName)) return true;
    if (!AssetGet(Player.AssetFamily || "Female3DCG", groupName, TAG_ASSET_NAME)) registerTagAssets();
    if (typeof globalThis.InventoryWear !== "function") return false;
    try {
      return !!InventoryWear(Player, TAG_ASSET_NAME, groupName, "Default", null, Player.MemberNumber, null, true);
    } catch (error) {
      warn(`自动装备「自定义${clothingSlotLabel(groupName)}」失败`, error);
      return false;
    }
  }

  function installTagAssetPreviewHook() {
    modApi.hookFunction("DrawAssetPreview", 0, (args, next) => {
      const [x, y, asset, options = {}] = args;
      if (asset?.Name !== TAG_ASSET_NAME || asset?.Group?.Category !== "Appearance") return next(args);
      const width = options.Width || globalThis.DrawAssetPreviewDefaultWidth || 225;
      const height = options.Height || globalThis.DrawAssetPreviewDefaultHeight || 275;
      const description = options.Description ?? asset.DynamicDescription?.(options.C) ?? asset.Description;
      if (typeof globalThis.DrawPreviewBox === "function") {
        DrawPreviewBox(x, y, "", description, options);
        if (typeof globalThis.DrawTextFit === "function") {
          const gutter = description ? 44 : 0;
          DrawTextFit(TAG_PREVIEW_EMOTICON, x + width / 2, y + (height - gutter) / 2, width - 24, options.Foreground || "#27485f");
        }
        return;
      }
      return next(args);
    });
  }



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
    const drawable = refs.map(ref => ({ ref, sourceLayer: resolveSourceLayer(asset, ref) }))
      .filter(entry => isDrawableLayer(entry.sourceLayer))
      .sort((a, b) => (a.ref.sourceLayerIndex ?? asset.Layer.indexOf(a.sourceLayer)) - (b.ref.sourceLayerIndex ?? asset.Layer.indexOf(b.sourceLayer)));
    if (!drawable.length) throw new Error("no-drawable-layer");
    // Byte budgets are enforced at persistence and remote-protocol boundaries.
    // Avoid serializing unchanged material data on every preview frame.
    const colors = resolveMaterialColors(material, asset, refs);
    const baseProperty = sanitizeVisualProperty(material.sourceProperty || {}, analysis, asset);
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
    const duplicate = diagnostics.skippedMaterials.some(item =>
      item?.materialId === entry.materialId && item?.stage === entry.stage && item?.reason === entry.reason);
    if (!duplicate) {
      diagnostics.skippedMaterials.push(entry);
      diagnostics.skippedMaterials = diagnostics.skippedMaterials.slice(-100);
    }
  }

  function buildLocalSyntheticItems(character) {
    const rawComposition = getComposition(character);
    if (!rawComposition || (!isLocalPlayer(character) && !isPreviewCompositionCharacter(character))) return [];
    // Editor state is already normalized when opened and after structural UI edits.
    // Keep its object identities during live transforms so the lightweight redraw
    // path can reuse synthetic layers instead of cloning the whole composition.
    const composition = uiMode === "editor" ? rawComposition : normalizeComposition(rawComposition);
    const materialMap = new Map(composition.materials.map(material => [material.id, material]));
    const groupedRefs = new Map();
    for (let layerIndex = 0; layerIndex < composition.layers.length; layerIndex++) {
      const ref = composition.layers[layerIndex];
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
      if (material.wearGroup && uiMode !== "editor" && !isTagEquipped(character, material.wearGroup)) continue;
      let sourceAsset = null;
      let analysis = null;
      try {
        sourceAsset = AssetGet(character.AssetFamily || "Female3DCG", material.sourceGroup, material.sourceAsset);
        if (!sourceAsset) throw new Error("source-asset-missing");
        const formalConflict = (character.Appearance || []).some(item => item?.Asset === sourceAsset);
        // During editor preview a removable formal appearance is replaced by the
        // synthetic static layers in CommonDrawAppearanceBuild. Protected groups
        // still fail closed to avoid drawing two competing copies.
        if (formalConflict && !(uiMode === "editor" && isEditorRemovableAsset(sourceAsset))) throw new Error("formal-item-conflict");
        // Capability analysis is diagnostic only. Every loaded asset is projected to
        // inert static image layers; unsupported dynamic behavior is not invoked.
        analysis = analyzeAssetCached(sourceAsset);
        pruneOverallGeometry(character, material.id, sourceAsset, refs);
        const overall = resolveRenderableOverallTransform(composition, character, material);
        const layerGroups = buildStaticSynthetic({ character, material, refs, asset: sourceAsset, analysis, overall });
        for (let sourceOrder = 0; sourceOrder < layerGroups.length; sourceOrder++) {
          const group = layerGroups[sourceOrder];
          group.materialOrder = materialOrder;
          group.drawable[0].sourceOrder = sourceOrder;
          groups.push(group);
        }
        runtimeMaterialState.set(material.id, { disabled: false, analysis: cloneJSON(analysis), reason: null });
      } catch (error) {
        recordMaterialSkip(material, analysis, "buildSynthetic", error);
      }
    }
    return groups;
  }

  const CONTENT_ALPHA_THRESHOLD = 16;
  const CONTENT_MIN_PIXELS = 4;
  const CONTENT_SCAN_MAX_EDGE = 512;
  const textureContentPivotCache = new Map();
  const pendingPreviewTexturesByCharacter = new WeakMap();

  function trackPreviewTextureLoad(character, url, width, height) {
    if (!isPreviewCompositionCharacter(character) || !url) return;
    let pending = pendingPreviewTexturesByCharacter.get(character);
    if (width > 1 && height > 1) {
      pending?.delete(url);
      return;
    }
    const image = typeof globalThis.GLDrawImageCache?.get === "function" ? globalThis.GLDrawImageCache.get(url) : null;
    if (!image) return;
    if (!pending) {
      pending = new Set();
      pendingPreviewTexturesByCharacter.set(character, pending);
    }
    if (image.complete === true && Number(image.naturalWidth || image.width) > 0) {
      pending.delete(url);
      character.MustDraw = true;
      return;
    }
    if (pending.has(url)) return;
    pending.add(url);
    if (typeof image.addEventListener === "function") image.addEventListener("load", () => {
      pending.delete(url);
      character.MustDraw = true;
    }, { once: true });
  }

  function previewTexturesPending(character) {
    return (pendingPreviewTexturesByCharacter.get(character)?.size || 0) > 0;
  }

  function clearPreviewTextureTracking(character) {
    if (character) pendingPreviewTexturesByCharacter.delete(character);
  }

  // Asset metadata in BC R130 does not contain rendered texture dimensions.
  // Geometry discovered at GLDrawImage is therefore the authoritative source
  // for the next frame's material pivot. The cache is kept per character so
  // identical materials on different characters cannot contaminate one another.
  const overallGeometryCache = new WeakMap();

  function cacheOverallLayerGeometry(options, dstX, dstY, offsetX, texW, texH, canvasHeight, url = null) {
    const character = options?.__coeGeometryCharacter;
    const materialId = options?.__coeGeometryMaterialId;
    const layerKey = options?.__coeGeometryLayerKey;
    if (!character || materialId == null || layerKey == null || options?.__coeGeometryIsBlink === true) return;
    // BC only marks characters wearing a formal Appearance item dirty when its
    // texture finishes loading. COE layers are synthetic, so start our own load
    // observer before rejecting the initial 1x1 placeholder geometry. Isolated
    // wardrobe characters wear only COE tag assets, which vanilla's image loader
    // cannot associate with the real source texture.
    if (url) {
      trackPreviewTextureLoad(character, url, texW, texH);
      resolveTextureContentBounds(url);
    }
    if (!(texW > 1) || !(texH > 1)) return;
    const materialMap = overallGeometryCache.get(character) || new Map();
    const layerMap = materialMap.get(materialId) || new Map();
    const off = Number.isFinite(offsetX) ? offsetX : 0;
    const mirror = options.Mirror === true;
    const invert = options.Invert === true;
    let drawX = mirror ? 500 - dstX : dstX;
    drawX += off;
    let drawY = invert ? canvasHeight - dstY + 550 : dstY;
    // Store the normal (non-blink) material geometry. Blink receives the same
    // pivot plus offsetX at consumption time, so retaining the blink offset here
    // would apply it twice.
    drawX -= off;
    const signedW = (mirror ? -1 : 1) * texW;
    const signedH = (invert ? -1 : 1) * texH;
    const contentBounds = url ? resolveTextureContentBounds(url) : null;
    const contentState = url ? textureContentPivotCache.get(url) : null;
    const readyForOverall = !url || contentState?.status === "ready" || contentState?.status === "failed";
    const normalized = contentBounds || { left: 0, top: 0, right: 1, bottom: 1 };
    const corners = [
      { x: drawX + normalized.left * signedW, y: drawY + normalized.top * signedH },
      { x: drawX + normalized.right * signedW, y: drawY + normalized.top * signedH },
      { x: drawX + normalized.right * signedW, y: drawY + normalized.bottom * signedH },
      { x: drawX + normalized.left * signedW, y: drawY + normalized.bottom * signedH },
    ];
    const localRotation = typeof options.Rotation === "number" ? options.Rotation : 0;
    const localScale = clamp(typeof options.Scale === "number" ? options.Scale : 1, 0.25, 3);
    const localScaleX = localScale * (options.MirrorX === true ? -1 : 1);
    const localScaleY = localScale * (options.MirrorY === true ? -1 : 1);
    if (localRotation || Math.abs(localScale - 1) > 0.001 || options.MirrorX === true || options.MirrorY === true) {
      const pivot = contentState?.pivot || { x: 0.5, y: 0.5 };
      const pivotX = drawX + pivot.x * signedW;
      const pivotY = drawY + pivot.y * signedH;
      const cos = Math.cos(localRotation);
      const sin = Math.sin(localRotation);
      for (const corner of corners) {
        const dx = localScaleX * (corner.x - pivotX);
        const dy = localScaleY * (corner.y - pivotY);
        corner.x = pivotX + cos * dx - sin * dy;
        corner.y = pivotY + sin * dx + cos * dy;
      }
    }
    const rect = {
      left: Math.min(...corners.map(point => point.x)),
      top: Math.min(...corners.map(point => point.y)),
      right: Math.max(...corners.map(point => point.x)),
      bottom: Math.max(...corners.map(point => point.y)),
      readyForOverall,
    };
    const previous = layerMap.get(layerKey);
    const changed = !previous || previous.left !== rect.left || previous.top !== rect.top ||
      previous.right !== rect.right || previous.bottom !== rect.bottom ||
      previous.readyForOverall !== rect.readyForOverall;
    layerMap.set(layerKey, rect);
    materialMap.set(materialId, layerMap);
    overallGeometryCache.set(character, materialMap);
    // A local transform changes this rectangle every input step. Repainting again
    // is only useful when a material-level rotation/scale consumes the new union
    // center; otherwise the current draw already contains the final local result.
    const needsOverallCenter = options.__coeNeedsOverallCenter === true ||
      (typeof options.OverallRotation === "number" && options.OverallRotation !== 0) ||
      (typeof options.OverallScale === "number" && Math.abs(options.OverallScale - 1) > 0.001) ||
      options.OverallMirrorX === true || options.OverallMirrorY === true;
    if (changed && needsOverallCenter) scheduleContentPivotRefresh();
  }

  function pruneOverallGeometry(character, materialId, asset, refs) {
    const materialMap = overallGeometryCache.get(character);
    const layerMap = materialMap?.get(materialId);
    if (!layerMap) return;
    const drawable = refs.map(ref => ({ ref, sourceLayer: resolveSourceLayer(asset, ref) }))
      .filter(entry => isDrawableLayer(entry.sourceLayer))
      .sort((a, b) => (a.ref.sourceLayerIndex ?? asset.Layer.indexOf(a.sourceLayer)) -
        (b.ref.sourceLayerIndex ?? asset.Layer.indexOf(b.sourceLayer)));
    const validKeys = new Set(drawable.map((entry, sourceOrder) =>
      `${entry.ref.sourceLayerIndex ?? asset.Layer.indexOf(entry.sourceLayer)}:${sourceOrder}`));
    for (const key of layerMap.keys()) if (!validKeys.has(key)) layerMap.delete(key);
    if (!layerMap.size) materialMap.delete(materialId);
  }

  function cachedOverallCenter(character, materialId) {
    const layerMap = overallGeometryCache.get(character)?.get(materialId);
    if (!layerMap?.size) return null;
    let bounds = null;
    for (const rect of layerMap.values()) {
      if (rect.readyForOverall === false) return null;
      if (!bounds) bounds = { ...rect };
      else {
        bounds.left = Math.min(bounds.left, rect.left);
        bounds.top = Math.min(bounds.top, rect.top);
        bounds.right = Math.max(bounds.right, rect.right);
        bounds.bottom = Math.max(bounds.bottom, rect.bottom);
      }
    }
    return bounds ? { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 } : null;
  }

  function resolveRenderableOverallTransform(composition, character, material) {
    const rotation = typeof material?.overallRotation === "number" ? material.overallRotation : 0;
    const scale = typeof material?.overallScale === "number" ? material.overallScale : 1;
    const offsetX = typeof material?.overallOffsetX === "number" ? material.overallOffsetX : 0;
    const offsetY = typeof material?.overallOffsetY === "number" ? material.overallOffsetY : 0;
    const mirrorX = material?.overallMirrorX === true;
    const mirrorY = material?.overallMirrorY === true;
    const needsCenter = rotation !== 0 || Math.abs(scale - 1) > 0.001 || mirrorX || mirrorY;
    const runtimeCenter = cachedOverallCenter(character, material?.id);
    const center = runtimeCenter || (needsCenter
      ? computeDefaultOverallCenter(composition, character, material?.id)
      : { x: 0, y: 0 });
    // Do not visibly rotate/scale around metadata fallback while the authoritative
    // texture geometry is still being learned. Offset-only transforms do not
    // consume the center and can be rendered immediately.
    return {
      rotation: needsCenter && !runtimeCenter ? 0 : rotation,
      scale: needsCenter && !runtimeCenter ? 1 : scale,
      mirrorX: needsCenter && !runtimeCenter ? false : mirrorX,
      mirrorY: needsCenter && !runtimeCenter ? false : mirrorY,
      offsetX, offsetY, centerX: center.x, centerY: center.y,
      pendingCenter: needsCenter && !runtimeCenter,
    };
  }

  function syncLocalSyntheticRuntime(character) {
    if (character !== globalThis.Player || uiMode !== "editor") return false;
    const composition = getComposition(character);
    const groups = syntheticByCharacter.get(character);
    if (!composition || !Array.isArray(groups) || !groups.length) return false;
    const materials = new Map((composition.materials || []).map(material => [material.id, material]));
    const refsByMaterial = new Map();
    for (const ref of composition.layers || []) {
      if (!refsByMaterial.has(ref.materialId)) refsByMaterial.set(ref.materialId, []);
      refsByMaterial.get(ref.materialId).push(ref);
    }
    const visibleRefs = new Set();
    for (const ref of composition.layers || []) {
      const material = materials.get(ref.materialId);
      if (!ref.hidden && material && !material.hidden) visibleRefs.add(ref);
    }
    if (visibleRefs.size !== groups.length) return false;
    const stateByMaterial = new Map();
    for (const group of groups) {
      const material = materials.get(group.material?.id);
      const refs = refsByMaterial.get(material?.id) || [];
      const asset = group.item?.Asset?.__coeSourceAsset || group.item?.Asset?.Asset;
      const liveRef = group.drawable?.[0]?.ref;
      if (!material || material.hidden || !asset || !refs.length || !visibleRefs.has(liveRef)) return false;
      let state = stateByMaterial.get(material.id);
      if (!state) {
        state = {
          material,
          overall: resolveRenderableOverallTransform(composition, character, material),
          colors: resolveMaterialColors(material, asset, refs),
        };
        stateByMaterial.set(material.id, state);
      }
      group.material = state.material;
      Object.assign(group.overall, state.overall);
      group.item.Color = state.colors;
    }
    return true;
  }

  // Alpha 边界只依赖纹理本身，与颜色、Mirror、Invert 和图层变换无关。
  // 因此扫描结果按 URL 缓存，不能在每帧读取像素。
  function scanAlphaBounds(data, width, height, threshold = CONTENT_ALPHA_THRESHOLD) {
    if (!data || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (!(Number(alpha) >= threshold)) continue;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (count < CONTENT_MIN_PIXELS || maxX < minX || maxY < minY) return null;
    return { minX, minY, maxX, maxY, count };
  }

  function contentBoundsFromBounds(bounds, width, height) {
    if (!bounds || !(Number(width) > 0) || !(Number(height) > 0)) {
      return { left: 0, top: 0, right: 1, bottom: 1 };
    }
    return {
      left: clamp(Number(bounds.minX) / Number(width), 0, 1),
      top: clamp(Number(bounds.minY) / Number(height), 0, 1),
      right: clamp((Number(bounds.maxX) + 1) / Number(width), 0, 1),
      bottom: clamp((Number(bounds.maxY) + 1) / Number(height), 0, 1),
    };
  }

  function contentPivotFromBounds(bounds, width, height) {
    if (!bounds || !(Number(width) > 0) || !(Number(height) > 0)) return { x: 0.5, y: 0.5 };
    return {
      x: (Number(bounds.minX) + Number(bounds.maxX) + 1) / 2 / Number(width),
      y: (Number(bounds.minY) + Number(bounds.maxY) + 1) / 2 / Number(height),
    };
  }

  function scheduleContentPivotRefresh() {
    try {
      if (globalThis.Player) requestCharacterRefresh(globalThis.Player, uiMode === "editor" ? "visual" : "full");
      const characters = Array.isArray(globalThis.ChatRoomCharacter) ? globalThis.ChatRoomCharacter : [];
      for (const character of characters) {
        if (character && character !== globalThis.Player) requestCharacterRefresh(character, "full");
      }
    } catch (_) { /* Alpha 中心仅是视觉增强，刷新失败时保留几何中心 fallback */ }
  }

  function finishTextureContentPivot(url, pivot, bounds) {
    const current = textureContentPivotCache.get(url);
    if (!current || current.status !== "pending") return;
    textureContentPivotCache.set(url, { status: "ready", pivot, bounds });
    scheduleContentPivotRefresh();
  }

  function scanTextureContentPivot(url) {
    if (!url || typeof document === "undefined" || typeof document.createElement !== "function") return;
    const current = textureContentPivotCache.get(url);
    if (current) return;
    // 只扫描 BC/素材插件已经成功登记到 GLDrawImageCache 的图片。
    // 部分扩展素材使用虚拟 Assets 路径，并通过自己的缓存或绘制钩子提供图像；
    // 对这类 URL 另起 Image 会绕过素材提供方，向 BC 服务器制造成批 404。
    // 缓存尚未出现时不记录失败，让后续绘制有机会在图片就绪后重试。
    const image = typeof globalThis.GLDrawImageCache?.get === "function"
      ? globalThis.GLDrawImageCache.get(url) : null;
    if (!image) return;
    textureContentPivotCache.set(url, { status: "pending" });
    try {
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        const pending = textureContentPivotCache.get(url);
        if (pending?.status === "pending") textureContentPivotCache.set(url, { status: "failed" });
      };
      const complete = () => {
        if (settled) return;
        settled = true;
        try {
          const naturalWidth = Number(image.naturalWidth || image.width);
          const naturalHeight = Number(image.naturalHeight || image.height);
          if (!(naturalWidth > 0) || !(naturalHeight > 0)) throw new Error("image-dimensions-unavailable");
          const ratio = Math.min(1, CONTENT_SCAN_MAX_EDGE / Math.max(naturalWidth, naturalHeight));
          const width = Math.max(1, Math.round(naturalWidth * ratio));
          const height = Math.max(1, Math.round(naturalHeight * ratio));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext?.("2d", { willReadFrequently: true });
          if (!context || typeof context.drawImage !== "function" || typeof context.getImageData !== "function") throw new Error("canvas-pixel-reader-unavailable");
          context.clearRect?.(0, 0, width, height);
          context.drawImage(image, 0, 0, width, height);
          const imageData = context.getImageData(0, 0, width, height);
          const bounds = scanAlphaBounds(imageData?.data, width, height);
          const normalizedBounds = contentBoundsFromBounds(bounds, width, height);
          finishTextureContentPivot(url, contentPivotFromBounds(bounds, width, height), normalizedBounds);
        } catch (_) {
          const pending = textureContentPivotCache.get(url);
          if (pending?.status === "pending") textureContentPivotCache.set(url, { status: "failed" });
          scheduleContentPivotRefresh();
        }
      };
      if (typeof image.addEventListener === "function") {
        image.addEventListener("load", complete, { once: true });
        image.addEventListener("error", fail, { once: true });
      } else {
        image.onload = complete;
        image.onerror = fail;
      }
      if (image.complete && Number(image.naturalWidth || image.width) > 0) complete();
    } catch (_) {
      const pending = textureContentPivotCache.get(url);
      if (pending?.status === "pending") textureContentPivotCache.set(url, { status: "failed" });
    }
  }

  function resolveTextureContentPivot(url) {
    if (!url) return null;
    const cached = textureContentPivotCache.get(url);
    if (cached?.status === "ready" && cached.pivot) return cached.pivot;
    if (!cached) scanTextureContentPivot(url);
    return null;
  }

  function resolveTextureContentBounds(url) {
    if (!url) return null;
    const cached = textureContentPivotCache.get(url);
    if (cached?.status === "ready" && cached.bounds) return cached.bounds;
    if (!cached) scanTextureContentPivot(url);
    return null;
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
      var layerToken = slashIdx >= 0 ? rest.slice(slashIdx + 1) : rest;
      var asset = AssetGet(family, groupName, assetName);
      if (!asset) return null;
      var layer = asset.Layer ? asset.Layer.find(function(l) {
        if (l.Name === layerToken || l.Image === layerToken) return true;
        if (l.Name && (layerToken === `${assetName}_${l.Name}` || layerToken.endsWith(`_${l.Name}`))) return true;
        if (l.Image && (layerToken === `${assetName}_${l.Image}` || layerToken.endsWith(`_${l.Image}`))) return true;
        return false;
      }) : null;
      if (!layer && asset.Layer?.length === 1) layer = asset.Layer[0];
      if (!layer) return null;
      return { w: layer.DrawingWidth || asset.Width || 100, h: layer.DrawingHeight || asset.Height || 100 };
    } catch (_) { return null; }
  }

  // Apply one uniform 2D transform around a shared screen-space pivot.
  // Keeping this as a pure helper makes the invariant explicit: the pivot
  // itself may only receive the requested overall offset, never rotation or
  // scale drift.
  function transformPointAroundOverallPivotAxes(x, y, pivotX, pivotY, rotation, scaleX, scaleY, offsetX = 0, offsetY = 0) {
    const dx = scaleX * (x - pivotX);
    const dy = scaleY * (y - pivotY);
    const cos = Math.cos(rotation || 0);
    const sin = Math.sin(rotation || 0);
    return {
      x: pivotX + offsetX + cos * dx - sin * dy,
      y: pivotY + offsetY + sin * dx + cos * dy,
    };
  }

  function transformPointAroundOverallPivot(x, y, pivotX, pivotY, rotation, scale, offsetX = 0, offsetY = 0) {
    return transformPointAroundOverallPivotAxes(x, y, pivotX, pivotY, rotation, scale, scale, offsetX, offsetY);
  }

  function rotateTransformMatrix(matrix, angle) {
    if (!angle) return matrix;
    return typeof m4.zRotate === "function"
      ? m4.zRotate(matrix, angle)
      : m4.multiply(matrix, m4.zRotation(angle));
  }

  // 合成图层的变换参数渲染穿线
  function installTransformRenderHooks() {
    // --- ExtendedItemGetDrawingOptions hook ---
    // 为 COE 合成 item 注入 Mirror/Invert（BC 原生消费）以及 Rotation/Scale（供 GLDrawImage 包装消费）
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
          if (typeof p.Scale === "number" && Math.abs(p.Scale - 1) > 0.001) base.Scale = p.Scale;
          if (p.MirrorX === true) base.MirrorX = true;
          if (p.MirrorY === true) base.MirrorY = true;
          // 素材服装组整体变换参数
          if (typeof p.OverallRotation === "number" && p.OverallRotation !== 0) base.OverallRotation = p.OverallRotation;
          if (typeof p.OverallScale === "number" && Math.abs(p.OverallScale - 1) > 0.001) base.OverallScale = p.OverallScale;
          if (p.OverallMirrorX === true) base.OverallMirrorX = true;
          if (p.OverallMirrorY === true) base.OverallMirrorY = true;
          if (typeof p.OverallOffsetX === "number") base.OverallOffsetX = p.OverallOffsetX;
          if (typeof p.OverallOffsetY === "number") base.OverallOffsetY = p.OverallOffsetY;
          if (typeof p.OverallCenterX === "number") base.OverallCenterX = p.OverallCenterX;
          if (typeof p.OverallCenterY === "number") base.OverallCenterY = p.OverallCenterY;
          return base;
        });
      }
    } catch (_) { /* ExtendedItemGetDrawingOptions hook 不可用；Mirror/Invert 以默认行为 fallback */ }

    // --- GLDrawImage 包装：加入旋转和缩放的矩阵变换 ---
    // BC/其它 Mod 可能在 COE 初始化前后替换 GLDrawImage，因此这里不是
    // 一次性安装，而是由同一个闭包重复检查并包住当前函数。
    const installGLDrawImageTransformHook = () => {
      try {
        const currentGLDrawImage = globalThis.GLDrawImage;
        if (typeof currentGLDrawImage !== "function" || typeof globalThis.m4 !== "object" || typeof modApi?.hookFunction !== "function") return false;
        if (currentGLDrawImage._coeTransformHooked === true) {
          glTransformHookTarget = currentGLDrawImage;
          return true;
        }
        if (glTransformHookTarget && glTransformHookTarget !== currentGLDrawImage) {
          const message = "GLDrawImage 变换包装被覆盖，正在恢复";
          if (!diagnostics.lastWarnings.includes(message)) diagnostics.lastWarnings.push(message);
        }
        const transformHook = function coeGLDrawImageHook(args, next) {
        try {
          const [url, gl, dstX, dstY, options, offsetX] = args;
          const drawOriginal = () => next(args);
          var opts = options || {};
        var rotation = typeof opts.Rotation === "number" ? opts.Rotation : 0;
        var scale = typeof opts.Scale === "number" ? opts.Scale : 1;
        var overallRotation = typeof opts.OverallRotation === "number" ? opts.OverallRotation : 0;
        var overallScale = typeof opts.OverallScale === "number" ? opts.OverallScale : 1;
        var overallOffsetX = typeof opts.OverallOffsetX === "number" ? opts.OverallOffsetX : 0;
        var overallOffsetY = typeof opts.OverallOffsetY === "number" ? opts.OverallOffsetY : 0;
        var mirrorX = opts.MirrorX === true;
        var mirrorY = opts.MirrorY === true;
        var overallMirrorX = opts.OverallMirrorX === true;
        var overallMirrorY = opts.OverallMirrorY === true;
        var needsGeometryCapture = opts.__coeGeometryCharacter &&
          opts.__coeGeometryMaterialId != null && opts.__coeGeometryLayerKey != null &&
          opts.__coeGeometryIsBlink !== true;
        // 普通 BC 图层没有 COE 几何身份；无变换时只走原始函数，避免为全局图层
        // 额外调用底层纹理加载器。合成图层仍需读取一次尺寸供整体 pivot 使用。
        if (!rotation && Math.abs(scale - 1) <= 0.001 && !mirrorX && !mirrorY &&
          !overallRotation && Math.abs(overallScale - 1) <= 0.001 && !overallMirrorX && !overallMirrorY &&
          !overallOffsetX && !overallOffsetY) {
          const result = drawOriginal();
          if (!needsGeometryCapture) return result;
          const textureInfo = typeof GLDrawLoadImage === "function" ? GLDrawLoadImage(gl, url) : null;
          cacheOverallLayerGeometry(opts, dstX, dstY, offsetX, Number(textureInfo?.width), Number(textureInfo?.height), gl.canvas.height, url);
          return result;
        }

        // --- 变换绘制 ---
        // 先让 BC 原始函数完成纹理、遮罩、着色器和 uniform 设置，但禁止它输出颜色；
        // 随后在同一个 program 上只用变换后的矩阵绘制一次。
        var colorMaskSaved;
        try {
          colorMaskSaved = gl.getParameter(gl.COLOR_WRITEMASK);
          gl.colorMask(false, false, false, false);
          drawOriginal();
        } finally {
          if (colorMaskSaved) gl.colorMask(colorMaskSaved[0], colorMaskSaved[1], colorMaskSaved[2], colorMaskSaved[3]);
        }

        // GLDrawLoadImage 返回的缓存尺寸才是可靠来源；URL 中通常是 Dress_Base.png，
        // 不能直接把完整文件名当作 AssetLayer.Name。
        var textureInfo = typeof GLDrawLoadImage === "function" ? GLDrawLoadImage(gl, url) : null;
        var dim = textureInfo && Number(textureInfo.width) > 0 && Number(textureInfo.height) > 0
          ? { w: textureInfo.width, h: textureInfo.height }
          : resolveTextureDimensions(url);
        if (!dim || !(dim.w > 0) || !(dim.h > 0)) {
          // 不能取得尺寸时必须恢复一次正常绘制，避免 colorMask 路径吞掉图层。
          return drawOriginal();
        }
        var texW = dim.w, texH = dim.h;
        cacheOverallLayerGeometry(opts, dstX, dstY, offsetX, texW, texH, gl.canvas.height, url);
        var uniformScale = clamp(scale, 0.25, 3.0);
        var groupScale = clamp(overallScale, 0.25, 3.0);
        var localScaleX = uniformScale * (mirrorX ? -1 : 1);
        var localScaleY = uniformScale * (mirrorY ? -1 : 1);
        var groupScaleX = groupScale * (overallMirrorX ? -1 : 1);
        var groupScaleY = groupScale * (overallMirrorY ? -1 : 1);
        var off = typeof offsetX === "number" ? offsetX : 0;
        var mirror = opts.Mirror === true;
        var invert = opts.Invert === true;
        // Match BC's GLDrawImage order: Mirror changes the destination first,
        // then the blink/draw offset is added in screen space.
        var drawX = mirror ? 500 - dstX : dstX;
        drawX += off;
        var drawY = dstY;
        if (invert) drawY = gl.canvas.height - drawY + 550;
        var signedW = (mirror ? -1 : 1) * texW;
        var signedH = (invert ? -1 : 1) * texH;
        // Alpha 扫描异步完成前使用纹理中点；完成后使用有效内容包围盒中心。
        // 使用归一化局部坐标乘以 signedW/signedH，Mirror / Invert 会自然反映到屏幕坐标。
        var contentPivot = (rotation || Math.abs(scale - 1) > 0.001 || mirrorX || mirrorY) ? resolveTextureContentPivot(url) : null;
        var localPivotX = contentPivot?.x ?? 0.5;
        var localPivotY = contentPivot?.y ?? 0.5;
        var localCenterScreenX = drawX + localPivotX * signedW;
        var localCenterScreenY = drawY + localPivotY * signedH;
        // The blink callback renders into the second 500px canvas half. Keep the
        // shared material pivot in that same half; otherwise the blink image is
        // transformed around the normal-image center and appears to jump.
        var overallCenterX = typeof opts.OverallCenterX === "number"
          ? opts.OverallCenterX + off : localCenterScreenX;
        var overallCenterY = typeof opts.OverallCenterY === "number" ? opts.OverallCenterY : localCenterScreenY;

        var program = gl.getParameter(gl.CURRENT_PROGRAM);
        if (!program) return drawOriginal();

        // 获取 u_matrix 位置。BC 的 GLDraw 在 program 上缓存了此位置，
        // 但用 gl.getUniformLocation 更健壮，不依赖内部实现。
        var uMatrix = program.u_matrix || gl.getUniformLocation(program, "u_matrix");
        if (!uMatrix) return drawOriginal();

        // First transform the local image pivot as a point. The resulting point
        // is then used as the sole translation anchor for the sprite matrix.
        // This avoids relying on a long chain of nested screen-space translates
        // and makes it impossible for local rotation/scale to move the shared
        // material pivot accidentally.
        const transformedLocalCenter = transformPointAroundOverallPivotAxes(
          localCenterScreenX,
          localCenterScreenY,
          overallCenterX,
          overallCenterY,
          overallRotation,
          groupScaleX,
          groupScaleY,
          overallOffsetX,
          overallOffsetY,
        );
        var matrix = m4.orthographic(0, gl.canvas.width, gl.canvas.height, 0, -1, 1);
        // 镜像使坐标系改变手性，两级旋转不能再相加。严格保留
        // material × layer × source 的层级顺序，所有变换围绕各自自动中心。
        matrix = m4.translate(matrix, transformedLocalCenter.x, transformedLocalCenter.y, 0);
        matrix = rotateTransformMatrix(matrix, overallRotation);
        matrix = m4.scale(matrix, groupScaleX, groupScaleY, 1);
        matrix = rotateTransformMatrix(matrix, rotation);
        matrix = m4.scale(matrix, localScaleX, localScaleY, 1);
        matrix = m4.translate(matrix, -localCenterScreenX, -localCenterScreenY, 0);
        matrix = m4.translate(matrix, drawX, drawY, 0);
        matrix = m4.scale(matrix, signedW, signedH, 1);

        gl.uniformMatrix4fv(uMatrix, false, matrix);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        } catch (_coeTransformErr) {
          // 任何异常不传播到 BC 绘制循环，降级为原始绘制
          try { drawOriginal(); } catch (_e2) {}
        }
        };
        // SugarChain ImageMapping 在优先级 10 映射 URL、优先级 0 剥离 @nomap/。
        // COE 必须位于它们之后，避免把控制路径直接传给 GLDrawLoadImage。
        modApi.hookFunction("GLDrawImage", -1, transformHook);
        const installedTarget = globalThis.GLDrawImage;
        if (typeof installedTarget === "function") {
          installedTarget._coeTransformHooked = true;
          installedTarget._coeTransformWrapped = true;
          glTransformHookTarget = installedTarget;
        } else glTransformHookTarget = currentGLDrawImage;
        return true;
      } catch (error) {
        const message = `GLDrawImage 变换包装失败: ${error?.message || error}`;
        if (!diagnostics.lastWarnings.includes(message)) diagnostics.lastWarnings.push(message);
        return false;
      }
    };
    installGLDrawImageTransformHook();
    if (!glTransformHookWatch && typeof globalThis.setInterval === "function") {
      glTransformHookWatch = globalThis.setInterval(installGLDrawImageTransformHook, 500);
    }
  }

  // Backward-compatible internal alias used by the local editor tests/API.
  const buildSyntheticItems = buildLocalSyntheticItems;

  function buildRemoteSyntheticItems(character, snapshot) {
    if (!character || isLocalPlayer(character) || !snapshot) return [];
    const memberNumber = Number(character.MemberNumber);
    const refsByMaterial = new Map();
    const duplicateCounters = new Map();
    for (const layer of snapshot.l || []) {
      if (!refsByMaterial.has(layer.m)) refsByMaterial.set(layer.m, []);
      const duplicateKey = `${layer.m}:${layer.i}:${layer.n || ""}`;
      const duplicateIndex = duplicateCounters.get(duplicateKey) || 0;
      duplicateCounters.set(duplicateKey, duplicateIndex + 1);
      var remoteRef = {
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
      };
      if (typeof layer.r === "number" && layer.r !== 0) remoteRef.rotation = layer.r;
      if (typeof layer.s === "number" && Math.abs(layer.s - 1) > 0.001) remoteRef.scale = layer.s;
      if (layer.h === true) remoteRef.mirrorX = true;
      if (layer.v === true) remoteRef.mirrorY = true;
      refsByMaterial.get(layer.m).push(remoteRef);
    }
    const groups = [];
    for (let materialOrder = 0; materialOrder < (snapshot.m || []).length; materialOrder++) {
      const compact = snapshot.m[materialOrder];
      const refs = refsByMaterial.get(materialOrder) || [];
      if (!refs.length || (compact.w && !isTagEquipped(character, compact.w))) continue;
      const material = { id: `remote:${memberNumber}:${materialOrder}`, sourceGroup: compact.g, sourceAsset: compact.a, colors: compact.c, sourceProperty: compact.p || {}, wearGroup: compact.w || null, overallRotation: compact.r, overallScale: compact.s, overallOffsetX: compact.x, overallOffsetY: compact.y, overallMirrorX: compact.h === true, overallMirrorY: compact.v === true, hidden: false };
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
        pruneOverallGeometry(character, material.id, sourceAsset, refs);
        const overall = resolveRenderableOverallTransform({ layers: refs }, character, material);
        const layerGroups = buildStaticSynthetic({ character, material, refs, asset: sourceAsset, analysis, overall });
        for (let sourceOrder = 0; sourceOrder < layerGroups.length; sourceOrder++) {
          const group = layerGroups[sourceOrder];
          group.materialOrder = materialOrder;
          group.drawable[0].sourceOrder = sourceOrder;
          groups.push(group);
        }
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
              materialId: group.material.id,
              materialOrder: group.materialOrder, sourceOrder: entry.sourceOrder, overall: group.overall,
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

    // bcModSdk 1.2.0 calls higher priorities first. The verified downstream chain
    // is wrapped at priority 0 without assuming an arbitrary late priority.
    modApi.hookFunction("CharacterAppearanceSortLayers", 0, (args, next) => {
      const character = args[0];
      const baseLayers = next(args) || [];
      if (isLocalPlayer(character) || isPreviewCompositionCharacter(character)) {
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
      const originalCallbacks = args[1];
      let currentDrawLayer = null;
      try {
        const previewAssets = uiMode === "editor" && isLocalPlayer(character)
          ? new Set(groups.map(group => group.item?.Asset?.__coeSourceAsset || group.item?.Asset?.Asset).filter(Boolean)) : null;
        const renderableAppearance = previewAssets
          ? (originalAppearance || []).filter(item => !(previewAssets.has(item?.Asset) && isEditorRemovableAsset(item?.Asset)))
          : (originalAppearance || []);
        character.Appearance = groups.map(group => group.item).concat(renderableAppearance);
        const drawLayers = (originalLayers || []).map(layer => {
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
        // CommonDrawAppearanceBuild 只把 Mirror/Invert 从 drawOptions 转发给 GLDrawImage，
        // 因此通过迭代器记录当前图层，再在四个图像回调上补回图层级变换字段。
        const trackedLayers = drawLayers.slice();
        // Proxy 拦截下标访问，确保 BC 用普通 for 循环时也能追踪当前绘制图层
        character.AppearanceLayers = new Proxy(trackedLayers, {
          get(target, prop) {
            if (prop === "length" || typeof prop === "symbol") return target[prop];
            var idx = Number(prop);
            if (Number.isInteger(idx) && idx >= 0 && idx < target.length) {
              currentDrawLayer = target[idx];
            }
            return Reflect.get(target, prop);
          },
        });
        if (originalCallbacks && typeof originalCallbacks === "object") {
          const callbacks = { ...originalCallbacks };
          const imageCallbacks = ["drawImage", "drawImageBlink", "drawImageColorize", "drawImageColorizeBlink"];
          for (const name of imageCallbacks) {
            const callback = originalCallbacks[name];
            if (typeof callback !== "function") continue;
            callbacks[name] = function (...callbackArgs) {
              const marker = currentDrawLayer?.__coeSyntheticLayer;
              const ref = marker?.ref;
              if (!ref) return callback.apply(this, callbackArgs);
              const options = callbackArgs[3] || {};
              const transformed = { ...options };
              if (typeof ref.rotation === "number" && isFinite(ref.rotation) && ref.rotation !== 0)
                transformed.Rotation = clamp(ref.rotation, -Math.PI, Math.PI);
              if (typeof ref.scale === "number" && isFinite(ref.scale) && Math.abs(ref.scale - 1) > 0.001)
                transformed.Scale = clamp(ref.scale, 0.25, 3.0);
              if (ref.mirrorX === true) transformed.MirrorX = true;
              if (ref.mirrorY === true) transformed.MirrorY = true;
              const overall = marker.overall;
              if (overall) {
                transformed.OverallRotation = clamp(overall.rotation, -Math.PI, Math.PI);
                transformed.OverallScale = clamp(overall.scale, 0.25, 3.0);
                if (overall.mirrorX === true) transformed.OverallMirrorX = true;
                if (overall.mirrorY === true) transformed.OverallMirrorY = true;
                transformed.OverallOffsetX = clamp(overall.offsetX, -1200, 1200);
                transformed.OverallOffsetY = clamp(overall.offsetY, -1200, 1200);
                transformed.OverallCenterX = overall.centerX;
                transformed.OverallCenterY = overall.centerY;
                if (overall.pendingCenter === true) transformed.__coeNeedsOverallCenter = true;
              }
              // GLDrawImage is the first point where the actual texture size is
              // known. Carry an internal identity through the callback so it can
              // feed authoritative, untransformed geometry into the next frame.
              transformed.__coeGeometryCharacter = character;
              transformed.__coeGeometryMaterialId = marker.materialId;
              transformed.__coeGeometryLayerKey = `${marker.sourceLayerIndex}:${marker.sourceOrder}`;
              transformed.__coeGeometryIsBlink = name.includes("Blink");
              callbackArgs[3] = transformed;
              return callback.apply(this, callbackArgs);
            };
          }
          args[1] = callbacks;
        }
        return next(args);
      } finally {
        args[1] = originalCallbacks;
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
#${ROOT_ID}{--coe-panel-width:clamp(520px,42vw,820px);position:fixed;inset:0;z-index:99990;background:transparent;color:#111;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;box-sizing:border-box;pointer-events:none}#${ROOT_ID} *{box-sizing:border-box}#${ROOT_ID} button,#${ROOT_ID} input,#${ROOT_ID} select{font:inherit}.coe-panel{position:absolute;inset:0;background:transparent;pointer-events:none}.coe-head{position:absolute;right:0;top:0;width:var(--coe-panel-width);height:72px;display:flex;align-items:center;gap:14px;padding:9px 18px;border-bottom:2px solid #111;border-left:2px solid #111;background:linear-gradient(180deg,#f6fbff 0,#c4dbe9 100%);color:#132333;box-shadow:-6px 3px 12px #0008;pointer-events:auto;z-index:3}.coe-brand{display:flex;align-items:center;gap:11px;min-width:0;flex:1}.coe-brand-mark{display:grid;place-items:center;width:42px;height:42px;flex:none;border:2px solid #142535;border-radius:50%;background:#fff;color:#24658e;font-size:22px}.coe-head h2{margin:0;font-size:20px;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.coe-build{display:block;margin-top:3px;color:#496479;font:600 11px/1.2 ui-monospace,Consolas,monospace}.coe-body{position:absolute;right:0;top:72px;bottom:0;width:var(--coe-panel-width);padding:12px;overflow:auto;border-left:2px solid #111;background:#d8d8d8f2;box-shadow:-6px 0 18px #0008;pointer-events:auto}.coe-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.coe-head .coe-actions{justify-content:flex-end}.coe-btn{border:2px solid #111923;border-radius:6px;background:linear-gradient(#fff,#c4d2dc);color:#152432;padding:7px 11px;font-weight:700;box-shadow:0 2px 0 #070b0f;cursor:pointer}.coe-btn:hover{filter:brightness(1.07)}.coe-btn:active{transform:translateY(1px);box-shadow:0 1px 0 #070b0f}.coe-primary{background:linear-gradient(#b8e9ff,#54b6eb);color:#071a27}.coe-danger{background:linear-gradient(#ffd0d8,#e67689);color:#32101a}.coe-muted{color:#536b7d}.coe-menu{position:relative}.coe-menu>summary{list-style:none;user-select:none}.coe-menu>summary::-webkit-details-marker{display:none}.coe-menu-panel{position:absolute;right:0;top:calc(100% + 6px);z-index:8;display:grid;min-width:180px;padding:6px;border:2px solid #172631;border-radius:7px;background:#f2f6f8;box-shadow:0 7px 20px #0007}.coe-menu-panel button{border:0;border-radius:4px;background:transparent;color:#142331;padding:8px 9px;text-align:left;font-weight:700;cursor:pointer}.coe-menu-panel button:hover{background:#cdeaff}.coe-modal-backdrop{position:fixed;inset:0;z-index:100005;display:grid;place-items:center;padding:20px;background:#0008;pointer-events:auto}.coe-modal{width:min(680px,92vw);max-height:86vh;overflow:auto;border:2px solid #172631;border-radius:9px;background:#eef3f6;color:#142331;padding:16px;box-shadow:0 14px 42px #000b}.coe-modal h3{margin:0 0 10px;font-size:18px}.coe-modal-content{display:grid;gap:9px}.coe-modal-content p{margin:0}.coe-modal-actions{justify-content:flex-end;margin-top:13px}.coe-exchange-text{width:100%;min-height:210px;resize:vertical;border:1px solid #667c8c;border-radius:6px;background:#fff;color:#111;padding:9px;font:12px/1.45 ui-monospace,Consolas,monospace;word-break:break-all}.coe-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.coe-card{border:2px solid #555;border-radius:7px;padding:11px;background:#f4f4f4;color:#142331;box-shadow:0 2px 5px #0003}.coe-card h3{margin:0 0 5px;font-size:16px}.coe-card-title{display:flex;align-items:center;gap:8px}.coe-card-title h3{flex:1}.coe-card.coe-equipped{border:3px solid #1889c8;background:#e0f3ff;box-shadow:0 0 0 2px #8bd2f7 inset}.coe-equipped-badge{display:inline-block;padding:3px 7px;border-radius:4px;background:#d5d5d5;color:#555;font-size:11px}.coe-card.coe-equipped .coe-equipped-badge{background:#1889c8;color:#fff}.coe-wardrobe-summary{margin-bottom:10px;padding:8px 10px;border:1px solid #677b88;border-radius:5px;background:#eef5f9;color:#233b4b;font-size:12px}.coe-remote-prefs{display:grid;gap:7px;margin-bottom:10px;padding:10px;border:2px solid #52758b;border-radius:7px;background:#e7f4fb}.coe-remote-prefs h3{margin:0 0 2px}.coe-remote-prefs label{display:flex;align-items:center;gap:7px;font-weight:700}.coe-remote-prefs input{width:17px;height:17px}.coe-remote-prefs p{margin:2px 0 0;color:#3f5c6d;font-size:11px}.coe-empty{text-align:center;padding:48px 18px;color:#536b7d}
#${ROOT_ID}.coe-set-gallery-root{--coe-panel-width:100vw}#${ROOT_ID}.coe-set-gallery-root .coe-panel{pointer-events:none}#${ROOT_ID}.coe-set-gallery-root .coe-set-global-actions{position:absolute;right:18px;top:14px;z-index:6;display:flex;align-items:center;justify-content:flex-end;gap:8px;pointer-events:auto}#${ROOT_ID}.coe-set-gallery-root .coe-body{inset:0;width:100%;padding:0;overflow:hidden;border:0;background:transparent;color:#fff;box-shadow:none}#${ROOT_ID}.coe-set-gallery-root .coe-set-workspace{display:grid;grid-template-columns:minmax(300px,26vw) minmax(0,1fr);width:100%;height:100%;min-width:0;min-height:0}#${ROOT_ID}.coe-set-gallery-root .coe-set-character-stage{min-width:0;min-height:0;pointer-events:none}#${ROOT_ID}.coe-set-gallery-root .coe-set-gallery-pane{min-width:0;min-height:0;padding:64px 16px 12px 4px}#${ROOT_ID}.coe-set-gallery-root .coe-wardrobe-content{display:grid;grid-template-rows:auto auto minmax(0,1fr);width:100%;height:100%;min-width:0;min-height:0}#${ROOT_ID}.coe-set-gallery-root .coe-tool-tabs{background:#1d2730cc;border:1px solid #ffffff55;border-radius:7px}.coe-set-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 8px;padding:9px 12px;border-radius:7px;background:#111b;color:#fff;box-shadow:0 2px 8px #0008}.coe-set-toolbar>strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coe-set-page-tabs{display:flex;justify-content:center;gap:6px;margin:0 0 8px}.coe-set-page-tabs button{min-width:112px;border:0;border-radius:7px 7px 0 0;background:#202a34cc;color:#ddd;padding:8px 18px;font-weight:700;cursor:pointer}.coe-set-page-tabs button.coe-active{background:#edf7fd;color:#102333;box-shadow:0 -3px 0 #52baf0 inset}.coe-set-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));min-width:0;min-height:0;gap:4px 10px;overflow:hidden}.coe-set-slot{position:relative;display:grid;grid-template-rows:minmax(0,1fr) 30px;min-width:0;min-height:0;overflow:hidden;border:0;border-radius:0;background:transparent;color:#fff;padding:3px;box-shadow:none;cursor:pointer}.coe-set-slot:hover{background:#ffffff12}.coe-set-slot::after{position:absolute;inset:3px;border:4px solid transparent;border-radius:4px;pointer-events:none;content:""}.coe-set-slot.coe-selected::after{border-color:#35d7ff}.coe-set-slot canvas{position:relative;z-index:1;display:block;width:100%;height:100%;min-height:0;object-fit:contain}.coe-set-slot-name{position:absolute;left:3px;right:3px;bottom:3px;z-index:4;display:block;overflow:hidden;padding:3px 6px;border-radius:4px;background:#000;color:#fff;font-weight:700;text-align:center;text-overflow:ellipsis;white-space:nowrap;pointer-events:none}.coe-set-plus{position:relative;z-index:1;display:grid;place-items:center;border:0;background:transparent;color:#fff9;font:300 clamp(58px,7vw,132px)/1 system-ui;text-shadow:0 4px 12px #000;cursor:pointer}.coe-set-slot:hover .coe-set-plus{color:#fff;transform:scale(1.04)}.coe-set-warning{position:absolute;right:10px;top:10px;padding:3px 7px;border-radius:999px;background:#ffd36b;color:#3b2700;font-size:12px;font-weight:800;box-shadow:0 2px 6px #0008}.coe-set-slot.coe-loading canvas{opacity:.45}.coe-set-slot.coe-loading::before{position:absolute;left:50%;top:45%;z-index:2;width:28px;height:28px;margin:-14px;border:4px solid #fff5;border-top-color:#fff;border-radius:50%;animation:coe-spin .8s linear infinite;content:""}.coe-set-slot.coe-preview-failed::before{position:absolute;left:50%;top:45%;transform:translate(-50%,-50%);color:#ffd36b;font-size:30px;content:"⚠"}@keyframes coe-spin{to{transform:rotate(360deg)}}
.coe-editor{height:100%;min-height:0}.coe-editor-tools{height:100%;min-height:0;display:grid;grid-template-rows:auto auto minmax(0,1fr);border:2px solid #555;border-radius:6px;background:#ededed;overflow:hidden}.coe-scheme-bar{padding:9px 11px;border-bottom:1px solid #777;background:#f7f7f7}.coe-field{display:flex;align-items:center;gap:8px}.coe-field label{font-weight:700;white-space:nowrap}.coe-field input,.coe-field select,.coe-search{min-width:0;border:1px solid #667c8c;border-radius:5px;background:#fff;color:#111;padding:7px 9px;outline:none}.coe-field input:focus,.coe-search:focus{border-color:#2699dc;box-shadow:0 0 0 2px #4bb9f044}.coe-title-input{width:100%;font-size:16px!important}.coe-tool-tabs{display:flex;gap:6px;padding:7px;border-bottom:1px solid #777;background:#c9c9c9}.coe-tool-tabs .coe-btn{flex:1;padding:6px 9px}.coe-tool-content{min-height:0;overflow:auto;padding:9px}.coe-editor-section{margin-bottom:11px}.coe-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 7px}.coe-section-head h3{margin:0;font-size:14px}.coe-badge{display:inline-flex;align-items:center;min-height:21px;padding:2px 7px;border:1px solid #688296;border-radius:999px;background:#e4f2fb;color:#24516c;font-size:11px}.coe-pose-groups{display:grid;gap:3px}.coe-pose-group{display:grid;grid-template-columns:42px minmax(0,1fr);align-items:center;gap:5px}.coe-pose-group h4{margin:0;color:#3d5363;font-size:11px}.coe-pose-buttons{display:flex;flex-wrap:wrap;gap:3px}.coe-pose-buttons .coe-btn{padding:2px 6px;border-width:1px;border-radius:4px;box-shadow:none;font-size:10px}.coe-pose-buttons button.coe-active{background:linear-gradient(#b8e9ff,#54b6eb);border-color:#116c9d}.coe-hint{padding:7px 9px;border:1px solid #708798;border-radius:6px;background:#e4edf4;color:#233b4b;font-size:11px}.coe-transform-editor{position:sticky;top:-9px;z-index:5;margin:9px 0;padding:9px;border:2px solid #d28b28;border-radius:7px;background:#fff6df;color:#2b2112;box-shadow:0 3px 8px #0003}.coe-transform-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.coe-transform-head strong,.coe-transform-head .coe-muted{display:block}.coe-transform-fields{display:grid;grid-template-columns:repeat(4,minmax(70px,1fr));gap:6px;margin-top:7px}.coe-transform-fields label{display:flex;flex-direction:column;color:#333;font-size:10px}.coe-transform-fields input{margin-top:3px;width:100%;min-width:0;border:1px solid #967a45;border-radius:4px;background:#fff;color:#111;padding:5px}.coe-transform-actions{margin-top:8px}.coe-divider{height:1px;background:#888;margin:10px 0}.coe-layer-list{display:flex;flex-direction:column;gap:7px}.coe-layer{border:1px solid #777;border-radius:6px;padding:8px;background:#fafafa;cursor:pointer}.coe-layer.coe-selected{border:2px solid #168cca;background:#e2f4ff;box-shadow:0 0 0 2px #8bd2f755 inset}.coe-layer.coe-hidden{opacity:.55}.coe-layer.coe-recycled{opacity:.7;border-style:dashed}.coe-layer-top{display:flex;gap:6px;align-items:center}.coe-drag-handle{color:#667;cursor:grab}.coe-layer-name{flex:1;min-width:0;overflow:hidden;border:0;background:transparent;color:inherit;padding:3px 4px;text-align:left;font-weight:700;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.coe-layer-name:hover{color:#096c9f;text-decoration:underline}.coe-layer-top .coe-btn{padding:4px 6px;font-size:11px}.coe-controls{display:grid;grid-template-columns:repeat(4,minmax(52px,1fr)) minmax(90px,1.4fr) repeat(2,minmax(52px,1fr));gap:4px;overflow-x:auto}.coe-controls label{display:flex;min-width:0;flex-direction:column;color:#333;font-size:10px}.coe-controls input{margin-top:2px;width:100%;min-width:0;height:27px;border:1px solid #777;border-radius:4px;background:#fff;color:#111;padding:3px 4px}.coe-color-choice{display:flex;align-items:center;gap:5px;margin-top:3px;width:100%;min-width:0;height:29px;padding:3px 5px;border:1px solid #667;border-radius:4px;background:#fff;color:#111;cursor:pointer}.coe-color-choice:hover{border-color:#168cca;background:#eaf7ff}.coe-color-choice:disabled{cursor:not-allowed;opacity:.55}.coe-color-swatch{width:18px;height:18px;flex:none;border:1px solid #555;border-radius:3px;background-color:#fff;background-image:linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%);background-size:8px 8px;background-position:0 0,0 4px,4px -4px,-4px 0}.coe-color-swatch::after{display:block;width:100%;height:100%;border-radius:2px;background:var(--coe-color,#fff);content:""}.coe-color-choice code{min-width:0;overflow:hidden;color:inherit;font:700 10px/1.2 ui-monospace,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.coe-material-editor{border:2px solid #666;border-radius:7px;background:#e4e4e4;overflow:hidden}.coe-material-editor+.coe-material-editor{margin-top:9px}.coe-material-editor.coe-selected{border-color:#168cca;box-shadow:0 0 0 2px #8bd2f755}.coe-material-editor.coe-contains-selected{border-color:#4a91b8}.coe-material-editor.coe-hidden{opacity:.58}.coe-material-editor.coe-recycled{border-style:dashed}.coe-material-editor-head{display:flex;align-items:center;gap:7px;padding:8px;background:#d0d0d0;border-bottom:1px solid #777}.coe-material-editor.coe-selected>.coe-material-editor-head{background:#c5e9fb}.coe-material-identity{display:flex;flex:1;min-width:0;flex-direction:column;overflow:hidden;border:0;background:transparent;color:inherit;padding:2px 4px;text-align:left;cursor:pointer}.coe-material-identity:hover strong{color:#096c9f;text-decoration:underline}.coe-material-identity strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.coe-material-identity .coe-muted{font-size:10px}.coe-collapse{width:25px;height:25px;border:0;background:transparent;cursor:pointer}.coe-overall-color{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:700}.coe-overall-color .coe-color-choice{width:auto;max-width:104px;margin-top:0}.coe-material-editor-layers{display:flex;flex-direction:column;gap:7px;padding:7px}.coe-material-editor.coe-collapsed .coe-material-editor-head{border-bottom:0}.coe-recycle-row{display:flex;align-items:center;gap:8px;padding:5px 7px;border:1px solid #888;border-radius:5px;background:#fafafa}.coe-recycle-row span{flex:1}
.coe-material-picker{display:block;min-height:100%}.coe-material-toolbar{position:sticky;top:-9px;z-index:3;padding:0 0 9px;background:#ededed}.coe-search{width:100%}.coe-materials{display:flex;flex-direction:column;gap:7px;min-height:0}.coe-material-group-title{position:sticky;top:38px;z-index:2;margin:0 0 6px;border-radius:4px;background:#c9c9c9;color:#111;font-size:13px}.coe-material-group-toggle{display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;gap:5px;width:100%;border:0;background:transparent;color:inherit;padding:5px 7px;text-align:left;cursor:pointer}.coe-material-group-toggle strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coe-material-group-toggle small{padding:1px 5px;border-radius:999px;background:#eef3f6;color:#405765}.coe-material-section.coe-collapsed .coe-material-group{display:none}.coe-material-group{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.coe-material{display:flex;flex-direction:column;align-items:stretch;gap:4px;min-width:0;min-height:136px;border:1px solid #777;border-radius:5px;background:#fafafa;padding:6px;text-align:center;color:#111;cursor:pointer}.coe-material:hover{border-color:#168cca;background:#e2f4ff}.coe-material:disabled{cursor:not-allowed;filter:grayscale(.7);opacity:.58}.coe-material.coe-cap-safe{border-color:#268a52}.coe-material.coe-cap-limited{border-color:#c38b13}.coe-material.coe-cap-unverified,.coe-material.coe-cap-unsupported{border-color:#a34b56}.coe-material img{width:100%;height:96px;object-fit:contain;border-radius:4px;background:#eee}.coe-material strong{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px}.coe-material .coe-muted{font-size:10px}.coe-toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,14px);opacity:0;z-index:100010;background:#e8f4fc;color:#142331;border:2px solid #182735;border-radius:8px;padding:9px 15px;box-shadow:0 7px 22px #0009;transition:.2s;pointer-events:none}.coe-toast.coe-show{transform:translate(-50%,0);opacity:1}.coe-toast.coe-error{background:#ffd3dc}.coe-toast.coe-warn{background:#ffe4a8}
.coe-owned-color-picker{background:linear-gradient(180deg,#f7fbfe 0,#d5e1e8 100%)!important;border:2px solid #172631!important;border-radius:8px;box-shadow:0 8px 28px #000a!important}
@media(max-width:1250px){#${ROOT_ID}{--coe-panel-width:clamp(480px,46vw,520px)}.coe-brand-mark,.coe-build{display:none}.coe-grid{grid-template-columns:1fr}.coe-material-group{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:800px){#${ROOT_ID}{--coe-panel-width:58vw}.coe-head{height:80px;align-items:flex-start}.coe-body{top:80px}.coe-material-group{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
    document.head.appendChild(style);
  }

  function isAppearanceRootMode() {
    const mode = globalThis.CharacterAppearanceMode ?? "";
    const extendedItemOpen = globalThis.DialogFocusItem != null;
    let layeringActive = false;
    try { layeringActive = globalThis.Layering?.IsActive?.() === true; } catch (_) { layeringActive = true; }
    return mode === "" && !extendedItemOpen && !layeringActive;
  }

  function isAppearanceWorkspaceActive() {
    return globalThis.CurrentScreen === "Appearance" && (uiMode === "wardrobe" || uiMode === "editor");
  }

  function updateEntryButton() {
    if (!initialized || !document.body) return;
    const isEditingSelf = !globalThis.CharacterAppearanceSelection || globalThis.CharacterAppearanceSelection === globalThis.Player;
    const shouldShow = globalThis.CurrentScreen === "Appearance" && isAppearanceRootMode() && !document.getElementById(ROOT_ID) && isEditingSelf;
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

  function rootShell(title, actions = "", options = {}) {
    closeUI();
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.dataset.coeVersion = VERSION;
    const setGallery = options.variant === "set-gallery";
    if (setGallery) root.classList.add("coe-set-gallery-root");
    root.innerHTML = setGallery
      ? `<section class="coe-panel"><nav class="coe-set-global-actions" aria-label="套装衣柜页面操作">${actions}</nav><main class="coe-body"></main></section>`
      : `<section class="coe-panel"><header class="coe-head"><div class="coe-brand"><span class="coe-brand-mark">✦</span><div><h2>${escapeHTML(title)}</h2><span class="coe-build">${MOD_NAME} v${escapeHTML(VERSION)} · Appearance Workspace</span></div></div><div class="coe-actions">${actions}</div></header><main class="coe-body"></main></section>`;
    for (const eventName of ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend", "wheel"])
      root.addEventListener(eventName, event => event.stopPropagation());
    root.addEventListener("click", event => {
      event.stopPropagation();
      if (event.target.closest('[data-action="close"]')) closeUI();
    });
    document.body.appendChild(root);
    updateEntryButton();
    return root.querySelector(".coe-body");
  }

  function drawAppearanceWorkspaceCharacters() {
    const character = globalThis.CharacterAppearanceSelection || globalThis.Player;
    if (!character || typeof globalThis.DrawCharacter !== "function") return;
    const isPlayer = typeof character.IsPlayer === "function" ? character.IsPlayer() : character === globalThis.Player;
    if (uiMode === "wardrobe" && wardrobeView === "sets") {
      DrawCharacter(character, 20, isPlayer ? 70 : 0, isPlayer ? 0.96 : 1);
      return;
    }
    const heightModifier = Number.isFinite(character.HeightModifier) ? character.HeightModifier : 0;
    DrawCharacter(character, -600, -100 + 4 * heightModifier, 4, false);
    DrawCharacter(character, 660, isPlayer ? 90 : 0, isPlayer ? 0.95 : 1);
  }

  function installAppearanceWorkspaceHooks() {
    modApi.hookFunction("AppearanceRun", 1000, (args, next) => {
      if (!isAppearanceWorkspaceActive()) return next(args);
      drawAppearanceWorkspaceCharacters();
    });
    for (const name of ["AppearanceClick", "AppearanceMouseDown", "AppearanceMouseUp", "AppearanceMouseMove", "AppearanceMouseWheel", "AppearanceKeyDown", "AppearanceKeyUp", "AppearancePaste"]) {
      if (typeof globalThis[name] !== "function") continue;
      modApi.hookFunction(name, 1000, (args, next) => {
        if (!isAppearanceWorkspaceActive()) return next(args);
      });
    }
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
    if (typeof cancelSetPreviewQueue === "function") cancelSetPreviewQueue();
    restoreEditorAppearance();
    document.getElementById(ROOT_ID)?.remove();
    // Closing the local editor must not discard texture/geometry refreshes already
    // queued for remote characters. Remove only the local preview request and keep
    // the shared frame alive while any other character remains pending.
    pendingCharacterRefreshes.delete(globalThis.Player);
    if (!pendingCharacterRefreshes.size) {
      if (characterRefreshScheduled && typeof globalThis.cancelAnimationFrame === "function") cancelAnimationFrame(previewTimer);
      if (characterRefreshScheduled && typeof globalThis.clearTimeout === "function") clearTimeout(previewTimer);
      previewTimer = 0;
      characterRefreshScheduled = false;
    }
    uiMode = null;
    editing = null;
    editingId = null;
    previewPoseMapping = null;
    transformEditTarget = null;
    expandedMaterialGroups.clear();
    setTimeout(updateEntryButton, 0);
  }

  function renderEditor(body) {
    const slots = clothingSlotGroups();
    if (!slots.some(group => group.Name === editing.slotGroup)) editing.slotGroup = defaultClothingSlotGroup();
    const slotOptions = slots.map(group => `<option value="${escapeHTML(group.Name)}" ${group.Name === editing.slotGroup ? "selected" : ""}>${escapeHTML(group.Description || group.Name)}</option>`).join("");
    body.innerHTML = `<div class="coe-editor"><aside class="coe-editor-tools"><div class="coe-scheme-bar"><div class="coe-field"><label for="coe-name">方案</label><input id="coe-name" class="coe-title-input" maxlength="60" value="${escapeHTML(editing.name)}"><label for="coe-slot">服装部位</label><select id="coe-slot">${slotOptions}</select></div></div><nav class="coe-tool-tabs"><button class="coe-btn coe-primary" data-tool="layers">图层与姿势</button><button class="coe-btn" data-tool="materials">＋ 添加素材</button></nav><div class="coe-tool-content"></div></aside></div>`;
    body.querySelector("#coe-name").addEventListener("input", event => { editing.name = event.target.value.slice(0, 60); });
    body.querySelector("#coe-slot").addEventListener("change", event => { editing.slotGroup = event.target.value; });
    const tools = body.querySelector(".coe-editor-tools");
    tools.querySelector('[data-tool="layers"]').addEventListener("click", () => renderEditorTools(tools));
    tools.querySelector('[data-tool="materials"]').addEventListener("click", openMaterialPicker);
    renderEditorTools(tools);
  }

  function renderEditorTools(host) {
    const content = host.querySelector(".coe-tool-content");
    host.querySelectorAll("[data-tool]").forEach(button => button.classList.toggle("coe-primary", button.dataset.tool === "layers"));
    content.innerHTML = `<section class="coe-editor-section"><div class="coe-section-head"><h3>角色姿势</h3><span class="coe-badge">编辑预览</span></div><div class="coe-pose-groups"></div></section><div class="coe-hint">编辑预览只在绘制阶段隐藏可移除衣物，不会修改或同步真实 Appearance。图层固定按原素材顺序排列。</div><section class="coe-transform-editor" data-transform-editor></section><div class="coe-divider"></div><div class="coe-layer-list"></div>`;
    renderPoseControls(content.querySelector(".coe-pose-groups"));
    const layerList = content.querySelector(".coe-layer-list");
    renderLayerList(layerList);
    renderTransformEditor(content);
    ensureLayerNameCache();
    layerNameCachePromise?.then(() => { if (document.body.contains(layerList)) renderLayerList(layerList); });
  }

  const CHARACTER_REFRESH_LEVEL = Object.freeze({ visual: 1, structure: 2, full: 3 });

  function performCharacterRefresh(character, level) {
    if (!character) return;
    try {
      if (level <= CHARACTER_REFRESH_LEVEL.visual && character === globalThis.Player && uiMode === "editor" &&
        typeof globalThis.CharacterAppearanceBuildCanvas === "function" && syncLocalSyntheticRuntime(character)) {
        CharacterAppearanceBuildCanvas(character);
        character.MustDraw = false;
        return;
      }
      if (level <= CHARACTER_REFRESH_LEVEL.structure && typeof globalThis.CharacterLoadCanvas === "function") {
        CharacterLoadCanvas(character);
        return;
      }
      if (typeof globalThis.CharacterRefresh === "function") CharacterRefresh(character, false, false);
    } catch (error) {
      warn("角色预览刷新失败", error);
      // A failed lightweight redraw must not prevent other queued characters from
      // refreshing. Try the full path once as a compatibility fallback.
      if (level < CHARACTER_REFRESH_LEVEL.full && typeof globalThis.CharacterRefresh === "function") {
        try { CharacterRefresh(character, false, false); } catch (fallbackError) { warn("角色完整刷新回退失败", fallbackError); }
      }
    }
  }

  function flushCharacterRefreshes() {
    previewTimer = 0;
    characterRefreshScheduled = false;
    const pending = pendingCharacterRefreshes;
    pendingCharacterRefreshes = new Map();
    for (const [character, level] of pending) performCharacterRefresh(character, level);
  }

  function requestCharacterRefresh(character, mode = "full") {
    if (!character) return;
    const level = CHARACTER_REFRESH_LEVEL[mode] || CHARACTER_REFRESH_LEVEL.full;
    pendingCharacterRefreshes.set(character, Math.max(level, pendingCharacterRefreshes.get(character) || 0));
    if (characterRefreshScheduled) return;
    characterRefreshScheduled = true;
    if (typeof globalThis.requestAnimationFrame === "function") {
      const handle = requestAnimationFrame(flushCharacterRefreshes);
      if (characterRefreshScheduled) previewTimer = handle;
    } else if (typeof globalThis.setTimeout === "function") {
      const handle = setTimeout(flushCharacterRefreshes, 0);
      if (characterRefreshScheduled) previewTimer = handle;
    } else flushCharacterRefreshes();
  }

  function refreshPreviewLoop(mode = "visual") {
    if (uiMode !== "editor" || !editorAppearanceSnapshot || !globalThis.Player) return;
    requestCharacterRefresh(globalThis.Player, mode);
  }



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

  function buildSetImportPlan(parsed, targetSlot, data = wardrobe) {
    if (!parsed?.set || !Array.isArray(parsed.outfits)) throw exchangeError("invalid-set-plan", "套装导入计划无效");
    if (!Number.isInteger(targetSlot) || targetSlot < 0 || targetSlot >= MAX_SETS) throw exchangeError("invalid-target-slot", "请先选择一个套装格子");
    const replacedSet = (data.sets || []).find(set => set.slot === targetSlot) || null;
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
    const namingData = { ...data, sets: data.sets.filter(entry => entry.slot !== targetSlot) };
    const set = normalizeSet({ id: uid(), slot: targetSlot, name: uniqueSetName(parsed.set.name, namingData), appearance, customOutfits }, { validSchemeIds: new Set(candidateSchemes.map(entry => entry.id)) });
    const sets = replacedSet
      ? data.sets.map(entry => entry.slot === targetSlot ? set : entry)
      : [...data.sets, set];
    const candidate = normalizeWardrobe({ ...data, schemes: candidateSchemes, sets, equippedIds: data.equippedIds }, { validateReferences: false });
    compactWardrobeForStorage(candidate);
    return { wardrobe: candidate, set, replacedSet: replacedSet ? cloneJSON(replacedSet) : null, targetSlot, report };
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



  function openSetNameModal(title, initialName, onAccept) {
    const modal = openExchangeModal(title);
    const label = document.createElement("label");
    label.className = "coe-field";
    label.innerHTML = '<span>名称</span>';
    const input = document.createElement("input");
    input.className = "coe-title-input";
    input.maxLength = 60;
    input.value = String(initialName || "").slice(0, 60);
    label.appendChild(input);
    const submit = document.createElement("button");
    submit.className = "coe-btn coe-primary";
    submit.textContent = "确定";
    submit.addEventListener("click", () => {
      const name = input.value.trim();
      if (!name) { input.focus(); toast("名称不能为空", "warn"); return; }
      try { if (onAccept(name) !== false) modal.backdrop.remove(); }
      catch (error) { toast(`操作失败: ${error?.message || error}`, "error"); }
    });
    modal.content.appendChild(label);
    modal.actions.appendChild(submit);
    input.focus();
    input.select();
    return modal;
  }

  function syncFormalAppearance() {
    if (typeof globalThis.ServerPlayerAppearanceSync === "function") ServerPlayerAppearanceSync();
  }

  function uniqueSetName(name, data = wardrobe) {
    const base = String(name || "未命名套装").slice(0, 60);
    const names = new Set((data?.sets || []).map(set => set.name));
    if (!names.has(base)) return base;
    for (let index = 1; index < 1000; index++) {
      const suffix = index === 1 ? "（副本）" : `（副本 ${index}）`;
      const candidate = `${base.slice(0, Math.max(0, 60 - suffix.length))}${suffix}`;
      if (!names.has(candidate)) return candidate;
    }
    return `${base.slice(0, 48)}（${uid().slice(-7)}）`;
  }

  function removeSchemeAndSetReferences(schemeId, options = {}) {
    const previous = cloneJSON(wardrobe);
    const previousAppearance = globalThis.Player ? cloneAppearanceItems(Player.Appearance) : null;
    const references = findSetsReferencingScheme(schemeId, wardrobe);
    const removedScheme = wardrobe.schemes.find(entry => entry.id === schemeId);
    const wasEquipped = wardrobe.equippedIds.includes(schemeId);
    try {
      const candidate = normalizeWardrobe({
        ...wardrobe,
        schemes: wardrobe.schemes.filter(entry => entry.id !== schemeId),
        sets: wardrobe.sets.map(set => ({ ...set, customOutfits: set.customOutfits.filter(entry => entry.schemeId !== schemeId) })),
        equippedIds: wardrobe.equippedIds.filter(id => id !== schemeId),
      }, { validateReferences: false });
      compactWardrobeForStorage(candidate, { validateReferences: false });
      wardrobe = candidate;
      if (wasEquipped && removedScheme && globalThis.Player) {
        const slotGroup = schemeSlotGroup(removedScheme);
        Player.Appearance = Player.Appearance.filter(item => !(item?.Asset?.Name === TAG_ASSET_NAME && item?.Asset?.Group?.Name === slotGroup));
      }
      (options.persist || persistWardrobe)();
      if (options.sync !== false) { syncEquippedSchemes(); syncFormalAppearance(); }
      return { removedReferences: references.length };
    } catch (error) {
      wardrobe = previous;
      if (previousAppearance && globalThis.Player) Player.Appearance = previousAppearance;
      if (options.sync !== false) syncEquippedSchemes();
      throw error;
    }
  }

  function deleteSetTransaction(setId, options = {}) {
    const previous = cloneJSON(wardrobe);
    const previousAppliedSetId = lastAppliedSetId;
    const previousReconnectSetId = reconnectSetId;
    try {
      const candidate = normalizeWardrobe({ ...wardrobe, sets: wardrobe.sets.filter(set => set.id !== setId) }, { validateReferences: false });
      if (candidate.sets.length === wardrobe.sets.length) return false;
      wardrobe = candidate;
      if (lastAppliedSetId === setId) lastAppliedSetId = null;
      if (reconnectSetId === setId) reconnectSetId = null;
      (options.persist || persistWardrobe)();
      return true;
    } catch (error) {
      wardrobe = previous;
      lastAppliedSetId = previousAppliedSetId;
      reconnectSetId = previousReconnectSetId;
      throw error;
    }
  }

  function setAtSlot(slot, data = wardrobe) {
    return (data?.sets || []).find(set => set.slot === slot) || null;
  }

  function firstEmptySetSlot(data = wardrobe) {
    const occupied = new Set((data?.sets || []).map(set => set.slot));
    for (let slot = 0; slot < MAX_SETS; slot++) if (!occupied.has(slot)) return slot;
    return null;
  }

  function saveCurrentSetToSlotTransaction(slot, name, options = {}) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SETS) throw new Error("套装储存格无效");
    const existing = setAtSlot(slot);
    if (existing && options.overwrite !== true) throw new Error("该套装格子已有内容");
    if (!existing && wardrobe.sets.length >= MAX_SETS) throw new Error(`套装衣柜最多保存 ${MAX_SETS} 套`);
    const finalName = existing && options.keepName !== false ? existing.name : uniqueSetName(name);
    const captured = captureCurrentSet(finalName, options.character || globalThis.Player, wardrobe, slot);
    if (captured.anomalies.some(entry => entry.type === "orphan-tag")) throw new Error("当前外观存在没有对应自定义服装的 COE 标签，请先重新启用该服装");
    if (existing) captured.set.id = existing.id;
    const previous = cloneJSON(wardrobe);
    try {
      const sets = existing
        ? wardrobe.sets.map(set => set.slot === slot ? captured.set : set)
        : [...wardrobe.sets, captured.set];
      const candidate = normalizeWardrobe({ ...wardrobe, sets }, { validateReferences: false });
      compactWardrobeForStorage(candidate, { validateReferences: false });
      wardrobe = candidate;
      (options.persist || persistWardrobe)();
      return { set: cloneJSON(setAtSlot(slot)), anomalies: captured.anomalies, overwritten: !!existing };
    } catch (error) { wardrobe = previous; throw error; }
  }

  function saveCurrentSetTransaction(name, options = {}) {
    const slot = Number.isInteger(options.slot) ? options.slot : firstEmptySetSlot();
    if (slot == null) throw new Error(`套装衣柜最多保存 ${MAX_SETS} 套`);
    return saveCurrentSetToSlotTransaction(slot, name, options);
  }

  function overwriteCurrentSetTransaction(slot, options = {}) {
    const existing = setAtSlot(slot);
    if (!existing) throw new Error("所选套装格子为空");
    return saveCurrentSetToSlotTransaction(slot, existing.name, { ...options, overwrite: true, keepName: true });
  }

  function setAppearanceFingerprint(character, data, equippedIds) {
    const captureData = { ...data, equippedIds: Array.isArray(equippedIds) ? equippedIds : data?.equippedIds || [] };
    const captured = captureAppearanceForSet(character, captureData);
    if (captured.anomalies.length) return null;
    const appearance = captured.appearance
      .map(bundle => compactAppearanceBundle(bundle))
      .sort((left, right) => `${left.g}/${left.a}`.localeCompare(`${right.g}/${right.a}`));
    const customOutfits = captured.customOutfits
      .map(reference => ({ slotGroup: reference.slotGroup, schemeId: reference.schemeId }))
      .sort((left, right) => left.slotGroup.localeCompare(right.slotGroup));
    return JSON.stringify({ appearance, customOutfits });
  }

  function isSetCurrentlyWorn(set, character = globalThis.Player, data = wardrobe) {
    if (!set || !character) return false;
    try {
      const plan = buildSetApplyPlan(set, character, data);
      if (plan.missingAppearance.length || plan.missingSchemes.length) return false;
      const expected = { Appearance: plan.appearance };
      return setAppearanceFingerprint(character, data, plan.equippedIds) === setAppearanceFingerprint(expected, data, plan.equippedIds);
    } catch (_) { return false; }
  }

  function captureSetReconnectIntent() {
    reconnectSetId = null;
    reconnectSetRestoreScheduled = false;
    if (!globalThis.Player) return null;
    const selected = Number.isInteger(selectedSetSlot) ? setAtSlot(selectedSetSlot) : null;
    const lastApplied = lastAppliedSetId ? wardrobe.sets.find(set => set.id === lastAppliedSetId) : null;
    const candidates = [selected, lastApplied, ...wardrobe.sets].filter(Boolean);
    const seen = new Set();
    for (const set of candidates) {
      if (seen.has(set.id)) continue;
      seen.add(set.id);
      if (!isSetCurrentlyWorn(set, Player, wardrobe)) continue;
      reconnectSetId = set.id;
      return reconnectSetId;
    }
    return null;
  }

  function restoreSetReconnectIntent(options = {}) {
    reconnectSetRestoreScheduled = false;
    const setId = reconnectSetId;
    reconnectSetId = null;
    if (!setId || !globalThis.Player) return false;
    const set = wardrobe.sets.find(entry => entry.id === setId);
    if (!set) return false;
    try {
      applySetTransaction(set, options);
      return true;
    } catch (error) {
      warn(`重连后恢复套装「${set.name}」失败`, error);
      return false;
    }
  }

  function scheduleSetReconnectRestore() {
    if (!reconnectSetId || reconnectSetRestoreScheduled) return false;
    reconnectSetRestoreScheduled = true;
    setTimeout(() => restoreSetReconnectIntent(), 0);
    return true;
  }

  function applySetTransaction(set, options = {}) {
    if (!globalThis.Player) throw new Error("当前角色不可用");
    const plan = buildSetApplyPlan(set, globalThis.Player, wardrobe);
    const previousWardrobe = cloneJSON(wardrobe);
    const previousAppearance = cloneAppearanceItems(Player.Appearance);
    const previousAppliedSetId = lastAppliedSetId;
    try {
      const candidateWardrobe = normalizeWardrobe({ ...wardrobe, equippedIds: plan.equippedIds }, { validateReferences: false });
      compactWardrobeForStorage(candidateWardrobe, { validateReferences: false });
      Player.Appearance = plan.appearance;
      wardrobe = candidateWardrobe;
      (options.persist || persistWardrobe)();
      lastAppliedSetId = set.id;
      syncEquippedSchemes();
      syncFormalAppearance();
      return plan;
    } catch (error) {
      Player.Appearance = previousAppearance;
      wardrobe = previousWardrobe;
      lastAppliedSetId = previousAppliedSetId;
      syncEquippedSchemes();
      try { syncFormalAppearance(); } catch (_) { /* best-effort rollback sync */ }
      throw error;
    }
  }

  function formatSetApplyReport(plan) {
    const missingAppearance = plan.missingAppearance.length;
    const missingSchemes = plan.missingSchemes.length;
    if (!missingAppearance && !missingSchemes) return "套装已完整穿上";
    return `套装已部分穿上：缺少原版外观 ${missingAppearance} 件，自定义服装 ${missingSchemes} 件`;
  }

  function showSetExport(set) {
    try {
      const text = createSetExchangeString(set.id);
      const modal = openExchangeModal(`导出套装「${set.name}」`);
      const hint = document.createElement("p");
      hint.className = "coe-muted";
      hint.textContent = "此字符串包含套装外观及其引用的自定义服装，可用于手动分享或备份。";
      const textarea = document.createElement("textarea");
      textarea.className = "coe-exchange-text";
      textarea.readOnly = true;
      textarea.value = text;
      const copy = document.createElement("button");
      copy.className = "coe-btn coe-primary";
      copy.textContent = "复制字符串";
      copy.addEventListener("click", () => copyExchangeText(text, textarea));
      modal.content.append(hint, textarea);
      modal.actions.appendChild(copy);
      textarea.focus();
      textarea.select();
    } catch (error) { toast(`导出套装失败: ${error?.message || error}`, "error"); }
  }

  function showSetImport(body, targetSlot) {
    if (!Number.isInteger(targetSlot)) { toast("请先选择一个套装格子", "warn"); return; }
    const current = setAtSlot(targetSlot);
    const modal = openExchangeModal(`导入到第 ${targetSlot + 1} 格`);
    const hint = document.createElement("p");
    hint.className = "coe-muted";
    hint.textContent = current
      ? `格子中现有套装「${current.name}」。导入会覆盖这个格子，但不会删除它引用的自定义服装。`
      : "粘贴以 COE-SET 开头的套装字符串。导入只保存，不会自动穿上。";
    const textarea = document.createElement("textarea");
    textarea.className = "coe-exchange-text";
    textarea.placeholder = "COE-SET:1:…";
    const submit = document.createElement("button");
    submit.className = "coe-btn coe-primary";
    submit.textContent = "检查并导入";
    submit.addEventListener("click", () => {
      if (!ensureWardrobeWritable()) return;
      try {
        const parsed = parseSetExchangeString(textarea.value);
        const plan = buildSetImportPlan(parsed, targetSlot);
        const report = plan.report;
        const warning = report.appearanceMissing || report.outfitsSkipped || report.missingLayers
          ? `\n\n缺少原版外观 ${report.appearanceMissing} 件；跳过自定义服装 ${report.outfitsSkipped} 件；缺少图层 ${report.missingLayers} 个。其余内容仍可使用。` : "";
        const overwrite = plan.replacedSet ? `\n将覆盖格子中的「${plan.replacedSet.name}」。` : "";
        openConfirmationModal(
          `导入套装到第 ${targetSlot + 1} 格`,
          `将套装「${plan.set.name}」导入第 ${targetSlot + 1} 格。${overwrite}\n新建自定义服装 ${report.outfitsCreated} 件，复用 ${report.outfitsReused} 件。${warning}\n\n导入后保持未穿着，是否继续？`,
          "继续导入",
          () => {
            commitSetImportPlan(plan);
            selectedSetSlot = targetSlot;
            modal.backdrop.remove();
            renderWardrobe(body);
            toast(`已导入套装「${plan.set.name}」`);
          },
        );
      } catch (error) { toast(`导入套装失败: ${error?.message || error}`, "error"); }
    });
    modal.content.append(hint, textarea);
    modal.actions.appendChild(submit);
    textarea.focus();
  }

  function setPreviewFingerprint(set) {
    const schemeById = new Map(wardrobe.schemes.map(entry => [entry.id, entry]));
    const compactSet = compactSetForStorage(set, { validSchemeIds: new Set(schemeById.keys()) });
    delete compactSet.name;
    delete compactSet.slot;
    return JSON.stringify({
      set: compactSet,
      outfits: set.customOutfits.map(entry => {
        const scheme = schemeById.get(entry.schemeId);
        return scheme ? compactCompositionForStorage(scheme.composition, { validateReferences: false }) : null;
      }),
    });
  }

  function paintSetPreview(target, source) {
    const context = target?.getContext?.("2d");
    if (!context || !source) return false;
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(source, 0, 0, source.width, source.height, 0, 0, target.width, target.height);
    return true;
  }

  function releaseSetPreviewCharacter(character) {
    if (!character) return;
    previewCompositionByCharacter.delete(character);
    syntheticByCharacter.delete(character);
    if (typeof clearPreviewTextureTracking === "function") clearPreviewTextureTracking(character);
    try { if (typeof globalThis.CharacterDelete === "function") CharacterDelete(character, false); } catch (_) { /* best effort */ }
    try { if (character.Canvas) { character.Canvas.width = 0; character.Canvas.height = 0; } } catch (_) { /* best effort */ }
    try { if (character.CanvasBlink) { character.CanvasBlink.width = 0; character.CanvasBlink.height = 0; } } catch (_) { /* best effort */ }
  }

  function cancelSetPreviewQueue() {
    setPreviewGeneration++;
    setPreviewQueue = [];
  }

  // A reconnect can leave the browser's image cache and the preview canvases at
  // different points in their loading lifecycle. Never reuse a snapshot created
  // before the new online character has finished loading its assets.
  function invalidateSetPreviewCache() {
    setPreviewCache.clear();
    cancelSetPreviewQueue();
  }

  async function buildSetPreviewSnapshot(set, generation) {
    if (typeof globalThis.CharacterLoadSimple !== "function" || !globalThis.Player) return null;
    const character = CharacterLoadSimple(`COESetPreview-${++setPreviewCharacterSerial}`);
    try {
      character.AssetFamily = Player.AssetFamily || "Female3DCG";
      character.Appearance = cloneAppearanceItems(Player.Appearance || []);
      character.ActivePoseMapping = cloneJSON(Player.ActivePoseMapping || {});
      character.HeightModifier = Player.HeightModifier;
      character.HeightRatio = Player.HeightRatio;
      const plan = buildSetApplyPlan(set, character, wardrobe);
      character.Appearance = plan.appearance;
      previewCompositionByCharacter.set(character, combineSchemes(plan.equippedIds, wardrobe));
      if (typeof globalThis.CharacterRefresh === "function") CharacterRefresh(character, false, false);
      // Synthetic source textures are absent from the preview character's formal
      // Appearance, so BC's DrawRefreshCharacterForImage cannot mark this isolated
      // character dirty when their 1x1 placeholders finish loading. The renderer
      // tracks those URLs for us; keep rebuilding until every observed texture is
      // ready, with a bounded wait so a broken URL cannot stall the whole queue.
      for (let attempt = 0; attempt < 40; attempt++) {
        if (generation !== setPreviewGeneration) return null;
        if (typeof globalThis.CharacterLoadCanvas === "function") CharacterLoadCanvas(character);
        await new Promise(resolve => setTimeout(resolve, attempt < 2 ? 0 : 60));
        if (!character.MustDraw && !previewTexturesPending(character) && attempt >= 2) break;
      }
      // The timeout is a safety boundary, not permission to capture a partial
      // character. Capturing here used to poison setPreviewCache with a snapshot
      // made from 1x1 texture placeholders; saving the same appearance to a new
      // slot appeared to fix it only because that slot received a new fingerprint.
      if (character.MustDraw || previewTexturesPending(character)) return null;
      const cacheable = !previewTexturesPending(character);
      const snapshot = document.createElement("canvas");
      snapshot.width = 500;
      snapshot.height = 1000;
      const context = snapshot.getContext?.("2d");
      if (!context) return null;
      context.clearRect(0, 0, snapshot.width, snapshot.height);
      if (typeof globalThis.DrawCharacter === "function") DrawCharacter(character, 0, 0, 1, false, context);
      else if (character.Canvas) context.drawImage(character.Canvas, 0, 0, snapshot.width, snapshot.height);
      return { snapshot, plan, cacheable };
    } catch (error) {
      warn(`套装「${set.name}」预览生成失败`, error);
      return null;
    } finally { releaseSetPreviewCharacter(character); }
  }

  async function runSetPreviewQueue() {
    if (setPreviewRunning) return;
    setPreviewRunning = true;
    try {
      while (setPreviewQueue.length) {
        const job = setPreviewQueue.shift();
        if (!job || job.generation !== setPreviewGeneration || !job.canvas.isConnected) continue;
        const cached = setPreviewCache.get(job.fingerprint);
        if (cached) {
          paintSetPreview(job.canvas, cached);
          job.slot.classList.remove("coe-loading", "coe-preview-failed");
          continue;
        }
        const result = await buildSetPreviewSnapshot(job.set, job.generation);
        if (!result) {
          if (job.generation === setPreviewGeneration && job.canvas.isConnected) {
            job.slot.classList.remove("coe-loading");
            job.slot.classList.add("coe-preview-failed");
          }
          continue;
        }
        if (job.generation !== setPreviewGeneration || !job.canvas.isConnected) continue;
        if (result.cacheable) {
          setPreviewCache.set(job.fingerprint, result.snapshot);
          if (setPreviewCache.size > MAX_SETS * 2) setPreviewCache.delete(setPreviewCache.keys().next().value);
        }
        paintSetPreview(job.canvas, result.snapshot);
        job.slot.classList.remove("coe-loading", "coe-preview-failed");
      }
    } finally { setPreviewRunning = false; }
  }

  function queueSetPreview(set, slotElement, canvas, generation) {
    let fingerprint;
    try { fingerprint = setPreviewFingerprint(set); }
    catch (error) {
      slotElement.classList.remove("coe-loading");
      slotElement.classList.add("coe-preview-failed");
      return;
    }
    const cached = setPreviewCache.get(fingerprint);
    if (cached) {
      paintSetPreview(canvas, cached);
      slotElement.classList.remove("coe-loading", "coe-preview-failed");
      return;
    }
    setPreviewQueue.push({ set: cloneJSON(set), slot: slotElement, canvas, fingerprint, generation });
    runSetPreviewQueue();
  }

  function updateSetSelectionUI(body) {
    const slotSelected = Number.isInteger(selectedSetSlot) && selectedSetSlot >= 0 && selectedSetSlot < MAX_SETS;
    const selected = slotSelected ? setAtSlot(selectedSetSlot) : null;
    body.querySelectorAll("[data-set-slot]").forEach(element => {
      element.classList.toggle("coe-selected", slotSelected && Number(element.dataset.setSlot) === selectedSetSlot);
    });
    const label = body.querySelector("[data-selected-set-name]");
    if (label) label.textContent = selected ? `已选择：${selected.name}` : slotSelected ? `已选择：第 ${selectedSetSlot + 1} 格（空）` : "请选择一个套装格子";
    body.querySelectorAll("[data-set-command]").forEach(button => {
      const command = button.dataset.setCommand;
      const needsContent = command !== "store";
      const readOnlyBlocked = persistenceBlocked && command !== "export";
      button.disabled = !slotSelected || (needsContent && !selected) || readOnlyBlocked;
    });
  }

  function renderSetWardrobe(body) {
    cancelSetPreviewQueue();
    setWardrobePage = clamp(setWardrobePage, 0, 1);
    const generation = setPreviewGeneration;
    const toolbar = document.createElement("div");
    toolbar.className = "coe-set-toolbar";
    toolbar.innerHTML = `<strong data-selected-set-name>请选择一个已有套装格子</strong><div class="coe-actions"><button class="coe-btn" data-set-command="store">储存</button><button class="coe-btn coe-primary" data-set-command="wear">穿上</button><button class="coe-btn" data-set-command="rename">重命名</button><button class="coe-btn" data-set-command="export">导出</button><button class="coe-btn coe-danger" data-set-command="delete">删除</button></div>`;
    const selected = () => setAtSlot(selectedSetSlot);
    toolbar.querySelector('[data-set-command="store"]').addEventListener("click", () => {
      if (!Number.isInteger(selectedSetSlot) || !ensureWardrobeWritable()) return;
      const set = selected();
      if (set) {
        openConfirmationModal(
          `覆盖「${set.name}」`,
          `将当前完整外观储存到套装「${set.name}」？\n\n这会覆盖该格子原有的外观和自定义服装引用。`,
          "确认覆盖",
          () => {
            try {
              overwriteCurrentSetTransaction(selectedSetSlot);
              renderWardrobe(body);
              toast(`已更新套装「${set.name}」`);
            } catch (error) { toast(`储存套装失败: ${error?.message || error}`, "error"); return false; }
          },
        );
      } else {
        try {
          const result = saveCurrentSetToSlotTransaction(selectedSetSlot, `新套装 ${selectedSetSlot + 1}`);
          renderWardrobe(body);
          toast(`已保存套装「${result.set.name}」`);
        } catch (error) { toast(`储存套装失败: ${error?.message || error}`, "error"); }
      }
    });
    toolbar.querySelector('[data-set-command="wear"]').addEventListener("click", () => {
      const set = selected();
      if (!set || !ensureWardrobeWritable()) return;
      try { const plan = applySetTransaction(set); toast(formatSetApplyReport(plan), plan.missingAppearance.length || plan.missingSchemes.length ? "warn" : "info"); }
      catch (error) { toast(`穿上套装失败: ${error?.message || error}`, "error"); }
    });
    toolbar.querySelector('[data-set-command="rename"]').addEventListener("click", () => {
      const set = selected();
      if (!set || !ensureWardrobeWritable()) return;
      openSetNameModal(`重命名套装「${set.name}」`, set.name, nextName => {
        const previous = cloneJSON(wardrobe);
        try {
          const target = setAtSlot(set.slot);
          target.name = nextName.slice(0, 60);
          wardrobe = normalizeWardrobe(wardrobe);
          persistWardrobe();
          renderWardrobe(body);
        } catch (error) { wardrobe = previous; throw error; }
      });
    });
    toolbar.querySelector('[data-set-command="export"]').addEventListener("click", () => { const set = selected(); if (set) showSetExport(set); });
    toolbar.querySelector('[data-set-command="delete"]').addEventListener("click", () => {
      const set = selected();
      if (!set || !ensureWardrobeWritable()) return;
      openConfirmationModal(
        `删除套装「${set.name}」`,
        "删除后无法恢复。这个操作只删除套装格子，套装引用的自定义服装会继续保留。",
        "确认删除",
        () => {
          try { deleteSetTransaction(set.id); selectedSetSlot = null; renderWardrobe(body); }
          catch (error) { toast(`删除套装失败: ${error?.message || error}`, "error"); return false; }
        },
        { danger: true },
      );
    });
    body.appendChild(toolbar);

    const pageTabs = document.createElement("nav");
    pageTabs.className = "coe-set-page-tabs";
    pageTabs.innerHTML = `<button class="${setWardrobePage === 0 ? "coe-active" : ""}" data-page="0">第 1 页</button><button class="${setWardrobePage === 1 ? "coe-active" : ""}" data-page="1">第 2 页</button>`;
    pageTabs.querySelectorAll("[data-page]").forEach(button => button.addEventListener("click", () => {
      setWardrobePage = Number(button.dataset.page);
      renderWardrobe(body);
    }));
    body.appendChild(pageTabs);

    const grid = document.createElement("div");
    grid.className = "coe-set-grid";
    body.appendChild(grid);
    const start = setWardrobePage * SETS_PER_PAGE;
    for (let slot = start; slot < start + SETS_PER_PAGE; slot++) {
      const set = setAtSlot(slot);
      const element = document.createElement("div");
      element.className = `coe-set-slot${set ? " coe-loading" : " coe-empty-slot"}`;
      element.tabIndex = 0;
      element.setAttribute("role", "button");
      element.dataset.setSlot = String(slot);
      grid.appendChild(element);
      if (!set) {
        element.innerHTML = `<button type="button" class="coe-set-plus" title="把当前完整外观储存到第 ${slot + 1} 格">＋</button><span class="coe-set-slot-name">第 ${slot + 1} 格</span>`;
        element.addEventListener("click", () => { selectedSetSlot = slot; updateSetSelectionUI(body); });
        element.querySelector(".coe-set-plus").addEventListener("click", event => {
          event.stopPropagation();
          if (!ensureWardrobeWritable()) return;
          try {
            const result = saveCurrentSetToSlotTransaction(slot, `新套装 ${slot + 1}`);
            selectedSetSlot = slot;
            renderWardrobe(body);
            toast(`已保存套装「${result.set.name}」`);
          } catch (error) { toast(`保存套装失败: ${error?.message || error}`, "error"); }
        });
      } else {
        const missing = validateSetReferences(set).length;
        element.innerHTML = `<canvas width="225" height="440" aria-label="${escapeHTML(set.name)}预览"></canvas>${missing ? `<span class="coe-set-warning" title="缺少 ${missing} 件自定义服装">⚠ ${missing}</span>` : ""}<span class="coe-set-slot-name">${escapeHTML(set.name)}</span>`;
        element.addEventListener("click", () => { selectedSetSlot = slot; updateSetSelectionUI(body); });
        queueSetPreview(set, element, element.querySelector("canvas"), generation);
      }
      element.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        selectedSetSlot = slot;
        updateSetSelectionUI(body);
      });
    }
    updateSetSelectionUI(body);
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

  function schemeSlotGroup(scheme) {
    return scheme?.composition?.slotGroup || defaultClothingSlotGroup();
  }

  function activateScheme(scheme, autoEquipTag = true) {
    if (!scheme) return false;
    const slotGroup = schemeSlotGroup(scheme);
    if (!clothingSlotGroup(slotGroup)) {
      toast(`服装格子「${slotGroup}」当前不可用`, "error");
      return false;
    }
    if (autoEquipTag && !equipTagForGroup(slotGroup)) {
      toast(`无法自动装备「自定义${clothingSlotLabel(slotGroup)}」`, "error");
      return false;
    }
    const sameSlotIds = new Set(wardrobe.schemes
      .filter(entry => entry.id !== scheme.id && schemeSlotGroup(entry) === slotGroup)
      .map(entry => entry.id));
    wardrobe.equippedIds = ensureEquippedIds().filter(id => !sameSlotIds.has(id));
    if (!wardrobe.equippedIds.includes(scheme.id)) wardrobe.equippedIds.push(scheme.id);
    return true;
  }

  function combineSchemes(schemeIds, data = wardrobe) {
    const equipped = new Set(Array.isArray(schemeIds) ? schemeIds : []);
    const selected = (data?.schemes || []).filter(scheme => equipped.has(scheme.id));
    const materials = [];
    const layers = [];
    for (const scheme of selected) {
      const composition = normalizeComposition(scheme.composition);
      const idMap = new Map();
      for (const material of composition.materials) {
        const nextId = `${scheme.id}:${material.id}`;
        idMap.set(material.id, nextId);
        materials.push({ ...cloneJSON(material), id: nextId, wearGroup: composition.slotGroup });
      }
      for (const layer of composition.layers) {
        if (layers.length >= MAX_LAYERS) break;
        layers.push({ ...cloneJSON(layer), materialId: idMap.get(layer.materialId) || layer.materialId });
      }
    }
    const combined = {
      name: selected.map(scheme => scheme.composition.name).join(" + ") || "已装备方案",
      materials,
      layers,
      recycle: [],
    };
    // Overall transforms are stored on each material, so cloning the materials
    // above preserves independent per-asset rotation/scale even when schemes are
    // equipped together. There is deliberately no composition-wide transform.
    return normalizeComposition(combined);
  }

  function combinedEquippedComposition() {
    return combineSchemes(ensureEquippedIds(), wardrobe);
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

  function uniqueImportedSchemeName(name, data = wardrobe) {
    const base = String(name || "未命名方案").slice(0, 60);
    const names = new Set((data?.schemes || []).map(scheme => scheme.composition.name));
    if (!names.has(base)) return base;
    for (let index = 1; index < 1000; index++) {
      const suffix = index === 1 ? "（导入）" : `（导入 ${index}）`;
      const candidate = `${base.slice(0, Math.max(0, 60 - suffix.length))}${suffix}`;
      if (!names.has(candidate)) return candidate;
    }
    return `${base.slice(0, 48)}（${uid().slice(-7)}）`;
  }

  function openExchangeModal(title) {
    document.querySelector(`#${ROOT_ID} .coe-modal-backdrop`)?.remove();
    const backdrop = document.createElement("div");
    backdrop.className = "coe-modal-backdrop";
    const panel = document.createElement("section");
    panel.className = "coe-modal";
    const heading = document.createElement("h3");
    heading.textContent = title;
    const content = document.createElement("div");
    content.className = "coe-modal-content";
    const actions = document.createElement("div");
    actions.className = "coe-actions coe-modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "coe-btn";
    cancel.textContent = "关闭";
    cancel.addEventListener("click", () => backdrop.remove());
    actions.appendChild(cancel);
    panel.append(heading, content, actions);
    backdrop.appendChild(panel);
    document.getElementById(ROOT_ID)?.appendChild(backdrop);
    return { backdrop, content, actions, cancel };
  }

  function openConfirmationModal(title, message, confirmLabel, onConfirm, options = {}) {
    const modal = openExchangeModal(title);
    modal.cancel.textContent = "取消";
    const text = document.createElement("p");
    // Support line breaks from browser confirm() messages;
    // HTML-escape to prevent injection while preserving newlines.
    text.innerHTML = options.html
      ? message
      : message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').split(String.fromCharCode(10)).join('<br>');
    const confirmButton = document.createElement("button");
    confirmButton.className = `coe-btn ${options.danger ? "coe-danger" : "coe-primary"}`;
    confirmButton.textContent = confirmLabel || "确定";
    confirmButton.addEventListener("click", () => {
      try {
        if (onConfirm() === false) return;
        modal.backdrop.remove();
      } catch (error) { toast(`操作失败: ${error?.message || error}`, "error"); }
    });
    modal.content.appendChild(text);
    modal.actions.appendChild(confirmButton);
    confirmButton.focus();
    return modal;
  }

  async function copyExchangeText(text, textarea) {
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error("clipboard-unavailable");
      await navigator.clipboard.writeText(text);
      toast("服装字符串已复制到剪贴板");
    } catch (_) {
      textarea.focus();
      textarea.select();
      toast("无法自动复制，已为你选中字符串", "warn");
    }
  }

  function showOutfitExport(scheme) {
    try {
      const text = createOutfitExchangeString(scheme.composition);
      const modal = openExchangeModal(`导出「${scheme.composition.name}」`);
      const hint = document.createElement("p");
      hint.className = "coe-muted";
      hint.textContent = "复制下面以 COE-OUTFIT 开头的字符串，即可分享或备份这件服装。";
      const textarea = document.createElement("textarea");
      textarea.className = "coe-exchange-text";
      textarea.readOnly = true;
      textarea.value = text;
      const copy = document.createElement("button");
      copy.className = "coe-btn coe-primary";
      copy.textContent = "复制字符串";
      copy.addEventListener("click", () => copyExchangeText(text, textarea));
      modal.content.append(hint, textarea);
      modal.actions.appendChild(copy);
      textarea.focus();
      textarea.select();
    } catch (error) {
      toast(`导出失败: ${error?.message || error}`, "error");
    }
  }

  function importSingleOutfitString(text, body) {
    if (!ensureWardrobeWritable()) return false;
    if (wardrobe.schemes.length >= MAX_SCHEMES) throw new Error(`衣柜最多保存 ${MAX_SCHEMES} 套方案`);
    const parsed = parseOutfitExchangeString(text);
    const missing = parsed.missingLayers + parsed.missingRecycle;
    if (parsed.allAssetsMissing) throw new Error("这件服装没有任何可用图层，已跳过");
    if (missing) {
      openConfirmationModal(
        "缺少图层",
        `当前环境缺少 ${missing} 个图层引用。继续导入后，这些部分不会显示，是否继续？`,
        "继续导入",
        () => { doImportOutfit(parsed, text, body); },
      );
      return null;
    }
    return doImportOutfit(parsed, text, body);
  }

  function doImportOutfit(parsed, text, body) {
    const previous = cloneJSON(wardrobe);
    try {
      const composition = cloneJSON(parsed.composition);
      composition.name = uniqueImportedSchemeName(composition.name);
      const candidate = normalizeWardrobe({
        ...wardrobe,
        schemes: [{ id: uid(), composition }, ...wardrobe.schemes],
        equippedIds: wardrobe.equippedIds,
      });
      compactWardrobeForStorage(candidate);
      wardrobe = candidate;
      persistWardrobe();
      syncEquippedSchemes();
      renderWardrobe(body);
      const missing = parsed.missingLayers + parsed.missingRecycle;
      toast(missing ? `已导入「${composition.name}」；缺少 ${missing} 个图层，已保留可用部分` : `已导入「${composition.name}」，当前保持未启用`);
      return true;
    } catch (error) {
      wardrobe = previous;
      throw error;
    }
  }

  function showOutfitImport(body) {
    const modal = openExchangeModal("导入单件服装");
    const hint = document.createElement("p");
    hint.className = "coe-muted";
    hint.textContent = "粘贴以 COE-OUTFIT 开头的服装字符串。导入后会作为新方案加入，并保持未启用。";
    const textarea = document.createElement("textarea");
    textarea.className = "coe-exchange-text";
    textarea.placeholder = "COE-OUTFIT:1:…";
    const submit = document.createElement("button");
    submit.className = "coe-btn coe-primary";
    submit.textContent = "检查并导入";
    submit.addEventListener("click", () => {
      try {
        const result = importSingleOutfitString(textarea.value, body);
        if (result === true) modal.backdrop.remove();
      } catch (error) {
        toast(`导入失败: ${error?.message || error}`, "error");
      }
    });
    modal.content.append(hint, textarea);
    modal.actions.appendChild(submit);
    textarea.focus();
  }

  function downloadWardrobeFile() {
    if (persistenceBlocked) {
      openConfirmationModal(
        "导出衣柜",
        `衣柜当前处于「${wardrobeReadState.status}」状态。将只导出当前界面选中的 ${wardrobeReadState.source || "内存"} 版本，不包含另一份冲突数据。是否继续？`,
        "继续导出",
        doDownloadWardrobe,
      );
      return;
    }
    doDownloadWardrobe();
  }

  function doDownloadWardrobe() {
    try {
      const documentData = createWardrobeExchangeDocument(wardrobe);
      const text = JSON.stringify(documentData, null, 2);
      const blob = new Blob([text], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = wardrobeExportFilename();
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast(`已导出 ${wardrobe.schemes.length} 件自定义服装和 ${wardrobe.sets.length} 套套装`);
    } catch (error) {
      toast(`导出衣柜失败: ${error?.message || error}`, "error");
    }
  }

  function doImportWardrobe(parsed, body) {
    const previous = cloneJSON(wardrobe);
    const previousBlocked = persistenceBlocked;
    try {
      wardrobe = normalizeWardrobe({ ...parsed.wardrobe, equippedIds: [] });
      persistenceBlocked = false;
      persistWardrobe({ force: true });
      syncEquippedSchemes();
      renderWardrobe(body);
      const localOnly = wardrobeReadState.sync?.mode === "local-only";
      const countText = `${wardrobe.schemes.length} 件自定义服装和 ${wardrobe.sets.length} 套套装`;
      toast(localOnly ? `已导入 ${countText}，仅保存到本机` : `已导入 ${countText}`, localOnly ? "warn" : "info");
    } catch (error) {
      wardrobe = previous;
      persistenceBlocked = previousBlocked;
      throw error;
    }
  }

  function importWardrobeFile(body) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.coe-wardrobe.json,application/json";
    input.style.display = "none";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      try {
        if (file.size > MAX_WARDROBE_FILE_BYTES) throw new Error("衣柜文件超过 1 MiB 安全限制");
        const parsed = parseWardrobeExchangeDocument(await file.text());
        const source = parsed.metadata.accountName
          ? `${parsed.metadata.accountName}${parsed.metadata.memberNumber == null ? "" : ` #${parsed.metadata.memberNumber}`}`
          : "未知玩家";
        const warning = persistenceBlocked ? `\n当前衣柜处于「${wardrobeReadState.status}」保护状态，本次操作会明确覆盖该状态。` : "";
        const missingWarning = parsed.missingLayers
          ? `\n当前环境缺少 ${parsed.missingLayers} 个图层引用，影响 ${parsed.affectedSchemes} 件自定义服装；导入后这些部分不会显示。`
          : "";
        const danglingWarning = parsed.missingSetReferences ? `\n另有 ${parsed.missingSetReferences} 个失效的套装引用会被清除。` : "";
        const importMessage = `文件来源：${source}\n文件包含：${parsed.wardrobe.schemes.length} 件自定义服装、${parsed.wardrobe.sets.length} 套套装\n当前衣柜：${wardrobe.schemes.length} 件自定义服装、${wardrobe.sets.length} 套套装\n\n导入会替换整个衣柜，并将所有自定义服装设为未启用。${missingWarning}${danglingWarning}${warning}\n建议先导出当前衣柜。是否继续？`;
        openConfirmationModal(
          "导入衣柜",
          importMessage,
          "继续导入",
          () => {
            doImportWardrobe(parsed, body);
          },
        );
      } catch (error) {
        toast(`导入衣柜失败: ${error?.message || error}`, "error");
      }
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  }

  function openWardrobe(view = wardrobeView) {
    restoreEditorAppearance();
    wardrobeView = view === "sets" ? "sets" : "outfits";
    loadWardrobe();
    ensureEquippedIds();
    syncEquippedSchemes();
    const exchangeMenu = '<details class="coe-menu"><summary class="coe-btn">导入导出 ▾</summary><div class="coe-menu-panel"><button data-import-outfit>导入单件服装</button><button data-import-set>导入套装到所选格</button><button data-import-wardrobe>导入整个衣柜</button><button data-export-wardrobe>导出整个衣柜</button></div></details>';
    const outfitActions = wardrobeView === "outfits" ? '<button class="coe-btn coe-primary" data-action="new">＋ 新建自定义服装</button><button class="coe-btn" data-action="unequip-all">全部卸下</button>' : "";
    const setNavigation = wardrobeView === "sets" ? '<button class="coe-btn" data-action="show-outfits">自定义服装</button><button class="coe-btn coe-primary" disabled>套装衣柜</button>' : "";
    const body = rootShell("COE 衣柜", `${setNavigation}${outfitActions}${exchangeMenu}<button class="coe-btn" data-action="close">返回</button>`, wardrobeView === "sets" ? { variant: "set-gallery" } : undefined);
    uiMode = "wardrobe";
    const root = document.getElementById(ROOT_ID);
    root.classList.add("coe-wardrobe-root");
    root.querySelector('[data-action="show-outfits"]')?.addEventListener("click", () => openWardrobe("outfits"));
    root.querySelector('[data-action="new"]')?.addEventListener("click", () => openEditor({ version: 2, name: "新方案", layers: [], recycle: [] }, null));
    root.querySelector("[data-import-outfit]").addEventListener("click", () => showOutfitImport(body));
    root.querySelector("[data-import-set]").addEventListener("click", () => showSetImport(body, selectedSetSlot));
    root.querySelector("[data-import-wardrobe]").addEventListener("click", () => importWardrobeFile(body));
    root.querySelector("[data-export-wardrobe]").addEventListener("click", downloadWardrobeFile);
    root.querySelector('[data-action="unequip-all"]')?.addEventListener("click", () => {
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

  function wardrobeRootBody(body) {
    return body?.closest?.(".coe-body") || body;
  }

  function renderWardrobe(body) {
    body = wardrobeRootBody(body);
    body.innerHTML = "";
    const root = document.getElementById(ROOT_ID);
    root?.classList.toggle("coe-set-gallery-root", wardrobeView === "sets");
    if (wardrobeView === "sets") {
      const workspace = document.createElement("div");
      workspace.className = "coe-set-workspace";
      workspace.innerHTML = '<aside class="coe-set-character-stage" aria-label="当前正在穿着的角色外观"></aside><section class="coe-set-gallery-pane"><div class="coe-wardrobe-content"></div></section>';
      body.appendChild(workspace);
      return renderSetWardrobe(workspace.querySelector(".coe-wardrobe-content"));
    }
    const tabs = document.createElement("nav");
    tabs.className = "coe-tool-tabs coe-wardrobe-tabs";
    tabs.innerHTML = '<button class="coe-btn coe-primary" data-view="outfits">自定义服装</button><button class="coe-btn" data-view="sets">套装衣柜</button>';
    const content = document.createElement("div");
    content.className = "coe-wardrobe-content";
    tabs.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => openWardrobe(button.dataset.view === "sets" ? "sets" : "outfits")));
    body.append(tabs, content);
    return renderOutfitWardrobe(content);
  }

  function renderOutfitWardrobe(body) {
    ensureEquippedIds();
    const equipped = new Set(wardrobe.equippedIds);
    const summary = document.createElement("div");
    summary.className = "coe-wardrobe-summary";
    summary.textContent = persistenceBlocked
      ? `衣柜处于只读保护：${wardrobeReadState.status}。请先通过诊断 API 导出原始数据，当前不会覆盖存储。`
      : equipped.size
      ? `当前启用 ${equipped.size} 套方案。只有对应格子穿着插件标签服装时才会显示。`
      : "当前没有启用自定义方案。启用服装时会自动穿上对应格子的透明标签服装。";
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
      const slotLabel = clothingSlotLabel(schemeSlotGroup(scheme));
      const tagWorn = isTagEquipped(globalThis.Player, schemeSlotGroup(scheme));
      card.innerHTML = `<div class="coe-card-title"><h3>${escapeHTML(scheme.composition.name)}</h3><span class="coe-equipped-badge">${isEquipped ? (tagWorn ? "已穿着" : "已启用") : "未启用"}</span></div><p class="coe-muted">部位 ${escapeHTML(slotLabel)} · 图层 ${stats.layers} · 素材 ${stats.assets} 件</p><div class="coe-actions"><button class="coe-btn ${isEquipped ? "coe-danger" : "coe-primary"}" data-toggle>${isEquipped ? "停用" : "启用"}</button><button class="coe-btn" data-edit>编辑</button><button class="coe-btn" data-export>导出</button><button class="coe-btn coe-danger" data-delete>删除</button></div>`;
      card.querySelector("[data-toggle]").addEventListener("click", () => {
        if (!ensureWardrobeWritable()) return;
        if (isEquipped) wardrobe.equippedIds = wardrobe.equippedIds.filter(id => id !== scheme.id);
        else if (!activateScheme(scheme, true)) return;
        syncEquippedSchemes();
        persistWardrobe();
        renderWardrobe(body);
      });
      card.querySelector("[data-edit]").addEventListener("click", () => openEditor(scheme.composition, scheme.id));
      card.querySelector("[data-export]").addEventListener("click", () => showOutfitExport(scheme));
      card.querySelector("[data-delete]").addEventListener("click", () => {
        if (!ensureWardrobeWritable()) return;
        const references = findSetsReferencingScheme(scheme.id);
        if (references.length) {
          openConfirmationModal(
            "删除自定义服装",
            `自定义服装「${scheme.composition.name}」正在被 ${references.length} 套套装使用。\n\n继续删除后，这件自定义服装也会从这些套装中移除；套装中的其他服装和外貌不会改变。\n\n是否继续？`,
            "确认删除",
            () => {
              try {
                removeSchemeAndSetReferences(scheme.id);
                renderWardrobe(body);
              } catch (error) { toast(`删除失败: ${error?.message || error}`, "error"); return false; }
            },
            { danger: true },
          );
        } else {
          openConfirmationModal(
            "删除自定义服装",
            `删除自定义服装「${scheme.composition.name}」？此操作无法撤销。`,
            "确认删除",
            () => {
              try {
                removeSchemeAndSetReferences(scheme.id);
                renderWardrobe(body);
              } catch (error) { toast(`删除失败: ${error?.message || error}`, "error"); return false; }
            },
            { danger: true },
          );
        }
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

  async function openGameColorPicker({ heading, currentColor, defaultColor, onPreview, onAccept, onCancel }) {
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
      lastPreview: initialColor,
      preview(value) {
        const selected = normalizePickerColor(value, null);
        if (!selected || selected === session.lastPreview || uiMode !== "editor" || !editing) return;
        session.lastPreview = selected;
        try { onPreview?.(selected); } catch (error) { warn("预览颜色失败", error); }
      },
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
        onInput: fieldset => {
          const output = fieldset?.querySelector?.('[name="output"]');
          session.preview(output?.value);
        },
        onExit: ({ colors }, save) => {
          const selected = normalizePickerColor(colors?.[0], initialColor);
          if (save) session.preview(selected);
          session.finish();
          // 原版关闭回调不会保证清理 #color-picker，主动卸载并清除残留节点。
          unloadOwnedColorPicker(session.root || document.getElementById("color-picker"));
          if (uiMode !== "editor" || !editing) return;
          try {
            if (save) onAccept?.(selected);
            else onCancel?.(initialColor);
          } catch (error) {
            warn(save ? "应用颜色失败" : "恢复颜色失败", error);
            toast("颜色没有更新成功", "error");
          }
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

  function ensureTransformTarget() {
    if (!editing) { transformEditTarget = null; return null; }
    if (transformEditTarget?.kind === "layer" && editing.layers.includes(transformEditTarget.layer)) return transformEditTarget;
    if (transformEditTarget?.kind === "material") {
      const material = editing.materials.find(item => item === transformEditTarget.material || item.id === transformEditTarget.materialId);
      if (material) {
        transformEditTarget.material = material;
        transformEditTarget.materialId = material.id;
        return transformEditTarget;
      }
    }
    const material = editing.materials[0];
    transformEditTarget = material ? { kind: "material", materialId: material.id, material } : null;
    return transformEditTarget;
  }

  function transformTargetLabel() {
    const target = ensureTransformTarget();
    if (!target) return "请选择素材或图层";
    if (target.kind === "material") return `${target.material.label || target.material.sourceAsset} · 素材整体`;
    const material = editing?.materials?.find(item => item.id === target.layer.materialId);
    const materialLabel = material?.label || target.layer.sourceAsset || "素材";
    return `${materialLabel} · ${target.layer.layerLabel || target.layer.sourceLayer || "图层"}`;
  }

  function refreshTransformSelectionStyles(root = document.getElementById(ROOT_ID)) {
    root?.querySelectorAll(".coe-material-editor").forEach(group => {
      const selected = transformEditTarget?.kind === "material" && group.__coeMaterial === transformEditTarget.material;
      const containsSelected = transformEditTarget?.kind === "layer" && group.__coeMaterial?.id === transformEditTarget.layer?.materialId;
      group.classList.toggle("coe-selected", selected);
      group.classList.toggle("coe-contains-selected", containsSelected);
    });
    root?.querySelectorAll(".coe-layer").forEach(card => card.classList.toggle("coe-selected", transformEditTarget?.kind === "layer" && card.__coeLayer === transformEditTarget.layer));
  }

  function setTransformTarget(target) {
    if (target?.kind === "material") {
      const material = target.material || editing?.materials?.find(item => item.id === target.materialId);
      transformEditTarget = material ? { kind: "material", materialId: material.id, material } : null;
    } else if (target?.kind === "layer" && editing?.layers?.includes(target.layer)) {
      transformEditTarget = { kind: "layer", layer: target.layer };
    } else transformEditTarget = null;
    ensureTransformTarget();
    const content = document.querySelector(`#${ROOT_ID} .coe-tool-content`);
    if (content) renderTransformEditor(content);
    refreshTransformSelectionStyles();
  }

  function setOptionalTransformValue(object, key, value, defaultValue) {
    if (!Number.isFinite(value) || Math.abs(value - defaultValue) < (key === "scale" || key === "overallScale" ? 0.001 : 0.000001)) delete object[key];
    else object[key] = value;
  }

  function toggleMirrorTransform(object, key) {
    if (!object) return false;
    if (object[key] === true) delete object[key];
    else object[key] = true;
    return object[key] === true;
  }

  function applyOverallTransformField(materialId, field, rawValue) {
    const material = editing?.materials?.find(item => item.id === materialId);
    if (!material || !Number.isFinite(rawValue)) return false;
    let value = rawValue;
    if (field === "rotation") {
      value = clamp(value, -180, 180) * Math.PI / 180;
      setOptionalTransformValue(material, "overallRotation", value, 0);
    } else if (field === "scale") {
      value = clamp(value, 0.25, 3);
      setOptionalTransformValue(material, "overallScale", value, 1);
    } else if (field === "offsetX" || field === "offsetY") {
      value = clamp(value, -1200, 1200);
      setOptionalTransformValue(material, `overall${field[0].toUpperCase()}${field.slice(1)}`, value, 0);
    } else return false;
    return true;
  }

  function resetMaterialOverallTransform(material) {
    if (!material) return;
    for (const key of ["overallRotation", "overallScale", "overallOffsetX", "overallOffsetY", "overallMirrorX", "overallMirrorY"]) delete material[key];
    transformEditTarget = { kind: "material", materialId: material.id, material };
    refreshPreviewLoop();
  }

  function resetLayerToDefaults(layer, material, asset, sourceLayer) {
    if (!layer) return;
    layer.priority = layer.defaultPriority;
    layer.offsetX = layer.defaultOffsetX;
    layer.offsetY = layer.defaultOffsetY;
    layer.opacity = layer.defaultOpacity;
    layer.hidden = false;
    layer.color = null;
    layer.rotation = layer.defaultRotation;
    layer.scale = layer.defaultScale;
    delete layer.mirrorX;
    delete layer.mirrorY;
    if (sourceLayer?.AllowColorize && Number.isInteger(sourceLayer.ColorIndex)) {
      material.colors[sourceLayer.ColorIndex] = material.defaultColors?.[sourceLayer.ColorIndex] || asset?.DefaultColor?.[sourceLayer.ColorIndex] || "Default";
    }
  }

  function resetMaterialToDefaults(material) {
    if (!material) return;
    const asset = materialAsset(material);
    material.colors = sanitizeColorArray(material.defaultColors?.length ? material.defaultColors : asset?.DefaultColor);
    editing.layers.filter(layer => layer.materialId === material.id).forEach(layer => resetLayerToDefaults(layer, material, asset, resolveSourceLayer(asset, layer)));
    material.hidden = false;
    resetMaterialOverallTransform(material);
    refreshPreviewLoop("structure");
  }

  function redrawLayerEditor() {
    const content = document.querySelector(`#${ROOT_ID} .coe-tool-content`);
    const list = content?.querySelector(".coe-layer-list");
    if (!content || !list) return;
    ensureTransformTarget();
    renderLayerList(list);
    renderTransformEditor(content);
    refreshTransformSelectionStyles(content);
  }

  function renderTransformEditor(content) {
    const host = content.querySelector("[data-transform-editor]");
    if (!host) return;
    const target = ensureTransformTarget();
    const typeLabel = target?.kind === "material" ? "素材整体" : target?.kind === "layer" ? "单图层" : "未选择";
    host.innerHTML = `<div class="coe-transform-head"><div><strong>变换编辑</strong><span class="coe-muted">${escapeHTML(transformTargetLabel())}</span></div><span class="coe-badge">${typeLabel}</span></div><p class="coe-hint">点击素材标题编辑素材整体，点击图层编辑该图层。旋转与缩放围绕共用中心生效。</p>`;
    if (!target) return;

    if (target.kind === "material") {
      const material = target.material;
      const asset = materialAsset(material);
      const colors = ensureMaterialColors(material, asset);
      const defaultHex = displayHexColor(asset?.DefaultColor?.[0], "#ffffff");
      const uniform = colors.every(color => color === colors[0]);
      const overallLabel = uniform ? colors[0] : "多种颜色";
      const overallColor = displayHexColor(uniform ? colors[0] : colors.find(color => /^#[0-9a-f]{6}$/i.test(color)), defaultHex);
      const overall = resolveOverallTransform(editing, globalThis.Player, material);
      host.insertAdjacentHTML("beforeend", `<div class="coe-transform-fields"><label>整体颜色<button type="button" class="coe-color-choice" data-overall-color title="统一修改所有可着色颜色槽"><span class="coe-color-swatch"></span><code>${escapeHTML(overallLabel)}</code></button></label><label>偏移 X<input type="number" step="1" min="-1200" max="1200" data-overall-field="offsetX" value="${overall.offsetX}"></label><label>偏移 Y<input type="number" step="1" min="-1200" max="1200" data-overall-field="offsetY" value="${overall.offsetY}"></label><label>旋转<input type="number" step="1" min="-180" max="180" data-overall-field="rotation" value="${Math.round(overall.rotation * 180 / Math.PI * 100) / 100}"></label><label>缩放<input type="number" step="0.05" min="0.25" max="3" data-overall-field="scale" value="${overall.scale}"></label></div><div class="coe-actions coe-transform-actions"><button type="button" class="coe-btn ${material.overallMirrorX === true ? "coe-primary" : ""}" aria-pressed="${material.overallMirrorX === true}" data-overall-mirror="overallMirrorX">水平镜像</button><button type="button" class="coe-btn ${material.overallMirrorY === true ? "coe-primary" : ""}" aria-pressed="${material.overallMirrorY === true}" data-overall-mirror="overallMirrorY">垂直镜像</button><button type="button" class="coe-btn" data-reset-overall>重置整体变换</button><button type="button" class="coe-btn" data-reset-material>整件恢复默认</button></div>`);
      const colorButton = host.querySelector("[data-overall-color]");
      updateColorChoice(colorButton, overallColor, defaultHex, overallLabel);
      colorButton?.addEventListener("click", () => {
        const originalColors = [...material.colors];
        const originalLayerColors = editing.layers.filter(layer => layer.materialId === material.id).map(layer => [layer, layer.color]);
        const applyColor = value => {
          const count = Math.max(1, Number(asset?.ColorableLayerCount) || material.colors.length);
          material.colors = Array(count).fill(value);
          originalLayerColors.forEach(([layer]) => { layer.color = null; });
          updateColorChoice(colorButton, value, defaultHex, value);
          refreshPreviewLoop();
        };
        chooseColor({
          heading: `${material.label || asset?.Description || material.sourceAsset} · 整体颜色`,
          currentColor: overallColor,
          defaultColor: "Default",
          onPreview: applyColor,
          onAccept: value => { applyColor(value); renderTransformEditor(content); },
          onCancel: () => {
            material.colors = originalColors;
            originalLayerColors.forEach(([layer, color]) => { layer.color = color; });
            refreshPreviewLoop();
            renderTransformEditor(content);
          },
        });
      });
      host.querySelectorAll("[data-overall-field]").forEach(input => input.addEventListener("input", () => {
        if (applyOverallTransformField(material.id, input.dataset.overallField, Number(input.value))) refreshPreviewLoop();
      }));
      host.querySelectorAll("[data-overall-mirror]").forEach(button => button.addEventListener("click", () => {
        const active = toggleMirrorTransform(material, button.dataset.overallMirror);
        button.classList.toggle("coe-primary", active);
        button.setAttribute("aria-pressed", String(active));
        refreshPreviewLoop();
      }));
      host.querySelector("[data-reset-overall]")?.addEventListener("click", () => {
        resetMaterialOverallTransform(material);
        renderTransformEditor(content);
      });
      host.querySelector("[data-reset-material]")?.addEventListener("click", () => {
        resetMaterialToDefaults(material);
        redrawLayerEditor();
      });
      return;
    }

    const layer = target.layer;
    const material = editing.materials.find(item => item.id === layer.materialId);
    const asset = materialAsset(material);
    const sourceLayer = resolveSourceLayer(asset, layer);
    const colorIndex = sourceLayer?.ColorIndex ?? 0;
    const canColor = !!sourceLayer?.AllowColorize;
    const colorValue = displayHexColor(material?.colors?.[colorIndex], displayHexColor(asset?.DefaultColor?.[colorIndex], "#ffffff"));
    host.insertAdjacentHTML("beforeend", `<div class="coe-transform-fields"><label>层级<input type="number" min="-99" max="99" step="1" data-layer-field="priority" value="${layer.priority}"></label><label>偏移 X<input type="number" min="-1200" max="1200" step="1" data-layer-field="offsetX" value="${layer.offsetX}"></label><label>偏移 Y<input type="number" min="-1200" max="1200" step="1" data-layer-field="offsetY" value="${layer.offsetY}"></label><label>透明度<input type="number" min="0" max="1" step="0.05" data-layer-field="opacity" value="${layer.opacity}"></label><label>颜色<button type="button" class="coe-color-choice" data-layer-color ${canColor ? "" : "disabled"} title="${canColor ? `编辑颜色槽 ${colorIndex}` : "原版将此图层标记为不可着色"}"><span class="coe-color-swatch"></span><code>${escapeHTML(material?.colors?.[colorIndex] || "Default")}</code></button></label><label>旋转<input type="number" step="1" min="-180" max="180" data-layer-field="rotation" value="${Math.round((layer.rotation || 0) * 180 / Math.PI * 100) / 100}"></label><label>缩放<input type="number" step="0.05" min="0.25" max="3" data-layer-field="scale" value="${layer.scale || 1}"></label></div><div class="coe-actions coe-transform-actions"><button type="button" class="coe-btn ${layer.mirrorX === true ? "coe-primary" : ""}" aria-pressed="${layer.mirrorX === true}" data-layer-mirror="mirrorX">水平镜像</button><button type="button" class="coe-btn ${layer.mirrorY === true ? "coe-primary" : ""}" aria-pressed="${layer.mirrorY === true}" data-layer-mirror="mirrorY">垂直镜像</button><button type="button" class="coe-btn" data-reset-layer>恢复本层默认</button></div>`);
    const colorButton = host.querySelector("[data-layer-color]");
    updateColorChoice(colorButton, material?.colors?.[colorIndex] || "Default", colorValue);
    host.querySelectorAll("[data-layer-field]").forEach(input => input.addEventListener("input", () => {
      const key = input.dataset.layerField;
      let value = Number(input.value);
      if (!Number.isFinite(value)) return;
      if (key === "priority") value = clamp(value, -99, 99);
      else if (key === "opacity") value = clamp(value, 0, 1);
      else if (key === "offsetX" || key === "offsetY") value = clamp(value, -1200, 1200);
      else if (key === "rotation") { value = clamp(value, -180, 180) * Math.PI / 180; setOptionalTransformValue(layer, "rotation", value, 0); refreshPreviewLoop(); return; }
      else if (key === "scale") { value = clamp(value, 0.25, 3); setOptionalTransformValue(layer, "scale", value, 1); refreshPreviewLoop(); return; }
      layer[key] = value;
      input.value = value;
      refreshPreviewLoop(key === "priority" ? "structure" : "visual");
    }));
    host.querySelectorAll("[data-layer-mirror]").forEach(button => button.addEventListener("click", () => {
      const active = toggleMirrorTransform(layer, button.dataset.layerMirror);
      button.classList.toggle("coe-primary", active);
      button.setAttribute("aria-pressed", String(active));
      refreshPreviewLoop();
    }));
    colorButton?.addEventListener("click", () => {
      if (!canColor || !material) return;
      const originalColor = material.colors[colorIndex];
      const originalLayerColor = layer.color;
      const applyColor = value => {
        material.colors[colorIndex] = value;
        layer.color = null;
        updateColorChoice(colorButton, value, colorValue, value);
        refreshPreviewLoop();
      };
      chooseColor({
        heading: `${material.label || asset?.Description || material.sourceAsset} · ${layer.layerLabel || getLayerLabelByRef(layer) || layer.sourceLayer || "图层"}`,
        currentColor: material.colors[colorIndex] || "Default",
        defaultColor: material.defaultColors?.[colorIndex] || asset?.DefaultColor?.[colorIndex] || "Default",
        onPreview: applyColor,
        onAccept: value => { applyColor(value); renderTransformEditor(content); },
        onCancel: () => {
          material.colors[colorIndex] = originalColor;
          layer.color = originalLayerColor;
          refreshPreviewLoop();
          renderTransformEditor(content);
        },
      });
    });
    host.querySelector("[data-reset-layer]")?.addEventListener("click", () => {
      resetLayerToDefaults(layer, material, asset, sourceLayer);
      refreshPreviewLoop("structure");
      redrawLayerEditor();
    });
  }

  function renderLayerList(list) {
    list.innerHTML = "";
    // Editor state is normalized at open/import/save boundaries. Preserve object
    // identities during UI redraws so selection and live preview keep stable refs.
    ensureTransformTarget();
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
          transformEditTarget = { kind: "material", materialId: material.id, material };
          refreshPreviewLoop("structure");
          redrawLayerEditor();
        });
        const host = group.querySelector(".coe-material-editor-layers");
        layers.sort((a, b) => (a.sourceLayerIndex ?? 0) - (b.sourceLayerIndex ?? 0)).forEach(layer => {
          const row = document.createElement("div");
          row.className = "coe-recycle-row";
          row.innerHTML = `<span>${escapeHTML(layer.layerLabel || getLayerLabelByRef(layer) || layer.sourceLayer || "默认图层")}</span><button class="coe-btn" data-restore>还原</button>`;
          row.querySelector("[data-restore]").addEventListener("click", () => {
            editing.recycle = editing.recycle.filter(item => item !== layer);
            editing.layers.push(layer);
            transformEditTarget = { kind: "layer", layer };
            refreshPreviewLoop("structure");
            redrawLayerEditor();
          });
          host.appendChild(row);
        });
        list.appendChild(group);
      }
    }
  }

  function renderMaterialGroup(material, layers, list) {
    const asset = materialAsset(material);
    ensureMaterialColors(material, asset);
    const group = document.createElement("section");
    group.__coeMaterial = material;
    const materialSelected = transformEditTarget?.kind === "material" && transformEditTarget.material === material;
    const containsSelected = transformEditTarget?.kind === "layer" && transformEditTarget.layer?.materialId === material.id;
    group.className = `coe-material-editor${material.hidden ? " coe-hidden" : ""}${material.collapsed ? " coe-collapsed" : ""}${materialSelected ? " coe-selected" : ""}${containsSelected ? " coe-contains-selected" : ""}`;
    group.innerHTML = `<div class="coe-material-editor-head"><button class="coe-collapse" type="button" data-collapse>${material.collapsed ? "▶" : "▼"}</button><button type="button" class="coe-material-identity" data-select-material><strong>${escapeHTML(material.label || asset?.Description || material.sourceAsset)}</strong><span class="coe-muted">${escapeHTML(material.sourceGroup)} · ${layers.length} 层</span></button><button class="coe-btn" data-hide-material>${material.hidden ? "显示" : "隐藏"}</button><button class="coe-btn coe-danger" data-remove-material>移除素材</button></div><div class="coe-material-editor-layers"></div>`;
    group.querySelector("[data-select-material]").addEventListener("click", () => setTransformTarget({ kind: "material", material }));
    group.querySelector("[data-collapse]").addEventListener("click", () => {
      material.collapsed = !material.collapsed;
      renderLayerList(list);
    });
    group.querySelector("[data-hide-material]").addEventListener("click", () => {
      material.hidden = !material.hidden;
      refreshPreviewLoop("structure");
      redrawLayerEditor();
    });
    group.querySelector("[data-remove-material]").addEventListener("click", () => {
      const materialId = material.id;
      // 移除代表撤销当前方案对整件素材的选择：启用图层、已清除图层和素材记录都要一起移除。
      // 原始 BC Asset 不受影响，之后仍可从素材选择器重新添加。
      editing.layers = editing.layers.filter(layer => layer.materialId !== materialId);
      editing.recycle = editing.recycle.filter(layer => layer.materialId !== materialId);
      editing.materials = editing.materials.filter(item => item.id !== materialId);
      if (transformEditTarget?.materialId === materialId || transformEditTarget?.layer?.materialId === materialId) transformEditTarget = null;
      refreshPreviewLoop("structure");
      redrawLayerEditor();
    });
    if (!material.collapsed) renderMaterialLayerCards(group.querySelector(".coe-material-editor-layers"), material, layers, asset);
    return group;
  }

  function nextCopyLayerLabel(layer, composition = editing) {
    const current = layer?.layerLabel || getLayerLabelByRef(layer) || layer?.sourceLayer || "默认图层";
    const base = current.replace(/(?:_copy)+$/i, "").replace(/_副本\d+$/, "");
    const labels = new Set([...(composition?.layers || []), ...(composition?.recycle || [])]
      .filter(item => !layer?.materialId || item.materialId === layer.materialId)
      .map(item => item.layerLabel || getLayerLabelByRef(item) || item.sourceLayer || "默认图层"));
    let suffix = 1;
    while (labels.has(`${base}_副本${suffix}`)) suffix++;
    return `${base}_副本${suffix}`;
  }

  function renderMaterialLayerCards(host, material, layers, asset) {
    layers.forEach(layer => {
      const sourceLayer = resolveSourceLayer(asset, layer);
      const layerName = layer.layerLabel || getLayerLabelByRef(layer) || layer.sourceLayer || `默认图层 #${layer.sourceLayerIndex ?? 0}`;
      const card = document.createElement("article");
      card.__coeLayer = layer;
      card.className = `coe-layer${layer.hidden ? " coe-hidden" : ""}${transformEditTarget?.kind === "layer" && transformEditTarget.layer === layer ? " coe-selected" : ""}`;
      card.innerHTML = `<div class="coe-layer-top"><button type="button" class="coe-layer-name" data-select-layer title="${escapeHTML(`${layer.sourceGroup}/${layer.sourceAsset}/${layerName}`)}">${escapeHTML(layerName)}</button>${sourceLayer?.ColorGroup ? `<span class="coe-badge">颜色组：${escapeHTML(sourceLayer.ColorGroup)}</span>` : ""}${layer.hidden ? '<span class="coe-badge">已隐藏</span>' : ""}<button type="button" class="coe-btn" data-hide>${layer.hidden ? "显示" : "隐藏"}</button><button type="button" class="coe-btn" data-copy>复制</button><button type="button" class="coe-btn coe-danger" data-remove>清除</button></div>`;
      card.querySelector("[data-select-layer]").addEventListener("click", () => setTransformTarget({ kind: "layer", layer }));
      card.addEventListener("click", event => {
        if (!event.target.closest("button")) setTransformTarget({ kind: "layer", layer });
      });
      card.querySelector("[data-hide]").addEventListener("click", () => {
        layer.hidden = !layer.hidden;
        transformEditTarget = { kind: "layer", layer };
        refreshPreviewLoop("structure");
        redrawLayerEditor();
      });
      card.querySelector("[data-copy]").addEventListener("click", () => {
        var copy = Object.assign({}, layer);
        copy.layerLabel = nextCopyLayerLabel(layer);
        var idx = editing.layers.indexOf(layer);
        editing.layers.splice(idx + 1, 0, copy);
        transformEditTarget = { kind: "layer", layer: copy };
        refreshPreviewLoop("structure");
        redrawLayerEditor();
      });
      card.querySelector("[data-remove]").addEventListener("click", () => {
        const index = editing.layers.indexOf(layer);
        const siblingLayers = editing.layers.filter(item => item.materialId === layer.materialId && item !== layer);
        editing.layers = editing.layers.filter(item => item !== layer);
        editing.recycle.push(layer);
        if (transformEditTarget?.layer === layer) {
          const nextLayer = siblingLayers.find(item => editing.layers.indexOf(item) >= index) || siblingLayers[siblingLayers.length - 1];
          const parent = editing.materials.find(item => item.id === layer.materialId);
          transformEditTarget = nextLayer ? { kind: "layer", layer: nextLayer } : parent ? { kind: "material", materialId: parent.id, material: parent } : null;
        }
        refreshPreviewLoop("structure");
        redrawLayerEditor();
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
    const searching = typeof query === "string" && query.trim().length > 0;
    for (const [groupName, groupAssets] of groups) {
      const section = document.createElement("section");
      const collapsed = !searching && !expandedMaterialGroups.has(groupName);
      section.className = `coe-material-section${collapsed ? " coe-collapsed" : ""}`;
      section.innerHTML = `<h3 class="coe-material-group-title"><button type="button" class="coe-material-group-toggle" aria-expanded="${!collapsed}"><span>${collapsed ? "▶" : "▼"}</span><strong>${escapeHTML(groupName)}</strong><small>${groupAssets.length}</small></button></h3>`;
      section.querySelector(".coe-material-group-toggle").addEventListener("click", () => {
        if (searching) return;
        if (expandedMaterialGroups.has(groupName)) expandedMaterialGroups.delete(groupName);
        else expandedMaterialGroups.add(groupName);
        renderMaterials(list, query);
      });
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
        colors: Array.isArray(sourceColor) ? sourceColor : (asset.DefaultColor?.map(() => sourceColor) ?? []),
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
    transformEditTarget = { kind: "material", materialId: material.id, material };
    refreshPreviewLoop("structure");
    toast(added ? `已添加「${material.label || asset.Name}」的 ${added} 个图层` : "这些图层已经在方案中", added ? "info" : "warn");
  }

  function saveEditing() {
    if (!ensureWardrobeWritable()) return;
    const previousWardrobe = cloneJSON(wardrobe);
    const previousEditing = cloneJSON(editing);
    const previousEditingId = editingId;
    try {
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
      if (!activateScheme(entry, true)) throw new Error("tag-equip-failed");
      persistWardrobe();
    } catch (error) {
      wardrobe = previousWardrobe;
      editing = previousEditing;
      editingId = previousEditingId;
      toast(`保存失败: ${error?.message || error}`, "error");
      return;
    }
    restoreEditorAppearance();
    syncEquippedSchemes();
    toast(`已保存并穿上「${editing.name}」`);
    openWardrobe();
  }

  function openEditor(composition, id) {
    // rootShell() closes the current wardrobe UI and clears editor state, so prepare
    // the new state first and assign it only after the new shell has been created.
    const nextEditing = normalizeComposition(cloneJSON(composition), { validateReferences: false });
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

  function localizedPoseLabel(pose) {
    const labels = {
      BaseUpper: "自然上身", BackBoxTie: "背后箱式缚", BackCuffs: "背后并手", BackElbowTouch: "背后合肘",
      OverTheHead: "双手过头", Yoked: "双手平举", TapedHands: "双手并拢",
      BaseLower: "自然站立", Kneel: "跪姿", KneelingSpread: "跪姿张腿", LegsClosed: "双腿并拢",
      LegsOpen: "双腿分开", Spread: "双腿张开", Hogtied: "四肢反绑", AllFours: "四肢着地", Suspension: "悬吊",
    };
    if (labels[pose?.Name]) return labels[pose.Name];
    if (typeof pose?.Description === "string" && /[\u3400-\u9fff]/.test(pose.Description)) return pose.Description;
    return pose?.Description || pose?.Name || "姿势";
  }

  function renderPoseControls(host) {
    host.innerHTML = "";
    const poseTable = typeof PoseFemale3DCG !== "undefined" ? PoseFemale3DCG : globalThis.PoseFemale3DCG;
    const poses = Array.isArray(poseTable)
      ? poseTable.filter(pose => pose.AllowMenu || pose.AllowMenuTransient)
      : [];
    const categories = ["BodyFull", "BodyLower", "BodyUpper", "BodyHands", "BodyAddon"];
    const labels = { BodyFull: "整体", BodyLower: "腿部", BodyUpper: "上身", BodyHands: "手部", BodyAddon: "附加" };
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
        button.textContent = localizedPoseLabel(pose);
        button.title = `${localizedPoseLabel(pose)} (${pose.Name})`;
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



  const REMOTE_PROTOCOL = "COE_RVP/1";
  const REMOTE_PREFIX = `${REMOTE_PROTOCOL}|`;
  const REMOTE_ENCODING = "gz";
  const REMOTE_LIMITS = Object.freeze({
    content: 1800, inlineData: 1300, chunkData: 1400, chunks: 24,
    snapshotBytes: 32768, compressedBytes: 24576,
    materialBytes: 8192, materials: 32, layers: 120, string: 64, color: 40,
  });
  const REMOTE_TYPES = new Set(["D", "A", "W", "X", "N", "R"]);
  const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

  function remotePlainObject(value) {
    if (!value || Object.prototype.toString.call(value) !== "[object Object]") return false;
    const proto = Object.getPrototypeOf(value);
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
    const allowed = new Set(["Type", "Mirror", "Invert", "TypeRecord"]);
    const output = {};
    for (const key of Object.keys(value)) if (!allowed.has(key) || POLLUTION_KEYS.has(key)) throw new Error("snapshot-property-key");
    if (value.Type != null) output.Type = remoteString(value.Type, "property-type", 40);
    if (value.Mirror != null) {
      if (typeof value.Mirror !== "boolean") throw new Error("snapshot-property-mirror");
      output.Mirror = value.Mirror;
    }
    if (value.Invert != null) {
      if (typeof value.Invert !== "boolean") throw new Error("snapshot-property-invert");
      output.Invert = value.Invert;
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
      for (const key of Object.keys(material)) if (!new Set(["g", "a", "c", "p", "w", "r", "s", "x", "y", "h", "v"]).has(key)) throw new Error("snapshot-material-key");
      const output = { g: remoteString(material.g, "group"), a: remoteString(material.a, "asset") };
      if (material.w != null) output.w = remoteString(material.w, "wear-group");
      if (!Array.isArray(material.c) || material.c.length > 40) throw new Error("snapshot-colors");
      output.c = material.c.map(color => remoteString(color, "color", REMOTE_LIMITS.color));
      for (const [key, min, max] of [["r", -Math.PI, Math.PI], ["s", 0.25, 3.0], ["x", -1200, 1200], ["y", -1200, 1200]]) {
        if (material[key] == null) continue;
        if (typeof material[key] !== "number" || !Number.isFinite(material[key])) throw new Error(`snapshot-material-${key}`);
        output[key] = normalizeRemoteNumber(material[key], min, max);
      }
      for (const key of ["h", "v"]) {
        if (material[key] == null) continue;
        if (typeof material[key] !== "boolean") throw new Error(`snapshot-material-${key}`);
        if (material[key]) output[key] = true;
      }
      const property = validateRemoteProperty(material.p);
      if (property) output.p = property;
      return output;
    });
    const layers = value.l.map(layer => {
      if (!remotePlainObject(layer)) throw new Error("snapshot-layer");
      for (const key of Object.keys(layer)) if (!new Set(["m", "n", "i", "p", "x", "y", "o", "r", "s", "h", "v"]).has(key)) throw new Error("snapshot-layer-key");
      const output = {
        m: remoteInteger(layer.m, "material-index", 0, Math.max(0, materials.length - 1)),
        n: layer.n == null ? null : remoteString(layer.n, "layer-name"),
        i: remoteInteger(layer.i, "layer-index", 0, 999),
        p: normalizeRemoteNumber(layer.p, -99, 99),
        x: normalizeRemoteNumber(layer.x, -1200, 1200),
        y: normalizeRemoteNumber(layer.y, -1200, 1200),
        o: normalizeRemoteNumber(layer.o, 0, 1),
      };
      if (layer.r != null) {
        if (typeof layer.r !== "number" || !Number.isFinite(layer.r)) throw new Error("snapshot-layer-rotation");
        output.r = normalizeRemoteNumber(layer.r, -Math.PI, Math.PI);
      }
      if (layer.s != null) {
        if (typeof layer.s !== "number" || !Number.isFinite(layer.s)) throw new Error("snapshot-layer-scale");
        output.s = normalizeRemoteNumber(layer.s, 0.25, 3.0);
      }
      for (const key of ["h", "v"]) {
        if (layer[key] == null) continue;
        if (typeof layer[key] !== "boolean") throw new Error(`snapshot-layer-${key}`);
        if (layer[key]) output[key] = true;
      }
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

  function canonicalRemoteSnapshot(value) { return JSON.stringify(validateRemoteSnapshot(value)); }

  async function sha256Base64Url(text) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error("crypto-subtle-unavailable");
    const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(text)));
    return bytesToBase64Url(digest);
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlToBytes(value, maxBytes = REMOTE_LIMITS.compressedBytes) {
    remoteString(value, "base64url", Math.ceil(maxBytes * 4 / 3) + 4, /^[A-Za-z0-9_-]+$/);
    if (Math.floor(value.length * 3 / 4) > maxBytes) throw new Error("remote-decoded-budget");
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
    let binary;
    try { binary = atob(padded); } catch (_) { throw new Error("remote-base64url"); }
    if (binary.length > maxBytes) throw new Error("remote-decoded-budget");
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  async function remoteTransformBytes(bytes, format, outputLimit) {
    const Constructor = format === "compress" ? globalThis.CompressionStream : globalThis.DecompressionStream;
    if (typeof Constructor !== "function") throw new Error(`remote-${format}-unavailable`);
    const stream = new Constructor("gzip");
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const parts = [];
    let total = 0;
    const reading = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > outputLimit) throw new Error(`remote-${format}-budget`);
        parts.push(value);
      }
      const output = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
      return output;
    })();
    let failure = null;
    try {
      await writer.write(bytes);
      await writer.close();
    } catch (error) {
      failure = error;
      try { await writer.abort(error); } catch (_) { /* closed */ }
    }
    let output = null;
    try { output = await reading; }
    catch (error) { failure ||= error; }
    if (failure) {
      try { await writer.abort(failure); } catch (_) { /* closed */ }
      try { await reader.cancel(failure); } catch (_) { /* closed */ }
      const wrapped = new Error(`remote-${format}-data`);
      wrapped.cause = failure;
      throw wrapped;
    }
    return output;
  }

  async function encodeRemoteText(text) {
    if (typeof text !== "string" || utf8Bytes(text) > REMOTE_LIMITS.snapshotBytes) throw new Error("remote-encode-budget");
    const compressed = await remoteTransformBytes(new TextEncoder().encode(text), "compress", REMOTE_LIMITS.compressedBytes);
    return { encoded: bytesToBase64Url(compressed), compressedBytes: compressed.byteLength };
  }

  async function decodeRemoteText(value, expectedBytes = null) {
    const compressed = base64UrlToBytes(value);
    if (expectedBytes != null && compressed.byteLength !== expectedBytes) throw new Error("remote-compressed-size");
    const output = await remoteTransformBytes(compressed, "decompress", REMOTE_LIMITS.snapshotBytes);
    return new TextDecoder("utf-8", { fatal: true }).decode(output);
  }

  function splitRemoteData(value) {
    remoteString(value, "chunk-source", Math.ceil(REMOTE_LIMITS.compressedBytes * 4 / 3) + 4, /^[A-Za-z0-9_-]+$/);
    const chunks = [];
    for (let index = 0; index < value.length; index += REMOTE_LIMITS.chunkData) chunks.push(value.slice(index, index + REMOTE_LIMITS.chunkData));
    if (!chunks.length || chunks.length > REMOTE_LIMITS.chunks) throw new Error("remote-chunk-count");
    return chunks;
  }

  function remoteSession(value) { return remoteString(value, "session", 32, /^[A-Za-z0-9_-]+$/); }
  function remoteHash(value) { return remoteString(value, "hash", 64, /^[A-Za-z0-9_-]+$/); }

  function validateRemoteEnvelope(value) {
    remoteAssertTree(value);
    if (!remotePlainObject(value) || !REMOTE_TYPES.has(value.t)) throw new Error("remote-envelope");
    const allowedByType = {
      D: new Set(["t", "s", "rx", "e"]), A: new Set(["t", "s", "r", "h", "u", "z", "n", "d"]),
      W: new Set(["t", "o", "s", "r", "h"]), X: new Set(["t", "s", "r", "h", "i", "n", "d"]),
      N: new Set(["t", "o", "s", "r", "h", "m"]), R: new Set(["t", "s", "r"]),
    };
    for (const key of Object.keys(value)) if (!allowedByType[value.t].has(key)) throw new Error("remote-envelope-key");
    if (value.t === "D") {
      if (typeof value.rx !== "boolean" || value.e !== REMOTE_ENCODING) throw new Error("remote-discover");
      return { t: "D", s: remoteSession(value.s), rx: value.rx, e: REMOTE_ENCODING };
    }
    if (value.t === "A") {
      const result = { t: "A", s: remoteSession(value.s), r: remoteInteger(value.r, "revision"), h: remoteHash(value.h), u: remoteInteger(value.u, "uncompressed-size", 1, REMOTE_LIMITS.snapshotBytes), z: remoteInteger(value.z, "compressed-size", 1, REMOTE_LIMITS.compressedBytes), n: remoteInteger(value.n, "chunk-count", 1, REMOTE_LIMITS.chunks) };
      if (value.d != null) {
        result.d = remoteString(value.d, "inline-data", REMOTE_LIMITS.inlineData, /^[A-Za-z0-9_-]+$/);
        if (result.n !== 1) throw new Error("remote-inline-count");
      }
      return result;
    }
    if (value.t === "W") return { t: "W", o: remoteInteger(value.o, "owner", 1), s: remoteSession(value.s), r: remoteInteger(value.r, "revision"), h: remoteHash(value.h) };
    if (value.t === "R") return { t: "R", s: remoteSession(value.s), r: remoteInteger(value.r, "revision") };
    if (value.t === "N") {
      if (!Array.isArray(value.m) || !value.m.length || value.m.length > REMOTE_LIMITS.chunks) throw new Error("remote-missing");
      const missing = [...new Set(value.m.map(index => remoteInteger(index, "missing-index", 0, REMOTE_LIMITS.chunks - 1)))].sort((a, b) => a - b);
      return { t: "N", o: remoteInteger(value.o, "owner", 1), s: remoteSession(value.s), r: remoteInteger(value.r, "revision"), h: remoteHash(value.h), m: missing };
    }
    const data = { t: "X", s: remoteSession(value.s), r: remoteInteger(value.r, "revision"), h: remoteHash(value.h), i: remoteInteger(value.i, "chunk-index", 0, REMOTE_LIMITS.chunks - 1), n: remoteInteger(value.n, "chunk-count", 1, REMOTE_LIMITS.chunks), d: remoteString(value.d, "chunk-data", REMOTE_LIMITS.chunkData, /^[A-Za-z0-9_-]+$/) };
    if (data.i >= data.n) throw new Error("remote-chunk-index");
    return data;
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
    return { messagesSent: 0, messagesReceived: 0, messagesRejected: 0, rateLimited: 0, chunksExpired: 0, bytesSent: 0, bytesReceived: 0, remoteMaterialsSkipped: 0, publicationsAccepted: 0, cacheHits: 0, wantsSuppressed: 0, repairsSent: 0 };
  }

  function createRemoteStore() {
    const publications = new Map();
    return {
      roomGeneration: 0,
      peers: publications,
      publications,
      discoveries: new Map(),
      assemblies: new Map(),
      objectCache: new Map(),
      activeSnapshots: new Map(),
      wantedObjects: new Set(),
      announcedWants: new Set(),
      wantRetryScheduled: new Set(),
      dataMessageCounts: new Map(),
      senderBuckets: new Map(), roomBucket: null,
      timers: new Set(), diagnostics: [], stats: createRemoteStats(), totalBytes: 0,
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
    const roomOk = remoteBucketConsume(remoteStore, null, 40, 8, now);
    if (!senderOk || !roomOk) remoteStore.stats.rateLimited++;
    return senderOk && roomOk;
  }

  function remotePeerKey(memberNumber) { return Number(memberNumber); }
  function remoteObjectKey(memberNumber, hash) { return `${remotePeerKey(memberNumber)}:${hash}`; }
  function getRemotePublication(memberNumber) { return remoteStore.publications.get(remotePeerKey(memberNumber)) || null; }

  function setRemoteDiscovery(memberNumber, discovery) {
    const key = remotePeerKey(memberNumber);
    if (!remoteStore.discoveries.has(key) && remoteStore.discoveries.size >= 20) throw new Error("remote-peer-limit");
    const value = { memberNumber: key, session: discovery.session, receiving: discovery.receiving === true, encoding: discovery.encoding, seenAt: remoteNow() };
    remoteStore.discoveries.set(key, value);
    return value;
  }

  function setRemotePublication(memberNumber, state) {
    const key = remotePeerKey(memberNumber);
    if (!remoteStore.publications.has(key) && remoteStore.publications.size >= 20) throw new Error("remote-peer-limit");
    const previous = remoteStore.publications.get(key);
    if (previous?.session === state.session) {
      if (state.revision < previous.revision) throw new Error("remote-stale-revision");
      if (state.revision === previous.revision && state.hash !== previous.hash) throw new Error("remote-revision-hash-conflict");
      if (state.revision === previous.revision && (state.uncompressedBytes !== previous.uncompressedBytes || state.compressedBytes !== previous.compressedBytes || state.count !== previous.count)) throw new Error("remote-revision-metadata-conflict");
    }
    const publication = {
      memberNumber: key, session: state.session, revision: state.revision, hash: state.hash,
      uncompressedBytes: state.uncompressedBytes, compressedBytes: state.compressedBytes,
      count: state.count, seenAt: remoteNow(),
    };
    remoteStore.publications.set(key, publication);
    const changedSession = !previous || previous.session !== publication.session;
    const changedObject = changedSession || previous.revision !== publication.revision || previous.hash !== publication.hash;
    if (changedObject) {
      const active = remoteStore.activeSnapshots.get(key);
      if (active && active.hash !== publication.hash) remoteStore.activeSnapshots.delete(key);
      for (const assemblyKey of [...remoteStore.assemblies.keys()]) if (assemblyKey.startsWith(`${key}:`)) remoteStore.assemblies.delete(assemblyKey);
      for (const wanted of [...remoteStore.wantedObjects]) if (wanted.startsWith(`${key}:`)) remoteStore.wantedObjects.delete(wanted);
    }
    return { publication, changedSession, changedObject };
  }

  function publicationMatchesEnvelope(memberNumber, envelope) {
    const publication = getRemotePublication(memberNumber);
    return !!publication && publication.session === envelope.s && publication.revision === envelope.r && publication.hash === envelope.h && publication.count === envelope.n;
  }

  function markRemoteObjectWanted(memberNumber, hash) {
    const key = remoteObjectKey(memberNumber, hash);
    remoteStore.wantedObjects.add(key);
    return key;
  }

  function noteRemoteWantAnnouncement(memberNumber, hash) {
    const key = remoteObjectKey(memberNumber, hash);
    const existed = remoteStore.announcedWants.has(key);
    remoteStore.announcedWants.add(key);
    if (existed) remoteStore.stats.wantsSuppressed++;
    return !existed;
  }

  function hasRemoteObject(hash) { return remoteStore.objectCache.has(hash); }

  function addRemoteDataChunk(memberNumber, envelope, now = remoteNow()) {
    const member = remotePeerKey(memberNumber);
    if (!publicationMatchesEnvelope(member, envelope)) throw new Error("remote-unsolicited-data");
    const publication = getRemotePublication(member);
    const key = remoteObjectKey(member, envelope.h);
    let assembly = remoteStore.assemblies.get(key);
    if (!assembly) {
      if (remoteStore.assemblies.size >= 8) throw new Error("remote-assembly-room-limit");
      assembly = {
        memberNumber: member, session: envelope.s, revision: envelope.r, hash: envelope.h,
        count: envelope.n, compressedBytes: publication.compressedBytes,
        parts: new Map(), encodedChars: 0, startedAt: now, lastProgressAt: now,
        generation: remoteStore.roomGeneration, repairAttempts: 0,
      };
      remoteStore.assemblies.set(key, assembly);
    }
    if (assembly.session !== envelope.s || assembly.revision !== envelope.r || assembly.count !== envelope.n) {
      remoteStore.assemblies.delete(key);
      throw new Error("remote-assembly-conflict");
    }
    const existing = assembly.parts.get(envelope.i);
    if (existing != null) {
      if (existing === envelope.d) return { status: "duplicate", charged: 0, assembly };
      remoteStore.assemblies.delete(key);
      throw new Error("remote-chunk-conflict");
    }
    assembly.parts.set(envelope.i, envelope.d);
    assembly.encodedChars += envelope.d.length;
    assembly.lastProgressAt = now;
    if (assembly.encodedChars > Math.ceil(REMOTE_LIMITS.compressedBytes * 4 / 3) + 4) {
      remoteStore.assemblies.delete(key);
      throw new Error("remote-assembly-budget");
    }
    if (assembly.parts.size !== assembly.count) return { status: "partial", charged: envelope.d.length, assembly };
    const encoded = Array.from({ length: assembly.count }, (_, index) => assembly.parts.get(index)).join("");
    remoteStore.assemblies.delete(key);
    return { status: "complete", charged: envelope.d.length, encoded, assembly };
  }

  function missingRemoteDataIndexes(memberNumber, hash) {
    const assembly = remoteStore.assemblies.get(remoteObjectKey(memberNumber, hash));
    if (!assembly) return [];
    return Array.from({ length: assembly.count }, (_, index) => index).filter(index => !assembly.parts.has(index));
  }

  function expireRemoteAssemblies(now = remoteNow()) {
    let expired = 0;
    for (const [key, assembly] of remoteStore.assemblies) {
      if (now - assembly.lastProgressAt > 30000) {
        remoteStore.assemblies.delete(key);
        expired++;
      }
    }
    remoteStore.stats.chunksExpired += expired;
    return expired;
  }

  function cacheRemoteObject(hash, snapshot, canonical) {
    const bytes = utf8Bytes(canonical);
    const previous = remoteStore.objectCache.get(hash);
    const nextTotal = remoteStore.totalBytes - (previous?.bytes || 0) + bytes;
    if (nextTotal > 262144) throw new Error("remote-room-byte-budget");
    const object = { hash, snapshot, canonical, bytes, acceptedAt: remoteNow() };
    remoteStore.objectCache.set(hash, object);
    remoteStore.totalBytes = nextTotal;
    return object;
  }

  function activateRemoteObject(memberNumber, publication, object) {
    const key = remotePeerKey(memberNumber);
    remoteStore.activeSnapshots.set(key, {
      identity: `${remoteStore.roomGeneration}:${key}:${publication.session}`,
      session: publication.session, revision: publication.revision, hash: publication.hash,
      snapshot: object.snapshot, canonical: object.canonical, bytes: object.bytes, acceptedAt: remoteNow(),
    });
    remoteStore.wantedObjects.delete(remoteObjectKey(key, publication.hash));
    remoteStore.stats.publicationsAccepted++;
    return object.snapshot;
  }

  function activateCachedRemoteObject(memberNumber, publication) {
    const object = remoteStore.objectCache.get(publication.hash);
    if (!object) return null;
    remoteStore.stats.cacheHits++;
    return activateRemoteObject(memberNumber, publication, object);
  }

  function acceptRemoteSnapshot(memberNumber, publication, snapshot, canonical) {
    const object = cacheRemoteObject(publication.hash, snapshot, canonical);
    return activateRemoteObject(memberNumber, publication, object);
  }

  function revokeRemotePublication(memberNumber, session, revision = null) {
    const key = remotePeerKey(memberNumber);
    const publication = getRemotePublication(key);
    if (publication && publication.session !== session) throw new Error("remote-revoke-session");
    if (publication && revision != null && revision < publication.revision) return false;
    remoteStore.publications.delete(key);
    remoteStore.activeSnapshots.delete(key);
    for (const assemblyKey of [...remoteStore.assemblies.keys()]) if (assemblyKey.startsWith(`${key}:`)) remoteStore.assemblies.delete(assemblyKey);
    for (const wanted of [...remoteStore.wantedObjects]) if (wanted.startsWith(`${key}:`)) remoteStore.wantedObjects.delete(wanted);
    syntheticByCharacter = new WeakMap();
    return true;
  }

  function clearRemoteMember(memberNumber) {
    const key = remotePeerKey(memberNumber);
    remoteStore.publications.delete(key);
    remoteStore.discoveries.delete(key);
    remoteStore.activeSnapshots.delete(key);
    remoteStore.senderBuckets.delete(key);
    for (const collection of [remoteStore.assemblies, remoteStore.dataMessageCounts]) {
      for (const objectKey of [...collection.keys()]) if (objectKey.startsWith(`${key}:`)) collection.delete(objectKey);
    }
    for (const collection of [remoteStore.wantedObjects, remoteStore.announcedWants, remoteStore.wantRetryScheduled]) {
      for (const objectKey of [...collection]) if (objectKey.startsWith(`${key}:`)) collection.delete(objectKey);
    }
    syntheticByCharacter = new WeakMap();
  }

  function remoteSnapshotForCharacter(character) {
    const memberNumber = Number(character?.MemberNumber);
    if (!Number.isInteger(memberNumber)) return null;
    return remoteStore.activeSnapshots.get(memberNumber)?.snapshot || null;
  }



  let remoteMessageHandlerDispose = null;
  let remoteMessageHandlerRetryTimer = 0;

  function remoteRoomMember(memberNumber) {
    return (globalThis.ChatRoomCharacter || []).find(character => Number(character?.MemberNumber) === Number(memberNumber)) || null;
  }

  function cancelRemoteTransport() {
    // RVP/1 hands complete publication batches directly to BC's native queue.
    // There is no plugin-owned timer queue to cancel; room generation invalidates
    // all asynchronous protocol work in the controller and store.
  }

  function enqueueRemoteEnvelope(envelope, target = null) {
    const content = serializeRemoteEnvelope(envelope);
    try {
      const packet = { Type: "Hidden", Content: content };
      if (Number.isInteger(target)) packet.Target = target;
      ServerSend("ChatRoomChat", packet);
      remoteStore.stats.messagesSent++;
      remoteStore.stats.bytesSent += utf8Bytes(content);
      return true;
    } catch (error) {
      remoteDiagnostic("send-failed", target, error?.message || error);
      return false;
    }
  }

  function enqueueRemoteDataBatch(baseEnvelope, chunks, target = null, indexes = null) {
    if (!Array.isArray(chunks) || !chunks.length) return 0;
    const selected = Array.isArray(indexes) ? [...new Set(indexes)] : chunks.map((_, index) => index);
    let sent = 0;
    for (const index of selected) {
      if (!Number.isInteger(index) || index < 0 || index >= chunks.length) continue;
      if (enqueueRemoteEnvelope({ ...baseEnvelope, t: "X", i: index, n: chunks.length, d: chunks[index] }, target)) sent++;
    }
    return sent;
  }

  function acceptPublishedRemoteData(senderNumber, envelope) {
    if (!publicationMatchesEnvelope(senderNumber, envelope)) return false;
    const key = remoteObjectKey(senderNumber, envelope.h);
    const count = remoteStore.dataMessageCounts.get(key) || 0;
    if (count >= envelope.n * 2 + 4) return false;
    remoteStore.dataMessageCounts.set(key, count + 1);
    return true;
  }

  function clearRemoteDataBudget(senderNumber, hash) {
    remoteStore.dataMessageCounts.delete(remoteObjectKey(senderNumber, hash));
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
      let envelope;
      try { envelope = parseRemoteContent(data.Content); }
      catch (error) {
        remoteStore.stats.messagesRejected++;
        remoteDiagnostic("invalid-envelope", senderNumber, error?.message || error);
        return true;
      }
      const accepted = envelope.t === "X"
        ? acceptPublishedRemoteData(senderNumber, envelope)
        : acceptRemoteInboundRate(senderNumber);
      if (!accepted) {
        remoteStore.stats.messagesRejected++;
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
    if (remoteMessageHandlerDispose) return true;
    if (typeof globalThis.ChatRoomRegisterMessageHandler !== "function") return false;
    remoteMessageHandlerDispose = ChatRoomRegisterMessageHandler({ Description: "COE room visual publication protocol", Priority: -50, Callback: onRemoteMessage }) || true;
    return true;
  }

  function ensureRemoteMessageHandler() {
    if (installRemoteMessageHandler()) {
      if (remoteMessageHandlerRetryTimer) clearInterval(remoteMessageHandlerRetryTimer);
      remoteMessageHandlerRetryTimer = 0;
      return true;
    }
    if (!remoteMessageHandlerRetryTimer) {
      remoteMessageHandlerRetryTimer = setInterval(() => {
        if (!installRemoteMessageHandler()) return;
        clearInterval(remoteMessageHandlerRetryTimer);
        remoteMessageHandlerRetryTimer = 0;
      }, 1000);
      remoteMessageHandlerRetryTimer?.unref?.();
    }
    return false;
  }



  const REMOTE_PREFS_PREFIX = "BC.CustomOutfitEditor.RemotePrefs.v1";
  const REMOTE_PUBLICATION_COHORT_MS = 2000;
  let remotePrefs = { sharingEnabled: false, receivingEnabled: false };
  let localPeerSessionId = "";
  let localRemoteRevision = 0;
  let localRemoteHash = "";
  let localRemoteCanonical = "";
  let localRemoteEncoded = "";
  let localRemoteCompressedBytes = 0;
  let localRemoteChunks = [];
  let localRemoteSnapshot = null;
  let localRemoteBuildToken = 0;
  let localRemoteStateTimer = 0;
  let localRemoteBuildInFlight = null;
  let localRemoteDirty = true;
  let localRemotePreviouslyShared = false;
  let remoteRoomSyncing = false;
  let localPublicationFlights = new Map();

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

  function clearActiveRemotePublications() {
    const members = [...remoteStore.activeSnapshots.keys()];
    remoteStore.activeSnapshots.clear();
    remoteStore.assemblies.clear();
    remoteStore.wantedObjects.clear();
    remoteStore.announcedWants.clear();
    remoteStore.wantRetryScheduled.clear();
    syntheticByCharacter = new WeakMap();
    for (const memberNumber of members) {
      const character = remoteRoomMember(memberNumber);
      if (character) CharacterRefresh(character, false, false);
    }
  }

  function setRemotePrefs(next) {
    const previous = remotePrefs;
    remotePrefs = { sharingEnabled: next.sharingEnabled === true, receivingEnabled: next.receivingEnabled === true };
    saveRemotePrefs();
    if (!remotePrefs.receivingEnabled && previous.receivingEnabled) clearActiveRemotePublications();
    if (remotePrefs.receivingEnabled && !previous.receivingEnabled) sendRemoteDiscover();
    if (!remotePrefs.sharingEnabled && previous.sharingEnabled) sendRemoteRevoke();
    scheduleLocalRemoteBuild(true);
    return { ...remotePrefs };
  }

  function buildLocalRemoteSnapshot() {
    if (!activeComposition) return { v: 1, m: [], l: [] };
    const composition = normalizeComposition(activeComposition);
    const visibleMaterials = [];
    const layers = [];
    for (const material of composition.materials) {
      if (material.hidden || (material.wearGroup && !isTagEquipped(globalThis.Player, material.wearGroup))) continue;
      const refs = composition.layers.filter(ref => ref.materialId === material.id && !ref.hidden);
      if (!refs.length) continue;
      const index = visibleMaterials.length;
      const compact = { g: material.sourceGroup, a: material.sourceAsset, c: sanitizeColorArray(material.colors) };
      if (material.wearGroup) compact.w = material.wearGroup;
      if (typeof material.overallRotation === "number") compact.r = material.overallRotation;
      if (typeof material.overallScale === "number") compact.s = material.overallScale;
      if (typeof material.overallOffsetX === "number") compact.x = material.overallOffsetX;
      if (typeof material.overallOffsetY === "number") compact.y = material.overallOffsetY;
      if (material.overallMirrorX === true) compact.h = true;
      if (material.overallMirrorY === true) compact.v = true;
      const property = sanitizeSourceProperty(material.sourceProperty);
      if (Object.keys(property).length) compact.p = property;
      visibleMaterials.push(compact);
      for (const ref of refs) {
        const layer = { m: index, n: ref.sourceLayer == null ? null : ref.sourceLayer, i: Number.isInteger(ref.sourceLayerIndex) ? ref.sourceLayerIndex : 0, p: ref.priority, x: ref.offsetX, y: ref.offsetY, o: ref.opacity };
        if (typeof ref.rotation === "number" && ref.rotation !== 0) layer.r = ref.rotation;
        if (typeof ref.scale === "number" && Math.abs(ref.scale - 1) > 0.001) layer.s = ref.scale;
        if (ref.mirrorX === true) layer.h = true;
        if (ref.mirrorY === true) layer.v = true;
        layers.push(layer);
      }
    }
    return validateRemoteSnapshot({ v: 1, m: visibleMaterials, l: layers });
  }

  function cancelLocalRemoteBuildTimer() {
    if (!localRemoteStateTimer) return;
    clearTimeout(localRemoteStateTimer);
    remoteStore.timers.delete(localRemoteStateTimer);
    localRemoteStateTimer = 0;
  }

  function recordLocalRemoteBuildFailure(error) {
    remoteDiagnostic("local-build-failed", null, error?.message || error);
    if (localRemotePreviouslyShared) sendRemoteRevoke();
  }

  function scheduleLocalRemoteBuild(forcePublication = false) {
    cancelLocalRemoteBuildTimer();
    localRemoteDirty = true;
    const generation = remoteStore.roomGeneration;
    const token = ++localRemoteBuildToken;
    localRemoteStateTimer = scheduleRemoteTimer(() => {
      localRemoteStateTimer = 0;
      const record = { generation, token, promise: null };
      record.promise = updateLocalRemoteSnapshot(generation, token, forcePublication).catch(error => {
        recordLocalRemoteBuildFailure(error);
        return false;
      }).finally(() => {
        if (localRemoteBuildInFlight === record) localRemoteBuildInFlight = null;
      });
      localRemoteBuildInFlight = record;
    }, 500);
  }

  function ensureFreshLocalRemoteSnapshot(generation) {
    if (generation !== remoteStore.roomGeneration) return Promise.resolve(false);
    if (!localRemoteDirty && localRemoteSnapshot !== null) return Promise.resolve(true);
    if (localRemoteBuildInFlight && localRemoteBuildInFlight.generation === generation && localRemoteBuildInFlight.token === localRemoteBuildToken) return localRemoteBuildInFlight.promise;
    const token = localRemoteStateTimer ? localRemoteBuildToken : ++localRemoteBuildToken;
    cancelLocalRemoteBuildTimer();
    const record = { generation, token, promise: null };
    record.promise = updateLocalRemoteSnapshot(generation, token, false, true).catch(error => {
      recordLocalRemoteBuildFailure(error);
      return false;
    }).finally(() => {
      if (localRemoteBuildInFlight === record) localRemoteBuildInFlight = null;
    });
    localRemoteBuildInFlight = record;
    return record.promise;
  }

  function currentRemoteAdvertiseEnvelope(includeInline = true) {
    if (!localRemoteHash || !localRemoteCanonical || !localRemoteChunks.length) return null;
    const envelope = {
      t: "A", s: localPeerSessionId, r: localRemoteRevision, h: localRemoteHash,
      u: utf8Bytes(localRemoteCanonical), z: localRemoteCompressedBytes, n: localRemoteChunks.length,
    };
    if (includeInline && localRemoteChunks.length === 1 && localRemoteEncoded.length <= REMOTE_LIMITS.inlineData) envelope.d = localRemoteEncoded;
    return envelope;
  }

  function sendRemoteDiscover() {
    if (!localPeerSessionId) return false;
    return enqueueRemoteEnvelope({ t: "D", s: localPeerSessionId, rx: remotePrefs.receivingEnabled, e: REMOTE_ENCODING });
  }

  function sendRemoteRevoke() {
    if (!localPeerSessionId) return false;
    localRemotePreviouslyShared = false;
    localPublicationFlights.clear();
    return enqueueRemoteEnvelope({ t: "R", s: localPeerSessionId, r: localRemoteRevision });
  }

  function sendLocalRemoteAdvertisement(target = null) {
    if (!remotePrefs.sharingEnabled) return false;
    const envelope = currentRemoteAdvertiseEnvelope(true);
    if (!envelope) return false;
    localRemotePreviouslyShared = true;
    return enqueueRemoteEnvelope(envelope, target);
  }

  function announceLocalRemotePublication(target = null, generation = remoteStore.roomGeneration) {
    if (generation !== remoteStore.roomGeneration) return Promise.resolve(false);
    if (!localRemoteDirty && localRemoteSnapshot !== null) return Promise.resolve(sendLocalRemoteAdvertisement(target));
    return ensureFreshLocalRemoteSnapshot(generation).then(updated => updated ? sendLocalRemoteAdvertisement(target) : false);
  }

  async function updateLocalRemoteSnapshot(generation = remoteStore.roomGeneration, token = ++localRemoteBuildToken, forcePublication = false, suppressPublication = false) {
    let snapshot;
    try { snapshot = buildLocalRemoteSnapshot(); }
    catch (error) {
      toast(`远端共享已暂停：${error.message}`, "warn");
      throw error;
    }
    const canonical = canonicalRemoteSnapshot(snapshot);
    let encoded = "";
    let compressedBytes = 0;
    let chunks = [];
    let hash = "";
    if (snapshot.l.length) {
      const compressed = await encodeRemoteText(canonical);
      encoded = compressed.encoded;
      compressedBytes = compressed.compressedBytes;
      chunks = splitRemoteData(encoded);
      hash = await sha256Base64Url(canonical);
    }
    if (generation !== remoteStore.roomGeneration || token !== localRemoteBuildToken) return false;
    const changed = hash !== localRemoteHash;
    if (changed) localRemoteRevision++;
    localRemoteSnapshot = snapshot;
    localRemoteCanonical = canonical;
    localRemoteEncoded = encoded;
    localRemoteCompressedBytes = compressedBytes;
    localRemoteChunks = chunks;
    localRemoteHash = hash;
    localRemoteDirty = false;
    if (changed) localPublicationFlights.clear();
    if (suppressPublication) return true;
    if (!snapshot.l.length) {
      if (localRemotePreviouslyShared) sendRemoteRevoke();
      return true;
    }
    if (remotePrefs.sharingEnabled && (changed || forcePublication)) sendLocalRemoteAdvertisement();
    return true;
  }

  function sendLocalRemoteData(target = null, indexes = null) {
    if (!remotePrefs.sharingEnabled || !localRemoteHash || !localRemoteChunks.length) return 0;
    return enqueueRemoteDataBatch({ s: localPeerSessionId, r: localRemoteRevision, h: localRemoteHash }, localRemoteChunks, target, indexes);
  }

  function respondToRemoteWant(requester, envelope) {
    if (envelope.o !== Number(globalThis.Player?.MemberNumber) || envelope.s !== localPeerSessionId || envelope.r !== localRemoteRevision || envelope.h !== localRemoteHash) return false;
    if (!remotePrefs.sharingEnabled || !localRemoteChunks.length) return false;
    const now = remoteNow();
    const previous = localPublicationFlights.get(envelope.h);
    if (!previous) {
      localPublicationFlights.set(envelope.h, { broadcastAt: now });
      sendLocalRemoteData();
      return true;
    }
    if (now - previous.broadcastAt <= REMOTE_PUBLICATION_COHORT_MS) return true;
    sendLocalRemoteData(Number(requester.MemberNumber));
    return true;
  }

  async function decodeAndAcceptRemotePublication(sender, publication, encoded, generation) {
    const canonical = await decodeRemoteText(encoded, publication.compressedBytes);
    if (generation !== remoteStore.roomGeneration) return false;
    if (utf8Bytes(canonical) !== publication.uncompressedBytes) throw new Error("remote-uncompressed-size");
    let parsed;
    try { parsed = JSON.parse(canonical); } catch (_) { throw new Error("snapshot-json"); }
    const snapshot = validateRemoteSnapshot(parsed);
    const normalizedCanonical = JSON.stringify(snapshot);
    if (normalizedCanonical !== canonical) throw new Error("snapshot-not-canonical");
    const hash = await sha256Base64Url(canonical);
    if (generation !== remoteStore.roomGeneration) return false;
    const current = getRemotePublication(sender.MemberNumber);
    if (!current || current.session !== publication.session || current.revision !== publication.revision || current.hash !== hash) throw new Error("snapshot-hash");
    acceptRemoteSnapshot(sender.MemberNumber, current, snapshot, canonical);
    clearRemoteDataBudget(sender.MemberNumber, hash);
    syntheticByCharacter = new WeakMap();
    CharacterRefresh(sender, false, false);
    return true;
  }

  function scheduleRemoteWantRetry(senderNumber, publication, generation) {
    const key = remoteObjectKey(senderNumber, publication.hash);
    if (remoteStore.wantRetryScheduled.has(key)) return;
    remoteStore.wantRetryScheduled.add(key);
    scheduleRemoteTimer(() => {
      remoteStore.wantRetryScheduled.delete(key);
      if (generation !== remoteStore.roomGeneration || !remotePrefs.receivingEnabled) return;
      const current = getRemotePublication(senderNumber);
      const active = remoteStore.activeSnapshots.get(senderNumber);
      if (!current || current.session !== publication.session || current.revision !== publication.revision || current.hash !== publication.hash) return;
      if (active?.hash === publication.hash || remoteStore.assemblies.has(key)) return;
      enqueueRemoteEnvelope({ t: "W", o: senderNumber, s: publication.session, r: publication.revision, h: publication.hash });
    }, 12000);
  }

  function scheduleRemoteAssemblyRepair(senderNumber, publication, generation) {
    const key = remoteObjectKey(senderNumber, publication.hash);
    const assembly = remoteStore.assemblies.get(key);
    if (!assembly || assembly.repairTimer) return;
    assembly.repairTimer = scheduleRemoteTimer(() => {
      if (generation !== remoteStore.roomGeneration) return;
      const current = remoteStore.assemblies.get(key);
      if (!current || current.repairAttempts >= 1) return;
      const missing = missingRemoteDataIndexes(senderNumber, publication.hash);
      if (!missing.length) return;
      current.repairAttempts++;
      enqueueRemoteEnvelope({ t: "N", o: senderNumber, s: publication.session, r: publication.revision, h: publication.hash, m: missing });
    }, 12000);
  }

  async function handleRemoteEnvelope(sender, envelope, generation) {
    if (generation !== remoteStore.roomGeneration) return;
    const memberNumber = Number(sender.MemberNumber);
    if (envelope.t === "D") {
      setRemoteDiscovery(memberNumber, { session: envelope.s, receiving: envelope.rx, encoding: envelope.e });
      if (envelope.rx) await announceLocalRemotePublication(memberNumber, generation);
      return;
    }
    if (envelope.t === "R") {
      if (revokeRemotePublication(memberNumber, envelope.s, envelope.r)) CharacterRefresh(sender, false, false);
      return;
    }
    if (envelope.t === "A") {
      const hadActive = remoteStore.activeSnapshots.has(memberNumber);
      const result = setRemotePublication(memberNumber, {
        session: envelope.s, revision: envelope.r, hash: envelope.h,
        uncompressedBytes: envelope.u, compressedBytes: envelope.z, count: envelope.n,
      });
      const publication = result.publication;
      if (!remotePrefs.receivingEnabled) return;
      if (activateCachedRemoteObject(memberNumber, publication)) {
        syntheticByCharacter = new WeakMap();
        CharacterRefresh(sender, false, false);
        return;
      }
      if (result.changedObject && hadActive) {
        syntheticByCharacter = new WeakMap();
        CharacterRefresh(sender, false, false);
      }
      markRemoteObjectWanted(memberNumber, publication.hash);
      if (envelope.d != null) {
        await decodeAndAcceptRemotePublication(sender, publication, envelope.d, generation);
        return;
      }
      if (noteRemoteWantAnnouncement(memberNumber, publication.hash)) {
        enqueueRemoteEnvelope({ t: "W", o: memberNumber, s: publication.session, r: publication.revision, h: publication.hash });
      }
      scheduleRemoteWantRetry(memberNumber, publication, generation);
      return;
    }
    if (envelope.t === "W") {
      if (envelope.o === Number(globalThis.Player?.MemberNumber)) {
        respondToRemoteWant(sender, envelope);
        return;
      }
      const publication = getRemotePublication(envelope.o);
      if (publication && publication.session === envelope.s && publication.revision === envelope.r && publication.hash === envelope.h) {
        markRemoteObjectWanted(envelope.o, envelope.h);
        noteRemoteWantAnnouncement(envelope.o, envelope.h);
        scheduleRemoteWantRetry(envelope.o, publication, generation);
      }
      return;
    }
    if (envelope.t === "N") {
      if (envelope.o !== Number(globalThis.Player?.MemberNumber) || envelope.s !== localPeerSessionId || envelope.r !== localRemoteRevision || envelope.h !== localRemoteHash) return;
      if (!remotePrefs.sharingEnabled) return;
      const sent = sendLocalRemoteData(null, envelope.m);
      if (sent) remoteStore.stats.repairsSent += sent;
      return;
    }
    const publication = getRemotePublication(memberNumber);
    if (!publication || !remotePrefs.receivingEnabled) return;
    const assembled = addRemoteDataChunk(memberNumber, envelope);
    if (assembled.status === "partial") {
      scheduleRemoteAssemblyRepair(memberNumber, publication, generation);
      return;
    }
    if (assembled.status !== "complete") return;
    await decodeAndAcceptRemotePublication(sender, publication, assembled.encoded, generation);
  }

  function installRemoteLifecycleHooks() {
    modApi.hookFunction("ChatRoomSync", 1000, (args, next) => {
      ensureRemoteMessageHandler();
      cancelRemoteTransport();
      resetRemoteRoom();
      localPublicationFlights = new Map();
      remoteRoomSyncing = true;
      const generation = remoteStore.roomGeneration;
      let result;
      try { result = next(args); }
      catch (error) { remoteRoomSyncing = false; throw error; }
      Promise.resolve(result).then(async () => {
        remoteRoomSyncing = false;
        if (generation !== remoteStore.roomGeneration) return;
        sendRemoteDiscover();
        await announceLocalRemotePublication(null, generation);
      }).catch(() => { remoteRoomSyncing = false; });
      return result;
    });
    modApi.hookFunction("ChatRoomSyncMemberJoin", 1000, (args, next) => next(args));
    modApi.hookFunction("ChatRoomSyncMemberLeave", 1000, (args, next) => {
      const memberNumber = Number(args[0]?.SourceMemberNumber ?? args[0]?.MemberNumber ?? args[0]);
      const result = next(args);
      if (Number.isInteger(memberNumber)) clearRemoteMember(memberNumber);
      return result;
    });
    modApi.hookFunction("ChatRoomLeave", 1000, (args, next) => { cancelRemoteTransport(); resetRemoteRoom(); localPublicationFlights = new Map(); return next(args); });
    modApi.hookFunction("ServerDisconnect", 1000, (args, next) => {
      captureSetReconnectIntent();
      invalidateSetPreviewCache();
      cancelRemoteTransport();
      resetRemoteRoom();
      localPublicationFlights = new Map();
      return next(args);
    });
    modApi.hookFunction("CharacterLoadOnline", 1000, (args, next) => {
      const result = next(args);
      invalidateSetPreviewCache();
      syntheticByCharacter = new WeakMap();
      if (result === globalThis.Player) scheduleSetReconnectRestore();
      return result;
    });
    modApi.hookFunction("CharacterRefresh", 1000, (args, next) => {
      const result = next(args);
      if (args[0] === globalThis.Player && activeComposition) scheduleLocalRemoteBuild();
      return result;
    });
  }

  function initializeRemoteController() {
    loadRemotePrefs();
    localPeerSessionId = remoteRandomId(12);
    localRemoteRevision = 0;
    localRemoteHash = "";
    localRemoteCanonical = "";
    localRemoteEncoded = "";
    localRemoteCompressedBytes = 0;
    localRemoteChunks = [];
    localRemoteSnapshot = null;
    localRemoteBuildInFlight = null;
    localRemoteDirty = true;
    remoteRoomSyncing = false;
    localPublicationFlights = new Map();
    const messageHandlerReady = ensureRemoteMessageHandler();
    scheduleLocalRemoteBuild(true);
    return messageHandlerReady;
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
    return cloneJSON({
      installed: runtimeInstalled,
      active: initialized && !duplicateInstance,
      duplicateInstance,
      version: VERSION,
      bcVersion: String(globalThis.GameVersion || globalThis.CurrentVersion || "R130"),
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
        syncMode: wardrobeReadState.sync?.mode || null,
        syncReason: wardrobeReadState.sync?.reason || null,
        requestBytes: wardrobeReadState.sync?.requestBytes ?? null,
        maxRequestBytes: MAX_SERVER_SYNC_MESSAGE_BYTES,
        persistenceBlocked,
        migrationStatus: wardrobeReadState.migration?.status || null,
        migrationFromVersion: wardrobeReadState.migration?.fromVersion ?? null,
        migrationToVersion: wardrobeReadState.migration?.toVersion ?? null,
        migrationBackupKey: wardrobeReadState.migration?.backupKey || null,
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
      exportWardrobeDocument: () => cloneJSON(createWardrobeExchangeDocument(wardrobe)),
      exportOutfit: schemeId => {
        const scheme = wardrobe.schemes.find(entry => entry.id === schemeId);
        if (!scheme) throw new Error("找不到要导出的服装方案");
        return createOutfitExchangeString(scheme.composition);
      },
      exportSet: setId => createSetExchangeString(setId, wardrobe),
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
    const message = `[${MOD_NAME}] 检测到另一份 Custom Outfit Editor。当前实例已停止安装，请只启用一个版本。`;
    console.error(message);
    try { if (!globalThis.__coeDuplicateWarningShown) { globalThis.__coeDuplicateWarningShown = true; alert(message); } } catch (_) { /* console warning remains */ }
    return true;
  }

  function initialize() {
    if (!globalThis.bcModSdk || typeof globalThis.AssetGet !== "function" || !globalThis.Player) return;
    if (!runtimeInstalled) {
      if (detectDuplicateInstance()) return;
      try {
        modApi = bcModSdk.registerMod({ name: MOD_NAME, fullName: "Custom Outfit Editor", version: VERSION }, { allowReplace: false });
        registerTagAssets();
        installTagAssetPreviewHook();
        installRenderHooks();
        installAppearanceWorkspaceHooks();
        installRemoteLifecycleHooks();
        injectStyle();
        runtimeInstalled = true;
      } catch (error) {
        duplicateInstance = /already|duplicate|registered|replace/i.test(String(error?.message || error));
        warn(duplicateInstance ? "检测到同名 Mod，Custom Outfit Editor 当前实例已停止安装" : "安全 Hook 安装失败，将继续等待游戏加载", error);
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
      try {
        if (!initializeRemoteController()) warn("Remote 消息处理器尚不可用，已在后台等待游戏接口就绪");
      } catch (error) {
        warn("Remote 初始化失败，本地衣柜仍将继续加载", error);
      }
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
      normalizeWardrobe, normalizeComposition, normalizeLayerTransform, compactWardrobeForStorage, compactCompositionForStorage, compactLayerForStorage,
      normalizeSet, compactSetForStorage, normalizeAppearanceBundle, sanitizeSetProperty, captureAppearanceForSet, captureCurrentSet, buildSetApplyPlan, validateSetReferences, findSetsReferencingScheme,
      migrateWardrobeData, readWardrobeSchemaVersion, packWardrobe, unpackWardrobeDetailed,
      createOutfitExchangeString, parseOutfitExchangeString, createSetExchangeString, parseSetExchangeString, buildSetImportPlan, commitSetImportPlan, createWardrobeExchangeDocument, parseWardrobeExchangeDocument, wardrobeExportFilename, localTimestamp, sanitizeFilenamePart,
      removeSchemeAndSetReferences, deleteSetTransaction, saveCurrentSetTransaction, saveCurrentSetToSlotTransaction, overwriteCurrentSetTransaction, setAtSlot, firstEmptySetSlot, applySetTransaction,
      setAppearanceFingerprint, isSetCurrentlyWorn, captureSetReconnectIntent, restoreSetReconnectIntent, scheduleSetReconnectRestore,
      serverSyncMessageBytes, storageFingerprint, loadWardrobe, persistWardrobe,
      computeDefaultOverallCenter, resolveOverallTransform, resolveRenderableOverallTransform, resolveNumericOrigin, transformPointAroundOverallPivot, transformPointAroundOverallPivotAxes,
      stableInsertSyntheticLayers, coeAssetLayerSort: stableInsertSyntheticLayers, analyzeSourceAsset, sanitizePlainRecord,
      scanAlphaBounds, contentBoundsFromBounds, contentPivotFromBounds, resolveTextureContentPivot, resolveTextureContentBounds, cacheOverallLayerGeometry, cachedOverallCenter, buildSyntheticItems, buildLocalSyntheticItems, buildRemoteSyntheticItems, makeSyntheticLayers, syncLocalSyntheticRuntime, requestCharacterRefresh, statusSnapshot,
      isDrawableLayer, normalizedMaterialColors, normalizePickerColor, nextCopyLayerLabel, localizedPoseLabel, clothingSlotGroups, registerTagAssets, isTagEquipped, equipTagForGroup, activateScheme, combineSchemes, combinedEquippedComposition, validateRemoteSnapshot, canonicalRemoteSnapshot, sha256Base64Url,
      parseRemoteContent, serializeRemoteEnvelope, encodeRemoteText, decodeRemoteText, splitRemoteData,
      createRemoteStore, setRemoteDiscovery, setRemotePublication, getRemotePublication, markRemoteObjectWanted, noteRemoteWantAnnouncement,
      addRemoteDataChunk, missingRemoteDataIndexes, expireRemoteAssemblies, cacheRemoteObject, activateRemoteObject, activateCachedRemoteObject,
      acceptRemoteSnapshot, revokeRemotePublication, clearRemoteMember, onRemoteMessage, handleRemoteEnvelope, buildLocalRemoteSnapshot, updateLocalRemoteSnapshot,
      enqueueRemoteEnvelope, enqueueRemoteDataBatch, cancelRemoteTransport, acceptPublishedRemoteData, clearRemoteDataBudget,
      installRemoteMessageHandler, ensureRemoteMessageHandler, initializeRemoteController, scheduleLocalRemoteBuild, announceLocalRemotePublication, sendRemoteDiscover,
      getRemoteStoreForTest: () => remoteStore,
      getLocalRemoteStateForTest: () => ({ session: localPeerSessionId, revision: localRemoteRevision, hash: localRemoteHash, canonical: localRemoteCanonical, encoded: localRemoteEncoded, compressedBytes: localRemoteCompressedBytes, chunks: localRemoteChunks.slice(), snapshot: localRemoteSnapshot, buildToken: localRemoteBuildToken, dirty: localRemoteDirty }),
      resetRemoteRoomForTest: resetRemoteRoom,
      setRemotePrefsForTest: value => { remotePrefs = { sharingEnabled: value?.sharingEnabled === true, receivingEnabled: value?.receivingEnabled === true }; },
      setLocalRemoteStateForTest: value => {
        localPeerSessionId = value.session;
        localRemoteRevision = value.revision;
        localRemoteHash = value.hash;
        localRemoteCanonical = value.canonical;
        localRemoteEncoded = value.encoded ?? "";
        localRemoteCompressedBytes = value.compressedBytes ?? 0;
        localRemoteChunks = value.chunks ?? (localRemoteEncoded ? splitRemoteData(localRemoteEncoded) : []);
        localRemoteSnapshot = value.snapshot;
        localRemoteBuildToken = value.buildToken ?? localRemoteBuildToken;
        localRemoteBuildInFlight = null;
        localRemoteDirty = value.dirty ?? false;
      },
      setActiveCompositionForTest: value => { activeComposition = value; },
      setPreviewCompositionForTest: (character, value) => { if (value) previewCompositionByCharacter.set(character, value); else previewCompositionByCharacter.delete(character); },
      trackPreviewTextureForTest: trackPreviewTextureLoad,
      previewTexturesPendingForTest: previewTexturesPending,
      clearPreviewTextureTrackingForTest: clearPreviewTextureTracking,
      setWardrobeForTest: value => { wardrobe = normalizeWardrobe(value, { validateReferences: false }); },
      getWardrobeForTest: () => cloneJSON(wardrobe),
      setEditingForTest: value => { editing = value; uiMode = value ? "editor" : null; },
      setUIModeForTest: value => { uiMode = value; },
      isAppearanceRootMode, isAppearanceWorkspaceActive, drawAppearanceWorkspaceCharacters,
      applyOverallTransformField, closeUI,
      installHooksForTest: api => { modApi = api; installRenderHooks(); },
      installWorkspaceHooksForTest: api => { modApi = api; installAppearanceWorkspaceHooks(); },
      installAllHooksForTest: api => { modApi = api; installRenderHooks(); installAppearanceWorkspaceHooks(); installRemoteLifecycleHooks(); },
    };
  } else {
    const initTimer = setInterval(() => {
      initialize();
      if (initialized || duplicateInstance) clearInterval(initTimer);
    }, 500);
    window.addEventListener("load", initialize);
  }
})();



