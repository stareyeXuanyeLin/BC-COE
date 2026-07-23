# COE-Echo-Mirror 1.8.1：移除旧 CustomOutfit 容器机制

## 任务结论

当前最新版本为：

```text
COE-Echo-Mirror 1.8.1
```

检查结果确认：旧版 `CustomOutfit` 正式服装容器机制在 Mirror 版中仍然存在，并且仍会在插件初始化时执行迁移路径。

因此，旧容器机制仍应移除。

本任务只移除旧版正式服装容器，不删除当前 Mirror 版的：

- 本地衣柜方案
- 本地静态图层渲染
- COE Remote 协议
- 远端快照接收与渲染
- Synthetic Item / Synthetic Layer 绘制链
- Echo 静态素材适配
- LSCG 视觉代理兼容层

## 当前版本中确认仍存在的旧机制

### `src/01-runtime.js`

仍存在：

```js
const CONTAINER_GROUP = "ClothOuter";
const LEGACY_CONTAINER_GROUP = "ItemMisc";
const CONTAINER_ASSET = "CustomOutfit";
const APPEARANCE_SANITIZED_VERSION = 1;
```

诊断状态仍存在：

```js
inboundLegacyFiltered
```

### `src/04-assets.js`

仍存在：

```js
isLegacyContainerItem()
getLegacyContainerItem()
```

并且素材选择和编辑器保护逻辑仍会排除：

```js
asset.Name === CONTAINER_ASSET
asset.Name !== CONTAINER_ASSET
```

### `src/07-renderer.js`

仍安装两个旧容器相关同步 Hook：

```js
ServerAppearanceLoadFromBundle
ServerAppearanceBundle
```

当前它们分别承担：

- 入站过滤旧 `CustomOutfit`
- 出站过滤旧 `CustomOutfit`
- 出站过滤当前 Synthetic Item

出站 Hook 中的 Synthetic Item 过滤必须保留，但旧容器过滤应删除。

### `src/09-wardrobe.js`

仍存在：

```js
migrateLegacyContainerState()
```

该函数会：

1. 查找 Player.Appearance 中的旧 `CustomOutfit`
2. 读取 `Property.CustomComposition`
3. 转换为当前衣柜方案
4. 修改 `Player.Appearance`
5. 调用 `CharacterRefresh`
6. 调用 `ServerPlayerAppearanceSync`
7. 在聊天室中调用 `ChatRoomCharacterUpdate`

### `src/15-bootstrap.js`

初始化仍然执行：

```js
loadWardrobe();
migrateLegacyContainerState();
syncEquippedSchemes();
initializeRemoteController();
```

这意味着 Mirror 版启动时仍可能主动修改正式 Appearance，并主动触发服务器/聊天室同步。

## 为什么 Mirror 版更应该移除

Mirror 版已经新增了远端协议与远端渲染路径：

```text
本地衣柜方案
→ buildLocalRemoteSnapshot()
→ COE Remote 协议发送
→ 远端接收快照
→ buildRemoteSyntheticItems()
→ CharacterAppearanceSortLayers
→ CommonDrawAppearanceBuild
```

远端共享已经通过独立的协议数据完成，不再需要通过正式服装槽携带方案数据。

因此旧容器现在同时存在两套互不相容的路径：

```text
旧路径：CustomOutfit 正式服装 + CustomComposition
新路径：本地衣柜 + Remote Snapshot + Synthetic Rendering
```

旧路径会带来额外风险：

- 初始化时修改 `Player.Appearance`
- 初始化时触发 `ServerPlayerAppearanceSync()`
- 初始化时触发 `ChatRoomCharacterUpdate()`
- 可能与 BCX/聊天室属性同步发生重入
- 让 `ChatRoomMapViewInitializeCharacter` 错误难以隔离
- 继续保留旧 `CustomComposition` 数据边界
- 与 Mirror 的远端协议职责重复

## 任务范围

### 必须删除

#### `src/01-runtime.js`

删除：

```js
CONTAINER_GROUP
LEGACY_CONTAINER_GROUP
CONTAINER_ASSET
APPEARANCE_SANITIZED_VERSION
```

