# Bondage Club - Custom Outfit Editor（重构分支）

> **重构分支说明**：本分支为 `single-layer-transform-rebuild` 重构分支，包含图层复制、图层变换和素材整体变换功能。功能用于当前重构验证，不与旧 `main` 版本混用。

## 本分支新增功能

### 图层复制
每个图层面板中新增 **复制** 按钮，点击后在当前图层后生成一份副本（带 `_copy` 后缀）。复制图层继承原图层的全部属性（位置、偏移、透明度、颜色），可独立调整。两个图层共用纹理缓存，不增加额外加载开销。

### 旋转
在素材变换区域中可调整旋转角度（−180° ~ 180°，步进 1°）。单图层旋转以纹理有效内容中心为优先锚点，可与镜像/翻转叠加使用。素材整体旋转作用于同一素材的全部图片层，不会把整个自定义服装方案一起旋转。

### 缩放
支持等比缩放，范围 **0.25 ~ 3.0**，步进 0.05。图层和素材整体分别保存缩放参数，可先对单层微调，再对同一素材的全部图层统一缩放。

变换参数存储在图层字段和 material 字段中，不写入 `sourceProperty`：
- 图层：`rotation` / `scale` / `offsetX` / `offsetY`
- 素材整体：`overallRotation` / `overallScale` / `overallOffsetX` / `overallOffsetY`

### 已知限制
- 旋转与半透明（opacity < 1）组合时存在透明度叠加残影，建议在编辑器预览中避免同时使用
- Canvas 2D 回退管线的旋转支持暂未实现（WebGL 不可用时极少触发该路径）
- GLDrawImage 包装依赖 `window.GLDrawImage` 全局可达，少部分 BC 版本可能需要额外适配

## 安装

### 重构版加载器安装（推荐）

[![Install Beta Loader](https://img.shields.io/badge/Tampermonkey-%E2%86%95%20%E5%AE%89%E8%A3%85%E6%B5%8B%E8%AF%95%E7%89%88-8B0000?labelColor=1c1c1c&logo=tampermonkey)](https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/single-layer-transform-rebuild/dist/CustomOutfitEditorEchoMirror.loader.user.js)

点击上方按钮安装重构版加载器。当前版本应与旧版分开验证，避免两个版本同时改写同一绘制链。

### 完整脚本安装

将 `https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/single-layer-transform-rebuild/dist/CustomOutfitEditorEchoMirror.user.js` 拖拽到 Tampermonkey 管理面板。

## 与旧版的差异

| 项目 | 旧版 | single-layer-transform-rebuild |
|------|------|-------------------------------|
| 图层复制 | ❌ | ✅ |
| 单图层旋转/缩放 | ❌ | ✅ |
| 素材整体旋转/缩放 | 整体方案语义 | ✅ 仅同一素材的全部图层 |
| 协议版本 | 旧版本 | COE_RVS/3 |

> `COE_RVS/3` 将素材整体变换放在 material 条目中。旧版收到重构版数据时会因前缀不匹配自动忽略。

## 数据安全

重构版继续使用本地存储键（`BC.CustomOutfitEditor.v1`）。读取旧方案时，只有单素材方案的旧整体字段会迁移到该素材；多素材旧整体字段会被丢弃，避免继续把多个素材错误地绑定为一个整体。
