# Bondage Club - Custom Outfit Editor（测试分支）

> **测试分支说明**：本分支为 `layer-transform` 测试分支，包含图层复制、旋转、缩放功能。功能尚未合并到 `main` 主分支，仅供测试和体验。两个分支的 Tampermonkey 脚本可在插件面板中同时启用、随时切换。

## 本分支新增功能

### 图层复制
每个图层面板中新增 **复制** 按钮，点击后在当前图层后生成一份副本（带 `_copy` 后缀）。复制图层继承原图层的全部属性（位置、偏移、透明度、颜色），可独立调整。两个图层共用纹理缓存，不增加额外加载开销。

### 旋转
在素材变换区域中可调整旋转角度（−180° ~ 180°，步进 1°）。旋转以纹理几何中心为锚点，可与镜像/翻转叠加使用。

### 缩放
支持各向异性独立缩放（ScaleX / ScaleY），范围 **0.25 ~ 3.0**，步进 0.05：
- 低于 0.25 纹理像素排列失去视觉意义
- 超过 3.0 双线性插值模糊明显
- 独立控制 X/Y 轴，可实现不对称拉伸（如圆形配件变椭圆）

变换参数（旋转/缩放）存储在 material 级别的 `sourceProperty` 中，同一素材所有图层共享一套变换参数。

### 已知限制
- 旋转与半透明（opacity < 1）组合时存在透明度叠加残影，建议在编辑器预览中避免同时使用
- Canvas 2D 回退管线的旋转支持暂未实现（WebGL 不可用时极少触发该路径）
- GLDrawImage 包装依赖 `window.GLDrawImage` 全局可达，少部分 BC 版本可能需要额外适配

## 安装

### 测试版加载器安装（推荐）

[![Install Beta Loader](https://img.shields.io/badge/Tampermonkey-%E2%86%95%20%E5%AE%89%E8%A3%85%E6%B5%8B%E8%AF%95%E7%89%88-8B0000?labelColor=1c1c1c&logo=tampermonkey)](https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/layer-transform/dist/CustomOutfitEditorEchoMirror.loader.user.js)

点击上方按钮安装测试版加载器。Tampermonkey 中会出现名为 **"测试版加载器"** 的独立脚本，与主分支的稳定版加载器互不冲突。两个可同时启用，方便随时切换验证。

### 完整脚本安装

将 `https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/layer-transform/dist/CustomOutfitEditorEchoMirror.user.js` 拖拽到 Tampermonkey 管理面板。

## 与本家 main 分支的差异

| 项目 | main（稳定版） | layer-transform（测试版） |
|------|---------------|--------------------------|
| Tampermonkey 名称 | 远程加载器 | 测试版加载器 |
| 内部标志位 | `__COE_ECHO_MIRROR_LOADER_ACTIVE__` | `__COE_ECHO_MIRROR_LOADER_BETA__` |
| 图层复制 | ❌ | ✅ |
| 旋转 | ❌ | ✅ |
| 缩放 ScaleX/ScaleY | ❌ | ✅ |
| 协议版本 | COE_RVS/1 | COE_RVS/2 |

> 协议版本已升级为 `COE_RVS/2`，旧版 COE 收到测试版数据时会因前缀不匹配自动忽略，不会产生兼容性报错。

## 数据安全

测试版与稳定版共享同一本地存储键（`BC.CustomOutfitEditor.v1`）。切换分支不会丢失已保存的方案数据。变换参数（Rotation/Scale）为新版数据字段，在旧版中会被自动忽略而非报错。
