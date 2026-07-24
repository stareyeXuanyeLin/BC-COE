  const REMOTE_PROTOCOL = "COE_RVS/2";
  const REMOTE_PREFIX = `${REMOTE_PROTOCOL}|`;
  const REMOTE_LIMITS = Object.freeze({
    content: 1800, chunkData: 1200, chunks: 32, snapshotBytes: 32768,
    materialBytes: 8192, materials: 32, layers: 120, string: 64, color: 40,
  });
  const REMOTE_TYPES = new Set(["STATE", "REQUEST", "CHUNK", "CLEAR"]);
  const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

  function remotePlainObject(value) {
    if (!value || Object.prototype.toString.call(value) !== "[object Object]") return false;
    const proto = Object.getPrototypeOf(value);
    // JSON values created in another realm (tests/iframes) still have a plain
    // Object prototype whose own prototype is null. Class instances do not.
    return proto === null || proto === Object.prototype || (Object.getPrototypeOf(proto) === null && proto.constructor?.name === "Object");
  }

  function remoteAssertTree(value, depth = 0, seen = new Set()) {
    if (value == null || typeof value === "boolean" || typeof value === "string") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("remote-number");
      return;
    }
    if (depth > 3) throw new Error("remote-depth");
    if (typeof value !== "object" || seen.has(value)) throw new Error("remote-object");
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 120) throw new Error("remote-array");
      for (const entry of value) remoteAssertTree(entry, depth, seen);
    } else {
      if (!remotePlainObject(value)) throw new Error("remote-not-plain");
      const keys = Object.keys(value);
      if (keys.length > 128) throw new Error("remote-keys");
      for (const key of keys) {
        if (POLLUTION_KEYS.has(key)) throw new Error("remote-pollution");
        if (key.length > 40) throw new Error("remote-key-length");
        remoteAssertTree(value[key], depth + 1, seen);
      }
    }
    seen.delete(value);
  }

  function remoteString(value, name, max = REMOTE_LIMITS.string, pattern = null) {
    if (typeof value !== "string" || !value || value.length > max || (pattern && !pattern.test(value))) throw new Error(`remote-${name}`);
    return value;
  }

  function remoteInteger(value, name, min = 0, max = 0x7fffffff) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`remote-${name}`);
    return value;
  }

  function normalizeRemoteNumber(value, min, max) {
    if (!Number.isFinite(value)) throw new Error("snapshot-number");
    const bounded = Math.min(max, Math.max(min, value));
    const rounded = Math.round(bounded * 10000) / 10000;
    return Object.is(rounded, -0) ? 0 : rounded;
  }

  function validateRemoteProperty(value) {
    if (value == null) return undefined;
    if (!remotePlainObject(value)) throw new Error("snapshot-property");
    const allowed = new Set(["Type", "Mirror", "Invert", "Rotation", "ScaleX", "ScaleY", "TypeRecord"]);
    const output = {};
    for (const key of Object.keys(value)) {
      if (!allowed.has(key) || POLLUTION_KEYS.has(key)) throw new Error("snapshot-property-key");
    }
    if (value.Type != null) output.Type = remoteString(value.Type, "property-type", 40);
    if (value.Mirror != null) {
      if (typeof value.Mirror !== "boolean") throw new Error("snapshot-property-mirror");
      output.Mirror = value.Mirror;
    }
    if (value.Invert != null) {
      if (typeof value.Invert !== "boolean") throw new Error("snapshot-property-invert");
      output.Invert = value.Invert;
    }
    if (value.Rotation != null) {
      if (typeof value.Rotation !== "number" || !Number.isFinite(value.Rotation)) throw new Error("snapshot-property-rotation");
      output.Rotation = normalizeRemoteNumber(value.Rotation, -Math.PI, Math.PI);
    }
    if (value.ScaleX != null) {
      if (typeof value.ScaleX !== "number" || !Number.isFinite(value.ScaleX)) throw new Error("snapshot-property-scalex");
      output.ScaleX = normalizeRemoteNumber(value.ScaleX, 0.25, 3.0);
    }
    if (value.ScaleY != null) {
      if (typeof value.ScaleY !== "number" || !Number.isFinite(value.ScaleY)) throw new Error("snapshot-property-scaley");
      output.ScaleY = normalizeRemoteNumber(value.ScaleY, 0.25, 3.0);
    }
    if (value.TypeRecord != null) output.TypeRecord = sanitizePlainRecord(value.TypeRecord);
    return Object.keys(output).length ? output : undefined;
  }

  function validateRemoteSnapshot(value) {
    remoteAssertTree(value);
    if (!remotePlainObject(value) || value.v !== 1 || !Array.isArray(value.m) || !Array.isArray(value.l)) throw new Error("snapshot-root");
    if (value.m.length > REMOTE_LIMITS.materials || value.l.length > REMOTE_LIMITS.layers) throw new Error("snapshot-count");
    for (const key of Object.keys(value)) if (!new Set(["v", "m", "l"]).has(key)) throw new Error("snapshot-root-key");
    const materials = value.m.map(material => {
      if (!remotePlainObject(material)) throw new Error("snapshot-material");
      for (const key of Object.keys(material)) if (!new Set(["g", "a", "c", "p"]).has(key)) throw new Error("snapshot-material-key");
      const output = { g: remoteString(material.g, "group"), a: remoteString(material.a, "asset") };
      if (!Array.isArray(material.c) || material.c.length > 40) throw new Error("snapshot-colors");
      output.c = material.c.map(color => remoteString(color, "color", REMOTE_LIMITS.color));
      const property = validateRemoteProperty(material.p);
      if (property) output.p = property;
      return output;
    });
    const layers = value.l.map(layer => {
      if (!remotePlainObject(layer)) throw new Error("snapshot-layer");
      for (const key of Object.keys(layer)) if (!new Set(["m", "n", "i", "p", "x", "y", "o"]).has(key)) throw new Error("snapshot-layer-key");
      const output = {
        m: remoteInteger(layer.m, "material-index", 0, Math.max(0, materials.length - 1)),
        n: layer.n == null ? null : remoteString(layer.n, "layer-name"),
        i: remoteInteger(layer.i, "layer-index", 0, 999),
        p: normalizeRemoteNumber(layer.p, -99, 99),
        x: normalizeRemoteNumber(layer.x, -1200, 1200),
        y: normalizeRemoteNumber(layer.y, -1200, 1200),
        o: normalizeRemoteNumber(layer.o, 0, 1),
      };
      return output;
    });
    const snapshot = { v: 1, m: materials, l: layers };
    const canonical = JSON.stringify(snapshot);
    if (utf8Bytes(canonical) > REMOTE_LIMITS.snapshotBytes) throw new Error("snapshot-byte-budget");
    for (let index = 0; index < materials.length; index++) {
      const refs = layers.filter(layer => layer.m === index);
      if (utf8Bytes({ m: materials[index], l: refs }) > REMOTE_LIMITS.materialBytes) throw new Error("snapshot-material-budget");
    }
    return snapshot;
  }

  function canonicalRemoteSnapshot(value) {
    return JSON.stringify(validateRemoteSnapshot(value));
  }

  async function sha256Base64Url(text) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error("crypto-subtle-unavailable");
    const bytes = new TextEncoder().encode(text);
    const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
    return bytesToBase64Url(digest);
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlToBytes(value, maxBytes = REMOTE_LIMITS.snapshotBytes) {
    remoteString(value, "base64url", Math.ceil(maxBytes * 4 / 3) + 4, /^[A-Za-z0-9_-]+$/);
    const estimated = Math.floor(value.length * 3 / 4);
    if (estimated > maxBytes) throw new Error("remote-decoded-budget");
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
    let binary;
    try { binary = atob(padded); } catch (_) { throw new Error("remote-base64url"); }
    if (binary.length > maxBytes) throw new Error("remote-decoded-budget");
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  function encodeRemoteText(text) {
    return bytesToBase64Url(new TextEncoder().encode(text));
  }

  function decodeRemoteText(value) {
    return new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(value));
  }

  function splitRemoteData(value) {
    remoteString(value, "chunk-source", REMOTE_LIMITS.chunks * REMOTE_LIMITS.chunkData, /^[A-Za-z0-9_-]+$/);
    const chunks = [];
    for (let index = 0; index < value.length; index += REMOTE_LIMITS.chunkData) chunks.push(value.slice(index, index + REMOTE_LIMITS.chunkData));
    if (!chunks.length || chunks.length > REMOTE_LIMITS.chunks) throw new Error("remote-chunk-count");
    return chunks;
  }

  function validateRemoteEnvelope(value) {
    remoteAssertTree(value);
    if (!remotePlainObject(value) || !REMOTE_TYPES.has(value.t)) throw new Error("remote-envelope");
    const allowed = value.t === "STATE" ? new Set(["t", "s", "r", "h", "z", "sharing"])
      : value.t === "CLEAR" ? new Set(["t", "s"])
      : value.t === "REQUEST" ? new Set(["t", "requestId", "session", "revision", "hash"])
      : new Set(["t", "requestId", "session", "revision", "hash", "index", "count", "data"]);
    for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error("remote-envelope-key");
    if (value.t === "STATE") {
      if (typeof value.sharing !== "boolean") throw new Error("remote-sharing");
      const state = { t: "STATE", s: remoteString(value.s, "session", 32, /^[A-Za-z0-9_-]+$/), r: remoteInteger(value.r, "revision"), h: value.h === "" ? "" : remoteString(value.h, "hash", 64, /^[A-Za-z0-9_-]+$/), z: remoteInteger(value.z, "size", 0, REMOTE_LIMITS.snapshotBytes), sharing: value.sharing };
      if (state.sharing !== (!!state.h && state.z > 0)) throw new Error("remote-state-consistency");
      return state;
    }
    if (value.t === "CLEAR") return { t: "CLEAR", s: remoteString(value.s, "session", 32, /^[A-Za-z0-9_-]+$/) };
    if (value.t === "REQUEST") return { t: "REQUEST", requestId: remoteString(value.requestId, "request-id", 32, /^[A-Za-z0-9_-]+$/), session: remoteString(value.session, "session", 32, /^[A-Za-z0-9_-]+$/), revision: remoteInteger(value.revision, "revision"), hash: remoteString(value.hash, "hash", 64, /^[A-Za-z0-9_-]+$/) };
    const chunk = { t: "CHUNK", requestId: remoteString(value.requestId, "request-id", 32, /^[A-Za-z0-9_-]+$/), session: remoteString(value.session, "session", 32, /^[A-Za-z0-9_-]+$/), revision: remoteInteger(value.revision, "revision"), hash: remoteString(value.hash, "hash", 64, /^[A-Za-z0-9_-]+$/), index: remoteInteger(value.index, "chunk-index", 0, REMOTE_LIMITS.chunks - 1), count: remoteInteger(value.count, "chunk-count", 1, REMOTE_LIMITS.chunks), data: remoteString(value.data, "chunk-data", REMOTE_LIMITS.chunkData, /^[A-Za-z0-9_-]+$/) };
    if (chunk.index >= chunk.count) throw new Error("remote-chunk-index");
    return chunk;
  }

  function parseRemoteContent(content) {
    if (typeof content !== "string" || content.length > REMOTE_LIMITS.content || !content.startsWith(REMOTE_PREFIX)) throw new Error("remote-content");
    let parsed;
    try { parsed = JSON.parse(content.slice(REMOTE_PREFIX.length)); } catch (_) { throw new Error("remote-json"); }
    return validateRemoteEnvelope(parsed);
  }

  function serializeRemoteEnvelope(envelope) {
    const content = REMOTE_PREFIX + JSON.stringify(validateRemoteEnvelope(envelope));
    if (content.length > REMOTE_LIMITS.content) throw new Error("remote-content-budget");
    return content;
  }
