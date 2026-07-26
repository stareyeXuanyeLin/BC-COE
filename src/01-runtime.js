  const MOD_NAME = "CustomOutfitEditor";
  const VERSION = "1.8.1";
  console.info(`[${MOD_NAME}] userscript injected`, location.href);
  const SETTINGS_KEY = "CustomOutfitEditor";
  const STORAGE_KEY = "BC.CustomOutfitEditor.v1";
  const STYLE_ID = "coe-style";
  const BUTTON_ID = "coe-entry-button";
  const ROOT_ID = "coe-root";
  const MAX_SCHEMES = 40;
  const MAX_LAYERS = 120;
  const MAX_MATERIAL_BYTES = 8192;
  const MAX_SCHEME_BYTES = 65536;
  const MAX_WARDROBE_BYTES = 262144;

  let modApi = null;
  let runtimeInstalled = false;
  let initialized = false;
  let uiMode = null;
  let editing = null;
  let editingId = null;
  let syntheticByCharacter = new WeakMap();
  // 最近一帧实际绘制几何，供编辑器把 client 坐标转换为 BC canvas 坐标。
  // key 是非持久化的运行时图层 key，绝不进入方案或远程协议。
  let renderedTransformGeometry = new Map();
  let renderedTransformCanvas = null;
  function getRenderedTransformGeometry(key) { return renderedTransformGeometry.get(key) || null; }
  function getRenderedTransformCanvas() { return renderedTransformCanvas; }
  let wardrobe = { version: 5, schemes: [], equippedIds: [] };
  let wardrobeReadState = { status: "absent", source: null, server: null, local: null, conflict: false };
  let persistenceBlocked = false;
  let duplicateInstance = false;
  let activeComposition = null;
  let capabilityCache = new WeakMap();
  let runtimeMaterialState = new Map();
  let diagnostics = {
    outboundSyntheticFiltered: 0,
    skippedMaterials: [],
    lastWarnings: [],
  };
  let previewTimer = 0;
  let previewPoseMapping = null;
  let editorAppearanceSnapshot = null;
  let editorPoseSnapshot = null;
  let layerNameCache = null;
  let layerNameCachePromise = null;
  let colorPickerSession = null;
  let colorPickerClosing = false;
  // Only one layer or composition-level target can own transform controls.
  let transformEditTarget = null;
  let transformPointer = null;

  const log = (...args) => console.log(`[${MOD_NAME}]`, ...args);
  const warn = (...args) => console.warn(`[${MOD_NAME}]`, ...args);
  const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || 0));
  const cloneJSON = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const utf8Bytes = value => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : unescape(encodeURIComponent(text)).length;
  };
  const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const escapeHTML = (value) => String(value ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]);

  function toast(message, kind = "info") {
    const host = document.getElementById(ROOT_ID) || document.body;
    if (!host) return;
    const el = document.createElement("div");
    el.className = `coe-toast coe-${kind}`;
    el.textContent = message;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("coe-show"));
    setTimeout(() => {
      el.classList.remove("coe-show");
      setTimeout(() => el.remove(), 220);
    }, 2600);
  }