如果 `inboundLegacyFiltered` 只用于旧容器统计，也删除该字段。

#### `src/04-assets.js`

删除：

```js
isLegacyContainerItem()
getLegacyContainerItem()
```

删除 `isEditorRemovableAsset()` 中仅用于保护旧容器的条件：

```js
asset.Name !== CONTAINER_ASSET
```

删除素材选择器中仅用于排除旧容器的条件：

```js
asset.Name === CONTAINER_ASSET
```

素材选择器仍应继续排除锁定素材、不可穿戴素材和没有静态图片层的素材。

#### `src/09-wardrobe.js`

删除完整函数：

```js
migrateLegacyContainerState()
```

删除其所有副作用：

```js
Player.Appearance = ...
ServerPlayerAppearanceSync()
ChatRoomCharacterUpdate(Player)
```

注意：`syncEquippedSchemes()` 仍需保留：

```js
activeComposition = ...
CharacterRefresh(Player, false, false)
scheduleLocalRemoteBuild()
```

这属于当前本地方案与 Remote Snapshot 的正常路径，不是旧容器迁移。

#### `src/15-bootstrap.js`

初始化顺序改为：

```js
const readState = loadWardrobe();
if (readState.status === "deferred") return;
syncEquippedSchemes();
initializeRemoteController();
exposeAPI();
```

删除：

```js
migrateLegacyContainerState();
```

诊断状态删除：

```js
inboundLegacyFiltered
```

测试 API 中删除：

```js
isLegacyContainerItem
```

#### `src/07-renderer.js`

删除整个旧容器入站过滤 Hook：

```js
modApi.hookFunction("ServerAppearanceLoadFromBundle", ...)
```

修改出站 Bundle Hook，仅保留 Synthetic Item 过滤：

```js
modApi.hookFunction("ServerAppearanceBundle", 1000, (args, next) => {
  if (Array.isArray(args[0])) {
    const before = args[0].length;
    args[0] = args[0].filter(item => !item?.__coeMaterialId);
    diagnostics.outboundSyntheticFiltered += before - args[0].length;
  }
  return next(args);
});
```

不要删除 `__coeMaterialId` 过滤。它仍是防止临时 Synthetic Item 进入正式 Appearance Bundle 的边界。

## Mirror 版必须保留的远端机制

本任务不能误删以下文件或函数：

### `src/11-remote-protocol.js`

保留远端快照协议、校验、规范化和消息格式。

### `src/12-remote-store.js`

保留远端成员、快照、分片、过期和房间生命周期状态。

### `src/13-remote-transport.js`

保留发送、接收、分片、限流与 BC 聊天消息通道。

### `src/14-remote-controller.js`

保留远端共享和接收开关，以及本地快照构建触发。

### `src/07-renderer.js`

保留远端渲染：

```js
buildRemoteSyntheticItems()
remoteSnapshotForCharacter()
remotePrefs.receivingEnabled
```

### `src/06-adapters.js`

本次不删除 LSCG 兼容代理：

```js
proxy.Asset
proxy.DynamicBeforeDraw
proxy.DynamicAfterDraw
proxy.DynamicScriptDraw
```

这部分解决的是 COE Synthetic Asset 与 LSCG `smartGetAssetGroup()` 的独立类型冲突，不属于旧 `CustomOutfit` 容器机制。

## 数据兼容决策

本任务选择：

```text
不再在正常运行时自动迁移旧 CustomOutfit 数据。
```

因此：

- 不读取 `Property.CustomComposition`
- 不把旧容器数据导入衣柜
- 不修改 `Player.Appearance`
- 不调用 `ServerPlayerAppearanceSync()`
- 不调用 `ChatRoomCharacterUpdate()`
- 不在启动阶段清理旧容器

如果未来必须支持旧版用户，应另做独立的一次性迁移工具，不放入主运行时初始化流程。

## 测试同步修改

### `tests/core.test.js`

删除或重写只测试旧容器的测试，包括：

```js
ServerAppearanceBundle 过滤 CustomOutfit
ServerAppearanceLoadFromBundle 过滤 CustomOutfit
isLegacyContainerItem
```

保留并加强：

