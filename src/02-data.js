  const COMPOSITION_VERSION = 4;
  const WARDROBE_VERSION = 5;

  function materialKey(group, asset) {
    return `${group}\u0000${asset}`;
  }

  const PIVOT_LIMIT = 10;
  const OVERALL_PIVOT_LIMIT = 5000;

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
    // A missing pivot deliberately means "use the current texture default".
    // Keeping it undefined is what lets storage omit an untouched default center.
    const pivotX = optionalFiniteNumber(raw.pivotX, -PIVOT_LIMIT, PIVOT_LIMIT);
    const pivotY = optionalFiniteNumber(raw.pivotY, -PIVOT_LIMIT, PIVOT_LIMIT);
    return { rotation, scale, pivotX, pivotY };
  }

  function normalizeOverallTransform(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      overallRotation: typeof raw.overallRotation === "number" && isFinite(raw.overallRotation) && raw.overallRotation !== 0
        ? clamp(raw.overallRotation, -Math.PI, Math.PI) : undefined,
      overallScale: typeof raw.overallScale === "number" && isFinite(raw.overallScale) && Math.abs(raw.overallScale - 1) > 0.001
        ? clamp(raw.overallScale, 0.25, 3.0) : undefined,
      overallOffsetX: optionalFiniteNumber(raw.overallOffsetX, -1200, 1200),
      overallOffsetY: optionalFiniteNumber(raw.overallOffsetY, -1200, 1200),
      overallPivotX: optionalFiniteNumber(raw.overallPivotX, -OVERALL_PIVOT_LIMIT, OVERALL_PIVOT_LIMIT),
      overallPivotY: optionalFiniteNumber(raw.overallPivotY, -OVERALL_PIVOT_LIMIT, OVERALL_PIVOT_LIMIT),
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
      pivotX: transform.pivotX,
      pivotY: transform.pivotY,
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
    const overall = normalizeOverallTransform(raw);
    const output = {
      version: COMPOSITION_VERSION,
      name: String(raw?.name || "未命名方案").slice(0, 60),
      materials: materials.filter(material => used.has(material.id)),
      layers,
      recycle,
    };
    Object.assign(output, overall);
    return output;
  }

  function getLayerPivot(layer) {
    return {
      x: typeof layer?.pivotX === "number" && Number.isFinite(layer.pivotX) ? layer.pivotX : 0.5,
      y: typeof layer?.pivotY === "number" && Number.isFinite(layer.pivotY) ? layer.pivotY : 0.5,
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

  function computeDefaultOverallPivot(composition, character = globalThis.Player) {
    let largest = null;
    for (const layer of composition?.layers || []) {
      if (layer.hidden) continue;
      const asset = typeof globalThis.AssetGet === "function"
        ? AssetGet(character?.AssetFamily || globalThis.Player?.AssetFamily || "Female3DCG", layer.sourceGroup, layer.sourceAsset) : null;
      if (!asset) continue;
      const sourceLayer = typeof resolveSourceLayer === "function" ? resolveSourceLayer(asset, layer) : asset.Layer?.[layer.sourceLayerIndex] || asset.Layer?.[0];
      if (!isDrawableLayer(sourceLayer)) continue;
      // DrawingLeft/DrawingTop 按姿势存储为对象，必须先解析成当前角色姿势的数字。
      // 这里仍只是没有渲染几何记录时的 fallback；真实绘制后由 renderer 提供最终坐标。
      var baseLeft = resolveNumericOrigin(sourceLayer.DrawingLeft, character, 0);
      var baseTop = resolveNumericOrigin(sourceLayer.DrawingTop, character, 0);
      var left = baseLeft + (Number.isFinite(layer.offsetX) ? layer.offsetX : 0);
      var top = baseTop + (Number.isFinite(layer.offsetY) ? layer.offsetY : 0);
      var width = resolveNumericOrigin(sourceLayer.DrawingWidth ?? sourceLayer.Width ?? asset.Width, character, 100);
      var height = resolveNumericOrigin(sourceLayer.DrawingHeight ?? sourceLayer.Height ?? asset.Height, character, 100);
      var area = Math.max(1, width) * Math.max(1, height);
      if (!largest || area > largest.area) largest = { left: left, top: top, width: width, height: height, area: area };
    }
    // Overall pivots are expressed in composition/screen pixels. Use the
    // character canvas center as a stable empty-composition fallback rather
    // than the layer-local default (0.5, 0.5).
    if (!largest) return { x: 250, y: 275 };
    return { x: largest.left + largest.width / 2, y: largest.top + largest.height / 2 };
  }

  function resolveOverallTransform(composition, character = globalThis.Player) {
    const fallback = computeDefaultOverallPivot(composition, character);
    return {
      rotation: typeof composition?.overallRotation === "number" ? composition.overallRotation : 0,
      scale: typeof composition?.overallScale === "number" ? composition.overallScale : 1,
      offsetX: typeof composition?.overallOffsetX === "number" ? composition.overallOffsetX : 0,
      offsetY: typeof composition?.overallOffsetY === "number" ? composition.overallOffsetY : 0,
      pivotX: typeof composition?.overallPivotX === "number" ? composition.overallPivotX : fallback.x,
      pivotY: typeof composition?.overallPivotY === "number" ? composition.overallPivotY : fallback.y,
      customPivot: typeof composition?.overallPivotX === "number" || typeof composition?.overallPivotY === "number",
    };
  }

  function canvasPointFromClient(clientX, clientY, canvas) {
    const rect = typeof canvas?.getBoundingClientRect === "function" ? canvas.getBoundingClientRect() : null;
    const width = Number(canvas?.width) > 0 ? Number(canvas.width) : Number(rect?.width) || 1;
    const height = Number(canvas?.height) > 0 ? Number(canvas.height) : Number(rect?.height) || 1;
    const cssWidth = Number(rect?.width) > 0 ? Number(rect.width) : width;
    const cssHeight = Number(rect?.height) > 0 ? Number(rect.height) : height;
    return {
      x: (Number(clientX) - (Number(rect?.left) || 0)) * width / cssWidth,
      y: (Number(clientY) - (Number(rect?.top) || 0)) * height / cssHeight,
    };
  }

  function inverseTransformPoint(point, pivot, rotation = 0, scale = 1, offsetX = 0, offsetY = 0) {
    const safeScale = Number.isFinite(scale) && Math.abs(scale) > 0.000001 ? scale : 1;
    const angle = Number.isFinite(rotation) ? rotation : 0;
    let x = point.x - pivot.x - (Number.isFinite(offsetX) ? offsetX : 0);
    let y = point.y - pivot.y - (Number.isFinite(offsetY) ? offsetY : 0);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const rotatedX = x * cosine + y * sine;
    const rotatedY = -x * sine + y * cosine;
    return { x: rotatedX / safeScale + pivot.x, y: rotatedY / safeScale + pivot.y };
  }

  function computeAbsoluteOverallPivot(pointerCanvas, transform) {
    const point = pointerCanvas && Number.isFinite(pointerCanvas.x) && Number.isFinite(pointerCanvas.y)
      ? pointerCanvas : { x: 0, y: 0 };
    const current = transform || {};
    return {
      x: clamp(inverseTransformPoint(point, { x: Number(current.pivotX) || 0, y: Number(current.pivotY) || 0 }, current.rotation, current.scale, current.offsetX, current.offsetY).x, -OVERALL_PIVOT_LIMIT, OVERALL_PIVOT_LIMIT),
      y: clamp(inverseTransformPoint(point, { x: Number(current.pivotX) || 0, y: Number(current.pivotY) || 0 }, current.rotation, current.scale, current.offsetX, current.offsetY).y, -OVERALL_PIVOT_LIMIT, OVERALL_PIVOT_LIMIT),
    };
  }

  function computeAbsoluteLayerPivot(pointerCanvas, geometry, transform) {
    const point = pointerCanvas && Number.isFinite(pointerCanvas.x) && Number.isFinite(pointerCanvas.y)
      ? pointerCanvas : { x: 0, y: 0 };
    const record = geometry || {};
    const width = Number(record.textureWidth) > 0 ? Number(record.textureWidth) : 1;
    const height = Number(record.textureHeight) > 0 ? Number(record.textureHeight) : 1;
    const mirror = record.mirror === true;
    const invert = record.invert === true;
    const signedWidth = mirror ? -width : width;
    const signedHeight = invert ? -height : height;
    const drawX = Number.isFinite(record.drawX) ? record.drawX : 0;
    const drawY = Number.isFinite(record.drawY) ? record.drawY : 0;
    const localPivot = {
      x: Number.isFinite(transform?.pivotX) ? transform.pivotX : 0.5,
      y: Number.isFinite(transform?.pivotY) ? transform.pivotY : 0.5,
    };
    const localPivotScreen = { x: drawX + localPivot.x * signedWidth, y: drawY + localPivot.y * signedHeight };
    let base = point;
    if (transform?.overall) {
      const overall = transform.overall;
      base = inverseTransformPoint(base, { x: Number(overall.pivotX) || 0, y: Number(overall.pivotY) || 0 }, overall.rotation, overall.scale, overall.offsetX, overall.offsetY);
    }
    base = inverseTransformPoint(base, localPivotScreen, transform?.rotation, transform?.scale);
    return {
      x: clamp((base.x - drawX) / signedWidth, -PIVOT_LIMIT, PIVOT_LIMIT),
      y: clamp((base.y - drawY) / signedHeight, -PIVOT_LIMIT, PIVOT_LIMIT),
    };
  }

  function normalizeWardrobe(raw, options = {}) {
    const list = Array.isArray(raw?.schemes) ? raw.schemes : [];
    const schemes = list.slice(0, MAX_SCHEMES).map(entry => ({
      id: typeof entry?.id === "string" ? entry.id : uid(),
      composition: normalizeComposition(entry?.composition, options),
    }));
    const validIds = new Set(schemes.map(entry => entry.id));
    const equippedIds = Array.isArray(raw?.equippedIds)
      ? raw.equippedIds.filter(id => typeof id === "string" && validIds.has(id))
      : [];
    return {
      version: WARDROBE_VERSION,
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
    if (typeof layer.pivotX === "number") output.pivotX = layer.pivotX;
    if (typeof layer.pivotY === "number") output.pivotY = layer.pivotY;
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
      version: COMPOSITION_VERSION,
      name: normalized.name,
      materials: normalized.materials.map(compactMaterialForStorage),
      layers: normalized.layers.map(compactLayerForStorage),
    };
    for (const key of ["overallRotation", "overallScale", "overallOffsetX", "overallOffsetY", "overallPivotX", "overallPivotY"]) {
      if (typeof normalized[key] === "number") compact[key] = normalized[key];
    }
    if (normalized.recycle.length) compact.recycle = normalized.recycle.map(compactLayerForStorage);
    if (utf8Bytes(compact) > MAX_SCHEME_BYTES) throw new Error("scheme-byte-budget");
    return compact;
  }

  function compactWardrobeForStorage(data) {
    const normalized = normalizeWardrobe(data);
    const compact = {
      version: WARDROBE_VERSION,
      schemes: normalized.schemes.map(entry => ({ id: entry.id, composition: compactCompositionForStorage(entry.composition) })),
      equippedIds: normalized.equippedIds,
    };
    if (utf8Bytes(compact) > MAX_WARDROBE_BYTES) throw new Error("wardrobe-byte-budget");
    return compact;
  }
