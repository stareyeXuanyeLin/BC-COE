  function ensureLayerNameCache() {
    if (layerNameCachePromise || typeof TextCache === "undefined") return;
    layerNameCachePromise = TextCache.buildAsync(`Assets/${globalThis.Player?.AssetFamily || "Female3DCG"}/LayerNames.csv`)
      .then(cache => { layerNameCache = cache; return cache; })
      .catch(error => { warn("图层本地化名称加载失败", error); return null; });
  }

  function getLayerLabel(asset, layer) {
    ensureLayerNameCache();
    const raw = layer?.Name ?? "";
    const key = `${asset?.DynamicGroupName || asset?.Group?.Name || ""}${asset?.Name || ""}${raw}`;
    return layerNameCache?.cache?.[key] || raw || "默认图层";
  }

  function getLayerLabelByRef(ref) {
    const asset = AssetGet(globalThis.Player?.AssetFamily || "Female3DCG", ref.sourceGroup, ref.sourceAsset);
    const layer = asset && Number.isInteger(ref.sourceLayerIndex) ? asset.Layer[ref.sourceLayerIndex] : asset?.Layer?.find(item => item.Name === ref.sourceLayer);
    return asset && layer ? getLayerLabel(asset, layer) : null;
  }

  function materialAsset(material) {
    return material ? AssetGet(globalThis.Player?.AssetFamily || "Female3DCG", material.sourceGroup, material.sourceAsset) : null;
  }

  function ensureMaterialColors(material, asset) {
    material.colors = normalizedMaterialColors(material, asset);
    if (!Array.isArray(material.defaultColors) || !material.defaultColors.length) material.defaultColors = sanitizeColorArray(asset?.DefaultColor);
    return material.colors;
  }

  function displayHexColor(value, fallback = "#ffffff") {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  }

  function normalizePickerColor(value, fallback = "Default") {
    if (value === "Default") return "Default";
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
      return `#${trimmed.slice(1).split("").map(char => char + char).join("")}`.toUpperCase();
    }
    return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toUpperCase() : fallback;
  }

  function updateColorChoice(button, color, swatchFallback, label = color) {
    if (!button) return;
    const swatch = button.querySelector(".coe-color-swatch");
    const code = button.querySelector("code");
    if (swatch) swatch.style.setProperty("--coe-color", displayHexColor(color, swatchFallback));
    if (code) code.textContent = label;
  }

  function unloadOwnedColorPicker(root = null) {
    if (colorPickerClosing) return;
    const picker = root || document.getElementById("color-picker");
    if (!picker && typeof globalThis.ColorPickerUnload !== "function") return;
    colorPickerClosing = true;
    try {
      const unload = typeof globalThis.ColorPickerUnload === "function" ? globalThis.ColorPickerUnload : null;
      unload?.();
    } catch (error) {
      warn("关闭原版颜色选择器失败", error);
    } finally {
      colorPickerClosing = false;
    }
    const remaining = document.getElementById("color-picker");
    if (remaining && (remaining === picker || remaining.classList.contains("coe-owned-color-picker"))) remaining.remove();
  }

  function closeOwnedColorPicker() {
    const session = colorPickerSession;
    const picker = session?.root || document.getElementById("color-picker");
    // session 可能已在原版 onExit 中被清空，但带有 COE 标记的残留节点仍需卸载。
    if (!session && !(picker?.classList.contains("coe-owned-color-picker"))) return;
    session?.finish();
    unloadOwnedColorPicker(picker);
  }

  async function openGameColorPicker({ heading, currentColor, defaultColor, onAccept }) {
    const init = typeof globalThis.ColorPickerInit === "function" ? globalThis.ColorPickerInit : null;
    if (!init) return false;
    if (colorPickerSession) return true;
    const existing = document.getElementById("color-picker");
    if (existing && !existing.hidden) {
      toast("请先完成当前颜色编辑", "warn");
      return true;
    }

    const initialColor = typeof currentColor === "string" ? currentColor : "Default";
    const resetColor = typeof defaultColor === "string" ? defaultColor : "Default";
    const session = {
      root: null,
      previousZIndex: "",
      closed: false,
      finish() {
        if (session.closed) return;
        session.closed = true;
        if (session.root) {
          session.root.style.zIndex = session.previousZIndex;
          session.root.classList.remove("coe-owned-color-picker");
        }
        if (colorPickerSession === session) colorPickerSession = null;
      },
    };
    colorPickerSession = session;

    try {
      const root = await init({
        heading,
        colorState: {
          colors: [initialColor],
          defaultColors: [resetColor],
          opacity: [1],
          defaultOpacity: [1],
          editOpacity: false,
        },
        onInput: () => null,
        onExit: ({ colors }, save) => {
          const selected = normalizePickerColor(colors?.[0], initialColor);
          session.finish();
          // 原版关闭回调不会保证清理 #color-picker，主动卸载并清除残留节点。
          unloadOwnedColorPicker(session.root || document.getElementById("color-picker"));
          if (!save || uiMode !== "editor" || !editing || typeof onAccept !== "function") return;
          try { onAccept(selected); } catch (error) { warn("应用颜色失败", error); toast("颜色没有应用成功", "error"); }
        },
      });
      if (session.closed) {
        unloadOwnedColorPicker(session.root || document.getElementById("color-picker"));
        return true;
      }
      session.root = root || document.getElementById("color-picker");
      if (session.root) {
        session.previousZIndex = session.root.style.zIndex;
        session.root.style.zIndex = "100020";
        session.root.classList.add("coe-owned-color-picker");
      }
      return true;
    } catch (error) {
      session.finish();
      unloadOwnedColorPicker(session.root || document.getElementById("color-picker"));
      warn("原版颜色选择器打开失败", error);
      return false;
    }
  }

  async function chooseColor(options) {
    if (await openGameColorPicker(options)) return;
    const promptFn = typeof globalThis.prompt === "function" ? globalThis.prompt : null;
    if (!promptFn) {
      toast("当前游戏版本未提供颜色选择器", "warn");
      return;
    }
    const input = promptFn("输入颜色代码（#RRGGBB）或 Default", options.currentColor || "Default");
    if (input == null) return;
    const selected = normalizePickerColor(input, null);
    if (!selected) {
      toast("颜色代码无效，请使用 #RRGGBB", "warn");
      return;
    }
    options.onAccept?.(selected);
  }

  function groupLayersByMaterial(layers) {
    const grouped = new Map();
    for (const layer of layers) {
      if (!grouped.has(layer.materialId)) grouped.set(layer.materialId, []);
      grouped.get(layer.materialId).push(layer);
    }
    return grouped;
  }

  function transformTargetLabel() {
    if (!transformEditTarget) return "未进入中心编辑";
    if (transformEditTarget.kind === "overall") return "整体服装变换中心";
    const layer = transformEditTarget.layer;
    return layer ? `${layer.sourceAsset || "素材"} · ${layer.layerLabel || layer.sourceLayer || "图层"} · 图层变换中心` : "当前图层变换中心";
  }

  function setTransformTarget(target) {
    if (transformPointer && (!target || target.kind !== transformEditTarget?.kind || target.index !== transformEditTarget?.index)) return;
    if (!target) {
      transformEditTarget = null;
      transformPointer = null;
      crosshairRemove();
    } else if (target.kind === "overall") {
      transformEditTarget = { kind: "overall" };
    } else {
      const index = Number.isInteger(target.index) ? target.index : editing?.layers?.indexOf(target.layer);
      transformEditTarget = { kind: "layer", index: index >= 0 ? index : 0, layer: editing?.layers?.[index] || target.layer };
    }
    const host = document.querySelector(`#${ROOT_ID} .coe-editor-tools`);
    if (host) renderEditorTools(host);
  }

  function setOptionalTransformValue(object, key, value, defaultValue) {
    if (!Number.isFinite(value) || Math.abs(value - defaultValue) < (key === "scale" || key === "overallScale" ? 0.001 : 0.000001)) delete object[key];
    else object[key] = value;
  }

  function setOptionalPivotValue(object, key, value, defaultValue = 0.5) {
    if (!Number.isFinite(value) || Math.abs(value - defaultValue) < 0.000001) delete object[key];
    else object[key] = value;
  }

  function resetTransformCenter() {
    if (!transformEditTarget || !editing) return;
    if (transformEditTarget.kind === "overall") {
      delete editing.overallPivotX;
      delete editing.overallPivotY;
    } else {
      const layer = editing.layers[transformEditTarget.index];
      if (layer) { delete layer.pivotX; delete layer.pivotY; transformEditTarget.layer = layer; }
    }
    refreshPreviewLoop();
    const host = document.querySelector(`#${ROOT_ID} .coe-editor-tools`);
    if (host) renderEditorTools(host);
  }

  function resetOverallTransform() {
    if (!editing) return;
    for (const key of ["overallRotation", "overallScale", "overallOffsetX", "overallOffsetY", "overallPivotX", "overallPivotY"]) delete editing[key];
    transformEditTarget = { kind: "overall" };
    refreshPreviewLoop();
    const host = document.querySelector(`#${ROOT_ID} .coe-editor-tools`);
    if (host) renderEditorTools(host);
  }

  function crosshairUpdate(clientX, clientY) {
    var el = document.getElementById("coe-crosshair");
    if (!el) {
      el = document.createElement("div");
      el.id = "coe-crosshair";
      el.className = "coe-crosshair";
      document.body.appendChild(el);
    }
    el.style.left = clientX + "px";
    el.style.top = clientY + "px";
  }

  function crosshairRemove() {
    var el = document.getElementById("coe-crosshair");
    if (el) el.remove();
  }

  function transformCanvas() {
    return getRenderedTransformCanvas()?.canvas || globalThis.GL?.canvas || globalThis.MainCanvas ||
      (typeof document?.querySelector === "function" ? document.querySelector("canvas") : null);
  }

  function bindTransformHandle(button, kind) {
    if (!button) return;
    button.addEventListener("pointerdown", event => {
      if (!transformEditTarget || !editing) return;
      event.preventDefault();
      event.stopPropagation();
      const layer = transformEditTarget.kind === "layer" ? editing.layers[transformEditTarget.index] : null;
      const overall = transformEditTarget.kind === "overall" ? resolveOverallTransform(editing, globalThis.Player) : null;
      const layerPivot = layer ? getLayerPivot(layer) : null;
      const overallDefaultPivot = overall ? computeDefaultOverallPivot(editing, globalThis.Player) : null;
      const canvas = kind === "pivot" ? transformCanvas() : null;
      transformPointer = { kind, startX: event.clientX, startY: event.clientY, layer, overall, layerPivot, overallDefaultPivot, canvas,
        layerKey: layer ? `local:${transformEditTarget.index}` : null,
        rotation: layer?.rotation || 0, scale: layer?.scale || 1, overallRotation: overall?.rotation || 0, overallScale: overall?.scale || 1 };
      // 拖拽 pivot 时显示十字光标
      if (kind === "pivot") crosshairUpdate(event.clientX, event.clientY);
      const move = moveEvent => {
        if (!transformPointer) return;
        const dx = moveEvent.clientX - transformPointer.startX;
        const dy = moveEvent.clientY - transformPointer.startY;
        const state = transformPointer;
        if (state.kind === "pivot") {
          // 十字光标跟随 client 坐标；数据则写入其对应的 BC canvas 位置。
          crosshairUpdate(moveEvent.clientX, moveEvent.clientY);
          const canvasPoint = state.canvas ? canvasPointFromClient(moveEvent.clientX, moveEvent.clientY, state.canvas) : null;
          if (state.layer && canvasPoint) {
            const geometry = getRenderedTransformGeometry(state.layerKey);
            if (!geometry) return;
            const overallTransform = state.overall || resolveOverallTransform(editing, globalThis.Player);
            const pivot = computeAbsoluteLayerPivot(canvasPoint, geometry, {
              pivotX: state.layerPivot.x, pivotY: state.layerPivot.y,
              rotation: state.rotation, scale: state.scale, overall: overallTransform,
            });
            setOptionalPivotValue(state.layer, "pivotX", pivot.x);
            setOptionalPivotValue(state.layer, "pivotY", pivot.y);
            // 同步更新 input 框，显示值就是 clamp 后实际写入的值。
            var pi = document.querySelector('[data-layer-advanced="pivotX"]');
            if (pi) pi.value = (typeof state.layer.pivotX === "number" ? state.layer.pivotX : 0.5).toFixed(2);
            pi = document.querySelector('[data-layer-advanced="pivotY"]');
            if (pi) pi.value = (typeof state.layer.pivotY === "number" ? state.layer.pivotY : 0.5).toFixed(2);
          } else if (state.overall && canvasPoint) {
            const pivot = computeAbsoluteOverallPivot(canvasPoint, state.overall);
            setOptionalPivotValue(editing, "overallPivotX", pivot.x, state.overallDefaultPivot.x);
            setOptionalPivotValue(editing, "overallPivotY", pivot.y, state.overallDefaultPivot.y);
            var pi = document.querySelector('[data-overall-field="pivotX"]');
            if (pi) pi.value = (typeof editing.overallPivotX === "number" ? editing.overallPivotX : state.overallDefaultPivot.x).toFixed(2);
            pi = document.querySelector('[data-overall-field="pivotY"]');
            if (pi) pi.value = (typeof editing.overallPivotY === "number" ? editing.overallPivotY : state.overallDefaultPivot.y).toFixed(2);
          }
        } else if (state.kind === "rotate") {
          const value = state.layer ? state.rotation + dx * Math.PI / 180 : state.overallRotation + dx * Math.PI / 180;
          if (state.layer) setOptionalTransformValue(state.layer, "rotation", clamp(value, -Math.PI, Math.PI), 0);
          else setOptionalTransformValue(editing, "overallRotation", clamp(value, -Math.PI, Math.PI), 0);
        } else {
          const value = clamp((state.layer ? state.scale : state.overallScale) * Math.max(0.1, 1 - dy / 120), 0.25, 3);
          if (state.layer) setOptionalTransformValue(state.layer, "scale", value, 1);
          else setOptionalTransformValue(editing, "overallScale", value, 1);
        }
        refreshPreviewLoop();
      };
      const done = () => {
        transformPointer = null;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", done);
        window.removeEventListener("pointercancel", done);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", done);
      window.addEventListener("pointercancel", done);
    });
  }

  function renderTransformEditor(content) {
    const host = content.querySelector("[data-transform-editor]");
    if (!host) return;
    const selectedIndex = transformEditTarget?.kind === "layer" ? transformEditTarget.index : "overall";
    const options = ['<option value="overall">整体服装整体</option>'].concat((editing?.layers || []).map((layer, index) => {
      const label = layer.layerLabel || layer.sourceLayer || `图层 #${index + 1}`;
      return `<option value="${index}">${escapeHTML(`${layer.sourceAsset || "素材"} · ${label}`)}</option>`;
    })).join("");
    host.innerHTML = `<div class="coe-transform-head"><div><strong>变换中心编辑</strong><span class="coe-muted">${escapeHTML(transformTargetLabel())}</span></div><div class="coe-actions"><select data-transform-target>${options}</select>${transformEditTarget ? '<button type="button" class="coe-btn" data-transform-done>完成</button>' : ''}</div></div><p class="coe-hint">同一中心同时控制旋转和缩放；未激活的图层不会显示变换控件。</p>${transformEditTarget ? '<div class="coe-transform-pad"><button type="button" data-transform-handle="pivot">✚ 中心</button><button type="button" data-transform-handle="rotate">↻ 旋转</button><button type="button" data-transform-handle="scale">⤢ 缩放</button></div>' : ''}`;
    const select = host.querySelector("[data-transform-target]");
    select.value = String(selectedIndex);
    select.addEventListener("change", () => {
      if (select.value === "overall") setTransformTarget({ kind: "overall" });
      else setTransformTarget({ kind: "layer", index: Number(select.value) });
    });
    host.querySelector("[data-transform-done]")?.addEventListener("click", () => setTransformTarget(null));
    bindTransformHandle(host.querySelector('[data-transform-handle="pivot"]'), "pivot");
    bindTransformHandle(host.querySelector('[data-transform-handle="rotate"]'), "rotate");
    bindTransformHandle(host.querySelector('[data-transform-handle="scale"]'), "scale");
    if (!transformEditTarget) return;
    if (transformEditTarget.kind === "overall") {
      const overall = resolveOverallTransform(editing, globalThis.Player);
      host.insertAdjacentHTML("beforeend", `<div class="coe-transform-fields"><label>旋转<input type="number" step="1" data-overall-field="rotation" value="${Math.round(overall.rotation * 180 / Math.PI * 100) / 100}">°</label><label>缩放<input type="number" step="0.05" min="0.25" max="3" data-overall-field="scale" value="${overall.scale}"></label><label>偏移 X<input type="number" step="1" data-overall-field="offsetX" value="${overall.offsetX}"></label><label>偏移 Y<input type="number" step="1" data-overall-field="offsetY" value="${overall.offsetY}"></label><label>中心 X<input type="number" step="0.01" data-overall-field="pivotX" value="${overall.pivotX}"></label><label>中心 Y<input type="number" step="0.01" data-overall-field="pivotY" value="${overall.pivotY}"></label></div><div class="coe-actions"><button type="button" class="coe-btn" data-reset-center>恢复默认中心</button><button type="button" class="coe-btn" data-reset-overall>重置整体服装变换</button></div>`);
      host.querySelectorAll("[data-overall-field]").forEach(input => input.addEventListener("input", () => {
        const field = input.dataset.overallField;
        let value = Number(input.value);
        if (!Number.isFinite(value)) return;
        if (field === "rotation") { value = clamp(value, -180, 180) * Math.PI / 180; setOptionalTransformValue(editing, "overallRotation", value, 0); }
        else if (field === "scale") { value = clamp(value, 0.25, 3); setOptionalTransformValue(editing, "overallScale", value, 1); }
        else if (field === "offsetX" || field === "offsetY") { value = clamp(value, -1200, 1200); setOptionalTransformValue(editing, `overall${field[0].toUpperCase()}${field.slice(1)}`, value, 0); }
        else {
          value = clamp(value, -OVERALL_PIVOT_LIMIT, OVERALL_PIVOT_LIMIT);
          const defaultPivot = computeDefaultOverallPivot(editing, globalThis.Player);
          setOptionalPivotValue(editing, `overall${field[0].toUpperCase()}${field.slice(1)}`, value, defaultPivot[field === "pivotX" ? "x" : "y"]);
          const actual = editing[`overall${field[0].toUpperCase()}${field.slice(1)}`];
          input.value = (typeof actual === "number" ? actual : defaultPivot[field === "pivotX" ? "x" : "y"]).toFixed(2);
        }
        refreshPreviewLoop();
      }));
      host.querySelector("[data-reset-center]")?.addEventListener("click", resetTransformCenter);
      host.querySelector("[data-reset-overall]")?.addEventListener("click", resetOverallTransform);
    } else {
      const layer = editing.layers[transformEditTarget.index];
      transformEditTarget.layer = layer;
      if (!layer) return;
      const pivot = getLayerPivot(layer);
      host.insertAdjacentHTML("beforeend", `<div class="coe-transform-fields"><label>旋转<input type="number" step="1" data-layer-advanced="rotation" value="${Math.round((layer.rotation || 0) * 180 / Math.PI * 100) / 100}">°</label><label>缩放<input type="number" step="0.05" min="0.25" max="3" data-layer-advanced="scale" value="${layer.scale || 1}"></label><label>中心 X<input type="number" step="0.01" data-layer-advanced="pivotX" value="${pivot.x}"></label><label>中心 Y<input type="number" step="0.01" data-layer-advanced="pivotY" value="${pivot.y}"></label></div><div class="coe-actions"><button type="button" class="coe-btn" data-reset-center>恢复默认中心</button></div>`);
      host.querySelectorAll("[data-layer-advanced]").forEach(input => input.addEventListener("input", () => {
        const field = input.dataset.layerAdvanced;
        let value = Number(input.value);
        if (!Number.isFinite(value)) return;
        if (field === "rotation") { value = clamp(value, -180, 180) * Math.PI / 180; setOptionalTransformValue(layer, "rotation", value, 0); }
        else if (field === "scale") { value = clamp(value, 0.25, 3); setOptionalTransformValue(layer, "scale", value, 1); }
        else { value = clamp(value, -PIVOT_LIMIT, PIVOT_LIMIT); setOptionalPivotValue(layer, field, value); input.value = (typeof layer[field] === "number" ? layer[field] : 0.5).toFixed(2); }
        refreshPreviewLoop();
      }));
      host.querySelector("[data-reset-center]")?.addEventListener("click", resetTransformCenter);
    }
  }

  function renderLayerList(list) {
    list.innerHTML = "";
    // UI redraws must not delete a temporarily unresolved layer. Reference
    // filtering happens at load/import/persistence boundaries instead.
    editing = normalizeComposition(editing, { validateReferences: false });
    if (transformEditTarget?.kind === "layer") transformEditTarget.layer = editing.layers[transformEditTarget.index] || null;
    if (!editing.layers.length && !editing.recycle.length) {
      list.innerHTML = '<div class="coe-empty"><p>还没有素材。点击“添加素材”。</p></div>';
      return;
    }
    const activeByMaterial = groupLayersByMaterial(editing.layers);
    for (const material of editing.materials) {
      const layers = (activeByMaterial.get(material.id) || []).sort((a, b) => (a.sourceLayerIndex ?? 0) - (b.sourceLayerIndex ?? 0));
      if (!layers.length) continue;
      list.appendChild(renderMaterialGroup(material, layers, list));
    }
    if (editing.recycle.length) {
      const title = document.createElement("h3");
      title.textContent = "已清除图层";
      list.appendChild(title);
      const recycledByMaterial = groupLayersByMaterial(editing.recycle);
      for (const material of editing.materials) {
        const layers = recycledByMaterial.get(material.id) || [];
        if (!layers.length) continue;
        const group = document.createElement("section");
        group.className = "coe-material-editor coe-recycled";
        group.innerHTML = `<div class="coe-material-editor-head"><strong>${escapeHTML(material.label || material.sourceAsset)}</strong><span class="coe-muted">${layers.length} 个已清除图层</span><button class="coe-btn coe-primary" data-restore-all>全部还原</button></div><div class="coe-material-editor-layers"></div>`;
        group.querySelector("[data-restore-all]").addEventListener("click", () => {
          editing.layers.push(...layers);
          editing.recycle = editing.recycle.filter(layer => layer.materialId !== material.id);
          refreshPreviewLoop();
          renderLayerList(list);
        });
        const host = group.querySelector(".coe-material-editor-layers");
        layers.sort((a, b) => (a.sourceLayerIndex ?? 0) - (b.sourceLayerIndex ?? 0)).forEach(layer => {
          const row = document.createElement("div");
          row.className = "coe-recycle-row";
          row.innerHTML = `<span>${escapeHTML(layer.layerLabel || getLayerLabelByRef(layer) || layer.sourceLayer || "默认图层")}</span><button class="coe-btn" data-restore>还原</button>`;
          row.querySelector("[data-restore]").addEventListener("click", () => {
            editing.recycle = editing.recycle.filter(item => item !== layer);
            editing.layers.push(layer);
            refreshPreviewLoop();
            renderLayerList(list);
          });
          host.appendChild(row);
        });
        list.appendChild(group);
      }
    }
  }

  function renderMaterialGroup(material, layers, list) {
    const asset = materialAsset(material);
    const colors = ensureMaterialColors(material, asset);
    const defaultHex = displayHexColor(asset?.DefaultColor?.[0], "#ffffff");
    const uniform = colors.every(color => color === colors[0]);
    const overallColor = displayHexColor(uniform ? colors[0] : colors.find(color => /^#[0-9a-f]{6}$/i.test(color)), defaultHex);
    const group = document.createElement("section");
    group.className = `coe-material-editor${material.hidden ? " coe-hidden" : ""}${material.collapsed ? " coe-collapsed" : ""}`;
    const overallLabel = uniform ? colors[0] : "多种颜色";
    group.innerHTML = `<div class="coe-material-editor-head"><button class="coe-collapse" type="button" data-collapse>${material.collapsed ? "▶" : "▼"}</button><div class="coe-material-identity"><strong>${escapeHTML(material.label || asset?.Description || material.sourceAsset)}</strong><span class="coe-muted">${escapeHTML(material.sourceGroup)} · ${layers.length} 层</span></div><label class="coe-overall-color">整体颜色<button type="button" class="coe-color-choice" data-overall-color title="使用游戏原版颜色选择器统一修改所有可着色颜色槽"><span class="coe-color-swatch"></span><code>${escapeHTML(overallLabel)}</code></button></label><button class="coe-btn" data-edit-overall>调整整体中心</button><button class="coe-btn" data-hide-material>${material.hidden ? "显示" : "隐藏"}</button><button class="coe-btn" data-reset-material>整件默认</button><button class="coe-btn coe-danger" data-remove-material>移除素材</button></div><div class="coe-material-editor-layers"></div>`;
    updateColorChoice(group.querySelector("[data-overall-color]"), overallColor, defaultHex, overallLabel);
    group.querySelector("[data-edit-overall]").addEventListener("click", () => setTransformTarget({ kind: "overall" }));
    group.querySelector("[data-collapse]").addEventListener("click", () => {
      material.collapsed = !material.collapsed;
      renderLayerList(list);
    });
    group.querySelector("[data-overall-color]").addEventListener("click", () => {
      chooseColor({
        heading: `${material.label || asset?.Description || material.sourceAsset} · 整体颜色`,
        currentColor: overallColor,
        defaultColor: "Default",
        onAccept: value => {
          const count = Math.max(1, Number(asset?.ColorableLayerCount) || colors.length);
          material.colors = Array(count).fill(value);
          layers.forEach(layer => { layer.color = null; });
          refreshPreviewLoop();
          renderLayerList(list);
        },
      });
    });
    group.querySelector("[data-hide-material]").addEventListener("click", () => {
      material.hidden = !material.hidden;
      refreshPreviewLoop();
      renderLayerList(list);
    });
    group.querySelector("[data-reset-material]").addEventListener("click", () => {
      material.colors = sanitizeColorArray(material.defaultColors?.length ? material.defaultColors : asset?.DefaultColor);
      layers.forEach(layer => {
        layer.priority = layer.defaultPriority;
        layer.offsetX = layer.defaultOffsetX;
        layer.offsetY = layer.defaultOffsetY;
        layer.opacity = layer.defaultOpacity;
        layer.color = null;
        layer.hidden = false;
        layer.rotation = layer.defaultRotation;
        layer.scale = layer.defaultScale;
        delete layer.pivotX;
        delete layer.pivotY;
      });
      refreshPreviewLoop();
      renderLayerList(list);
    });
    group.querySelector("[data-remove-material]").addEventListener("click", () => {
      const materialId = material.id;
      // 移除代表撤销当前方案对整件素材的选择：启用图层、已清除图层和素材记录都要一起移除。
      // 原始 BC Asset 不受影响，之后仍可从素材选择器重新添加。
      editing.layers = editing.layers.filter(layer => layer.materialId !== materialId);
      editing.recycle = editing.recycle.filter(layer => layer.materialId !== materialId);
      editing.materials = editing.materials.filter(item => item.id !== materialId);
      refreshPreviewLoop();
      renderLayerList(list);
    });
    if (!material.collapsed) renderMaterialLayerCards(group.querySelector(".coe-material-editor-layers"), material, layers, asset, list);
    return group;
  }

  function renderMaterialLayerCards(host, material, layers, asset, list) {
    layers.forEach((layer, layerIndex) => {
      const sourceLayer = resolveSourceLayer(asset, layer);
      const layerName = layer.layerLabel || getLayerLabelByRef(layer) || layer.sourceLayer || `默认图层 #${layer.sourceLayerIndex ?? 0}`;
      const colorIndex = sourceLayer?.ColorIndex ?? 0;
      const canColor = !!sourceLayer?.AllowColorize;
      const colorValue = displayHexColor(material.colors[colorIndex], displayHexColor(asset?.DefaultColor?.[colorIndex], "#ffffff"));
      const card = document.createElement("article");
      card.className = `coe-layer${layer.hidden ? " coe-hidden" : ""}`;
      var layerRotDeg = Math.round(((layer.rotation || 0) * 180 / Math.PI) * 100) / 100;
      var layerScaleVal = typeof layer.scale === "number" ? layer.scale : 1;
      card.innerHTML = `<div class="coe-layer-top"><span class="coe-layer-name" title="${escapeHTML(`${layer.sourceGroup}/${layer.sourceAsset}/${layerName}`)}">${escapeHTML(layerName)}</span>${sourceLayer?.ColorGroup ? `<span class="coe-badge">颜色组：${escapeHTML(sourceLayer.ColorGroup)}</span>` : ""}<button type="button" class="coe-btn" data-edit-transform>调整中心</button><button type="button" class="coe-btn" data-hide>${layer.hidden ? "显示" : "隐藏"}</button><button type="button" class="coe-btn" data-copy>复制</button><button type="button" class="coe-btn" data-reset>本层默认</button><button type="button" class="coe-btn coe-danger" data-remove>清除</button></div><div class="coe-controls"><label>图层位置<input type="number" min="-99" max="99" step="1" data-key="priority" value="${layer.priority}"></label><label>偏移 X<input type="number" min="-1200" max="1200" step="1" data-key="offsetX" value="${layer.offsetX}"></label><label>偏移 Y<input type="number" min="-1200" max="1200" step="1" data-key="offsetY" value="${layer.offsetY}"></label><label>透明度<input type="number" min="0" max="1" step="0.05" data-key="opacity" value="${layer.opacity}"></label><label>图层颜色<button type="button" class="coe-color-choice" data-layer-color="${layerIndex}" ${canColor ? "" : "disabled"} title="${canColor ? `使用游戏原版颜色选择器编辑颜色槽 ${colorIndex}` : "原版将此图层标记为不可着色"}"><span class="coe-color-swatch"></span><code>${escapeHTML(material.colors[colorIndex] || "Default")}</code></button></label></div><div class="coe-layer-transform"><label>旋转<input type="number" step="1" min="-180" max="180" data-layer-transform="rotation" value="${layerRotDeg}">°</label><label>缩放<input type="number" step="0.05" min="0.25" max="3" data-layer-transform="scale" value="${layerScaleVal}"></label></div>`;
      updateColorChoice(card.querySelector("[data-layer-color]"), material.colors[colorIndex] || "Default", colorValue);
      card.querySelector("[data-edit-transform]").addEventListener("click", () => setTransformTarget({ kind: "layer", index: editing.layers.indexOf(layer), layer }));
      card.querySelector("[data-hide]").addEventListener("click", () => {
        layer.hidden = !layer.hidden;
        refreshPreviewLoop();
        renderLayerList(list);
      });
      card.querySelector("[data-reset]").addEventListener("click", () => {
        layer.priority = layer.defaultPriority;
        layer.offsetX = layer.defaultOffsetX;
        layer.offsetY = layer.defaultOffsetY;
        layer.opacity = layer.defaultOpacity;
        layer.hidden = false;
        layer.color = null;
        layer.rotation = layer.defaultRotation;
        layer.scale = layer.defaultScale;
        delete layer.pivotX;
        delete layer.pivotY;
        if (canColor) material.colors[colorIndex] = material.defaultColors?.[colorIndex] || asset?.DefaultColor?.[colorIndex] || "Default";
        refreshPreviewLoop();
        renderLayerList(list);
      });
      card.querySelector("[data-copy]").addEventListener("click", () => {
        var copy = Object.assign({}, layer);
        copy.layerLabel = (layer.layerLabel || getLayerLabelByRef(layer) || layer.sourceLayer || "默认图层") + "_copy";
        var idx = editing.layers.indexOf(layer);
        editing.layers.splice(idx + 1, 0, copy);
        refreshPreviewLoop();
        renderLayerList(list);
      });
      card.querySelector("[data-remove]").addEventListener("click", () => {
        editing.layers = editing.layers.filter(item => item !== layer);
        editing.recycle.push(layer);
        refreshPreviewLoop();
        renderLayerList(list);
      });
      card.querySelectorAll("[data-key]").forEach(input => input.addEventListener("input", () => {
        const key = input.dataset.key;
        if (key === "opacity") layer[key] = clamp(input.value, 0, 1);
        else if (key === "priority") layer[key] = clamp(input.value, -99, 99);
        else layer[key] = clamp(input.value, -1200, 1200);
        input.value = layer[key];
        refreshPreviewLoop();
      }));
      // 图层级变换参数输入监听
      card.querySelectorAll("[data-layer-transform]").forEach(function(input) {
        input.addEventListener("input", function() {
          var raw = parseFloat(this.value);
          if (isNaN(raw)) return;
          var key = this.dataset.layerTransform;
          if (key === "rotation") {
            raw = clamp(raw, -180, 180);
            raw = Math.round(raw);
            layer.rotation = raw * Math.PI / 180;
            this.value = raw;
          } else if (key === "scale") {
            raw = clamp(raw, 0.25, 3.0);
            layer.scale = raw;
            this.value = raw;
          }
          refreshPreviewLoop();
        });
      });
      const colorButton = card.querySelector("[data-layer-color]");
      colorButton?.addEventListener("click", () => {
        if (!canColor) return;
        chooseColor({
          heading: `${material.label || asset?.Description || material.sourceAsset} · ${layerName}`,
          currentColor: material.colors[colorIndex] || "Default",
          defaultColor: material.defaultColors?.[colorIndex] || asset?.DefaultColor?.[colorIndex] || "Default",
          onAccept: value => {
            material.colors[colorIndex] = value;
            layer.color = null;
            refreshPreviewLoop();
            renderLayerList(list);
          },
        });
      });
      host.appendChild(card);
    });
  }

  function openMaterialPicker() {
    const root = document.getElementById(ROOT_ID);
    const host = root?.querySelector(".coe-editor-tools");
    const content = host?.querySelector(".coe-tool-content");
    if (!host || !content) return;
    host.querySelectorAll("[data-tool]").forEach(button => button.classList.toggle("coe-primary", button.dataset.tool === "materials"));
    content.innerHTML = '<div class="coe-material-picker"><div class="coe-material-toolbar"><input class="coe-search" type="search" placeholder="搜索装备格或服装名称……"></div><div class="coe-materials"></div></div>';
    const search = content.querySelector(".coe-search");
    const list = content.querySelector(".coe-materials");
    const render = () => renderMaterials(list, search.value);
    search.addEventListener("input", render);
    ensureLayerNameCache();
    render();
    layerNameCachePromise?.then(() => { if (document.body.contains(list)) render(); });
    search.focus();
  }

  function renderMaterials(list, query) {
    list.innerHTML = "";
    const assets = getMaterialAssets(query);
    if (!assets.length) { list.innerHTML = '<div class="coe-empty">没有匹配的已加载素材。</div>'; return; }
    const groups = new Map();
    for (const asset of assets) {
      const groupName = asset.Group?.Description || asset.Group?.Name || "未分类";
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName).push(asset);
    }
    for (const [groupName, groupAssets] of groups) {
      const section = document.createElement("section");
      section.className = "coe-material-section";
      section.innerHTML = `<h3 class="coe-material-group-title">${escapeHTML(groupName)}</h3>`;
      const grid = document.createElement("div");
      grid.className = "coe-material-group";
      for (const asset of groupAssets) {
        const drawable = asset.Layer.filter(isDrawableLayer);
        const button = document.createElement("button");
        button.className = "coe-material";
        button.title = "提取该素材的静态图片层；动画、脚本和物品功能不会复制";
        const previewPath = typeof globalThis.AssetGetPreviewPath === "function"
          ? `./${AssetGetPreviewPath(asset)}/${encodeURIComponent(asset.Name)}.png`
          : `./Assets/${asset.Group?.Family || "Female3DCG"}/${asset.DynamicGroupName || asset.Group?.Name}/Preview/${encodeURIComponent(asset.Name)}.png`;
        button.innerHTML = `<img loading="lazy" src="${escapeHTML(previewPath)}" alt=""><span><strong>${escapeHTML(asset.Description || asset.Name)}</strong><br><span class="coe-muted">${drawable.length} 层 · 静态提取</span></span>`;
        button.addEventListener("click", () => addAssetLayers(asset));
        grid.appendChild(button);
      }
      section.appendChild(grid);
      list.appendChild(section);
    }
  }

  function addAssetLayers(asset) {
    if (editing.layers.length >= MAX_LAYERS) { toast(`最多允许 ${MAX_LAYERS} 个图层`, "warn"); return; }
    const worn = (editorAppearanceSnapshot || globalThis.Player?.Appearance || []).find(item => item.Asset === asset);
    let material = editing.materials.find(item => item.sourceGroup === asset.Group.Name && item.sourceAsset === asset.Name);
    if (!material) {
      const sourceColor = sanitizeColor(worn?.Color ?? asset.DefaultColor ?? "Default");
      material = normalizeMaterial({
        sourceGroup: asset.Group.Name,
        sourceAsset: asset.Name,
        label: asset.Description || asset.Name,
        colors: Array.isArray(sourceColor) ? sourceColor : asset.DefaultColor?.map(() => sourceColor),
        defaultColors: asset.DefaultColor,
        sourceColor,
        sourceProperty: sanitizeSourceProperty(worn?.Property),
      });
      editing.materials.push(material);
    }
    ensureMaterialColors(material, asset);
    let added = 0;
    asset.Layer.forEach((layer, sourceLayerIndex) => {
      if (!isDrawableLayer(layer) || editing.layers.length >= MAX_LAYERS) return;
      const duplicate = editing.layers.some(ref => ref.materialId === material.id && ref.sourceLayerIndex === sourceLayerIndex);
      if (duplicate) return;
      const defaultOpacity = layer.Opacity ?? 1;
      editing.layers.push(normalizeLayer({ materialId: material.id, sourceGroup: asset.Group.Name, sourceAsset: asset.Name, sourceLayer: layer.Name, sourceLayerIndex, layerLabel: getLayerLabel(asset, layer), priority: layer.Priority, defaultPriority: layer.Priority, offsetX: 0, offsetY: 0, defaultOffsetX: 0, defaultOffsetY: 0, opacity: defaultOpacity, defaultOpacity, color: null, defaultColor: null, sourceColor: material.sourceColor, sourceProperty: material.sourceProperty }));
      added++;
    });
    refreshPreviewLoop();
    toast(added ? `已添加「${material.label || asset.Name}」的 ${added} 个图层` : "这些图层已经在方案中", added ? "info" : "warn");
  }

  function saveEditing() {
    if (!ensureWardrobeWritable()) return;
    editing = normalizeComposition(editing);
    if (!editing.name.trim()) editing.name = "未命名方案";
    const existingIndex = editingId ? wardrobe.schemes.findIndex(scheme => scheme.id === editingId) : -1;
    const entry = { id: editingId || uid(), composition: cloneJSON(editing) };
    if (existingIndex >= 0) wardrobe.schemes[existingIndex] = entry;
    else {
      if (wardrobe.schemes.length >= MAX_SCHEMES) { toast(`衣柜最多保存 ${MAX_SCHEMES} 套方案`, "warn"); return; }
      wardrobe.schemes.unshift(entry);
      editingId = entry.id;
    }
    wardrobe.equippedIds = [...new Set([...(wardrobe.equippedIds || []), entry.id])];
    persistWardrobe();
    restoreEditorAppearance();
    syncEquippedSchemes();
    toast(`已保存「${editing.name}」并在本地启用`);
    openWardrobe();
  }

  function openEditor(composition, id) {
    // rootShell() closes the current wardrobe UI and clears editor state, so prepare
    // the new state first and assign it only after the new shell has been created.
    const nextEditing = normalizeComposition(cloneJSON(composition), { validateReferences: false });
    const nextEditingId = id;
    previewPoseMapping = cloneJSON(globalThis.Player?.ActivePoseMapping || {});
    const actions = '<button class="coe-btn" data-action="back">← 衣柜</button><button class="coe-btn" data-action="add">＋ 添加素材</button><button class="coe-btn coe-primary" data-action="save">保存并启用</button>';
    const body = rootShell("自定义服装编辑器", actions);
    editing = nextEditing;
    editingId = nextEditingId;
    uiMode = "editor";
    const root = document.getElementById(ROOT_ID);
    root.classList.add("coe-editor-root");
    renderEditor(body);
    beginEditorPreview();
    root.querySelector('[data-action="back"]')?.addEventListener("click", openWardrobe);
    root.querySelector('[data-action="add"]')?.addEventListener("click", openMaterialPicker);
    root.querySelector('[data-action="save"]')?.addEventListener("click", saveEditing);
    refreshPreviewLoop();
  }

  function renderPoseControls(host) {
    host.innerHTML = "";
    const poseTable = typeof PoseFemale3DCG !== "undefined" ? PoseFemale3DCG : globalThis.PoseFemale3DCG;
    const poses = Array.isArray(poseTable)
      ? poseTable.filter(pose => pose.AllowMenu || pose.AllowMenuTransient)
      : [];
    const categories = ["BodyFull", "BodyLower", "BodyUpper", "BodyHands"];
    const labels = { BodyFull: "整体姿势", BodyLower: "腿部姿势", BodyUpper: "上身姿势", BodyHands: "手部姿势" };
    for (const category of categories) {
      const available = poses.filter(pose => pose.Category === category);
      if (!available.length) continue;
      const group = document.createElement("section");
      group.className = "coe-pose-group";
      group.innerHTML = `<h4>${labels[category] || category}</h4><div class="coe-pose-buttons"></div>`;
      const buttons = group.querySelector(".coe-pose-buttons");
      for (const pose of available) {
        const button = document.createElement("button");
        button.className = "coe-btn";
        button.textContent = pose.Description || pose.Name;
        button.title = pose.Name;
        if (previewPoseMapping?.[category] === pose.Name) button.classList.add("coe-active");
        button.addEventListener("click", () => {
          setPreviewPose(pose.Name);
          renderPoseControls(host);
        });
        buttons.appendChild(button);
      }
      host.appendChild(group);
    }
  }

  function setPreviewPose(poseName) {
    try {
      if (typeof globalThis.PoseSetActive !== "function" || !globalThis.Player) return;
      PoseSetActive(Player, poseName || null, true, false);
      previewPoseMapping = cloneJSON(Player.ActivePoseMapping || {});
      CharacterRefresh(Player, false, false);
    } catch (error) {
      warn("姿势切换失败", error);
      toast("当前角色无法切换到该姿势", "warn");
    }
  }
