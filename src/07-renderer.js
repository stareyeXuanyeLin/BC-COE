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

    modApi.hookFunction("ServerAppearanceLoadFromBundle", 1000, (args, next) => {
      if (Array.isArray(args[2])) {
        const before = args[2].length;
        args[2] = args[2].filter(item => !(item?.Name === CONTAINER_ASSET && (item?.Group === CONTAINER_GROUP || item?.Group === LEGACY_CONTAINER_GROUP)));
        diagnostics.inboundLegacyFiltered += before - args[2].length;
      }
      return next(args);
    });

    modApi.hookFunction("ServerAppearanceBundle", 1000, (args, next) => {
      if (Array.isArray(args[0])) {
        const before = args[0].length;
        args[0] = args[0].filter(item => !item?.__coeMaterialId && !isLegacyContainerItem(item));
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
        let workingBase = baseLayers;
        if (uiMode === "editor") workingBase = baseLayers.filter(layer => !isEditorRemovableAsset(layer?.Asset));
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
  }
