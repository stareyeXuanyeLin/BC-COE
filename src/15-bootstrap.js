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
      normalizeWardrobe, normalizeComposition, normalizeLayerTransform, compactWardrobeForStorage, compactCompositionForStorage, compactLayerForStorage, packWardrobe, unpackWardrobeDetailed,
      getLayerPivot, computeDefaultOverallPivot, resolveOverallTransform, resolveNumericOrigin,
      canvasPointFromClient, computeAbsoluteLayerPivot, computeAbsoluteOverallPivot,
      getRenderedTransformGeometry, getRenderedTransformCanvas,
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
