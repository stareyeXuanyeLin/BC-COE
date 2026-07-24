# Bondage Club - Custom Outfit Editor（BC-COE）

COE 系列是 Bondage Club 的自定义服装编辑器插件。本仓库（BC-COE）为 COE-Echo-Mirror 的继任版本，支持本地自定义衣柜与同房间静态视觉共享。

## 安装

### 加载器安装（推荐）

安装轻量加载器后，Tampermonkey 会把主程序作为 `@require` 依赖加载。主程序在用户脚本阶段执行，不经过 BC 页面动态 `<script>` 注入，因此不会被页面 CSP 拦截。仓库更新后，Tampermonkey 会按自身的脚本更新周期获取新版本；若要立即获取更新，可在 Tampermonkey 面板手动检查更新。

[![Install Loader](https://img.shields.io/badge/Tampermonkey-%E2%86%95%20%E5%AE%89%E8%A3%85%E5%8A%A0%E8%BD%BD%E5%99%A8-00485B?labelColor=1c1c1c&logo=tampermonkey)](https://cdn.jsdelivr.net/gh/stareyeXuanyeLin/BC-COE@main/dist/CustomOutfitEditorEchoMirror.loader.user.js?v=1.2.0)

点击上方按钮，Tampermonkey 弹出安装提示后确认安装。完整刷新 BC 页面即可使用。

### 完整脚本安装

如果加载器已经安装过旧版本，请先在 Tampermonkey 面板中删除旧的“远程加载器”，再通过上方按钮重新安装 1.2.0。旧版加载器曾经使用 `raw.githubusercontent.com` 动态注入主程序，可能因 MIME 类型或页面 CSP 而完全不执行。

将 `dist/CustomOutfitEditorEchoMirror.user.js` 拖拽到浏览器 Tampermonkey 管理面板，或手动新建脚本并粘贴全部代码。采用此方式时，每次更新需要重新安装此文件。

## 使用方法

安装完成后，进入 Appearance（衣柜），左上角出现 **✦ 自定义服装设计** 按钮。点击进入衣柜后：

- **新建方案**：选择游戏中已加载的服装素材，组合图层并调整颜色、位置和透明度
- **方案启停**：每套方案可独立启用或停用，不会写入角色 Appearance
- **共享开关**：衣柜内可分别控制"向同房间用户共享当前外观"和"显示同房间用户的外观"

两项共享默认关闭且彼此独立。对方也必须安装兼容版本（Mirror 或 Remote 均可，因协议兼容）。

## 共享范围

**会共享**：当前启用方案的 compact 静态视觉快照，包括素材 Group/Name、颜色、受限 Type/TypeRecord、图片层索引、优先级、偏移与透明度。

**不会共享**：
- 衣柜、方案名称/id、未启用方案或编辑状态
- PNG、Canvas、WebGL、Asset/Character 活对象
- DynamicBeforeDraw / DynamicAfterDraw / DynamicScriptDraw
- ExtendedItem、锁、活动、姿势、Hide/Block/Effect 等物品功能

接收端只解析本机已加载的 Asset，并为 `HasImage && !LockLayer` 图片层创建不可重新启用动态绘制的 Visual Asset Proxy。缺失或异常素材按 material 局部跳过。

## 设计原则

- 远端快照不写入任何角色的正式 `Appearance`，Synthetic Item 仅在 `CommonDrawAppearanceBuild` 调用中临时替换引用，由 `try/finally` 无条件恢复
- Hidden 协议使用 `COE_RVS/1`，不产生普通聊天、耳语或动作消息
- COE 不创建、不穿戴、不同步名为 `CustomOutfit` 的正式服装项目，也不在启动时读取或迁移 `CustomComposition`
- Synthetic Item 在 `ServerAppearanceBundle` 边界按 `__coeMaterialId` 过滤，不能进入服务器 Appearance Bundle

## 端偏好与诊断

远端偏好保存在 `BC.CustomOutfitEditor.RemotePrefs.v1.<accountId>`，只含两个 boolean。可通过 `CustomOutfitEditor.status()` 查看无载荷摘要。
