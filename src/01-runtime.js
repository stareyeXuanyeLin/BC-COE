  const MOD_NAME = "CustomOutfitEditor";
  const VERSION = "1.1.0";
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
  const OUTFIT_EXCHANGE_FORMAT = "COE_OUTFIT";
  const WARDROBE_EXCHANGE_FORMAT = "COE_WARDROBE";
  const EXCHANGE_FORMAT_VERSION = 1;
  const MAX_OUTFIT_EXCHANGE_CHARS = 200000;
  const MAX_WARDROBE_FILE_BYTES = 1048576;
  // The production BC server accepts at most 180,000 bytes per incoming
  // Socket.IO message. Keep a conservative reserve for Engine.IO/Socket.IO
  // framing and future protocol changes; the measured AccountUpdate event must
  // fit inside this smaller budget before server synchronization is attempted.
  const SERVER_SOCKET_MESSAGE_MAX_BYTES = 180000;
  const SERVER_SYNC_SAFETY_MARGIN_BYTES = 20000;
  const MAX_SERVER_SYNC_MESSAGE_BYTES = SERVER_SOCKET_MESSAGE_MAX_BYTES - SERVER_SYNC_SAFETY_MARGIN_BYTES;
  const TAG_ASSET_NAME = "COECustomOutfit";
  const TAG_PREVIEW_EMOTICON = "⋆｡ﾟ✶°☾⋆｡ﾟ";
  // R130 vanilla appearance groups explicitly marked as clothing/underwear.
  // Body decals and eye shadow are intentionally omitted because they are
  // cosmetic body features rather than removable clothing slots.
  const VANILLA_CLOTHING_SLOT_GROUPS = Object.freeze(new Set([
    "ClothOuter", "Cloth", "ClothAccessory", "Necklace", "Suit", "SuitLower", "ClothLower",
    "Bra", "Corset", "Panties", "Socks", "SocksRight", "SocksLeft", "AnkletRight", "AnkletLeft",
    "Garters", "Shoes", "Hat", "HairAccessory3", "HairAccessory1", "HairAccessory2", "Gloves",
    "HandAccessoryLeft", "HandAccessoryRight", "Bracelet", "Glasses", "Jewelry", "Mask",
    "TailStraps", "Wings",
  ]));

  let modApi = null;
  let runtimeInstalled = false;
  let initialized = false;
  let uiMode = null;
  let editing = null;
  let editingId = null;
  let syntheticByCharacter = new WeakMap();
  let wardrobe = { schemaVersion: 1, schemes: [], equippedIds: [] };
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
  let characterRefreshScheduled = false;
  let pendingCharacterRefreshes = new Map();
  let previewPoseMapping = null;
  let editorAppearanceSnapshot = null;
  let editorPoseSnapshot = null;
  let glTransformHookTarget = null;
  let glTransformHookWatch = 0;
  let visualAssetProxyCache = new WeakMap();
  let layerNameCache = null;
  let layerNameCachePromise = null;
  let colorPickerSession = null;
  let colorPickerClosing = false;
  // Only one layer or material-level target can own transform controls.
  let transformEditTarget = null;
  const expandedMaterialGroups = new Set();

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
