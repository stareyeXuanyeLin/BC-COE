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
    if (!rawComposition || !isLocalPlayer(character)) return [];
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
    // observer before rejecting the initial 1x1 placeholder geometry.
    if (url) resolveTextureContentBounds(url);
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
    if (localRotation || Math.abs(localScale - 1) > 0.001) {
      const pivot = contentState?.pivot || { x: 0.5, y: 0.5 };
      const pivotX = drawX + pivot.x * signedW;
      const pivotY = drawY + pivot.y * signedH;
      const cos = Math.cos(localRotation);
      const sin = Math.sin(localRotation);
      for (const corner of corners) {
        const dx = corner.x - pivotX;
        const dy = corner.y - pivotY;
        corner.x = pivotX + localScale * (cos * dx - sin * dy);
        corner.y = pivotY + localScale * (sin * dx + cos * dy);
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
      (typeof options.OverallScale === "number" && Math.abs(options.OverallScale - 1) > 0.001);
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
    const needsCenter = rotation !== 0 || Math.abs(scale - 1) > 0.001;
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
    textureContentPivotCache.set(url, { status: "pending" });
    try {
      const ImageCtor = globalThis.Image;
      // GLDrawLoadImage 已经维护了一份同 URL 的图片缓存。优先复用它，
      // 避免另起一个 Image 导致第二份图片尚未加载，而 WebGL 原图其实已经可用。
      const cachedImage = typeof globalThis.GLDrawImageCache?.get === "function"
        ? globalThis.GLDrawImageCache.get(url) : null;
      if (!cachedImage && typeof ImageCtor !== "function") throw new Error("image-constructor-unavailable");
      const image = cachedImage || new ImageCtor();
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
      if (!cachedImage) image.src = url;
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
  function transformPointAroundOverallPivot(x, y, pivotX, pivotY, rotation, scale, offsetX = 0, offsetY = 0) {
    const dx = x - pivotX;
    const dy = y - pivotY;
    const cos = Math.cos(rotation || 0);
    const sin = Math.sin(rotation || 0);
    return {
      x: pivotX + offsetX + scale * (cos * dx - sin * dy),
      y: pivotY + offsetY + scale * (sin * dx + cos * dy),
    };
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
          // 素材服装组整体变换参数
          if (typeof p.OverallRotation === "number" && p.OverallRotation !== 0) base.OverallRotation = p.OverallRotation;
          if (typeof p.OverallScale === "number" && Math.abs(p.OverallScale - 1) > 0.001) base.OverallScale = p.OverallScale;
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
        // 无变换时直接走原始函数，保持零开销。
        if (!rotation && Math.abs(scale - 1) <= 0.001 && !overallRotation && Math.abs(overallScale - 1) <= 0.001 &&
          !overallOffsetX && !overallOffsetY) {
          const result = drawOriginal();
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
        var contentPivot = (rotation || Math.abs(scale - 1) > 0.001) ? resolveTextureContentPivot(url) : null;
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
        const transformedLocalCenter = transformPointAroundOverallPivot(
          localCenterScreenX,
          localCenterScreenY,
          overallCenterX,
          overallCenterY,
          overallRotation,
          groupScale,
          overallOffsetX,
          overallOffsetY,
        );
        var matrix = m4.orthographic(0, gl.canvas.width, gl.canvas.height, 0, -1, 1);
        // Vertices remain a unit square. Local and overall uniform transforms can
        // be combined into one rotation/scale around the transformed local pivot.
        matrix = m4.translate(matrix, transformedLocalCenter.x, transformedLocalCenter.y, 0);
        const combinedRotation = overallRotation + rotation;
        if (combinedRotation) {
          matrix = typeof m4.zRotate === "function"
            ? m4.zRotate(matrix, combinedRotation)
            : m4.multiply(matrix, m4.zRotation(combinedRotation));
        }
        matrix = m4.scale(matrix, groupScale * uniformScale, groupScale * uniformScale, 1);
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
        modApi.hookFunction("GLDrawImage", 10, transformHook);
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
      refsByMaterial.get(layer.m).push(remoteRef);
    }
    const groups = [];
    for (let materialOrder = 0; materialOrder < (snapshot.m || []).length; materialOrder++) {
      const compact = snapshot.m[materialOrder];
      const refs = refsByMaterial.get(materialOrder) || [];
      if (!refs.length || (compact.w && !isTagEquipped(character, compact.w))) continue;
      const material = { id: `remote:${memberNumber}:${materialOrder}`, sourceGroup: compact.g, sourceAsset: compact.a, colors: compact.c, sourceProperty: compact.p || {}, wearGroup: compact.w || null, overallRotation: compact.r, overallScale: compact.s, overallOffsetX: compact.x, overallOffsetY: compact.y, hidden: false };
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
              const overall = marker.overall;
              if (overall) {
                transformed.OverallRotation = clamp(overall.rotation, -Math.PI, Math.PI);
                transformed.OverallScale = clamp(overall.scale, 0.25, 3.0);
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
