  function isLocalPlayer(character) {
    return !!character && character === globalThis.Player;
  }

  function isPreviewCompositionCharacter(character) {
    return !!character && previewCompositionByCharacter.has(character);
  }

  function getComposition(character) {
    const preview = character ? previewCompositionByCharacter.get(character) : null;
    if (preview) return preview;
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
    const delta = Number.isFinite(Number(offset)) ? Number(offset) : 0;
    if (typeof origin === "number") return Number.isFinite(origin) ? origin + delta : origin;
    if (!origin || typeof origin !== "object") return origin;
    const shifted = {};
    for (const [key, value] of Object.entries(origin)) {
      const numeric = Number(value);
      shifted[key] = Number.isFinite(numeric) ? numeric + delta : value;
    }
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

  // Body-replacement and cosmetic feature groups can be removable Appearance
  // groups too, so AllowNone alone is not enough to identify clothing. Keep the
  // material catalogue dynamic while excluding feature-editing groups. Ears and
  // tails are intentionally absent from this deny pattern because cosplay body
  // parts are valid clothing materials.
  const NON_CLOTHING_MATERIAL_GROUP_PATTERN = /^(?:Body(?:Upper|Lower|Style|Size)|Head|Hair(?:Front|Back)?|Eyes?2?|Eyebrows?|Mouth|Nose|Hands?|Height|Blush|Emoticon|Pussy|Nipples?|Breast|Butt|Skin)|(?:身体|替用身体|身高|左眼|右眼|眼睛|前发|后发|额外头发|发型|发色|妆容|化妆|纹身|液体|痕迹|外观工具)/i;

  function isMaterialAsset(asset) {
    const group = asset?.Group;
    if (!asset?.Wear || asset.IsLock || asset.Name === TAG_ASSET_NAME) return false;
    if (!group || group.Category !== "Appearance" || group.AllowNone !== true || group.AllowCustomize === false) return false;
    if (!asset.Layer?.some(isDrawableLayer)) return false;
    if (group.Clothing === true || group.Underwear === true) return true;
    if (group.BodyCosplay !== true && asset.BodyCosplay !== true) return false;
    const semanticName = `${group.Name || ""} ${group.Description || ""}`;
    return !NON_CLOTHING_MATERIAL_GROUP_PATTERN.test(semanticName);
  }

  function getMaterialAssetGroups(query = "") {
    const q = String(query || "").trim().toLowerCase();
    const groups = new Map();
    for (const asset of globalThis.Asset || []) {
      if (!isMaterialAsset(asset)) continue;
      const text = `${asset.Group?.Name || ""} ${asset.Group?.Description || ""} ${asset.Name || ""} ${asset.Description || ""}`.toLowerCase();
      if (q && !text.includes(q)) continue;
      const key = asset.Group.Name;
      let entry = groups.get(key);
      if (!entry) {
        entry = { key, label: asset.Group.Description || key, assets: [] };
        groups.set(key, entry);
      }
      entry.assets.push(asset);
    }
    return [...groups.values()];
  }

  function getMaterialAssets(query = "") {
    return getMaterialAssetGroups(query).flatMap(group => group.assets);
  }

  function clothingSlotGroups() {
    const runtimeGroups = Array.isArray(globalThis.AssetGroup) ? globalThis.AssetGroup : [];
    const assetGroups = (globalThis.Asset || []).map(asset => asset?.Group).filter(Boolean);
    const unique = new Map();
    for (const group of [...runtimeGroups, ...assetGroups]) {
      if (!group?.Name || unique.has(group.Name)) continue;
      unique.set(group.Name, group);
    }
    return [...unique.values()]
      .filter(group => VANILLA_CLOTHING_SLOT_GROUPS.has(group.Name)
        && group.Category === "Appearance" && group.AllowNone === true
        && group.BodyCosplay !== true && (group.Clothing === true || group.Underwear === true))
      .sort((left, right) => String(left.Description || left.Name).localeCompare(String(right.Description || right.Name), "zh-CN"));
  }

  function clothingSlotGroup(groupName) {
    return clothingSlotGroups().find(group => group.Name === groupName) || null;
  }

  function clothingSlotLabel(groupName) {
    const group = clothingSlotGroup(groupName)
      || (globalThis.Asset || []).find(asset => asset?.Group?.Name === groupName)?.Group;
    return group?.Description || groupName || "服装";
  }

  function defaultClothingSlotGroup() {
    const groups = clothingSlotGroups();
    return groups.find(group => group.Name === "Cloth")?.Name || groups[0]?.Name || "Cloth";
  }

  function registerTagAssets() {
    if (typeof globalThis.AssetAdd !== "function" || typeof globalThis.AssetGet !== "function") return false;
    let registered = 0;
    for (const group of clothingSlotGroups()) {
      if (AssetGet("Female3DCG", group.Name, TAG_ASSET_NAME)) continue;
      const groupDef = globalThis.AssetFemale3DCG?.find(definition => definition?.Group === group.Name);
      if (!groupDef) {
        warn(`无法注册 ${group.Name} 标签服装：缺少原版格子定义`);
        continue;
      }
      const description = `自定义${clothingSlotLabel(group.Name)}`;
      AssetAdd(group, {
        Name: TAG_ASSET_NAME,
        Description: description,
        Value: 0,
        Wear: true,
        Visible: true,
        Random: false,
        AllowLock: false,
        DefaultColor: ["Default"],
        DynamicDescription: () => description,
        DynamicName: () => description,
        Layer: [{ Name: "Tag", HasImage: false, AllowColorize: false }],
      }, null, groupDef);
      const asset = AssetGet("Female3DCG", group.Name, TAG_ASSET_NAME);
      if (asset) {
        asset.Description = description;
        asset.DynamicDescription = () => description;
        asset.DynamicName = () => description;
        asset.__coeTagAsset = true;
        registered++;
      }
    }
    return registered > 0;
  }

  function tagItem(character, groupName) {
    if (!character || !groupName) return null;
    const item = typeof globalThis.InventoryGet === "function"
      ? InventoryGet(character, groupName)
      : character.Appearance?.find(entry => entry?.Asset?.Group?.Name === groupName) || null;
    return item?.Asset?.Name === TAG_ASSET_NAME ? item : null;
  }

  function isTagEquipped(character, groupName) {
    return !!tagItem(character, groupName);
  }

  function equipTagForGroup(groupName) {
    if (!globalThis.Player || !clothingSlotGroup(groupName)) return false;
    if (isTagEquipped(Player, groupName)) return true;
    if (!AssetGet(Player.AssetFamily || "Female3DCG", groupName, TAG_ASSET_NAME)) registerTagAssets();
    if (typeof globalThis.InventoryWear !== "function") return false;
    try {
      return !!InventoryWear(Player, TAG_ASSET_NAME, groupName, "Default", null, Player.MemberNumber, null, true);
    } catch (error) {
      warn(`自动装备「自定义${clothingSlotLabel(groupName)}」失败`, error);
      return false;
    }
  }

  function installTagAssetPreviewHook() {
    modApi.hookFunction("DrawAssetPreview", 0, (args, next) => {
      const [x, y, asset, options = {}] = args;
      if (asset?.Name !== TAG_ASSET_NAME || asset?.Group?.Category !== "Appearance") return next(args);
      const width = options.Width || globalThis.DrawAssetPreviewDefaultWidth || 225;
      const height = options.Height || globalThis.DrawAssetPreviewDefaultHeight || 275;
      const description = options.Description ?? asset.DynamicDescription?.(options.C) ?? asset.Description;
      if (typeof globalThis.DrawPreviewBox === "function") {
        DrawPreviewBox(x, y, "", description, options);
        if (typeof globalThis.DrawTextFit === "function") {
          const gutter = description ? 44 : 0;
          DrawTextFit(TAG_PREVIEW_EMOTICON, x + width / 2, y + (height - gutter) / 2, width - 24, options.Foreground || "#27485f");
        }
        return;
      }
      return next(args);
    });
  }
