  const REMOTE_PROTOCOL = "COE_RVP/1";
  const REMOTE_PREFIX = `${REMOTE_PROTOCOL}|`;
  const REMOTE_ENCODING = "gz";
  const REMOTE_LIMITS = Object.freeze({
    content: 1800, inlineData: 1300, chunkData: 1400, chunks: 24,
    snapshotBytes: 32768, compressedBytes: 24576,
    materialBytes: 8192, materials: 32, layers: 120, string: 64, color: 40,
  });
  const REMOTE_TYPES = new Set(["D", "A", "W", "X", "N", "R"]);
  const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

  function remotePlainObject(value) {
    if (!value || Object.prototype.toString.call(value) !== "[object Object]") return false;
    const proto = Object.getPrototypeOf(value);
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
    const allowed = new Set(["Type", "Mirror", "Invert", "TypeRecord"]);
    const output = {};
    for (const key of Object.keys(value)) if (!allowed.has(key) || POLLUTION_KEYS.has(key)) throw new Error("snapshot-property-key");
    if (value.Type != null) output.Type = remoteString(value.Type, "property-type", 40);
    if (value.Mirror != null) {
      if (typeof value.Mirror !== "boolean") throw new Error("snapshot-property-mirror");
      output.Mirror = value.Mirror;
    }
    if (value.Invert != null) {
      if (typeof value.Invert !== "boolean") throw new Error("snapshot-property-invert");
      output.Invert = value.Invert;
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
      for (const key of Object.keys(material)) if (!new Set(["g", "a", "c", "p", "w", "r", "s", "x", "y", "h", "v"]).has(key)) throw new Error("snapshot-material-key");
      const output = { g: remoteString(material.g, "group"), a: remoteString(material.a, "asset") };
      if (material.w != null) output.w = remoteString(material.w, "wear-group");
      if (!Array.isArray(material.c) || material.c.length > 40) throw new Error("snapshot-colors");
      output.c = material.c.map(color => remoteString(color, "color", REMOTE_LIMITS.color));
      for (const [key, min, max] of [["r", -Math.PI, Math.PI], ["s", 0.25, 3.0], ["x", -1200, 1200], ["y", -1200, 1200]]) {
        if (material[key] == null) continue;
        if (typeof material[key] !== "number" || !Number.isFinite(material[key])) throw new Error(`snapshot-material-${key}`);
        output[key] = normalizeRemoteNumber(material[key], min, max);
      }
      for (const key of ["h", "v"]) {
        if (material[key] == null) continue;
        if (typeof material[key] !== "boolean") throw new Error(`snapshot-material-${key}`);
        if (material[key]) output[key] = true;
      }
      const property = validateRemoteProperty(material.p);
      if (property) output.p = property;
      return output;
    });
    const layers = value.l.map(layer => {
      if (!remotePlainObject(layer)) throw new Error("snapshot-layer");
      for (const key of Object.keys(layer)) if (!new Set(["m", "n", "i", "p", "x", "y", "o", "r", "s", "h", "v"]).has(key)) throw new Error("snapshot-layer-key");
      const output = {
        m: remoteInteger(layer.m, "material-index", 0, Math.max(0, materials.length - 1)),
        n: layer.n == null ? null : remoteString(layer.n, "layer-name"),
        i: remoteInteger(layer.i, "layer-index", 0, 999),
        p: normalizeRemoteNumber(layer.p, -99, 99),
        x: normalizeRemoteNumber(layer.x, -1200, 1200),
        y: normalizeRemoteNumber(layer.y, -1200, 1200),
        o: normalizeRemoteNumber(layer.o, 0, 1),
      };
      if (layer.r != null) {
        if (typeof layer.r !== "number" || !Number.isFinite(layer.r)) throw new Error("snapshot-layer-rotation");
        output.r = normalizeRemoteNumber(layer.r, -Math.PI, Math.PI);
      }
      if (layer.s != null) {
        if (typeof layer.s !== "number" || !Number.isFinite(layer.s)) throw new Error("snapshot-layer-scale");
        output.s = normalizeRemoteNumber(layer.s, 0.25, 3.0);
      }
      for (const key of ["h", "v"]) {
        if (layer[key] == null) continue;
        if (typeof layer[key] !== "boolean") throw new Error(`snapshot-layer-${key}`);
        if (layer[key]) output[key] = true;
      }
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

  function canonicalRemoteSnapshot(value) { return JSON.stringify(validateRemoteSnapshot(value)); }

  async function sha256Base64Url(text) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error("crypto-subtle-unavailable");
    const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(text)));
    return bytesToBase64Url(digest);
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlToBytes(value, maxBytes = REMOTE_LIMITS.compressedBytes) {
    remoteString(value, "base64url", Math.ceil(maxBytes * 4 / 3) + 4, /^[A-Za-z0-9_-]+$/);
    if (Math.floor(value.length * 3 / 4) > maxBytes) throw new Error("remote-decoded-budget");
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
    let binary;
    try { binary = atob(padded); } catch (_) { throw new Error("remote-base64url"); }
    if (binary.length > maxBytes) throw new Error("remote-decoded-budget");
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  async function remoteTransformBytes(bytes, format, outputLimit) {
    const Constructor = format === "compress" ? globalThis.CompressionStream : globalThis.DecompressionStream;
    if (typeof Constructor !== "function") throw new Error(`remote-${format}-unavailable`);
    const stream = new Constructor("gzip");
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const parts = [];
    let total = 0;
    const reading = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > outputLimit) throw new Error(`remote-${format}-budget`);
        parts.push(value);
      }
      const output = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
      return output;
    })();
    let failure = null;
    try {
      await writer.write(bytes);
      await writer.close();
    } catch (error) {
      failure = error;
      try { await writer.abort(error); } catch (_) { /* closed */ }
    }
    let output = null;
    try { output = await reading; }
    catch (error) { failure ||= error; }
    if (failure) {
      try { await writer.abort(failure); } catch (_) { /* closed */ }
      try { await reader.cancel(failure); } catch (_) { /* closed */ }
      const wrapped = new Error(`remote-${format}-data`);
      wrapped.cause = failure;
      throw wrapped;
    }
    return output;
  }

  async function encodeRemoteText(text) {
    if (typeof text !== "string" || utf8Bytes(text) > REMOTE_LIMITS.snapshotBytes) throw new Error("remote-encode-budget");
    const compressed = await remoteTransformBytes(new TextEncoder().encode(text), "compress", REMOTE_LIMITS.compressedBytes);
    return { encoded: bytesToBase64Url(compressed), compressedBytes: compressed.byteLength };
  }

  async function decodeRemoteText(value, expectedBytes = null) {
    const compressed = base64UrlToBytes(value);
    if (expectedBytes != null && compressed.byteLength !== expectedBytes) throw new Error("remote-compressed-size");
    const output = await remoteTransformBytes(compressed, "decompress", REMOTE_LIMITS.snapshotBytes);
    return new TextDecoder("utf-8", { fatal: true }).decode(output);
  }

  function splitRemoteData(value) {
    remoteString(value, "chunk-source", Math.ceil(REMOTE_LIMITS.compressedBytes * 4 / 3) + 4, /^[A-Za-z0-9_-]+$/);
    const chunks = [];
    for (let index = 0; index < value.length; index += REMOTE_LIMITS.chunkData) chunks.push(value.slice(index, index + REMOTE_LIMITS.chunkData));
    if (!chunks.length || chunks.length > REMOTE_LIMITS.chunks) throw new Error("remote-chunk-count");
    return chunks;
  }

  function remoteSession(value) { return remoteString(value, "session", 32, /^[A-Za-z0-9_-]+$/); }
  function remoteHash(value) { return remoteString(value, "hash", 64, /^[A-Za-z0-9_-]+$/); }

  function validateRemoteEnvelope(value) {
    remoteAssertTree(value);
    if (!remotePlainObject(value) || !REMOTE_TYPES.has(value.t)) throw new Error("remote-envelope");
    const allowedByType = {
      D: new Set(["t", "s", "rx", "e"]), A: new Set(["t", "s", "r", "h", "u", "z", "n", "d"]),
      W: new Set(["t", "o", "s", "r", "h"]), X: new Set(["t", "s", "r", "h", "i", "n", "d"]),
      N: new Set(["t", "o", "s", "r", "h", "m"]), R: new Set(["t", "s", "r"]),
    };
    for (const key of Object.keys(value)) if (!allowedByType[value.t].has(key)) throw new Error("remote-envelope-key");
    if (value.t === "D") {
      if (typeof value.rx !== "boolean" || value.e !== REMOTE_ENCODING) throw new Error("remote-discover");
      return { t: "D", s: remoteSession(value.s), rx: value.rx, e: REMOTE_ENCODING };
    }
    if (value.t === "A") {
      const result = { t: "A", s: remoteSession(value.s), r: remoteInteger(value.r, "revision"), h: remoteHash(value.h), u: remoteInteger(value.u, "uncompressed-size", 1, REMOTE_LIMITS.snapshotBytes), z: remoteInteger(value.z, "compressed-size", 1, REMOTE_LIMITS.compressedBytes), n: remoteInteger(value.n, "chunk-count", 1, REMOTE_LIMITS.chunks) };
      if (value.d != null) {
        result.d = remoteString(value.d, "inline-data", REMOTE_LIMITS.inlineData, /^[A-Za-z0-9_-]+$/);
        if (result.n !== 1) throw new Error("remote-inline-count");
      }
      return result;
    }
    if (value.t === "W") return { t: "W", o: remoteInteger(value.o, "owner", 1), s: remoteSession(value.s), r: remoteInteger(value.r, "revision"), h: remoteHash(value.h) };
    if (value.t === "R") return { t: "R", s: remoteSession(value.s), r: remoteInteger(value.r, "revision") };
    if (value.t === "N") {
      if (!Array.isArray(value.m) || !value.m.length || value.m.length > REMOTE_LIMITS.chunks) throw new Error("remote-missing");
      const missing = [...new Set(value.m.map(index => remoteInteger(index, "missing-index", 0, REMOTE_LIMITS.chunks - 1)))].sort((a, b) => a - b);
      return { t: "N", o: remoteInteger(value.o, "owner", 1), s: remoteSession(value.s), r: remoteInteger(value.r, "revision"), h: remoteHash(value.h), m: missing };
    }
    const data = { t: "X", s: remoteSession(value.s), r: remoteInteger(value.r, "revision"), h: remoteHash(value.h), i: remoteInteger(value.i, "chunk-index", 0, REMOTE_LIMITS.chunks - 1), n: remoteInteger(value.n, "chunk-count", 1, REMOTE_LIMITS.chunks), d: remoteString(value.d, "chunk-data", REMOTE_LIMITS.chunkData, /^[A-Za-z0-9_-]+$/) };
    if (data.i >= data.n) throw new Error("remote-chunk-index");
    return data;
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
