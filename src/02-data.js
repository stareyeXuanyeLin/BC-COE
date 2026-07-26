  function materialKey(group, asset) {
    return `${group}\u0000${asset}`;
  }

  function normalizeLayerTransform(raw) {
    const rotation = typeof raw.rotation === "number" && isFinite(raw.rotation) && raw.rotation !== 0
      ? clamp(raw.rotation, -Math.PI, Math.PI)
      : undefined;
    const directScale = typeof raw.scale === "number" && isFinite(raw.scale) && Math.abs(raw.scale - 1) > 0.001
      ? raw.scale
      : undefined;
    // 兼容上一版的非等比字段，但统一压成一个等比缩放值，绝不再生成椭圆。
    const legacyScales = [raw.scaleX, raw.scaleY].filter(value => typeof value === "number" && isFinite(value) && value > 0);
    const legacyScale = legacyScales.length
      ? legacyScales.reduce((product, value) => product * clamp(value, 0.25, 3.0), 1) ** (1 / legacyScales.length)
      : undefined;
    const scale = directScale != null ? clamp(directScale, 0.25, 3.0)
      : legacyScale != null && Math.abs(legacyScale - 1) > 0.001 ? clamp(legacyScale, 0.25, 3.0)
        : undefined;
    return { rotation, scale };
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
