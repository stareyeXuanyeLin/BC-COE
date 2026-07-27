# COE-Echo-Mirror 性能优化记录

日期：2026-07-28  
项目：`COE-Echo-Mirror`  版本基线：`1.9.0`  
BC：R130  
相关分支：`single-layer-transform-rebuild`  
任务类型：单图层旋转卡顿分析与性能优化

## 1. 文档目的

本文记录本次性能优化任务的原因、已完成的改动、没有处理的部分、兼容性边界和后续工作顺序。

以后继续处理 COE 图层变换性能问题时，应先阅读本文，避免重复分析已经解决的问题，也避免把尚未验证的优化误认为已经完成。

本次任务已经修改代码并通过测试，本文属于实现记录，不是待执行方案草稿。

## 2. 原始问题

用户反馈：

- COE 插件旋转单个图层时不够丝滑；
- 连续调整角度时有卡顿感；
- 需要从插件整体性能角度寻找优化点。

初始调用链确认如下：

```text
图层旋转 input
  → refreshPreviewLoop
  → requestAnimationFrame
  → CharacterRefresh(Player, false, false)
  → CharacterLoadCanvas
  → CharacterAppearanceSortLayers
  → CommonDrawAppearanceBuild
  → GLDrawImage
```

旧路径的问题在于：一个只改变旋转角度的操作，会重新执行人物级刷新、合成层构建和 WebGL 绘制准备。

同时，`GLDrawImage` 变换包装还会先调用一次 BC 原始绘制来准备纹理、遮罩、着色器和 uniform，再执行一次变换后的绘制。

## 3. 本次优化的总体原则

本次优化遵循以下原则：

1. 单层旋转和缩放优先走纯视觉更新路径；
2. 结构变化仍然使用结构级重建，不能为了性能牺牲图层排序和引用一致性；
3. 同一帧内同一个角色最多处理一次刷新请求；
4. 缓存只复用确定为静态的运行时对象，材料之间保留 BC 所需的对象身份隔离；
5. 持久化和协议边界继续执行数据预算检查；
6. 轻量路径失败时自动退回 BC 原生完整刷新路径；
7. 不改变旋转中心、缩放中心、远端同步和数据格式的既有语义。

## 4. 已完成的优化

### 4.1 统一刷新调度器

涉及文件：

- `src/01-runtime.js`
- `src/08-ui-shell.js`
- `src/07-renderer.js`

新增角色刷新队列，替代编辑器预览刷新和几何中心刷新各自维护 RAF 的方式。

刷新请求按角色合并，并按级别取最高值：

| 刷新级别 | 适用操作 | 当前路径 |
|---|---|---|
| `visual` | 旋转、缩放、偏移、透明度、颜色 | 优先纯画布重绘 |
| `structure` | 添加、删除、复制、隐藏、恢复、层级变化 | `CharacterLoadCanvas` |
| `full` | 角色状态、姿势或兼容性回退 | `CharacterRefresh` |

主要效果：

- 同一帧的多个刷新请求只执行一次；
- 不再因为多个调度器互相独立而在相邻帧重复刷新；
- 编辑器关闭时只删除本地玩家的待刷新请求，不会误删远端角色的刷新请求；
- 调度器不依赖 RAF 返回值的真假判断，使用 `characterRefreshScheduled` 显式记录调度状态。

### 4.2 单图层变换使用轻量画布重绘

涉及文件：

- `src/08-ui-shell.js`
- `src/07-renderer.js`

当满足以下条件时，视觉变换优先调用：

```js
CharacterAppearanceBuildCanvas(character)
```

并跳过：

- `AnimationPurge`；
- `CharacterLoadEffect`；
- `PoseRefresh`；
- `CharacterLoadCanvas`；
- Appearance 序列化与复制；
- AppearanceLayers 重新排序；
- 合成 Asset 和合成层的重复创建。

轻量路径只同步当前 composition 中仍然有效的：

- 图层 ref；
- material；
- material overall transform；
- 颜色数组；
- 合成组的运行时状态。

如果当前合成组已经过期、图层数量不一致、图层 ref 不再属于当前 composition，轻量路径会返回失败并自动退回结构级刷新，避免旧缓存造成错误画面。

### 4.3 区分视觉变化与结构变化

涉及文件：

- `src/10-editor.js`

已将编辑器操作分级。

纯视觉操作使用 `visual`：

- 单图层旋转；
- 单图层缩放；
- 素材整体旋转和缩放；
- X/Y 偏移；
- 透明度；
- 颜色预览。

会影响合成结构的操作使用 `structure`：

