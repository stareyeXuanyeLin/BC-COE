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
        sets: wardrobe.sets.map(set => ({
          ...set,
          customOutfits: set.customOutfits.filter(entry => entry.schemeId !== schemeId),
        })),
        equippedIds: wardrobe.equippedIds.filter(id => id !== schemeId),
      }, { validateReferences: false });
      compactWardrobeForStorage(candidate, { validateReferences: false });
      wardrobe = candidate;
      if (wasEquipped && removedScheme && globalThis.Player) {
        const slotGroup = schemeSlotGroup(removedScheme);
        Player.Appearance = Player.Appearance.filter(item => !(item?.Asset?.Name === TAG_ASSET_NAME && item?.Asset?.Group?.Name === slotGroup));
      }
      (options.persist || persistWardrobe)();
      if (options.sync !== false) {
        syncEquippedSchemes();
        syncFormalAppearance();
      }
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
    try {
      const candidate = normalizeWardrobe({ ...wardrobe, sets: wardrobe.sets.filter(set => set.id !== setId) }, { validateReferences: false });
      if (candidate.sets.length === wardrobe.sets.length) return false;
      wardrobe = candidate;
      (options.persist || persistWardrobe)();
      return true;
    } catch (error) {
      wardrobe = previous;
      throw error;
    }
  }

  function saveCurrentSetTransaction(name, options = {}) {
    if (wardrobe.sets.length >= MAX_SETS) throw new Error(`套装衣柜最多保存 ${MAX_SETS} 套`);
    const captured = captureCurrentSet(uniqueSetName(name), options.character || globalThis.Player, wardrobe);
    if (captured.anomalies.some(entry => entry.type === "orphan-tag")) throw new Error("当前外观存在没有对应自定义服装的 COE 标签，请先重新启用该服装");
    const previous = cloneJSON(wardrobe);
    try {
      const candidate = normalizeWardrobe({ ...wardrobe, sets: [captured.set, ...wardrobe.sets] }, { validateReferences: false });
      compactWardrobeForStorage(candidate, { validateReferences: false });
      wardrobe = candidate;
      (options.persist || persistWardrobe)();
      return { set: cloneJSON(captured.set), anomalies: captured.anomalies };
    } catch (error) {
      wardrobe = previous;
      throw error;
    }
  }

  function applySetTransaction(set, options = {}) {
    if (!globalThis.Player) throw new Error("当前角色不可用");
    const plan = buildSetApplyPlan(set, globalThis.Player, wardrobe);
    const previousWardrobe = cloneJSON(wardrobe);
    const previousAppearance = cloneAppearanceItems(Player.Appearance);
    try {
      const candidateWardrobe = normalizeWardrobe({ ...wardrobe, equippedIds: plan.equippedIds }, { validateReferences: false });
      compactWardrobeForStorage(candidateWardrobe, { validateReferences: false });
      Player.Appearance = plan.appearance;
      wardrobe = candidateWardrobe;
      (options.persist || persistWardrobe)();
      syncEquippedSchemes();
      syncFormalAppearance();
      return plan;
    } catch (error) {
      Player.Appearance = previousAppearance;
      wardrobe = previousWardrobe;
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

  function showSetImport(body) {
    const modal = openExchangeModal("导入套装");
    const hint = document.createElement("p");
    hint.className = "coe-muted";
    hint.textContent = "粘贴以 COE-SET 开头的套装字符串。导入只保存，不会自动穿上。";
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
        const plan = buildSetImportPlan(parsed);
        const report = plan.report;
        const warning = report.appearanceMissing || report.outfitsSkipped || report.missingLayers
          ? `\n\n缺少原版外观 ${report.appearanceMissing} 件；跳过自定义服装 ${report.outfitsSkipped} 件；缺少图层 ${report.missingLayers} 个。其余内容仍可使用。`
          : "";
        if (!confirm(`将导入套装「${plan.set.name}」。\n新建自定义服装 ${report.outfitsCreated} 件，复用 ${report.outfitsReused} 件。${warning}\n\n导入后保持未穿着，是否继续？`)) return;
        commitSetImportPlan(plan);
        modal.backdrop.remove();
        renderWardrobe(body);
        toast(`已导入套装「${plan.set.name}」`);
      } catch (error) { toast(`导入套装失败: ${error?.message || error}`, "error"); }
    });
    modal.content.append(hint, textarea);
    modal.actions.appendChild(submit);
    textarea.focus();
  }

  function renderSetWardrobe(body) {
    const summary = document.createElement("div");
    summary.className = "coe-wardrobe-summary";
    summary.textContent = persistenceBlocked
      ? `衣柜处于只读保护：${wardrobeReadState.status}。套装不会覆盖存储。`
      : `已保存 ${wardrobe.sets.length}/${MAX_SETS} 套完整外观。套装实时引用自定义服装，编辑服装后会自动使用新版。`;
    body.appendChild(summary);
    if (!wardrobe.sets.length) {
      body.insertAdjacentHTML("beforeend", '<div class="coe-empty"><h3>套装衣柜还是空的</h3><p>点击顶部“保存当前外观”，记录身体、脸、发型、原版服装和当前 COE 自定义服装。</p></div>');
      return;
    }
    const schemeIds = new Set(wardrobe.schemes.map(entry => entry.id));
    const grid = document.createElement("div");
    grid.className = "coe-grid";
    for (const set of wardrobe.sets) {
      const missing = set.customOutfits.filter(entry => !schemeIds.has(entry.schemeId)).length;
      const card = document.createElement("article");
      card.className = "coe-card";
      card.innerHTML = `<div class="coe-card-title"><h3>${escapeHTML(set.name)}</h3><span class="coe-equipped-badge">${missing ? `缺少 ${missing} 件` : "完整"}</span></div><p class="coe-muted">原版外观 ${set.appearance.length} 件 · 自定义服装 ${set.customOutfits.length} 件</p><div class="coe-actions"><button class="coe-btn coe-primary" data-wear>穿上</button><button class="coe-btn" data-rename>重命名</button><button class="coe-btn" data-export>导出</button><button class="coe-btn coe-danger" data-delete>删除</button></div>`;
      card.querySelector("[data-wear]").addEventListener("click", () => {
        if (!ensureWardrobeWritable()) return;
        try {
          const plan = applySetTransaction(set);
          toast(formatSetApplyReport(plan), plan.missingAppearance.length || plan.missingSchemes.length ? "warn" : "info");
          renderWardrobe(body);
        } catch (error) { toast(`穿上套装失败: ${error?.message || error}`, "error"); }
      });
      card.querySelector("[data-rename]").addEventListener("click", () => {
        if (!ensureWardrobeWritable()) return;
        const nextName = globalThis.prompt?.("套装名称", set.name);
        if (nextName == null || !nextName.trim()) return;
        const previous = cloneJSON(wardrobe);
        try {
          const target = wardrobe.sets.find(entry => entry.id === set.id);
          target.name = String(nextName).trim().slice(0, 60);
          wardrobe = normalizeWardrobe(wardrobe);
          persistWardrobe();
          renderWardrobe(body);
        } catch (error) { wardrobe = previous; toast(`重命名失败: ${error?.message || error}`, "error"); }
      });
      card.querySelector("[data-export]").addEventListener("click", () => showSetExport(set));
      card.querySelector("[data-delete]").addEventListener("click", () => {
        if (!ensureWardrobeWritable() || !confirm(`删除套装「${set.name}」？引用的自定义服装不会被删除。`)) return;
        try { deleteSetTransaction(set.id); renderWardrobe(body); }
        catch (error) { toast(`删除套装失败: ${error?.message || error}`, "error"); }
      });
      grid.appendChild(card);
    }
    body.appendChild(grid);
  }
