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
    return { backdrop, content, actions };
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
    if (missing && !confirm(`当前环境缺少 ${missing} 个图层引用。继续导入后，这些部分不会显示，是否继续？`)) return false;
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
        if (importSingleOutfitString(textarea.value, body)) modal.backdrop.remove();
      } catch (error) {
        toast(`导入失败: ${error?.message || error}`, "error");
      }
    });
    modal.content.append(hint, textarea);
    modal.actions.appendChild(submit);
    textarea.focus();
  }

  function downloadWardrobeFile() {
    if (persistenceBlocked && !confirm(`衣柜当前处于「${wardrobeReadState.status}」状态。将只导出当前界面选中的 ${wardrobeReadState.source || "内存"} 版本，不包含另一份冲突数据。是否继续？`)) return;
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
        if (!confirm(`文件来源：${source}\n文件包含：${parsed.wardrobe.schemes.length} 件自定义服装、${parsed.wardrobe.sets.length} 套套装\n当前衣柜：${wardrobe.schemes.length} 件自定义服装、${wardrobe.sets.length} 套套装\n\n导入会替换整个衣柜，并将所有自定义服装设为未启用。${missingWarning}${danglingWarning}${warning}\n建议先导出当前衣柜。是否继续？`)) return;
        const previous = wardrobe;
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
    const exchangeMenu = '<details class="coe-menu"><summary class="coe-btn">导入导出 ▾</summary><div class="coe-menu-panel"><button data-import-outfit>导入单件服装</button><button data-import-set>导入套装</button><button data-import-wardrobe>导入整个衣柜</button><button data-export-wardrobe>导出整个衣柜</button></div></details>';
    const primary = wardrobeView === "sets" ? "保存当前外观" : "＋ 新建自定义服装";
    const body = rootShell("COE 衣柜", `<button class="coe-btn coe-primary" data-action="new">${primary}</button>${exchangeMenu}<button class="coe-btn" data-action="unequip-all">全部卸下</button><button class="coe-btn" data-action="close">关闭</button>`);
    uiMode = "wardrobe";
    const root = document.getElementById(ROOT_ID);
    root.classList.add("coe-wardrobe-root");
    root.querySelector('[data-action="new"]').addEventListener("click", () => {
      if (wardrobeView === "outfits") return openEditor({ version: 2, name: "新方案", layers: [], recycle: [] }, null);
      if (!ensureWardrobeWritable()) return;
      const name = globalThis.prompt?.("套装名称", `新套装 ${wardrobe.sets.length + 1}`);
      if (name == null || !name.trim()) return;
      try {
        const result = saveCurrentSetTransaction(name.trim());
        renderWardrobe(body);
        toast(`已保存套装「${result.set.name}」`);
      } catch (error) { toast(`保存套装失败: ${error?.message || error}`, "error"); }
    });
    root.querySelector("[data-import-outfit]").addEventListener("click", () => showOutfitImport(body));
    root.querySelector("[data-import-set]").addEventListener("click", () => showSetImport(body));
    root.querySelector("[data-import-wardrobe]").addEventListener("click", () => importWardrobeFile(body));
    root.querySelector("[data-export-wardrobe]").addEventListener("click", downloadWardrobeFile);
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
    const tabs = document.createElement("nav");
    tabs.className = "coe-tool-tabs coe-wardrobe-tabs";
    tabs.innerHTML = `<button class="coe-btn ${wardrobeView === "outfits" ? "coe-primary" : ""}" data-view="outfits">自定义服装</button><button class="coe-btn ${wardrobeView === "sets" ? "coe-primary" : ""}" data-view="sets">套装衣柜</button>`;
    const content = document.createElement("div");
    content.className = "coe-wardrobe-content";
    tabs.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
      wardrobeView = button.dataset.view === "sets" ? "sets" : "outfits";
      const primary = document.querySelector(`#${ROOT_ID} [data-action="new"]`);
      if (primary) primary.textContent = wardrobeView === "sets" ? "保存当前外观" : "＋ 新建自定义服装";
      renderWardrobe(body);
    }));
    body.append(tabs, content);
    if (wardrobeView === "sets") return renderSetWardrobe(content);
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
        const message = references.length
          ? `自定义服装「${scheme.composition.name}」正在被 ${references.length} 套套装使用。\n\n继续删除后，这件自定义服装也会从这些套装中移除；套装中的其他服装和外貌不会改变。\n\n是否继续？`
          : `删除自定义服装「${scheme.composition.name}」？此操作无法撤销。`;
        if (!confirm(message)) return;
        try {
          removeSchemeAndSetReferences(scheme.id);
          renderWardrobe(body);
        } catch (error) { toast(`删除失败: ${error?.message || error}`, "error"); }
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
