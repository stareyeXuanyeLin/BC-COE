  function isLocalPlayer(character) {
    return !!character && character === globalThis.Player;
  }

  function getComposition(character) {
    if (!isLocalPlayer(character)) return null;
    if (uiMode === "editor" && editing) return editing;
    return activeComposition;
  }

  function isEditorRemovableAsset(asset) {
    const group = asset?.Group;
    if (!group || group.Category !== "Appearance" || group.AllowNone !== true) return false;
    const name = group.Name || "";
    const protectedNames = /^(Body|Head|Hair|Eyes|Eyebrows|Mouth|Nose|Ears|Hands|Height|Blush|Emoticon)/;
    return !protectedNames.test(name);
  }

  function shiftOrigin(origin, offset) {
    if (!origin || typeof origin !== "object") return origin;
    const shifted = {};
    for (const [key, value] of Object.entries(origin)) shifted[key] = (Number(value) || 0) + offset;
    return shifted;
  }

  function resolveSourceLayer(asset, ref) {
    if (!asset?.Layer?.length) return null;
    if (Number.isInteger(ref.sourceLayerIndex) && asset.Layer[ref.sourceLayerIndex]) {
      const candidate = asset.Layer[ref.sourceLayerIndex];
      if (ref.sourceLayer == null || candidate.Name === ref.sourceLayer) return candidate;
    }
    if (ref.sourceLayer != null) return asset.Layer.find(layer => layer.Name === ref.sourceLayer) || null;
    return asset.Layer.find(layer => layer.Name == null) || asset.Layer[0] || null;
  }

  function isDrawableLayer(layer) {
    return !!layer?.HasImage && !layer.LockLayer;
  }

  function getMaterialAssets(query = "") {
    const q = query.trim().toLowerCase();
    return (globalThis.Asset || []).filter(asset => {
      if (!asset?.Wear || asset.IsLock) return false;
      if (!asset.Layer?.some(isDrawableLayer)) return false;
      const text = `${asset.Group?.Name || ""} ${asset.Name || ""} ${asset.Description || ""}`.toLowerCase();
      return !q || text.includes(q);
    }).slice(0, 800);
  }
