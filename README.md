# Custom Outfit Editor Echo Mirror（COE Mirror）

> **当前状态：私有开发与测试版本。** 本项目尚未正式发布，不建议未参与测试的用户安装、转载或分发。功能、兼容性和完整生命周期仍在持续验证中。

COE Mirror 是 [COE-Echo-Remote v1.8.1](https://github.com/liliMozi/openhanako) 的 UX 优化衍生版，当前版本 **1.0.0**，面向 Bondage Club R130。它在 Remote 已验证的核心共享链路基础上，专注于**用户交互体验的打磨**——让远端服装的查看、切换、反馈更直观顺畅。

> 本项目的母版 COE-Echo-Remote 已完成核心功能验证（发现、请求、分片传输、快照接收和远端静态绘制组成的核心共享链路已在 R130 双账号私人房实机跑通），留作稳定基底与功能权威。Mirror 版只做交互层优化，不修改协议、数据结构或渲染核心。

## 安装与启用

安装 `dist/CustomOutfitEditorEchoMirror.user.js`，完整刷新 BC 页面，然后在 Appearance →「自定义服装衣柜」中分别选择：

- 向同房间用户共享当前外观；
- 显示同房间用户的外观。

两项默认关闭且彼此独立。对方也必须安装兼容版本（Mirror 或 Remote 均可，因协议兼容）。Mirror Edition 与旧 COE/COE-Echo 共用 `CustomOutfitEditor` 运行时和衣柜身份，不能同时启用。

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
- 单层默认按实际 `ColorIndex` 恢复，整件多颜色槽默认仍由“整件默认”准确恢复；
- 为 COE 打开的原版面板提供不透明背景，避免与底部编辑器透叠。

实现与验收记录见 `docs/mirror-ux-round-1-color-picker.md`。

### 后续优化方向

- **状态反馈**：共享/查看开关的即时视觉反馈，让用户清楚当前状态
- **操作流程**：减少启用/关闭远端共享的步骤和认知负担
- **信息呈现**：远端用户的方案状态以更直观的方式展示（如角色名旁指示器、小图标等）
- **错误处理**：缺失素材、断线重连等场景的用户友好提示，替代静默跳过
- **设置界面**：更清晰的分组、说明文字和交互控件

> 这些优化不会改变协议兼容性——Mirror 版仍可与 Remote 版互操作。

## 开发与验证

```powershell
npm test
npm run build
npm run check
```

构建只写入 `dist/CustomOutfitEditorEchoMirror.user.js`。自动化测试不能代替双客户端私人房验收；实机顺序参考原文档 `docs/multiplayer-test-plan.md`。

## 文档

原项目文档保留于 `docs/` 目录，Mirror 版新增/修改的文档会以 `docs/mirror-*.md` 格式存放。

- `docs/mirror-ux-round-1-color-picker.md`：Mirror 第一轮颜色交互实现与验收记录
- `docs/architecture.md`：模块和绘制生命周期（原版）
- `docs/protocol-spec.md`：协议、canonical、状态机和预算（原版，Mirror 不修改）
- `docs/known-limitations.md`：静态投影和兼容限制
- `docs/multiplayer-test-plan.md`：逐阶段实机计划
