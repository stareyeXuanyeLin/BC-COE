  function injectStyle() {
    document.getElementById(STYLE_ID)?.remove();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.dataset.coeVersion = VERSION;
    style.textContent = `
#${BUTTON_ID}{position:fixed;left:18px;top:18px;z-index:99980;min-width:176px;border:2px solid #111;border-radius:8px;background:linear-gradient(#fff,#cfeaff);color:#102333;padding:9px 14px;font:700 15px/1.2 system-ui;box-shadow:0 3px 0 #111,0 9px 24px #0008;cursor:pointer}#${BUTTON_ID}:hover{filter:brightness(1.07);transform:translateY(-1px)}
#${ROOT_ID}{--coe-panel-width:clamp(520px,42vw,820px);position:fixed;inset:0;z-index:99990;background:transparent;color:#111;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;box-sizing:border-box;pointer-events:none}#${ROOT_ID} *{box-sizing:border-box}#${ROOT_ID} button,#${ROOT_ID} input,#${ROOT_ID} select{font:inherit}.coe-panel{position:absolute;inset:0;background:transparent;pointer-events:none}.coe-head{position:absolute;right:0;top:0;width:var(--coe-panel-width);height:72px;display:flex;align-items:center;gap:14px;padding:9px 18px;border-bottom:2px solid #111;border-left:2px solid #111;background:linear-gradient(180deg,#f6fbff 0,#c4dbe9 100%);color:#132333;box-shadow:-6px 3px 12px #0008;pointer-events:auto;z-index:3}.coe-brand{display:flex;align-items:center;gap:11px;min-width:0;flex:1}.coe-brand-mark{display:grid;place-items:center;width:42px;height:42px;flex:none;border:2px solid #142535;border-radius:50%;background:#fff;color:#24658e;font-size:22px}.coe-head h2{margin:0;font-size:20px;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.coe-build{display:block;margin-top:3px;color:#496479;font:600 11px/1.2 ui-monospace,Consolas,monospace}.coe-body{position:absolute;right:0;top:72px;bottom:0;width:var(--coe-panel-width);padding:12px;overflow:auto;border-left:2px solid #111;background:#d8d8d8f2;box-shadow:-6px 0 18px #0008;pointer-events:auto}.coe-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.coe-head .coe-actions{justify-content:flex-end}.coe-btn{border:2px solid #111923;border-radius:6px;background:linear-gradient(#fff,#c4d2dc);color:#152432;padding:7px 11px;font-weight:700;box-shadow:0 2px 0 #070b0f;cursor:pointer}.coe-btn:hover{filter:brightness(1.07)}.coe-btn:active{transform:translateY(1px);box-shadow:0 1px 0 #070b0f}.coe-primary{background:linear-gradient(#b8e9ff,#54b6eb);color:#071a27}.coe-danger{background:linear-gradient(#ffd0d8,#e67689);color:#32101a}.coe-muted{color:#536b7d}.coe-menu{position:relative}.coe-menu>summary{list-style:none;user-select:none}.coe-menu>summary::-webkit-details-marker{display:none}.coe-menu-panel{position:absolute;right:0;top:calc(100% + 6px);z-index:8;display:grid;min-width:180px;padding:6px;border:2px solid #172631;border-radius:7px;background:#f2f6f8;box-shadow:0 7px 20px #0007}.coe-menu-panel button{border:0;border-radius:4px;background:transparent;color:#142331;padding:8px 9px;text-align:left;font-weight:700;cursor:pointer}.coe-menu-panel button:hover{background:#cdeaff}.coe-modal-backdrop{position:fixed;inset:0;z-index:100005;display:grid;place-items:center;padding:20px;background:#0008;pointer-events:auto}.coe-modal{width:min(680px,92vw);max-height:86vh;overflow:auto;border:2px solid #172631;border-radius:9px;background:#eef3f6;color:#142331;padding:16px;box-shadow:0 14px 42px #000b}.coe-modal h3{margin:0 0 10px;font-size:18px}.coe-modal-content{display:grid;gap:9px}.coe-modal-content p{margin:0}.coe-modal-actions{justify-content:flex-end;margin-top:13px}.coe-exchange-text{width:100%;min-height:210px;resize:vertical;border:1px solid #667c8c;border-radius:6px;background:#fff;color:#111;padding:9px;font:12px/1.45 ui-monospace,Consolas,monospace;word-break:break-all}.coe-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.coe-card{border:2px solid #555;border-radius:7px;padding:11px;background:#f4f4f4;color:#142331;box-shadow:0 2px 5px #0003}.coe-card h3{margin:0 0 5px;font-size:16px}.coe-card-title{display:flex;align-items:center;gap:8px}.coe-card-title h3{flex:1}.coe-card.coe-equipped{border:3px solid #1889c8;background:#e0f3ff;box-shadow:0 0 0 2px #8bd2f7 inset}.coe-equipped-badge{display:inline-block;padding:3px 7px;border-radius:4px;background:#d5d5d5;color:#555;font-size:11px}.coe-card.coe-equipped .coe-equipped-badge{background:#1889c8;color:#fff}.coe-wardrobe-summary{margin-bottom:10px;padding:8px 10px;border:1px solid #677b88;border-radius:5px;background:#eef5f9;color:#233b4b;font-size:12px}.coe-remote-prefs{display:grid;gap:7px;margin-bottom:10px;padding:10px;border:2px solid #52758b;border-radius:7px;background:#e7f4fb}.coe-remote-prefs h3{margin:0 0 2px}.coe-remote-prefs label{display:flex;align-items:center;gap:7px;font-weight:700}.coe-remote-prefs input{width:17px;height:17px}.coe-remote-prefs p{margin:2px 0 0;color:#3f5c6d;font-size:11px}.coe-empty{text-align:center;padding:48px 18px;color:#536b7d}
.coe-editor{height:100%;min-height:0}.coe-editor-tools{height:100%;min-height:0;display:grid;grid-template-rows:auto auto minmax(0,1fr);border:2px solid #555;border-radius:6px;background:#ededed;overflow:hidden}.coe-scheme-bar{padding:9px 11px;border-bottom:1px solid #777;background:#f7f7f7}.coe-field{display:flex;align-items:center;gap:8px}.coe-field label{font-weight:700;white-space:nowrap}.coe-field input,.coe-field select,.coe-search{min-width:0;border:1px solid #667c8c;border-radius:5px;background:#fff;color:#111;padding:7px 9px;outline:none}.coe-field input:focus,.coe-search:focus{border-color:#2699dc;box-shadow:0 0 0 2px #4bb9f044}.coe-title-input{width:100%;font-size:16px!important}.coe-tool-tabs{display:flex;gap:6px;padding:7px;border-bottom:1px solid #777;background:#c9c9c9}.coe-tool-tabs .coe-btn{flex:1;padding:6px 9px}.coe-tool-content{min-height:0;overflow:auto;padding:9px}.coe-editor-section{margin-bottom:11px}.coe-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 7px}.coe-section-head h3{margin:0;font-size:14px}.coe-badge{display:inline-flex;align-items:center;min-height:21px;padding:2px 7px;border:1px solid #688296;border-radius:999px;background:#e4f2fb;color:#24516c;font-size:11px}.coe-pose-groups{display:grid;gap:3px}.coe-pose-group{display:grid;grid-template-columns:42px minmax(0,1fr);align-items:center;gap:5px}.coe-pose-group h4{margin:0;color:#3d5363;font-size:11px}.coe-pose-buttons{display:flex;flex-wrap:wrap;gap:3px}.coe-pose-buttons .coe-btn{padding:2px 6px;border-width:1px;border-radius:4px;box-shadow:none;font-size:10px}.coe-pose-buttons button.coe-active{background:linear-gradient(#b8e9ff,#54b6eb);border-color:#116c9d}.coe-hint{padding:7px 9px;border:1px solid #708798;border-radius:6px;background:#e4edf4;color:#233b4b;font-size:11px}.coe-transform-editor{position:sticky;top:-9px;z-index:5;margin:9px 0;padding:9px;border:2px solid #d28b28;border-radius:7px;background:#fff6df;color:#2b2112;box-shadow:0 3px 8px #0003}.coe-transform-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.coe-transform-head strong,.coe-transform-head .coe-muted{display:block}.coe-transform-fields{display:grid;grid-template-columns:repeat(4,minmax(70px,1fr));gap:6px;margin-top:7px}.coe-transform-fields label{display:flex;flex-direction:column;color:#333;font-size:10px}.coe-transform-fields input{margin-top:3px;width:100%;min-width:0;border:1px solid #967a45;border-radius:4px;background:#fff;color:#111;padding:5px}.coe-transform-actions{margin-top:8px}.coe-divider{height:1px;background:#888;margin:10px 0}.coe-layer-list{display:flex;flex-direction:column;gap:7px}.coe-layer{border:1px solid #777;border-radius:6px;padding:8px;background:#fafafa;cursor:pointer}.coe-layer.coe-selected{border:2px solid #168cca;background:#e2f4ff;box-shadow:0 0 0 2px #8bd2f755 inset}.coe-layer.coe-hidden{opacity:.55}.coe-layer.coe-recycled{opacity:.7;border-style:dashed}.coe-layer-top{display:flex;gap:6px;align-items:center}.coe-drag-handle{color:#667;cursor:grab}.coe-layer-name{flex:1;min-width:0;overflow:hidden;border:0;background:transparent;color:inherit;padding:3px 4px;text-align:left;font-weight:700;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.coe-layer-name:hover{color:#096c9f;text-decoration:underline}.coe-layer-top .coe-btn{padding:4px 6px;font-size:11px}.coe-controls{display:grid;grid-template-columns:repeat(4,minmax(52px,1fr)) minmax(90px,1.4fr) repeat(2,minmax(52px,1fr));gap:4px;overflow-x:auto}.coe-controls label{display:flex;min-width:0;flex-direction:column;color:#333;font-size:10px}.coe-controls input{margin-top:2px;width:100%;min-width:0;height:27px;border:1px solid #777;border-radius:4px;background:#fff;color:#111;padding:3px 4px}.coe-color-choice{display:flex;align-items:center;gap:5px;margin-top:3px;width:100%;min-width:0;height:29px;padding:3px 5px;border:1px solid #667;border-radius:4px;background:#fff;color:#111;cursor:pointer}.coe-color-choice:hover{border-color:#168cca;background:#eaf7ff}.coe-color-choice:disabled{cursor:not-allowed;opacity:.55}.coe-color-swatch{width:18px;height:18px;flex:none;border:1px solid #555;border-radius:3px;background-color:#fff;background-image:linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%);background-size:8px 8px;background-position:0 0,0 4px,4px -4px,-4px 0}.coe-color-swatch::after{display:block;width:100%;height:100%;border-radius:2px;background:var(--coe-color,#fff);content:""}.coe-color-choice code{min-width:0;overflow:hidden;color:inherit;font:700 10px/1.2 ui-monospace,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.coe-material-editor{border:2px solid #666;border-radius:7px;background:#e4e4e4;overflow:hidden}.coe-material-editor+.coe-material-editor{margin-top:9px}.coe-material-editor.coe-selected{border-color:#168cca;box-shadow:0 0 0 2px #8bd2f755}.coe-material-editor.coe-contains-selected{border-color:#4a91b8}.coe-material-editor.coe-hidden{opacity:.58}.coe-material-editor.coe-recycled{border-style:dashed}.coe-material-editor-head{display:flex;align-items:center;gap:7px;padding:8px;background:#d0d0d0;border-bottom:1px solid #777}.coe-material-editor.coe-selected>.coe-material-editor-head{background:#c5e9fb}.coe-material-identity{display:flex;flex:1;min-width:0;flex-direction:column;overflow:hidden;border:0;background:transparent;color:inherit;padding:2px 4px;text-align:left;cursor:pointer}.coe-material-identity:hover strong{color:#096c9f;text-decoration:underline}.coe-material-identity strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.coe-material-identity .coe-muted{font-size:10px}.coe-collapse{width:25px;height:25px;border:0;background:transparent;cursor:pointer}.coe-overall-color{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:700}.coe-overall-color .coe-color-choice{width:auto;max-width:104px;margin-top:0}.coe-material-editor-layers{display:flex;flex-direction:column;gap:7px;padding:7px}.coe-material-editor.coe-collapsed .coe-material-editor-head{border-bottom:0}.coe-recycle-row{display:flex;align-items:center;gap:8px;padding:5px 7px;border:1px solid #888;border-radius:5px;background:#fafafa}.coe-recycle-row span{flex:1}
.coe-material-picker{display:block;min-height:100%}.coe-material-toolbar{position:sticky;top:-9px;z-index:3;padding:0 0 9px;background:#ededed}.coe-search{width:100%}.coe-materials{display:flex;flex-direction:column;gap:7px;min-height:0}.coe-material-group-title{position:sticky;top:38px;z-index:2;margin:0 0 6px;border-radius:4px;background:#c9c9c9;color:#111;font-size:13px}.coe-material-group-toggle{display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;gap:5px;width:100%;border:0;background:transparent;color:inherit;padding:5px 7px;text-align:left;cursor:pointer}.coe-material-group-toggle strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coe-material-group-toggle small{padding:1px 5px;border-radius:999px;background:#eef3f6;color:#405765}.coe-material-section.coe-collapsed .coe-material-group{display:none}.coe-material-group{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.coe-material{display:flex;flex-direction:column;align-items:stretch;gap:4px;min-width:0;min-height:136px;border:1px solid #777;border-radius:5px;background:#fafafa;padding:6px;text-align:center;color:#111;cursor:pointer}.coe-material:hover{border-color:#168cca;background:#e2f4ff}.coe-material:disabled{cursor:not-allowed;filter:grayscale(.7);opacity:.58}.coe-material.coe-cap-safe{border-color:#268a52}.coe-material.coe-cap-limited{border-color:#c38b13}.coe-material.coe-cap-unverified,.coe-material.coe-cap-unsupported{border-color:#a34b56}.coe-material img{width:100%;height:96px;object-fit:contain;border-radius:4px;background:#eee}.coe-material strong{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px}.coe-material .coe-muted{font-size:10px}.coe-toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,14px);opacity:0;z-index:100010;background:#e8f4fc;color:#142331;border:2px solid #182735;border-radius:8px;padding:9px 15px;box-shadow:0 7px 22px #0009;transition:.2s;pointer-events:none}.coe-toast.coe-show{transform:translate(-50%,0);opacity:1}.coe-toast.coe-error{background:#ffd3dc}.coe-toast.coe-warn{background:#ffe4a8}
.coe-owned-color-picker{background:linear-gradient(180deg,#f7fbfe 0,#d5e1e8 100%)!important;border:2px solid #172631!important;border-radius:8px;box-shadow:0 8px 28px #000a!important}
@media(max-width:1250px){#${ROOT_ID}{--coe-panel-width:clamp(480px,46vw,520px)}.coe-brand-mark,.coe-build{display:none}.coe-grid{grid-template-columns:1fr}.coe-material-group{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:800px){#${ROOT_ID}{--coe-panel-width:58vw}.coe-head{height:80px;align-items:flex-start}.coe-body{top:80px}.coe-material-group{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
    document.head.appendChild(style);
  }

  function isAppearanceRootMode() {
    const mode = globalThis.CharacterAppearanceMode ?? "";
    const extendedItemOpen = globalThis.DialogFocusItem != null;
    let layeringActive = false;
    try { layeringActive = globalThis.Layering?.IsActive?.() === true; } catch (_) { layeringActive = true; }
    return mode === "" && !extendedItemOpen && !layeringActive;
  }

  function isAppearanceWorkspaceActive() {
    return globalThis.CurrentScreen === "Appearance" && (uiMode === "wardrobe" || uiMode === "editor");
  }

  function updateEntryButton() {
    if (!initialized || !document.body) return;
    const isEditingSelf = !globalThis.CharacterAppearanceSelection || globalThis.CharacterAppearanceSelection === globalThis.Player;
    const shouldShow = globalThis.CurrentScreen === "Appearance" && isAppearanceRootMode() && !document.getElementById(ROOT_ID) && isEditingSelf;
    let button = document.getElementById(BUTTON_ID);
    if (shouldShow && !button) {
      button = document.createElement("button");
      button.id = BUTTON_ID;
      button.setAttribute("screen-generated", "Appearance");
      button.dataset.coeBuild = VERSION;
      button.textContent = "✦ 自定义服装设计";
      button.title = `${MOD_NAME} v${VERSION}`;
      button.addEventListener("click", openWardrobe);
      document.body.appendChild(button);
    } else if (!shouldShow && button) button.remove();
  }

  function rootShell(title, actions = "") {
    closeUI();
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.dataset.coeVersion = VERSION;
    root.innerHTML = `<section class="coe-panel"><header class="coe-head"><div class="coe-brand"><span class="coe-brand-mark">✦</span><div><h2>${escapeHTML(title)}</h2><span class="coe-build">${MOD_NAME} v${escapeHTML(VERSION)} · Appearance Workspace</span></div></div><div class="coe-actions">${actions}</div></header><main class="coe-body"></main></section>`;
    for (const eventName of ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend", "wheel"])
      root.addEventListener(eventName, event => event.stopPropagation());
    root.addEventListener("click", event => {
      event.stopPropagation();
      if (event.target.closest('[data-action="close"]')) closeUI();
    });
    document.body.appendChild(root);
    updateEntryButton();
    return root.querySelector(".coe-body");
  }

  function drawAppearanceWorkspaceCharacters() {
    const character = globalThis.CharacterAppearanceSelection;
    if (!character || typeof globalThis.DrawCharacter !== "function") return;
    const heightModifier = Number.isFinite(character.HeightModifier) ? character.HeightModifier : 0;
    DrawCharacter(character, -600, -100 + 4 * heightModifier, 4, false);
    const isPlayer = typeof character.IsPlayer === "function" ? character.IsPlayer() : character === globalThis.Player;
    DrawCharacter(character, 660, isPlayer ? 90 : 0, isPlayer ? 0.95 : 1);
  }

  function installAppearanceWorkspaceHooks() {
    modApi.hookFunction("AppearanceRun", 1000, (args, next) => {
      if (!isAppearanceWorkspaceActive()) return next(args);
      drawAppearanceWorkspaceCharacters();
    });
    for (const name of ["AppearanceClick", "AppearanceMouseDown", "AppearanceMouseUp", "AppearanceMouseMove", "AppearanceMouseWheel", "AppearanceKeyDown", "AppearanceKeyUp", "AppearancePaste"]) {
      if (typeof globalThis[name] !== "function") continue;
      modApi.hookFunction(name, 1000, (args, next) => {
        if (!isAppearanceWorkspaceActive()) return next(args);
      });
    }
  }

  function cloneAppearanceItems(items) {
    return (items || []).map(item => ({ Asset: item.Asset, Color: cloneJSON(item.Color), Property: cloneJSON(item.Property) }));
  }

  function beginEditorPreview() {
    if (!globalThis.Player || editorAppearanceSnapshot) return;
    // The snapshot is read-only and is used only for source colors/properties.
    // v1.5.2 never replaces Player.Appearance during preview.
    editorAppearanceSnapshot = cloneAppearanceItems(Player.Appearance);
    editorPoseSnapshot = cloneJSON(Player.ActivePoseMapping || {});
    CharacterRefresh(Player, false, false);
  }

  function restoreEditorAppearance() {
    if (!globalThis.Player || !editorAppearanceSnapshot) return;
    if (editorPoseSnapshot) Player.ActivePoseMapping = editorPoseSnapshot;
    editorAppearanceSnapshot = null;
    editorPoseSnapshot = null;
    uiMode = null;
    CharacterRefresh(Player, false, false);
  }

  function closeUI() {
    closeOwnedColorPicker();
    restoreEditorAppearance();
    document.getElementById(ROOT_ID)?.remove();
    // Closing the local editor must not discard texture/geometry refreshes already
    // queued for remote characters. Remove only the local preview request and keep
    // the shared frame alive while any other character remains pending.
    pendingCharacterRefreshes.delete(globalThis.Player);
    if (!pendingCharacterRefreshes.size) {
      if (characterRefreshScheduled && typeof globalThis.cancelAnimationFrame === "function") cancelAnimationFrame(previewTimer);
      if (characterRefreshScheduled && typeof globalThis.clearTimeout === "function") clearTimeout(previewTimer);
      previewTimer = 0;
      characterRefreshScheduled = false;
    }
    uiMode = null;
    editing = null;
    editingId = null;
    previewPoseMapping = null;
    transformEditTarget = null;
    expandedMaterialGroups.clear();
    setTimeout(updateEntryButton, 0);
  }

  function renderEditor(body) {
    const slots = clothingSlotGroups();
    if (!slots.some(group => group.Name === editing.slotGroup)) editing.slotGroup = defaultClothingSlotGroup();
    const slotOptions = slots.map(group => `<option value="${escapeHTML(group.Name)}" ${group.Name === editing.slotGroup ? "selected" : ""}>${escapeHTML(group.Description || group.Name)}</option>`).join("");
    body.innerHTML = `<div class="coe-editor"><aside class="coe-editor-tools"><div class="coe-scheme-bar"><div class="coe-field"><label for="coe-name">方案</label><input id="coe-name" class="coe-title-input" maxlength="60" value="${escapeHTML(editing.name)}"><label for="coe-slot">服装部位</label><select id="coe-slot">${slotOptions}</select></div></div><nav class="coe-tool-tabs"><button class="coe-btn coe-primary" data-tool="layers">图层与姿势</button><button class="coe-btn" data-tool="materials">＋ 添加素材</button></nav><div class="coe-tool-content"></div></aside></div>`;
    body.querySelector("#coe-name").addEventListener("input", event => { editing.name = event.target.value.slice(0, 60); });
    body.querySelector("#coe-slot").addEventListener("change", event => { editing.slotGroup = event.target.value; });
    const tools = body.querySelector(".coe-editor-tools");
    tools.querySelector('[data-tool="layers"]').addEventListener("click", () => renderEditorTools(tools));
    tools.querySelector('[data-tool="materials"]').addEventListener("click", openMaterialPicker);
    renderEditorTools(tools);
  }

  function renderEditorTools(host) {
    const content = host.querySelector(".coe-tool-content");
    host.querySelectorAll("[data-tool]").forEach(button => button.classList.toggle("coe-primary", button.dataset.tool === "layers"));
    content.innerHTML = `<section class="coe-editor-section"><div class="coe-section-head"><h3>角色姿势</h3><span class="coe-badge">编辑预览</span></div><div class="coe-pose-groups"></div></section><div class="coe-hint">编辑预览只在绘制阶段隐藏可移除衣物，不会修改或同步真实 Appearance。图层固定按原素材顺序排列。</div><section class="coe-transform-editor" data-transform-editor></section><div class="coe-divider"></div><div class="coe-layer-list"></div>`;
    renderPoseControls(content.querySelector(".coe-pose-groups"));
    const layerList = content.querySelector(".coe-layer-list");
    renderLayerList(layerList);
    renderTransformEditor(content);
    ensureLayerNameCache();
    layerNameCachePromise?.then(() => { if (document.body.contains(layerList)) renderLayerList(layerList); });
  }

  const CHARACTER_REFRESH_LEVEL = Object.freeze({ visual: 1, structure: 2, full: 3 });

  function performCharacterRefresh(character, level) {
    if (!character) return;
    try {
      if (level <= CHARACTER_REFRESH_LEVEL.visual && character === globalThis.Player && uiMode === "editor" &&
        typeof globalThis.CharacterAppearanceBuildCanvas === "function" && syncLocalSyntheticRuntime(character)) {
        CharacterAppearanceBuildCanvas(character);
        character.MustDraw = false;
        return;
      }
      if (level <= CHARACTER_REFRESH_LEVEL.structure && typeof globalThis.CharacterLoadCanvas === "function") {
        CharacterLoadCanvas(character);
        return;
      }
      if (typeof globalThis.CharacterRefresh === "function") CharacterRefresh(character, false, false);
    } catch (error) {
      warn("角色预览刷新失败", error);
      // A failed lightweight redraw must not prevent other queued characters from
      // refreshing. Try the full path once as a compatibility fallback.
      if (level < CHARACTER_REFRESH_LEVEL.full && typeof globalThis.CharacterRefresh === "function") {
        try { CharacterRefresh(character, false, false); } catch (fallbackError) { warn("角色完整刷新回退失败", fallbackError); }
      }
    }
  }

  function flushCharacterRefreshes() {
    previewTimer = 0;
    characterRefreshScheduled = false;
    const pending = pendingCharacterRefreshes;
    pendingCharacterRefreshes = new Map();
    for (const [character, level] of pending) performCharacterRefresh(character, level);
  }

  function requestCharacterRefresh(character, mode = "full") {
    if (!character) return;
    const level = CHARACTER_REFRESH_LEVEL[mode] || CHARACTER_REFRESH_LEVEL.full;
    pendingCharacterRefreshes.set(character, Math.max(level, pendingCharacterRefreshes.get(character) || 0));
    if (characterRefreshScheduled) return;
    characterRefreshScheduled = true;
    if (typeof globalThis.requestAnimationFrame === "function") {
      const handle = requestAnimationFrame(flushCharacterRefreshes);
      if (characterRefreshScheduled) previewTimer = handle;
    } else if (typeof globalThis.setTimeout === "function") {
      const handle = setTimeout(flushCharacterRefreshes, 0);
      if (characterRefreshScheduled) previewTimer = handle;
    } else flushCharacterRefreshes();
  }

  function refreshPreviewLoop(mode = "visual") {
    if (uiMode !== "editor" || !editorAppearanceSnapshot || !globalThis.Player) return;
    requestCharacterRefresh(globalThis.Player, mode);
  }