- 添加素材；
- 删除素材；
- 添加、复制、删除图层；
- 隐藏或显示图层；
- 隐藏或显示材料；
- 恢复或清除图层；
- 改变图层 Priority；
- 需要重新排序或重建 AppearanceLayers 的默认值操作。

这样可以避免单纯旋转角度时触发不必要的图层排序和合成对象创建，同时保留结构操作的正确性。

### 4.4 保持编辑器对象身份，避免每次 UI 重绘重新标准化

涉及文件：

- `src/07-renderer.js`
- `src/10-editor.js`

编辑器打开、导入和保存边界仍然会执行 composition 标准化。

在编辑器实时预览期间：

- `buildLocalSyntheticItems` 复用当前已标准化的编辑器 composition；
- `renderLayerList` 不再每次界面重绘都调用 `normalizeComposition`；
- 图层 ref 的对象身份保持稳定；
- 轻量刷新可以通过对象引用找到当前正在变换的图层。

这样减少了实时旋转期间的数组复制、字段清洗和对象分配。

### 4.5 缓存 Visual Asset Proxy，但保持材料隔离

涉及文件：

- `src/01-runtime.js`
- `src/06-adapters.js`

Visual Asset Proxy 现在按 material 缓存：

```text
同一 material 的多个图层 → 共享一个 proxy
不同 material 即使来源 Asset 相同 → 使用不同 proxy
```

之所以不能简单按原始 Asset 缓存，是因为 BC 的绘制代码会通过 Asset 对象身份寻找对应 Item。如果两个材料共用同一个代理，可能造成：

- 颜色读取串到另一个材料；
- Property 读取错误；
- 同源素材的两个材料无法独立渲染。

本次复查已经修正为 material 级对象身份隔离。

### 4.6 移除预览热路径中的材料序列化

涉及文件：

- `src/06-adapters.js`
- `src/02-data.js`

旧路径在每次合成构建时都会对材料和引用执行：

```text
compactMaterialForStorage
compactLayerForStorage
JSON.stringify
TextEncoder.encode
MAX_MATERIAL_BYTES 检查
```

这部分检查对持久化和网络边界有价值，但在用户连续旋转时会反复产生临时字符串和编码对象。

现在：

- 实时预览构建不再进行材料预算序列化；
- `compactCompositionForStorage` 仍然检查每个 material 的 `MAX_MATERIAL_BYTES`；
- composition 仍然检查 `MAX_SCHEME_BYTES`；
- wardrobe 仍然检查 `MAX_WARDROBE_BYTES`；
- 远端协议仍然检查单材料和整体快照预算。

优化只移除了热路径中的重复检查，没有降低持久化或协议边界的安全限制。

### 4.7 单层几何变化不再触发冗余刷新

涉及文件：

- `src/07-renderer.js`

`cacheOverallLayerGeometry` 会继续记录真实纹理尺寸、Alpha 有效区域和变换后的几何包围盒。

但现在只有当材料确实存在整体旋转或整体缩放时，几何变化才会安排下一帧整体中心刷新。

单独的局部旋转和局部缩放不会因为包围盒每一度变化而额外安排第二次人物刷新。

整体变换等待真实纹理几何时，仍保留 `pendingCenter` 语义，待真实几何到达后进行必要更新。

### 4.8 减少无意义的整体中心工作

涉及文件：

- `src/07-renderer.js`

对于没有整体旋转和整体缩放的材料：

- 不需要整体 pivot；
- 不需要遍历所有图层计算中心；
- 只存在整体偏移时可以直接渲染。

对于存在整体旋转或整体缩放的材料：

- 优先使用运行时真实几何中心；
- 尚无真实几何时保留 BC 坐标管线计算出的默认中心；
- 视觉上的整体旋转和缩放仍等待运行时纹理中心准备完成，不围绕不可靠的占位几何显示。

### 4.9 增强刷新异常隔离和兼容回退

涉及文件：

- `src/08-ui-shell.js`

刷新队列按角色分别捕获异常。

如果轻量画布重绘或结构刷新失败：

1. 记录警告；
2. 对允许回退的级别尝试 `CharacterRefresh`；
3. 不阻塞队列中其他角色的刷新。

这保留了性能优化带来的收益，同时降低了和其他 BC Mod 的 hook 发生冲突时的影响范围。

## 5. 未完成的优化

以下内容经过分析，但本次没有修改，后续任务不能默认它们已经优化。

### 5.1 WebGL 变换图层仍然存在双绘制

涉及位置：

- `src/07-renderer.js` 的 `GLDrawImage` 包装

当前变换路径仍然是：

```text
关闭颜色写入
  → 调用 BC 原始 GLDrawImage
  → 恢复颜色写入
  → 写入 COE 变换矩阵
  → 再执行一次 gl.drawArrays
```