- Synthetic Item 出站过滤
- 本地与远端角色边界
- 远端 Synthetic 渲染
- 代理 Asset 的 LSCG 兼容
- `finally` 恢复 Appearance / AppearanceLayers
- 远端缺失素材局部跳过

### `tests/remote-renderer.test.js`

确认以下行为不受影响：

- 远端角色不走本地衣柜
- 远端快照可构建 Synthetic Item
- 缺素材只跳过对应 material
- 正式穿戴同 Asset 时跳过合成
- 动态标志不会被重新开启

### `tests/remote-store.test.js`

无需修改协议语义，只确认旧 `CustomOutfit` 字段不会进入远端快照。

### `tests/protocol.test.js`

保留协议校验，确认协议数据仍只包含紧凑 material/layer 描述，不包含：

```text
CustomOutfit
CustomComposition
__coeMaterialId
Player.Appearance
```

## 文档同步

更新以下文档：

- `README.md`
- `docs/architecture.md`
- `docs/data-safety.md`
- `docs/known-limitations.md`
- `docs/regression-record.md`
- `docs/multiplayer-test-plan.md`
- `docs/implementation-status.md`

删除或改写：

- “插件开关是外套服装槽中的普通服装项目”
- “启动时迁移旧 CustomOutfit”
- “入站旧容器过滤”
- “出站旧容器过滤”
- 依赖 `CustomComposition` 的当前架构说明

保留并明确：

```text
COE-Echo-Mirror 通过本地衣柜、COE Remote 快照协议和绘制阶段 Synthetic Rendering 工作。
它不创建、不穿戴、不同步名为 CustomOutfit 的正式服装项目。
```

多人测试中的 Appearance/Bundle 检查仍应保留，但检查重点改为：

```text
不得出现 CustomOutfit
不得出现 CustomComposition
不得出现 __coeMaterialId
不得出现远端协议控制字段
```

## 静态扫描要求

在正常运行源码中搜索并确认不再出现：

```text
CONTAINER_GROUP
LEGACY_CONTAINER_GROUP
CONTAINER_ASSET
APPEARANCE_SANITIZED_VERSION
isLegacyContainerItem
getLegacyContainerItem
migrateLegacyContainerState
ServerPlayerAppearanceSync
ChatRoomCharacterUpdate
CustomComposition
```

注意：`CustomOutfit` 和 `CustomComposition` 可以保留在历史迁移文档中，但不应出现在主运行时代码或协议代码中。

## 验证命令

在 `COE-Echo-Mirror` 目录运行：

```powershell
npm test
npm run build
npm run check
```

并检查生成的：

```text
dist/CustomOutfitEditorEchoMirror.user.js
```

## 实机回归重点

1. 不启用本地方案启动游戏，不发生旧容器迁移或 Appearance 同步。
2. 启用 Vanilla 本地方案，确认本地静态服装正常。
3. 启用 Echo 本地方案，确认 Echo 静态图层正常。
4. 开启远端共享，确认协议仍能发送本地快照。
5. 开启远端接收，确认远端角色仍能显示 Synthetic 图层。
6. 进入和离开聊天室，确认无主动 `ChatRoomCharacterUpdate()`。
7. 刷新页面、断线重连、换房间，确认远端快照生命周期正常。
8. 与 Echo、BCX、LSCG、WCE 同时启用，确认无新的 `Group`、`Type` 或上下文重入错误。
9. 检查 `Player.Appearance` 和 `ServerAppearanceBundle(Player.Appearance)` 不包含旧容器或 Synthetic Item。

## 完成标准

- Mirror 版正常运行路径不再创建、读取、迁移或过滤 `CustomOutfit` 正式服装项目。
- 初始化不再修改 `Player.Appearance`。
- 初始化不再主动调用 `ServerPlayerAppearanceSync()` 或 `ChatRoomCharacterUpdate()`。
- 本地方案与远端协议功能保持可用。
- 远端角色仍通过独立快照渲染，不污染正式 Appearance。
- Synthetic Item 仍不会进入服务器 Appearance Bundle。
- LSCG 兼容代理保持不变并通过测试。
- 自动化测试、构建、语法检查全部通过。
- 文档与实际 Mirror 架构一致。
