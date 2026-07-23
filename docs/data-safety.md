# 数据与 Appearance 安全

## 存储身份与隔离

衣柜继续使用：

```text
Player.ExtensionSettings.CustomOutfitEditor
BC.CustomOutfitEditor.v1.<accountId>
```

远端偏好独立使用：

```text
BC.CustomOutfitEditor.RemotePrefs.v1.<accountId>
```

RemotePrefs 只保存 `sharingEnabled` 和 `receivingEnabled` 两个 boolean，不进入 ExtensionSettings，不修改 wardrobe schema v4，也不保存 peer、snapshot、assembly 或诊断。远端房间状态只存在于当前页面和 roomGeneration。

## 读取状态与写回闸门

`unpackWardrobeDetailed()` 区分 absent/ok/deferred/corrupt/unsupported。`loadWardrobe()` 同时保留服务端和本地原始字符串的状态：

- 任一非空来源 deferred/corrupt/unsupported：阻止写回。
- 两来源均 ok 但 compact 内容不同：报告 conflict，阻止写回。
- 不根据 updatedAt 自动覆盖或合并。
- 显式 API import 是用户授权的替换；无效 import 在修改内存前失败。

## Compact serializer

路径为：

```text
normalizeWardrobe → compactWardrobeForStorage → JSON → LZ/json 编码
```

新写出不包含：scheme.updatedAt、layer.defaultColor/defaultOffsetX/defaultOffsetY、material.collapsed、Layer 级重复 sourceColor/sourceProperty，以及 provider/version/compatibility/reasons 等运行时状态。读取器仍接受旧字段和旧 per-layer color。

预算：material 8 KiB、scheme 64 KiB、wardrobe 256 KiB；TypeRecord 最多 16 键、值只允许 boolean/有限整数/短字符串。

## 网络快照边界

远端协议只共享当前启用方案的 compact 静态视觉：素材 Group/Name、颜色、有限 Type/TypeRecord、图片层索引、优先级、偏移和透明度。方案名称/id、equippedIds、衣柜、未启用方案、图片、Canvas/WebGL、Asset/Character 活对象和函数均不进入协议。

网络对象先经过独立严格 validator、预算、canonical 和 SHA-256 校验；不得调用本地 `normalizeComposition()`。只有验证后的 snapshot 进入当前房间 Store，最后才允许绘制阶段执行本机 `AssetGet`。

## Appearance / Bundle

本地和远端 Synthetic Item 都不会持久加入正式 Appearance。`CommonDrawAppearanceBuild` 的临时替换由 `try/finally` 恢复；`ServerAppearanceBundle` 额外过滤 `__coeMaterialId` 和精确旧容器。视觉代理的 `Asset` 兼容属性是非枚举、只读的运行时引用，不进入 compact wardrobe、远端 snapshot 或 Bundle。

远端快照接受、CLEAR 和生命周期清理后只调用：

```js
CharacterRefresh(character, false, false)
```

不会为远端显示调用 ServerPlayerAppearanceSync、ChatRoomCharacterUpdate 或 ChatRoomCharacterItemUpdate。

静态扫描发现的服务器 Appearance/ChatRoom 同步均位于继承的 `migrateLegacyContainerState()`，只在检测到精确旧 CustomOutfit 容器且衣柜可安全读取时执行，用于迁移/清理而非 COE Remote 传播。普通加载、远端消息、能力分析、Echo 变化和 UI 打开不会触发。

实机仍需记录：

```js
Player.Appearance
ServerAppearanceBundle(Player.Appearance)
JSON.stringify(ServerAppearanceBundle(Player.Appearance)).length
```