因此每个变换图层仍然会额外执行一次绘制。

本次没有改动它，因为原始 GLDrawImage 同时负责：

- 纹理加载；
- AlphaMask；
- TextureAlphaMask；
- program 选择；
- BlendingMode；
- 颜色和透明度 uniform；
- 其他可能由 BC 或第三方 Mod 注入的绘制状态。

直接改成一次绘制虽然潜在收益很高，但兼容性风险也最高，应单独设计实验和回退方案。

### 5.2 WebGL 状态查询仍然存在

当前仍会调用：

```js
gl.getParameter(gl.COLOR_WRITEMASK)
gl.getParameter(gl.CURRENT_PROGRAM)
```

并在必要时调用：

```js
gl.getUniformLocation(program, "u_matrix")
```

这些调用可能产生同步状态查询开销。本次没有移除，因为需要先确认 BC 当前运行版本、其他 Mod 的 GL 状态修改方式和 program 生命周期。

后续可以考虑：

- 缓存 program 和 uniform location；
- 明确颜色写入状态的保存和恢复边界；
- 通过开发者工具比较查询前后的 GPU/主线程耗时。

### 5.3 角度输入仍然是整数度

当前编辑器输入仍使用：

```html
step="1"
```

并且会对旋转角度执行 `Math.round`。

这会带来输入离散感，尤其是距离旋转中心较大的图层：

```text
半径 100 px：每 1° 约移动 1.75 px
半径 200 px：每 1° 约移动 3.49 px
半径 300 px：每 1° 约移动 5.24 px
```

这属于交互采样精度问题，不完全属于渲染性能问题。本次没有修改角度语义，也没有新增滑杆或连续拖动控件。

后续应先确认真实帧率已经稳定，再单独评估：

- `0.1°` 输入精度；
- 滑杆输入；
- pointer drag；
- 输入显示精度与持久化精度的分离。

### 5.4 没有建立完整的生产环境性能面板

本次增加的是行为回归测试，没有在正式插件中加入长期性能统计面板。

目前仍缺少真实游戏中的以下数据：

- 单次旋转输入对应的实际刷新次数；
- `CharacterRefresh` 的 p50/p95 耗时；
- `CharacterLoadCanvas` 和 `CharacterAppearanceBuildCanvas` 耗时；
- 每帧 `GLDrawImage` 调用数；
- 变换图层数量与帧时间的关系；
- GPU 命令耗时；
- 垃圾回收造成的长帧比例。

如果后续要继续优化 WebGL 层，应先加入可关闭的诊断统计，而不是凭体感继续改矩阵代码。

### 5.5 没有改动 BC 原生动画和全人物刷新机制

本次只在 COE 编辑器预览和 COE 合成层刷新路径中降低刷新级别。

没有改动：

- BC 的 `CharacterRefresh` 实现；
- BC 的动画系统；
- BC 的全局 `CharacterLoadCanvasAll`；
- BC 的其他人物刷新来源；
- 其他 Mod 对这些函数的 hook。

因此游戏在姿势变化、角色状态变化或第三方 Mod 主动请求完整刷新时，仍可能执行原生全量流程，这是预期行为。

### 5.6 没有做纹理级合批或离屏缓存

当前仍是每个素材图层分别进入 BC/COE 绘制流程。

没有实现：

- 多层纹理合并；
- 离屏 Canvas/WebGL framebuffer 缓存；
- 仅更新旋转图层、复用其他人物层的局部画面；
- 材料级离屏纹理缓存。

这些方案会影响遮罩、颜色、透明度、Z 顺序和姿势坐标，属于更大范围的渲染架构改造，不应和本轮轻量优化混在一起。

## 6. 关键兼容性边界

### 6.1 轻量刷新只能用于纯视觉变换

如果操作改变了以下内容，应继续使用结构级刷新或完整刷新：

- 图层数量；
- 图层顺序；
- 图层隐藏状态；
- 材料隐藏状态；
- Asset 来源；
- 姿势坐标；
- 影响 AppearanceLayers 的字段；
- 影响 Mask 或动态行为的字段。

不要为了追求更高帧率，把这些操作强行塞进 `visual` 路径。

### 6.2 Visual Proxy 的缓存键不能退回原始 Asset

后续修改时必须保持：

```text
proxy cache key = material identity
```

不能简单改回：

```text
proxy cache key = source Asset identity
```

因为同一来源 Asset 可以被不同材料重复使用，而材料拥有独立颜色、属性和整体变换。

### 6.3 整体中心字段不能被删除或替换为本地持久化字段

整体中心仍是运行时自动计算值，不进入远端协议。

