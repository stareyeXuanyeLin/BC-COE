  const COMPOSITION_VERSION = 6;
  const WARDROBE_SCHEMA_VERSION = 1;
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
    return {
      schemaVersion: WARDROBE_SCHEMA_VERSION,
      schemes,
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
    const compact = {
      schemaVersion: WARDROBE_SCHEMA_VERSION,
      schemes: normalized.schemes.map(entry => ({ id: entry.id, composition: compactCompositionForStorage(entry.composition, options) })),
      equippedIds: normalized.equippedIds,
    };
    if (utf8Bytes(compact) > MAX_WARDROBE_BYTES) throw new Error("wardrobe-byte-budget");
    return compact;
  }
