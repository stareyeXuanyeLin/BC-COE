# Bondage Club - Custom Outfit Editor

Custom Outfit Editor 是独立的自定义服装编辑器，包含图层复制、图层变换、素材整体变换、服装格标签以及跨玩家远端视觉同步。项目开发过程中加入了对 Echo 的服装扩展插件的兼容；仓库目录和构建文件中的 `Echo`、`Echo Mirror` 是早期用于区分开发版本的历史名称，不表示插件基于或依赖 Echo。当前正式发布线路统一使用 `main` 分支。

## 功能

### 图层复制

每个图层面板均可复制当前图层。副本继承位置、偏移、透明度、颜色和变换参数，并可独立调整；共用纹理缓存，不重复加载图片。

### 图层与素材变换

- 单图层支持旋转、等比缩放和偏移；
- 素材整体变换作用于同一素材的全部图片层；
- 单图层与素材整体变换共用各自的旋转/缩放中心语义；
- 变换参数保存在 material 和 layer 字段中，不写入 `sourceProperty`。

### 服装格标签

启用方案时，插件会在对应原版服装格穿上透明的 `COECustomOutfit` 标签。标签属于正式 Appearance，用于参与 BC 原生穿脱互动；移除标签会隐藏该格对应的自定义服装，但不会关闭衣柜中的启用状态。

### 跨玩家同步

双方安装同一正式版本并分别开启共享与接收后，插件通过 `COE_RVS/4` Hidden 消息同步静态视觉快照。协议只传 Asset、图层、颜色和变换参数，不传图片；如果服装来自 BC 之外的素材扩展，双方还需要加载能够解析相同 Asset 与图层的对应扩展版本。

## 安装

### 加载器安装（推荐）

[![Install Loader](https://img.shields.io/badge/Tampermonkey-%E2%86%95%20%E5%AE%89%E8%A3%85%E6%AD%A3%E5%BC%8F%E7%89%88-8B0000?labelColor=1c1c1c&logo=tampermonkey)](https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/main/dist/CustomOutfitEditorEchoMirror.loader.user.js)

加载器每次进入游戏时从 `main` 分支获取最新核心脚本。请停用或删除旧 COE、COE-Echo、测试版加载器和重构版加载器，避免多个版本同时注册绘制 Hook。

### 完整脚本安装

直接安装：

<https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/main/dist/CustomOutfitEditorEchoMirror.user.js>

## 多人验证

双方进入同一聊天室后，可在控制台执行：

```js
CustomOutfitEditor.status()
```

至少确认：

```text
remoteProtocol: "COE_RVS/4"
sharingEnabled / receivingEnabled: 与各自设置一致
```

标签资产可通过以下命令确认：

```js
Asset.filter(asset => asset?.Name === "COECustomOutfit").map(asset => asset.Group?.Name)
```

安装或更新后应完整刷新游戏并重新进入聊天室，使在线 Appearance 按新的标签 Asset 注册表重新解析。

## 已知限制

- Canvas 2D 回退管线暂不支持旋转；
- GLDrawImage 包装依赖 `window.GLDrawImage` 全局可达；
- 接收端缺少对应 Asset、图层索引或图层名称不一致时，该素材会被跳过；
- Remote Snapshot 不传输图片、动态绘制脚本、锁、活动及完整 ExtendedItem 语义。

## 数据安全

衣柜使用本地存储键 `BC.CustomOutfitEditor.v1`。远端只接收通过严格 schema、大小预算和 SHA-256 完整性校验的静态视觉快照。