远端接收端需要根据本地纹理几何重新计算中心，不能把发送端的中心写入协议作为永久值。

### 6.4 关闭编辑器时不要清空整个刷新队列

刷新队列是共享队列，可能同时包含：

- 本地编辑器预览刷新；
- 远端角色纹理完成后的刷新；
- Alpha 中心完成后的刷新。

关闭编辑器只能移除本地玩家的预览请求，不能无条件重置整个队列。

### 6.5 轻量路径必须保留降级能力

如果出现以下任意情况，应让 `syncLocalSyntheticRuntime` 返回失败：

- composition 和 synthetic groups 数量不一致；
- group 的 ref 不属于当前可见图层；
- material 不存在或已隐藏；
- Asset proxy 无法解析来源 Asset；
- 当前运行时对象身份不能确认是最新的。

然后使用 `CharacterLoadCanvas` 或 `CharacterRefresh` 重新建立一致状态。

## 7. 测试与构建结果

本次最终验证结果：

```text
测试：90/90 通过
构建：通过
dist 语法检查：通过
git diff --check：通过
```

新增或加强的重点回归测试包括：

- 单层几何变化不触发冗余刷新；
- 同帧刷新请求只安排一个轻量重绘；
- 编辑器实时变换复用图层 ref 和 Visual Proxy；
- 无整体变换时不执行无意义中心遍历；
- 预览构建不执行材料预算序列化；
- 同源 Asset 的不同材料保持不同 CommonDraw identity；
- 编辑器关闭后远端刷新请求不丢失；
- 过期 editor ref 自动降级到结构级刷新；
- 整体中心仍可在远端接收端正确解析；
- 远端和本地的局部/整体变换字段保持分离。

## 8. 后续推荐顺序

如果继续优化，推荐严格按照下面顺序进行：

### 第一阶段：真实环境取证

加入可关闭的诊断统计，确认：

- 一次旋转输入是否已经稳定对应一次刷新；
- 轻量重绘的实际耗时；
- 长帧是否仍主要发生在 GLDrawImage；
- 双绘制和状态查询在真实浏览器中的占比。

### 第二阶段：WebGL 状态查询优化

在确认 BC 和第三方 Mod 的状态边界后，尝试缓存：

- `CURRENT_PROGRAM`；
- `u_matrix`；
- 必要的纹理和 uniform 状态。

必须提供异常回退，不能假设 program 始终稳定。

### 第三阶段：评估单次绘制路径

研究是否能够在保留 BC 所有 mask、颜色、混合和纹理语义的前提下，跳过隐藏的原始 `drawArrays`。

这一阶段必须配套：

- 普通图层测试；
- Mirror/Invert 测试；
- AlphaMask 测试；
- TextureAlphaMask 测试；
- 颜色和透明度测试；
- BlendingMode 测试；
- 眨眼图层测试；
- 其他 Mod 共存测试。

### 第四阶段：输入平滑度优化

在帧率确认稳定后，再处理整数度输入带来的阶梯感。输入精度调整不应和 WebGL 绘制重构同时进行。

### 第五阶段：离屏或合批方案

只有在前面几阶段仍无法满足性能目标时，才考虑材料级离屏缓存、纹理合批或局部画面缓存。

## 9. 参考文件

本次实现主要涉及：

- `src/01-runtime.js`
- `src/02-data.js`
- `src/06-adapters.js`
- `src/07-renderer.js`
- `src/08-ui-shell.js`
- `src/10-editor.js`
- `src/15-bootstrap.js`
- `tests/transform.test.js`
- `dist/CustomOutfitEditorEchoMirror.user.js`

相关历史文档：

- `docs/COE-Echo-Mirror-单图层变换机制完全重构任务.md`
- `docs/COE-Echo-Mirror-整体变换中心漂移-深度研究交接.md`
- `docs/COE-Echo-Mirror-整体变换中心错误选择-最终修复记录.md`
- `docs/变换渲染与持久化诊断-2026-07-27.md`
- `docs/architecture.md`

## 10. 变更摘要

本次已经完成的核心优化可以概括为：

```text
重复完整刷新
  → 同帧刷新合并
  → 纯视觉变换走轻量画布重绘
  → 结构变化才重建 AppearanceLayers
  → 复用稳定的合成对象和 material 级 Visual Proxy
  → 移除预览热路径中的材料序列化
  → 保留完整回退和协议/持久化边界校验
```

尚未完成的核心优化可以概括为：

```text
WebGL 双绘制未移除
WebGL 状态查询未移除
整数角度输入未平滑化
未建立正式运行时性能面板
未进行纹理合批、离屏缓存或局部画面缓存
```
