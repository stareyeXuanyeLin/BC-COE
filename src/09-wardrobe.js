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
      card.innerHTML = `<div class="coe-card-title"><h3>${escapeHTML(scheme.composition.name)}</h3><span class="coe-equipped-badge">${isEquipped ? (tagWorn ? "已穿着" : "已启用") : "未启用"}</span></div><p class="coe-muted">部位 ${escapeHTML(slotLabel)} · 图层 ${stats.layers} · 素材 ${stats.assets} 件</p><div class="coe-actions"><button class="coe-btn ${isEquipped ? "coe-danger" : "coe-primary"}" data-toggle>${isEquipped ? "停用" : "启用"}</button><button class="coe-btn" data-edit>编辑</button><button class="coe-btn coe-danger" data-delete>删除</button></div>`;
      card.querySelector("[data-toggle]").addEventListener("click", () => {
        if (!ensureWardrobeWritable()) return;
        if (isEquipped) wardrobe.equippedIds = wardrobe.equippedIds.filter(id => id !== scheme.id);
        else if (!activateScheme(scheme, true)) return;
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
