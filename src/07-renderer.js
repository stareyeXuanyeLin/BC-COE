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
        const layerGroups = buildStaticSynthetic({ character, material, refs, asset: sourceAsset, analysis });
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
        // 先让 BC 原始函数完成纹理、遮罩、着色器和 uniform 设置，但禁止它输出颜色；
        // 随后在同一个 program 上只用变换后的矩阵绘制一次。
        var colorMaskSaved;
        try {
          colorMaskSaved = gl.getParameter(gl.COLOR_WRITEMASK);
          gl.colorMask(false, false, false, false);
          _gldrawOriginal.call(window, url, gl, dstX, dstY, options, offsetX);
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
          return _gldrawOriginal.call(window, url, gl, dstX, dstY, options, offsetX);
        }
        var texW = dim.w, texH = dim.h;
        var cx = texW / 2, cy = texH / 2;
        var sx = typeof scaleX === "number" ? scaleX : 1;
        var sy = typeof scaleY === "number" ? scaleY : 1;
        var off = typeof offsetX === "number" ? offsetX : 0;
        var mirror = opts.Mirror === true;
        var invert = opts.Invert === true;
        var drawX = dstX + off;
        var drawY = dstY;
        if (mirror) drawX = 500 - drawX;
        if (invert) drawY = gl.canvas.height - drawY + 550;
        var centerX = drawX + (mirror ? -cx : cx);
        var centerY = drawY + (invert ? -cy : cy);

        var program = gl.getParameter(gl.CURRENT_PROGRAM);
        if (!program) return _gldrawOriginal.call(window, url, gl, dstX, dstY, options, offsetX);

        // 获取 u_matrix 位置。BC 的 GLDraw 在 program 上缓存了此位置，
        // 但用 gl.getUniformLocation 更健壮，不依赖内部实现。
        var uMatrix = program.u_matrix || gl.getUniformLocation(program, "u_matrix");
        if (!uMatrix) return _gldrawOriginal.call(window, url, gl, dstX, dstY, options, offsetX);

        var matrix = m4.orthographic(0, gl.canvas.width, gl.canvas.height, 0, -1, 1);
        matrix = m4.translate(matrix, centerX, centerY, 0);
        if (rotation) {
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
      if (typeof layer.sx === "number" && Math.abs(layer.sx - 1) > 0.001) remoteRef.scaleX = layer.sx;
      if (typeof layer.sy === "number" && Math.abs(layer.sy - 1) > 0.001) remoteRef.scaleY = layer.sy;
      refsByMaterial.get(layer.m).push(remoteRef);
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
        const layerGroups = buildStaticSynthetic({ character, material, refs, asset: sourceAsset, analysis });
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
      const originalCallbacks = args[1];
      let currentDrawLayer = null;
      try {
        character.Appearance = groups.map(group => group.item).concat(originalAppearance || []);
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
        trackedLayers[Symbol.iterator] = function* () {
          try {
            for (let index = 0; index < this.length; index++) {
              currentDrawLayer = this[index];
              yield currentDrawLayer;
            }
          } finally {
            currentDrawLayer = null;
          }
        };
        character.AppearanceLayers = trackedLayers;
        if (originalCallbacks && typeof originalCallbacks === "object") {
          const callbacks = { ...originalCallbacks };
          const imageCallbacks = ["drawImage", "drawImageBlink", "drawImageColorize", "drawImageColorizeBlink"];
          for (const name of imageCallbacks) {
            const callback = originalCallbacks[name];
            if (typeof callback !== "function") continue;
            callbacks[name] = function (...callbackArgs) {
              const ref = currentDrawLayer?.__coeSyntheticLayer?.ref;
              if (!ref) return callback.apply(this, callbackArgs);
              const options = callbackArgs[3] || {};
              const transformed = { ...options };
              if (typeof ref.rotation === "number" && isFinite(ref.rotation) && ref.rotation !== 0)
                transformed.Rotation = clamp(ref.rotation, -Math.PI, Math.PI);
              if (typeof ref.scaleX === "number" && isFinite(ref.scaleX) && Math.abs(ref.scaleX - 1) > 0.001)
                transformed.ScaleX = clamp(ref.scaleX, 0.25, 3.0);
              if (typeof ref.scaleY === "number" && isFinite(ref.scaleY) && Math.abs(ref.scaleY - 1) > 0.001)
                transformed.ScaleY = clamp(ref.scaleY, 0.25, 3.0);
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
