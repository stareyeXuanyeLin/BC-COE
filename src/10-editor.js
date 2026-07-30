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

  async function openGameColorPicker({ heading, currentColor, defaultColor, onPreview, onAccept, onCancel }) {
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
      lastPreview: initialColor,
      preview(value) {
        const selected = normalizePickerColor(value, null);
        if (!selected || selected === session.lastPreview || uiMode !== "editor" || !editing) return;
        session.lastPreview = selected;
        try { onPreview?.(selected); } catch (error) { warn("预览颜色失败", error); }
      },
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
        onInput: fieldset => {
          const output = fieldset?.querySelector?.('[name="output"]');
          session.preview(output?.value);
        },
        onExit: ({ colors }, save) => {
          const selected = normalizePickerColor(colors?.[0], initialColor);
          if (save) session.preview(selected);
          session.finish();
          // 原版关闭回调不会保证清理 #color-picker，主动卸载并清除残留节点。
          unloadOwnedColorPicker(session.root || document.getElementById("color-picker"));
          if (uiMode !== "editor" || !editing) return;
          try {
            if (save) onAccept?.(selected);
            else onCancel?.(initialColor);
          } catch (error) {
            warn(save ? "应用颜色失败" : "恢复颜色失败", error);
            toast("颜色没有更新成功", "error");
          }
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

  function ensureTransformTarget() {
    if (!editing) { transformEditTarget = null; return null; }
    if (transformEditTarget?.kind === "layer" && editing.layers.includes(transformEditTarget.layer)) return transformEditTarget;
    if (transformEditTarget?.kind === "material") {
      const material = editing.materials.find(item => item === transformEditTarget.material || item.id === transformEditTarget.materialId);
      if (material) {
        transformEditTarget.material = material;
        transformEditTarget.materialId = material.id;
        return transformEditTarget;
      }
    }
    const material = editing.materials[0];
    transformEditTarget = material ? { kind: "material", materialId: material.id, material } : null;
    return transformEditTarget;
  }

  function transformTargetLabel() {
    const target = ensureTransformTarget();
    if (!target) return "请选择素材或图层";
    if (target.kind === "material") return `${target.material.label || target.material.sourceAsset} · 素材整体`;
    const material = editing?.materials?.find(item => item.id === target.layer.materialId);
    const materialLabel = material?.label || target.layer.sourceAsset || "素材";
    return `${materialLabel} · ${target.layer.layerLabel || target.layer.sourceLayer || "图层"}`;
  }

  function refreshTransformSelectionStyles(root = document.getElementById(ROOT_ID)) {
    root?.querySelectorAll(".coe-material-editor").forEach(group => {
      const selected = transformEditTarget?.kind === "material" && group.__coeMaterial === transformEditTarget.material;
      const containsSelected = transformEditTarget?.kind === "layer" && group.__coeMaterial?.id === transformEditTarget.layer?.materialId;
      group.classList.toggle("coe-selected", selected);
      group.classList.toggle("coe-contains-selected", containsSelected);
    });
    root?.querySelectorAll(".coe-layer").forEach(card => card.classList.toggle("coe-selected", transformEditTarget?.kind === "layer" && card.__coeLayer === transformEditTarget.layer));
  }

  function setTransformTarget(target) {
    if (target?.kind === "material") {
      const material = target.material || editing?.materials?.find(item => item.id === target.materialId);
      transformEditTarget = material ? { kind: "material", materialId: material.id, material } : null;
    } else if (target?.kind === "layer" && editing?.layers?.includes(target.layer)) {
      transformEditTarget = { kind: "layer", layer: target.layer };
    } else transformEditTarget = null;
    ensureTransformTarget();
    const content = document.querySelector(`#${ROOT_ID} .coe-tool-content`);
    if (content) renderTransformEditor(content);
    refreshTransformSelectionStyles();
  }

  function setOptionalTransformValue(object, key, value, defaultValue) {
    if (!Number.isFinite(value) || Math.abs(value - defaultValue) < (key === "scale" || key === "overallScale" ? 0.001 : 0.000001)) delete object[key];
    else object[key] = value;
  }

  function toggleMirrorTransform(object, key) {
    if (!object) return false;
    if (object[key] === true) delete object[key];
    else object[key] = true;
    return object[key] === true;
  }

  function applyOverallTransformField(materialId, field, rawValue) {
    const material = editing?.materials?.find(item => item.id === materialId);
    if (!material || !Number.isFinite(rawValue)) return false;
    let value = rawValue;
    if (field === "rotation") {
      value = clamp(value, -180, 180) * Math.PI / 180;
      setOptionalTransformValue(material, "overallRotation", value, 0);
    } else if (field === "scale") {
      value = clamp(value, 0.25, 3);
      setOptionalTransformValue(material, "overallScale", value, 1);
    } else if (field === "offsetX" || field === "offsetY") {
      value = clamp(value, -1200, 1200);
      setOptionalTransformValue(material, `overall${field[0].toUpperCase()}${field.slice(1)}`, value, 0);
    } else return false;
    return true;
  }

  function resetMaterialOverallTransform(material) {
    if (!material) return;
    for (const key of ["overallRotation", "overallScale", "overallOffsetX", "overallOffsetY", "overallMirrorX", "overallMirrorY"]) delete material[key];
    transformEditTarget = { kind: "material", materialId: material.id, material };
    refreshPreviewLoop();
  }

  function resetLayerToDefaults(layer, material, asset, sourceLayer) {
    if (!layer) return;
    layer.priority = layer.defaultPriority;
    layer.offsetX = layer.defaultOffsetX;
    layer.offsetY = layer.defaultOffsetY;
    layer.opacity = layer.defaultOpacity;
    layer.hidden = false;
    layer.color = null;
    layer.rotation = layer.defaultRotation;
    layer.scale = layer.defaultScale;
    delete layer.mirrorX;
    delete layer.mirrorY;
    if (sourceLayer?.AllowColorize && Number.isInteger(sourceLayer.ColorIndex)) {
      material.colors[sourceLayer.ColorIndex] = material.defaultColors?.[sourceLayer.ColorIndex] || asset?.DefaultColor?.[sourceLayer.ColorIndex] || "Default";
    }
  }

  function resetMaterialToDefaults(material) {
    if (!material) return;
    const asset = materialAsset(material);
    material.colors = sanitizeColorArray(material.defaultColors?.length ? material.defaultColors : asset?.DefaultColor);
    editing.layers.filter(layer => layer.materialId === material.id).forEach(layer => resetLayerToDefaults(layer, material, asset, resolveSourceLayer(asset, layer)));
    material.hidden = false;
    resetMaterialOverallTransform(material);
    refreshPreviewLoop("structure");
  }

  function redrawLayerEditor() {
    const content = document.querySelector(`#${ROOT_ID} .coe-tool-content`);
    const list = content?.querySelector(".coe-layer-list");
    if (!content || !list) return;
    ensureTransformTarget();
    renderLayerList(list);
    renderTransformEditor(content);
    refreshTransformSelectionStyles(content);
  }

  function renderTransformEditor(content) {
    const host = content.querySelector("[data-transform-editor]");
    if (!host) return;
    const target = ensureTransformTarget();
    const typeLabel = target?.kind === "material" ? "素材整体" : target?.kind === "layer" ? "单图层" : "未选择";
    host.innerHTML = `<div class="coe-transform-head"><div><strong>变换编辑</strong><span class="coe-muted">${escapeHTML(transformTargetLabel())}</span></div><span class="coe-badge">${typeLabel}</span></div><p class="coe-hint">点击素材标题编辑素材整体，点击图层编辑该图层。旋转与缩放围绕共用中心生效。</p>`;
    if (!target) return;

    if (target.kind === "material") {
      const material = target.material;
      const asset = materialAsset(material);
      const colors = ensureMaterialColors(material, asset);
      const defaultHex = displayHexColor(asset?.DefaultColor?.[0], "#ffffff");
      const uniform = colors.every(color => color === colors[0]);
      const overallLabel = uniform ? colors[0] : "多种颜色";
      const overallColor = displayHexColor(uniform ? colors[0] : colors.find(color => /^#[0-9a-f]{6}$/i.test(color)), defaultHex);
      const overall = resolveOverallTransform(editing, globalThis.Player, material);
      host.insertAdjacentHTML("beforeend", `<div class="coe-transform-fields"><label>整体颜色<button type="button" class="coe-color-choice" data-overall-color title="统一修改所有可着色颜色槽"><span class="coe-color-swatch"></span><code>${escapeHTML(overallLabel)}</code></button></label><label>偏移 X<input type="number" step="1" min="-1200" max="1200" data-overall-field="offsetX" value="${overall.offsetX}"></label><label>偏移 Y<input type="number" step="1" min="-1200" max="1200" data-overall-field="offsetY" value="${overall.offsetY}"></label><label>旋转<input type="number" step="1" min="-180" max="180" data-overall-field="rotation" value="${Math.round(overall.rotation * 180 / Math.PI * 100) / 100}"></label><label>缩放<input type="number" step="0.05" min="0.25" max="3" data-overall-field="scale" value="${overall.scale}"></label></div><div class="coe-actions coe-transform-actions"><button type="button" class="coe-btn ${material.overallMirrorX === true ? "coe-primary" : ""}" aria-pressed="${material.overallMirrorX === true}" data-overall-mirror="overallMirrorX">水平镜像</button><button type="button" class="coe-btn ${material.overallMirrorY === true ? "coe-primary" : ""}" aria-pressed="${material.overallMirrorY === true}" data-overall-mirror="overallMirrorY">垂直镜像</button><button type="button" class="coe-btn" data-reset-overall>重置整体变换</button><button type="button" class="coe-btn" data-reset-material>整件恢复默认</button></div>`);
      const colorButton = host.querySelector("[data-overall-color]");
      updateColorChoice(colorButton, overallColor, defaultHex, overallLabel);
      colorButton?.addEventListener("click", () => {
        const originalColors = [...material.colors];
        const originalLayerColors = editing.layers.filter(layer => layer.materialId === material.id).map(layer => [layer, layer.color]);
        const applyColor = value => {
          const count = Math.max(1, Number(asset?.ColorableLayerCount) || material.colors.length);
          material.colors = Array(count).fill(value);
          originalLayerColors.forEach(([layer]) => { layer.color = null; });
          updateColorChoice(colorButton, value, defaultHex, value);
          refreshPreviewLoop();
        };
        chooseColor({
          heading: `${material.label || asset?.Description || material.sourceAsset} · 整体颜色`,
          currentColor: overallColor,
          defaultColor: "Default",
          onPreview: applyColor,
          onAccept: value => { applyColor(value); renderTransformEditor(content); },
          onCancel: () => {
            material.colors = originalColors;
            originalLayerColors.forEach(([layer, color]) => { layer.color = color; });
            refreshPreviewLoop();
            renderTransformEditor(content);
          },
        });
      });
      host.querySelectorAll("[data-overall-field]").forEach(input => input.addEventListener("input", () => {
        if (applyOverallTransformField(material.id, input.dataset.overallField, Number(input.value))) refreshPreviewLoop();
      }));
      host.querySelectorAll("[data-overall-mirror]").forEach(button => button.addEventListener("click", () => {
        const active = toggleMirrorTransform(material, button.dataset.overallMirror);
        button.classList.toggle("coe-primary", active);
        button.setAttribute("aria-pressed", String(active));
        refreshPreviewLoop();
      }));
      host.querySelector("[data-reset-overall]")?.addEventListener("click", () => {
        resetMaterialOverallTransform(material);
        renderTransformEditor(content);
      });
      host.querySelector("[data-reset-material]")?.addEventListener("click", () => {
        resetMaterialToDefaults(material);
        redrawLayerEditor();
      });
      return;
    }

    const layer = target.layer;
    const material = editing.materials.find(item => item.id === layer.materialId);
    const asset = materialAsset(material);
    const sourceLayer = resolveSourceLayer(asset, layer);
    const colorIndex = sourceLayer?.ColorIndex ?? 0;
    const canColor = !!sourceLayer?.AllowColorize;
    const colorValue = displayHexColor(material?.colors?.[colorIndex], displayHexColor(asset?.DefaultColor?.[colorIndex], "#ffffff"));
    host.insertAdjacentHTML("beforeend", `<div class="coe-transform-fields"><label>层级<input type="number" min="-99" max="99" step="1" data-layer-field="priority" value="${layer.priority}"></label><label>偏移 X<input type="number" min="-1200" max="1200" step="1" data-layer-field="offsetX" value="${layer.offsetX}"></label><label>偏移 Y<input type="number" min="-1200" max="1200" step="1" data-layer-field="offsetY" value="${layer.offsetY}"></label><label>透明度<input type="number" min="0" max="1" step="0.05" data-layer-field="opacity" value="${layer.opacity}"></label><label>颜色<button type="button" class="coe-color-choice" data-layer-color ${canColor ? "" : "disabled"} title="${canColor ? `编辑颜色槽 ${colorIndex}` : "原版将此图层标记为不可着色"}"><span class="coe-color-swatch"></span><code>${escapeHTML(material?.colors?.[colorIndex] || "Default")}</code></button></label><label>旋转<input type="number" step="1" min="-180" max="180" data-layer-field="rotation" value="${Math.round((layer.rotation || 0) * 180 / Math.PI * 100) / 100}"></label><label>缩放<input type="number" step="0.05" min="0.25" max="3" data-layer-field="scale" value="${layer.scale || 1}"></label></div><div class="coe-actions coe-transform-actions"><button type="button" class="coe-btn ${layer.mirrorX === true ? "coe-primary" : ""}" aria-pressed="${layer.mirrorX === true}" data-layer-mirror="mirrorX">水平镜像</button><button type="button" class="coe-btn ${layer.mirrorY === true ? "coe-primary" : ""}" aria-pressed="${layer.mirrorY === true}" data-layer-mirror="mirrorY">垂直镜像</button><button type="button" class="coe-btn" data-reset-layer>恢复本层默认</button></div>`);
    const colorButton = host.querySelector("[data-layer-color]");
    updateColorChoice(colorButton, material?.colors?.[colorIndex] || "Default", colorValue);
    host.querySelectorAll("[data-layer-field]").forEach(input => input.addEventListener("input", () => {
      const key = input.dataset.layerField;
      let value = Number(input.value);
      if (!Number.isFinite(value)) return;
      if (key === "priority") value = clamp(value, -99, 99);
      else if (key === "opacity") value = clamp(value, 0, 1);
      else if (key === "offsetX" || key === "offsetY") value = clamp(value, -1200, 1200);
      else if (key === "rotation") { value = clamp(value, -180, 180) * Math.PI / 180; setOptionalTransformValue(layer, "rotation", value, 0); refreshPreviewLoop(); return; }
      else if (key === "scale") { value = clamp(value, 0.25, 3); setOptionalTransformValue(layer, "scale", value, 1); refreshPreviewLoop(); return; }
      layer[key] = value;
      input.value = value;
      refreshPreviewLoop(key === "priority" ? "structure" : "visual");
    }));
    host.querySelectorAll("[data-layer-mirror]").forEach(button => button.addEventListener("click", () => {
      const active = toggleMirrorTransform(layer, button.dataset.layerMirror);
      button.classList.toggle("coe-primary", active);
      button.setAttribute("aria-pressed", String(active));
      refreshPreviewLoop();
    }));
    colorButton?.addEventListener("click", () => {
      if (!canColor || !material) return;
      const originalColor = material.colors[colorIndex];
      const originalLayerColor = layer.color;
      const applyColor = value => {
        material.colors[colorIndex] = value;
        layer.color = null;
        updateColorChoice(colorButton, value, colorValue, value);
        refreshPreviewLoop();
      };
      chooseColor({
        heading: `${material.label || asset?.Description || material.sourceAsset} · ${layer.layerLabel || getLayerLabelByRef(layer) || layer.sourceLayer || "图层"}`,
        currentColor: material.colors[colorIndex] || "Default",
        defaultColor: material.defaultColors?.[colorIndex] || asset?.DefaultColor?.[colorIndex] || "Default",
        onPreview: applyColor,
        onAccept: value => { applyColor(value); renderTransformEditor(content); },
        onCancel: () => {
          material.colors[colorIndex] = originalColor;
          layer.color = originalLayerColor;
          refreshPreviewLoop();
          renderTransformEditor(content);
        },
      });
    });
    host.querySelector("[data-reset-layer]")?.addEventListener("click", () => {
      resetLayerToDefaults(layer, material, asset, sourceLayer);
      refreshPreviewLoop("structure");
      redrawLayerEditor();
    });
  }

  function renderLayerList(list) {
    list.innerHTML = "";
    // Editor state is normalized at open/import/save boundaries. Preserve object
    // identities during UI redraws so selection and live preview keep stable refs.
    ensureTransformTarget();
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
          transformEditTarget = { kind: "material", materialId: material.id, material };
          refreshPreviewLoop("structure");
          redrawLayerEditor();
        });
        const host = group.querySelector(".coe-material-editor-layers");
        layers.sort((a, b) => (a.sourceLayerIndex ?? 0) - (b.sourceLayerIndex ?? 0)).forEach(layer => {
          const row = document.createElement("div");
          row.className = "coe-recycle-row";
          row.innerHTML = `<span>${escapeHTML(layer.layerLabel || getLayerLabelByRef(layer) || layer.sourceLayer || "默认图层")}</span><button class="coe-btn" data-restore>还原</button>`;
          row.querySelector("[data-restore]").addEventListener("click", () => {
            editing.recycle = editing.recycle.filter(item => item !== layer);
            editing.layers.push(layer);
            transformEditTarget = { kind: "layer", layer };
            refreshPreviewLoop("structure");
            redrawLayerEditor();
          });
          host.appendChild(row);
        });
        list.appendChild(group);
      }
    }
  }

  function renderMaterialGroup(material, layers, list) {
    const asset = materialAsset(material);
    ensureMaterialColors(material, asset);
    const group = document.createElement("section");
    group.__coeMaterial = material;
    const materialSelected = transformEditTarget?.kind === "material" && transformEditTarget.material === material;
    const containsSelected = transformEditTarget?.kind === "layer" && transformEditTarget.layer?.materialId === material.id;
    group.className = `coe-material-editor${material.hidden ? " coe-hidden" : ""}${material.collapsed ? " coe-collapsed" : ""}${materialSelected ? " coe-selected" : ""}${containsSelected ? " coe-contains-selected" : ""}`;
    group.innerHTML = `<div class="coe-material-editor-head"><button class="coe-collapse" type="button" data-collapse>${material.collapsed ? "▶" : "▼"}</button><button type="button" class="coe-material-identity" data-select-material><strong>${escapeHTML(material.label || asset?.Description || material.sourceAsset)}</strong><span class="coe-muted">${escapeHTML(material.sourceGroup)} · ${layers.length} 层</span></button><button class="coe-btn" data-hide-material>${material.hidden ? "显示" : "隐藏"}</button><button class="coe-btn coe-danger" data-remove-material>移除素材</button></div><div class="coe-material-editor-layers"></div>`;
    group.querySelector("[data-select-material]").addEventListener("click", () => setTransformTarget({ kind: "material", material }));
    group.querySelector("[data-collapse]").addEventListener("click", () => {
      material.collapsed = !material.collapsed;
      renderLayerList(list);
    });
    group.querySelector("[data-hide-material]").addEventListener("click", () => {
      material.hidden = !material.hidden;
      refreshPreviewLoop("structure");
      redrawLayerEditor();
    });
    group.querySelector("[data-remove-material]").addEventListener("click", () => {
      const materialId = material.id;
      // 移除代表撤销当前方案对整件素材的选择：启用图层、已清除图层和素材记录都要一起移除。
      // 原始 BC Asset 不受影响，之后仍可从素材选择器重新添加。
      editing.layers = editing.layers.filter(layer => layer.materialId !== materialId);
      editing.recycle = editing.recycle.filter(layer => layer.materialId !== materialId);
      editing.materials = editing.materials.filter(item => item.id !== materialId);
      if (transformEditTarget?.materialId === materialId || transformEditTarget?.layer?.materialId === materialId) transformEditTarget = null;
      refreshPreviewLoop("structure");
      redrawLayerEditor();
    });
    if (!material.collapsed) renderMaterialLayerCards(group.querySelector(".coe-material-editor-layers"), material, layers, asset);
    return group;
  }

  function nextCopyLayerLabel(layer, composition = editing) {
    const current = layer?.layerLabel || getLayerLabelByRef(layer) || layer?.sourceLayer || "默认图层";
    const base = current.replace(/(?:_copy)+$/i, "").replace(/_副本\d+$/, "");
    const labels = new Set([...(composition?.layers || []), ...(composition?.recycle || [])]
      .filter(item => !layer?.materialId || item.materialId === layer.materialId)
      .map(item => item.layerLabel || getLayerLabelByRef(item) || item.sourceLayer || "默认图层"));
    let suffix = 1;
    while (labels.has(`${base}_副本${suffix}`)) suffix++;
    return `${base}_副本${suffix}`;
  }

  function renderMaterialLayerCards(host, material, layers, asset) {
    layers.forEach(layer => {
      const sourceLayer = resolveSourceLayer(asset, layer);
      const layerName = layer.layerLabel || getLayerLabelByRef(layer) || layer.sourceLayer || `默认图层 #${layer.sourceLayerIndex ?? 0}`;
      const card = document.createElement("article");
      card.__coeLayer = layer;
      card.className = `coe-layer${layer.hidden ? " coe-hidden" : ""}${transformEditTarget?.kind === "layer" && transformEditTarget.layer === layer ? " coe-selected" : ""}`;
      card.innerHTML = `<div class="coe-layer-top"><button type="button" class="coe-layer-name" data-select-layer title="${escapeHTML(`${layer.sourceGroup}/${layer.sourceAsset}/${layerName}`)}">${escapeHTML(layerName)}</button>${sourceLayer?.ColorGroup ? `<span class="coe-badge">颜色组：${escapeHTML(sourceLayer.ColorGroup)}</span>` : ""}${layer.hidden ? '<span class="coe-badge">已隐藏</span>' : ""}<button type="button" class="coe-btn" data-hide>${layer.hidden ? "显示" : "隐藏"}</button><button type="button" class="coe-btn" data-copy>复制</button><button type="button" class="coe-btn coe-danger" data-remove>清除</button></div>`;
      card.querySelector("[data-select-layer]").addEventListener("click", () => setTransformTarget({ kind: "layer", layer }));
      card.addEventListener("click", event => {
        if (!event.target.closest("button")) setTransformTarget({ kind: "layer", layer });
      });
      card.querySelector("[data-hide]").addEventListener("click", () => {
        layer.hidden = !layer.hidden;
        transformEditTarget = { kind: "layer", layer };
        refreshPreviewLoop("structure");
        redrawLayerEditor();
      });
      card.querySelector("[data-copy]").addEventListener("click", () => {
        var copy = Object.assign({}, layer);
        copy.layerLabel = nextCopyLayerLabel(layer);
        var idx = editing.layers.indexOf(layer);
        editing.layers.splice(idx + 1, 0, copy);
        transformEditTarget = { kind: "layer", layer: copy };
        refreshPreviewLoop("structure");
        redrawLayerEditor();
      });
      card.querySelector("[data-remove]").addEventListener("click", () => {
        const index = editing.layers.indexOf(layer);
        const siblingLayers = editing.layers.filter(item => item.materialId === layer.materialId && item !== layer);
        editing.layers = editing.layers.filter(item => item !== layer);
        editing.recycle.push(layer);
        if (transformEditTarget?.layer === layer) {
          const nextLayer = siblingLayers.find(item => editing.layers.indexOf(item) >= index) || siblingLayers[siblingLayers.length - 1];
          const parent = editing.materials.find(item => item.id === layer.materialId);
          transformEditTarget = nextLayer ? { kind: "layer", layer: nextLayer } : parent ? { kind: "material", materialId: parent.id, material: parent } : null;
        }
        refreshPreviewLoop("structure");
        redrawLayerEditor();
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

  function materialPreviewPath(asset) {
    const rawPath = typeof globalThis.AssetGetPreviewPath === "function"
      ? `${AssetGetPreviewPath(asset)}/${asset.Name}.png`
      : `Assets/${asset.Group?.Family || "Female3DCG"}/${asset.DynamicGroupName || asset.Group?.Name}/Preview/${asset.Name}.png`;
    // Third-party providers normally hook BC's image cache loader rather than
    // arbitrary DOM <img> requests. Resolve through DrawGetImage first so
    // image-mapping mods can replace the virtual BC path with a CDN URL.
    if (typeof globalThis.DrawGetImage === "function") {
      try {
        const resolved = DrawGetImage(rawPath);
        if (typeof resolved?.currentSrc === "string" && resolved.currentSrc) return resolved.currentSrc;
        if (typeof resolved?.src === "string" && resolved.src) return resolved.src;
      } catch (error) {
        warn(`素材预览路径解析失败：${asset.Group?.Name || "?"}/${asset.Name || "?"}`, error);
      }
    }
    return `./${rawPath}`;
  }

  function renderMaterials(list, query) {
    list.innerHTML = "";
    const groups = getMaterialAssetGroups(query);
    if (!groups.length) { list.innerHTML = '<div class="coe-empty">没有匹配的已加载服装素材。</div>'; return; }
    const searching = typeof query === "string" && query.trim().length > 0;
    for (const group of groups) {
      const { key: groupKey, label: groupName, assets: groupAssets } = group;
      const section = document.createElement("section");
      const collapsed = !searching && !expandedMaterialGroups.has(groupKey);
      section.className = `coe-material-section${collapsed ? " coe-collapsed" : ""}`;
      section.innerHTML = `<h3 class="coe-material-group-title"><button type="button" class="coe-material-group-toggle" aria-expanded="${!collapsed}"><span>${collapsed ? "▶" : "▼"}</span><strong>${escapeHTML(groupName)}</strong><small>${groupAssets.length}</small></button></h3>`;
      section.querySelector(".coe-material-group-toggle").addEventListener("click", () => {
        if (searching) return;
        if (expandedMaterialGroups.has(groupKey)) expandedMaterialGroups.delete(groupKey);
        else expandedMaterialGroups.add(groupKey);
        renderMaterials(list, query);
      });
      // Opening the picker only builds lightweight category headers. Asset cards,
      // preview URL resolution and image requests begin when a category is opened.
      if (!collapsed) {
        const grid = document.createElement("div");
        grid.className = "coe-material-group";
        for (const asset of groupAssets) {
          const drawable = asset.Layer.filter(isDrawableLayer);
          const button = document.createElement("button");
          button.className = "coe-material";
          button.title = "提取该素材的静态图片层；动画、脚本和物品功能不会复制";
          const previewPath = materialPreviewPath(asset);
          button.innerHTML = `<img loading="lazy" src="${escapeHTML(previewPath)}" alt=""><span><strong>${escapeHTML(asset.Description || asset.Name)}</strong><br><span class="coe-muted">${drawable.length} 层 · 静态提取</span></span>`;
          button.addEventListener("click", () => addAssetLayers(asset));
          grid.appendChild(button);
        }
        section.appendChild(grid);
      }
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
        colors: Array.isArray(sourceColor) ? sourceColor : (asset.DefaultColor?.map(() => sourceColor) ?? []),
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
    transformEditTarget = { kind: "material", materialId: material.id, material };
    refreshPreviewLoop("structure");
    toast(added ? `已添加「${material.label || asset.Name}」的 ${added} 个图层` : "这些图层已经在方案中", added ? "info" : "warn");
  }

  function saveEditing() {
    if (!ensureWardrobeWritable()) return;
    const previousWardrobe = cloneJSON(wardrobe);
    const previousEditing = cloneJSON(editing);
    const previousEditingId = editingId;
    try {
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
      if (!activateScheme(entry, true)) throw new Error("tag-equip-failed");
      persistWardrobe();
    } catch (error) {
      wardrobe = previousWardrobe;
      editing = previousEditing;
      editingId = previousEditingId;
      toast(`保存失败: ${error?.message || error}`, "error");
      return;
    }
    restoreEditorAppearance();
    syncEquippedSchemes();
    toast(`已保存并穿上「${editing.name}」`);
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

  function localizedPoseLabel(pose) {
    const labels = {
      BaseUpper: "自然上身", BackBoxTie: "背后箱式缚", BackCuffs: "背后并手", BackElbowTouch: "背后合肘",
      OverTheHead: "双手过头", Yoked: "双手平举", TapedHands: "双手并拢",
      BaseLower: "自然站立", Kneel: "跪姿", KneelingSpread: "跪姿张腿", LegsClosed: "双腿并拢",
      LegsOpen: "双腿分开", Spread: "双腿张开", Hogtied: "四肢反绑", AllFours: "四肢着地", Suspension: "悬吊",
    };
    if (labels[pose?.Name]) return labels[pose.Name];
    if (typeof pose?.Description === "string" && /[\u3400-\u9fff]/.test(pose.Description)) return pose.Description;
    return pose?.Description || pose?.Name || "姿势";
  }

  function renderPoseControls(host) {
    host.innerHTML = "";
    const poseTable = typeof PoseFemale3DCG !== "undefined" ? PoseFemale3DCG : globalThis.PoseFemale3DCG;
    const poses = Array.isArray(poseTable)
      ? poseTable.filter(pose => pose.AllowMenu || pose.AllowMenuTransient)
      : [];
    const categories = ["BodyFull", "BodyLower", "BodyUpper", "BodyHands", "BodyAddon"];
    const labels = { BodyFull: "整体", BodyLower: "腿部", BodyUpper: "上身", BodyHands: "手部", BodyAddon: "附加" };
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
        button.textContent = localizedPoseLabel(pose);
        button.title = `${localizedPoseLabel(pose)} (${pose.Name})`;
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
