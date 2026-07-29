  function openSetNameModal(title, initialName, onAccept) {
    const modal = openExchangeModal(title);
    const label = document.createElement("label");
    label.className = "coe-field";
    label.innerHTML = '<span>名称</span>';
    const input = document.createElement("input");
    input.className = "coe-title-input";
    input.maxLength = 60;
    input.value = String(initialName || "").slice(0, 60);
    label.appendChild(input);
    const submit = document.createElement("button");
    submit.className = "coe-btn coe-primary";
    submit.textContent = "确定";
    submit.addEventListener("click", () => {
      const name = input.value.trim();
      if (!name) { input.focus(); toast("名称不能为空", "warn"); return; }
      try { if (onAccept(name) !== false) modal.backdrop.remove(); }
      catch (error) { toast(`操作失败: ${error?.message || error}`, "error"); }
    });
    modal.content.appendChild(label);
    modal.actions.appendChild(submit);
    input.focus();
    input.select();
    return modal;
  }

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
        sets: wardrobe.sets.map(set => ({ ...set, customOutfits: set.customOutfits.filter(entry => entry.schemeId !== schemeId) })),
        equippedIds: wardrobe.equippedIds.filter(id => id !== schemeId),
      }, { validateReferences: false });
      compactWardrobeForStorage(candidate, { validateReferences: false });
      wardrobe = candidate;
      if (wasEquipped && removedScheme && globalThis.Player) {
        const slotGroup = schemeSlotGroup(removedScheme);
        Player.Appearance = Player.Appearance.filter(item => !(item?.Asset?.Name === TAG_ASSET_NAME && item?.Asset?.Group?.Name === slotGroup));
      }
      (options.persist || persistWardrobe)();
      if (options.sync !== false) { syncEquippedSchemes(); syncFormalAppearance(); }
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
    } catch (error) { wardrobe = previous; throw error; }
  }

  function setAtSlot(slot, data = wardrobe) {
    return (data?.sets || []).find(set => set.slot === slot) || null;
  }

  function firstEmptySetSlot(data = wardrobe) {
    const occupied = new Set((data?.sets || []).map(set => set.slot));
    for (let slot = 0; slot < MAX_SETS; slot++) if (!occupied.has(slot)) return slot;
    return null;
  }

  function saveCurrentSetToSlotTransaction(slot, name, options = {}) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SETS) throw new Error("套装储存格无效");
    const existing = setAtSlot(slot);
    if (existing && options.overwrite !== true) throw new Error("该套装格子已有内容");
    if (!existing && wardrobe.sets.length >= MAX_SETS) throw new Error(`套装衣柜最多保存 ${MAX_SETS} 套`);
    const finalName = existing && options.keepName !== false ? existing.name : uniqueSetName(name);
    const captured = captureCurrentSet(finalName, options.character || globalThis.Player, wardrobe, slot);
    if (captured.anomalies.some(entry => entry.type === "orphan-tag")) throw new Error("当前外观存在没有对应自定义服装的 COE 标签，请先重新启用该服装");
    if (existing) captured.set.id = existing.id;
    const previous = cloneJSON(wardrobe);
    try {
      const sets = existing
        ? wardrobe.sets.map(set => set.slot === slot ? captured.set : set)
        : [...wardrobe.sets, captured.set];
      const candidate = normalizeWardrobe({ ...wardrobe, sets }, { validateReferences: false });
      compactWardrobeForStorage(candidate, { validateReferences: false });
      wardrobe = candidate;
      (options.persist || persistWardrobe)();
      return { set: cloneJSON(setAtSlot(slot)), anomalies: captured.anomalies, overwritten: !!existing };
    } catch (error) { wardrobe = previous; throw error; }
  }

  function saveCurrentSetTransaction(name, options = {}) {
    const slot = Number.isInteger(options.slot) ? options.slot : firstEmptySetSlot();
    if (slot == null) throw new Error(`套装衣柜最多保存 ${MAX_SETS} 套`);
    return saveCurrentSetToSlotTransaction(slot, name, options);
  }

  function overwriteCurrentSetTransaction(slot, options = {}) {
    const existing = setAtSlot(slot);
    if (!existing) throw new Error("所选套装格子为空");
    return saveCurrentSetToSlotTransaction(slot, existing.name, { ...options, overwrite: true, keepName: true });
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

  function showSetImport(body, targetSlot) {
    if (!Number.isInteger(targetSlot)) { toast("请先选择一个套装格子", "warn"); return; }
    const current = setAtSlot(targetSlot);
    const modal = openExchangeModal(`导入到第 ${targetSlot + 1} 格`);
    const hint = document.createElement("p");
    hint.className = "coe-muted";
    hint.textContent = current
      ? `格子中现有套装「${current.name}」。导入会覆盖这个格子，但不会删除它引用的自定义服装。`
      : "粘贴以 COE-SET 开头的套装字符串。导入只保存，不会自动穿上。";
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
        const plan = buildSetImportPlan(parsed, targetSlot);
        const report = plan.report;
        const warning = report.appearanceMissing || report.outfitsSkipped || report.missingLayers
          ? `\n\n缺少原版外观 ${report.appearanceMissing} 件；跳过自定义服装 ${report.outfitsSkipped} 件；缺少图层 ${report.missingLayers} 个。其余内容仍可使用。` : "";
        const overwrite = plan.replacedSet ? `\n将覆盖格子中的「${plan.replacedSet.name}」。` : "";
        if (!confirm(`将套装「${plan.set.name}」导入第 ${targetSlot + 1} 格。${overwrite}\n新建自定义服装 ${report.outfitsCreated} 件，复用 ${report.outfitsReused} 件。${warning}\n\n导入后保持未穿着，是否继续？`)) return;
        commitSetImportPlan(plan);
        selectedSetSlot = targetSlot;
        modal.backdrop.remove();
        renderWardrobe(body);
        toast(`已导入套装「${plan.set.name}」`);
      } catch (error) { toast(`导入套装失败: ${error?.message || error}`, "error"); }
    });
    modal.content.append(hint, textarea);
    modal.actions.appendChild(submit);
    textarea.focus();
  }

  function setPreviewFingerprint(set) {
    const schemeById = new Map(wardrobe.schemes.map(entry => [entry.id, entry]));
    const compactSet = compactSetForStorage(set, { validSchemeIds: new Set(schemeById.keys()) });
    delete compactSet.name;
    delete compactSet.slot;
    return JSON.stringify({
      set: compactSet,
      outfits: set.customOutfits.map(entry => {
        const scheme = schemeById.get(entry.schemeId);
        return scheme ? compactCompositionForStorage(scheme.composition, { validateReferences: false }) : null;
      }),
    });
  }

  function paintSetPreview(target, source) {
    const context = target?.getContext?.("2d");
    if (!context || !source) return false;
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(source, 0, 0, source.width, source.height, 0, 0, target.width, target.height);
    return true;
  }

  function releaseSetPreviewCharacter(character) {
    if (!character) return;
    previewCompositionByCharacter.delete(character);
    syntheticByCharacter.delete(character);
    if (typeof clearPreviewTextureTracking === "function") clearPreviewTextureTracking(character);
    try { if (typeof globalThis.CharacterDelete === "function") CharacterDelete(character, false); } catch (_) { /* best effort */ }
    try { if (character.Canvas) { character.Canvas.width = 0; character.Canvas.height = 0; } } catch (_) { /* best effort */ }
    try { if (character.CanvasBlink) { character.CanvasBlink.width = 0; character.CanvasBlink.height = 0; } } catch (_) { /* best effort */ }
  }

  function cancelSetPreviewQueue() {
    setPreviewGeneration++;
    setPreviewQueue = [];
  }

  async function buildSetPreviewSnapshot(set, generation) {
    if (typeof globalThis.CharacterLoadSimple !== "function" || !globalThis.Player) return null;
    const character = CharacterLoadSimple(`COESetPreview-${++setPreviewCharacterSerial}`);
    try {
      character.AssetFamily = Player.AssetFamily || "Female3DCG";
      character.Appearance = cloneAppearanceItems(Player.Appearance || []);
      character.ActivePoseMapping = cloneJSON(Player.ActivePoseMapping || {});
      character.HeightModifier = Player.HeightModifier;
      character.HeightRatio = Player.HeightRatio;
      const plan = buildSetApplyPlan(set, character, wardrobe);
      character.Appearance = plan.appearance;
      previewCompositionByCharacter.set(character, combineSchemes(plan.equippedIds, wardrobe));
      if (typeof globalThis.CharacterRefresh === "function") CharacterRefresh(character, false, false);
      // Synthetic source textures are absent from the preview character's formal
      // Appearance, so BC's DrawRefreshCharacterForImage cannot mark this isolated
      // character dirty when their 1x1 placeholders finish loading. The renderer
      // tracks those URLs for us; keep rebuilding until every observed texture is
      // ready, with a bounded wait so a broken URL cannot stall the whole queue.
      for (let attempt = 0; attempt < 22; attempt++) {
        if (generation !== setPreviewGeneration) return null;
        if (typeof globalThis.CharacterLoadCanvas === "function") CharacterLoadCanvas(character);
        await new Promise(resolve => setTimeout(resolve, attempt < 2 ? 0 : 60));
        if (!character.MustDraw && !previewTexturesPending(character) && attempt >= 1) break;
      }
      const cacheable = !previewTexturesPending(character);
      const snapshot = document.createElement("canvas");
      snapshot.width = 500;
      snapshot.height = 1000;
      const context = snapshot.getContext?.("2d");
      if (!context) return null;
      context.clearRect(0, 0, snapshot.width, snapshot.height);
      if (typeof globalThis.DrawCharacter === "function") DrawCharacter(character, 0, 0, 1, false, context);
      else if (character.Canvas) context.drawImage(character.Canvas, 0, 0, snapshot.width, snapshot.height);
      return { snapshot, plan, cacheable };
    } catch (error) {
      warn(`套装「${set.name}」预览生成失败`, error);
      return null;
    } finally { releaseSetPreviewCharacter(character); }
  }

  async function runSetPreviewQueue() {
    if (setPreviewRunning) return;
    setPreviewRunning = true;
    try {
      while (setPreviewQueue.length) {
        const job = setPreviewQueue.shift();
        if (!job || job.generation !== setPreviewGeneration || !job.canvas.isConnected) continue;
        const cached = setPreviewCache.get(job.fingerprint);
        if (cached) {
          paintSetPreview(job.canvas, cached);
          job.slot.classList.remove("coe-loading", "coe-preview-failed");
          continue;
        }
        const result = await buildSetPreviewSnapshot(job.set, job.generation);
        if (!result) {
          if (job.generation === setPreviewGeneration && job.canvas.isConnected) {
            job.slot.classList.remove("coe-loading");
            job.slot.classList.add("coe-preview-failed");
          }
          continue;
        }
        if (job.generation !== setPreviewGeneration || !job.canvas.isConnected) continue;
        if (result.cacheable) {
          setPreviewCache.set(job.fingerprint, result.snapshot);
          if (setPreviewCache.size > MAX_SETS * 2) setPreviewCache.delete(setPreviewCache.keys().next().value);
        }
        paintSetPreview(job.canvas, result.snapshot);
        job.slot.classList.remove("coe-loading", "coe-preview-failed");
      }
    } finally { setPreviewRunning = false; }
  }

  function queueSetPreview(set, slotElement, canvas, generation) {
    let fingerprint;
    try { fingerprint = setPreviewFingerprint(set); }
    catch (error) {
      slotElement.classList.remove("coe-loading");
      slotElement.classList.add("coe-preview-failed");
      return;
    }
    const cached = setPreviewCache.get(fingerprint);
    if (cached) {
      paintSetPreview(canvas, cached);
      slotElement.classList.remove("coe-loading", "coe-preview-failed");
      return;
    }
    setPreviewQueue.push({ set: cloneJSON(set), slot: slotElement, canvas, fingerprint, generation });
    runSetPreviewQueue();
  }

  function updateSetSelectionUI(body) {
    const slotSelected = Number.isInteger(selectedSetSlot) && selectedSetSlot >= 0 && selectedSetSlot < MAX_SETS;
    const selected = slotSelected ? setAtSlot(selectedSetSlot) : null;
    body.querySelectorAll("[data-set-slot]").forEach(element => {
      element.classList.toggle("coe-selected", slotSelected && Number(element.dataset.setSlot) === selectedSetSlot);
    });
    const label = body.querySelector("[data-selected-set-name]");
    if (label) label.textContent = selected ? `已选择：${selected.name}` : slotSelected ? `已选择：第 ${selectedSetSlot + 1} 格（空）` : "请选择一个套装格子";
    body.querySelectorAll("[data-set-command]").forEach(button => {
      const command = button.dataset.setCommand;
      const needsContent = command !== "store";
      const readOnlyBlocked = persistenceBlocked && command !== "export";
      button.disabled = !slotSelected || (needsContent && !selected) || readOnlyBlocked;
    });
  }

  function renderSetWardrobe(body) {
    cancelSetPreviewQueue();
    setWardrobePage = clamp(setWardrobePage, 0, 1);
    const generation = setPreviewGeneration;
    const toolbar = document.createElement("div");
    toolbar.className = "coe-set-toolbar";
    toolbar.innerHTML = `<strong data-selected-set-name>请选择一个已有套装格子</strong><div class="coe-actions"><button class="coe-btn" data-set-command="store">储存</button><button class="coe-btn coe-primary" data-set-command="wear">穿上</button><button class="coe-btn" data-set-command="rename">重命名</button><button class="coe-btn" data-set-command="export">导出</button><button class="coe-btn coe-danger" data-set-command="delete">删除</button></div>`;
    const selected = () => setAtSlot(selectedSetSlot);
    toolbar.querySelector('[data-set-command="store"]').addEventListener("click", () => {
      if (!Number.isInteger(selectedSetSlot) || !ensureWardrobeWritable()) return;
      const set = selected();
      if (set && !confirm(`将当前完整外观储存到套装「${set.name}」？\n\n这会覆盖该格子原有的外观和自定义服装引用。`)) return;
      try {
        const result = set
          ? overwriteCurrentSetTransaction(selectedSetSlot)
          : saveCurrentSetToSlotTransaction(selectedSetSlot, `新套装 ${selectedSetSlot + 1}`);
        renderWardrobe(body);
        toast(set ? `已更新套装「${set.name}」` : `已保存套装「${result.set.name}」`);
      } catch (error) { toast(`储存套装失败: ${error?.message || error}`, "error"); }
    });
    toolbar.querySelector('[data-set-command="wear"]').addEventListener("click", () => {
      const set = selected();
      if (!set || !ensureWardrobeWritable()) return;
      try { const plan = applySetTransaction(set); toast(formatSetApplyReport(plan), plan.missingAppearance.length || plan.missingSchemes.length ? "warn" : "info"); }
      catch (error) { toast(`穿上套装失败: ${error?.message || error}`, "error"); }
    });
    toolbar.querySelector('[data-set-command="rename"]').addEventListener("click", () => {
      const set = selected();
      if (!set || !ensureWardrobeWritable()) return;
      openSetNameModal(`重命名套装「${set.name}」`, set.name, nextName => {
        const previous = cloneJSON(wardrobe);
        try {
          const target = setAtSlot(set.slot);
          target.name = nextName.slice(0, 60);
          wardrobe = normalizeWardrobe(wardrobe);
          persistWardrobe();
          renderWardrobe(body);
        } catch (error) { wardrobe = previous; throw error; }
      });
    });
    toolbar.querySelector('[data-set-command="export"]').addEventListener("click", () => { const set = selected(); if (set) showSetExport(set); });
    toolbar.querySelector('[data-set-command="delete"]').addEventListener("click", () => {
      const set = selected();
      if (!set || !ensureWardrobeWritable()) return;
      openConfirmationModal(
        `删除套装「${set.name}」`,
        "删除后无法恢复。这个操作只删除套装格子，套装引用的自定义服装会继续保留。",
        "确认删除",
        () => {
          try { deleteSetTransaction(set.id); selectedSetSlot = null; renderWardrobe(body); }
          catch (error) { toast(`删除套装失败: ${error?.message || error}`, "error"); return false; }
        },
        { danger: true },
      );
    });
    body.appendChild(toolbar);

    const pageTabs = document.createElement("nav");
    pageTabs.className = "coe-set-page-tabs";
    pageTabs.innerHTML = `<button class="${setWardrobePage === 0 ? "coe-active" : ""}" data-page="0">第 1 页</button><button class="${setWardrobePage === 1 ? "coe-active" : ""}" data-page="1">第 2 页</button>`;
    pageTabs.querySelectorAll("[data-page]").forEach(button => button.addEventListener("click", () => {
      setWardrobePage = Number(button.dataset.page);
      renderWardrobe(body);
    }));
    body.appendChild(pageTabs);

    const grid = document.createElement("div");
    grid.className = "coe-set-grid";
    body.appendChild(grid);
    const start = setWardrobePage * SETS_PER_PAGE;
    for (let slot = start; slot < start + SETS_PER_PAGE; slot++) {
      const set = setAtSlot(slot);
      const element = document.createElement("div");
      element.className = `coe-set-slot${set ? " coe-loading" : " coe-empty-slot"}`;
      element.tabIndex = 0;
      element.setAttribute("role", "button");
      element.dataset.setSlot = String(slot);
      grid.appendChild(element);
      if (!set) {
        element.innerHTML = `<button type="button" class="coe-set-plus" title="把当前完整外观储存到第 ${slot + 1} 格">＋</button><span class="coe-set-slot-name">第 ${slot + 1} 格</span>`;
        element.addEventListener("click", () => { selectedSetSlot = slot; updateSetSelectionUI(body); });
        element.querySelector(".coe-set-plus").addEventListener("click", event => {
          event.stopPropagation();
          if (!ensureWardrobeWritable()) return;
          try {
            const result = saveCurrentSetToSlotTransaction(slot, `新套装 ${slot + 1}`);
            selectedSetSlot = slot;
            renderWardrobe(body);
            toast(`已保存套装「${result.set.name}」`);
          } catch (error) { toast(`保存套装失败: ${error?.message || error}`, "error"); }
        });
      } else {
        const missing = validateSetReferences(set).length;
        element.innerHTML = `<canvas width="225" height="440" aria-label="${escapeHTML(set.name)}预览"></canvas>${missing ? `<span class="coe-set-warning" title="缺少 ${missing} 件自定义服装">⚠ ${missing}</span>` : ""}<span class="coe-set-slot-name">${escapeHTML(set.name)}</span>`;
        element.addEventListener("click", () => { selectedSetSlot = slot; updateSetSelectionUI(body); });
        queueSetPreview(set, element, element.querySelector("canvas"), generation);
      }
      element.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        selectedSetSlot = slot;
        updateSetSelectionUI(body);
      });
    }
    updateSetSelectionUI(body);
  }
