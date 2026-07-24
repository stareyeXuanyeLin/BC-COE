# Bondage Club - Custom Outfit Editor（BC-COE）

> **⚠️ 制作中（WIP）**  
> 此仓库设为公开仅为了 Tampermonkey 能通过 raw 链接引用脚本。插件仍在开发中，不建议安装或使用，请勿在社群中传播。使用即视为接受遇到一切未知 Bug 的风险。

COE 系列是 Bondage Club 的自定义服装编辑器插件。本仓库（BC-COE）为 COE-Echo-Mirror 的继任版本。

## 安装与启用

### 加载器安装（推荐）

安装轻量加载器，每次进入游戏时从仓库实时拉取最新代码。仓库更新后**不需要**重新安装脚本。

[![Install Loader](https://img.shields.io/badge/Tampermonkey-%E2%86%95%20%E5%AE%89%E8%A3%85%E5%8A%A0%E8%BD%BD%E5%99%A8-00485B?labelColor=1c1c1c&logo=tampermonkey)](https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/main/dist/CustomOutfitEditorEchoMirror.loader.user.js)

点击上方按钮，Tampermonkey 弹出安装提示后确认安装。完整刷新 BC 页面即可使用。

### 完整脚本安装

将 `dist/CustomOutfitEditorEchoMirror.user.js` 拖拽到浏览器 Tampermonkey 管理面板，或手动新建脚本并粘贴全部代码。注意：完整安装方式每次更新都需要重新安装此文件。

### 启用方式

安装完成后，进入 Appearance →「自定义服装衣柜」中分别选择：

- 向同房间用户共享当前外观；
- 显示同房间用户的外观。

两项默认关闭且彼此独立。对方也必须安装兼容版本（Mirror 或 Remote 均可，因协议兼容）。

## 会与不会共享什么

共享内容只有当前启用方案的 compact 静态视觉快照：素材 Group/Name、颜色、受限 Type/TypeRecord、图片层索引、优先级、偏移与透明度。

不会共享：

- 衣柜、方案名称/id、未启用方案或编辑状态；
- PNG、Canvas、WebGL、Asset/Character 活对象；
- DynamicBeforeDraw / DynamicAfterDraw / DynamicScriptDraw；
- ExtendedItem、锁、活动、姿势、Hide/Block/Effect 等物品功能。

接收端只解析本机已经加载的 Asset，并为 `HasImage && !LockLayer` 图片层创建不可重新启用动态绘制的 Visual Asset Proxy。缺失或异常素材按 material 局部跳过。

## Appearance 隔离

远端快照不写入任何角色的正式 `Appearance`。Synthetic Item 仅在同步 `CommonDrawAppearanceBuild` 调用中临时替换引用，并由 `try/finally` 无条件恢复。远端刷新仅调用：

```js
CharacterRefresh(character, false, false)
```

Hidden 协议使用 `COE_RVS/1`，不产生普通聊天、耳语或动作消息。

COE 通过本地衣柜、COE Remote 快照协议和绘制阶段 Synthetic Rendering 工作。它不创建、不穿戴、不同步名为 `CustomOutfit` 的正式服装项目，也不在启动时读取或迁移 `CustomComposition`。Synthetic Item 在 `ServerAppearanceBundle` 边界按 `__coeMaterialId` 过滤，不能进入服务器 Appearance Bundle。

## 偏好与诊断

远端偏好单独保存在：

```text
BC.CustomOutfitEditor.RemotePrefs.v1.<accountId>
```

该键只含两个 boolean，不修改 wardrobe schema v4。可通过 `CustomOutfitEditor.status()` 查看无载荷摘要，包括 peer、active composition、收发/拒绝/限流/分片和跳过 material 计数。

## UX 优化进度

### 第一轮：颜色选择交互（已完成）

素材整体颜色与图层颜色已改为复用 Bondage Club R130 原版 `ColorPickerInit` 面板，不再使用浏览器原生 `<input type="color">`。现已支持：

- 在编辑器入口直接查看 `#RRGGBB` 或 `Default`；
- 使用原版颜色代码输入、复制与粘贴；
- 直接使用并维护账号的 `Player.SavedColors` 常用颜色；
- 使用原版确认、取消和还原默认操作；
- 单层默认按实际 `ColorIndex` 恢复，整件多颜色槽默认仍由"整件默认"准确恢复；
- 为 COE 打开的原版面板提供不透明背景，避免与底部编辑器透叠。

实现与验收记录见 `docs/mirror-ux-round-1-color-picker.md`。

### 后续优化方向

- **状态反馈**：共享/查看开关的即时视觉反馈，让用户清楚当前状态
- **操作流程**：减少启用/关闭远端共享的步骤和认知负担
- **信息呈现**：远端用户的方案状态以更直观的方式展示（如角色名旁指示器、小图标等）
- **错误处理**：缺失素材、断线重连等场景的用户友好提示，替代静默跳过
- **设置界面**：更清晰的分组、说明文字和交互控件

## 开发与验证

```powershell
npm test
npm run build
npm run check
```

构建只写入 `dist/CustomOutfitEditorEchoMirror.user.js`。自动化测试不能代替双客户端私人房验收；实机顺序参考原文档 `docs/multiplayer-test-plan.md`。

## 文档

原项目文档保留于 `docs/` 目录。

- `docs/mirror-ux-round-1-color-picker.md`：第一轮颜色交互实现与验收记录
- `docs/architecture.md`：模块和绘制生命周期（原版）
- `docs/protocol-spec.md`：协议、canonical、状态机和预算（原版）
- `docs/known-limitations.md`：静态投影和兼容限制
- `docs/multiplayer-test-plan.md`：逐阶段实机计划
