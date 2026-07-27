# COE-Echo-Mirror 素材服装组整体变换中心错误选择：最终修复记录

> 文档日期：2026-07-27  
> 项目：`BC-Plugin/COE-Echo-Mirror`  
> BC 目标版本：R130  
> 测试素材：`ClothOuter/BusinessSuit`  
> 状态：已修复，源码测试与构建检查通过

---

## 1. 文档目的

记录素材服装组整体旋转、缩放中心先后出现两次错误的完整定位过程和最终修复方案，作为以后排查同类问题的技术依据。

本问题具有较强的迷惑性：

- 旋转和缩放公式本身是正确的；
- `OverallCenterX/Y` 可以正常传递到 `GLDrawImage`；
- Node 模拟测试可以全部通过；
- 但真实服装仍然围绕错误位置旋转；
- 本地 BC 源码不包含美术纹理，无法直接通过仓库文件检查 PNG 尺寸和透明区域。

最终结论是：**整体变换中心必须根据运行时实际纹理及其 Alpha 可见内容计算，不能从 BC Asset 元数据推测。**

---

## 2. 用户可见现象

同一件服装被反复用于测试。

整体变换启用后：

- 服装可以旋转；
- 服装可以缩放；
- 但旋转中心不在服装主体中心；
- 视觉上像服装自身在自转，同时绕另一个偏远点公转；
- 旋转时服装沿弧线或斜向位移；
- 缩放时服装向下方或侧方漂移；
- 后续修复后，旋转中心不再位于远处，但又落到了服装底部附近。

第二阶段的现象尤其重要：它说明“整体矩形尺寸已经改用真实纹理尺寸”仍然不够，完整纹理画布与实际可见服装内容之间还存在透明留白差异。

---

## 3. 相关代码链路

整体变换从数据到 WebGL 的链路如下：

```text
material.overallRotation / overallScale / overallOffsetX / overallOffsetY
        ↓
resolveOverallTransform()
        ↓
buildStaticSynthetic()
        ↓
synthetic item.Property
        ↓
CommonDrawAppearanceBuild hook
        ↓
ExtendedItemGetDrawingOptions hook
        ↓
GLDrawImage hook
        ↓
WebGL u_matrix
```

涉及文件：

```text
src/02-data.js       旧的 Asset 元数据中心计算与整体变换默认值
src/06-adapters.js  synthetic item 以及整体参数注入
src/07-renderer.js  运行时纹理几何、Alpha 边界、整体 pivot 和 GL 矩阵
src/15-bootstrap.js  测试 API 暴露

tests/transform.test.js
                      变换、纹理中心、运行时几何回归测试

dist/CustomOutfitEditorEchoMirror.user.js
                      最终构建产物
```

BC 对应源码：

```text
BondageClub/Scripts/CommonDraw.js
BondageClub/Scripts/GLDraw.js
BondageClub/Scripts/Asset.js
BondageClub/Scripts/Typedef.d.ts
```

---

## 4. 第一阶段根因：使用了 BC R130 不存在的尺寸字段

### 4.1 错误实现

最初的整体中心算法通过 Asset 和 AssetLayer 元数据计算矩形：

```js
left = DrawingLeft
 top = DrawingTop
right = left + DrawingWidth
bottom = top + DrawingHeight
```

实际代码还尝试过以下候选字段：

```js
sourceLayer.DrawingWidth
sourceLayer.DrawingHeight
sourceLayer.Width
sourceLayer.Height
asset.Width
asset.Height
```

如果这些字段不存在，则回退到：

```js
width = 100
height = 100
```

### 4.2 BC R130 的真实结构

BC R130 的 `AssetLayer` 主要提供：

```text
DrawingLeft
DrawingTop
HasImage
Opacity
FixedPosition
MirrorExpression
各种图层行为和颜色属性
```

它没有提供：

```text
DrawingWidth
DrawingHeight
Width
Height
```

`Asset` 对象也没有可用于真实 WebGL 图片矩形的通用宽高字段。

BC 的纹理尺寸直到 `GLDrawLoadImage()` 读取纹理时才可靠可得。

### 4.3 BC 原生真正使用的尺寸

BC R130 的 `GLDrawImage()` 逻辑是：

```js
const tex = GLDrawLoadImage(gl, url);

if (Mirror) dstX = 500 - dstX;
if (Invert) dstY = gl.canvas.height - dstY + 550;

matrix = m4.translate(matrix, dstX + offsetX, dstY, 0);
matrix = m4.scale(
  matrix,
  (Mirror ? -1 : 1) * tex.width,
  (Invert ? -1 : 1) * tex.height,
  1,
);
```

所以真实绘制矩形由以下数据决定：

```text
dstX
dstY
offsetX
tex.width
tex.height
Mirror
Invert
```

### 4.4 错误的几何空间

插件算中心时使用：

```text
DrawingLeft / DrawingTop + 假定 100 × 100
```

WebGL 实际绘制时使用：

```text
dstX / dstY + 真实纹理宽高
```

两者不是同一矩形。

例如，真实纹理为 `400 × 800`，但插件回退使用 `100 × 100`：

```text
真实纹理中心：
(200, 400)

插件中心：
(50, 50)
```

旋转中心误差为：

```text
(150, 350)
```

旋转时，图像自然会绕错误中心运动，形成“自转加公转”的效果。

### 4.5 运行时记录提供的证据

实机曾记录到：

```json
{
  "OverallCenterX": 50,
  "OverallCenterY": 50
}
```

这正好对应：

```text
0 + 100 / 2 = 50
0 + 100 / 2 = 50
```

因此这个中心值不是随机偏差，而是旧 fallback 算法实际运行的直接证据。

---

## 5. 第二阶段根因：完整纹理矩形包含透明留白

第一阶段修复后，整体中心改为使用运行时真实纹理尺寸：

```text
GLDrawImage 中的 dstX/dstY
GLDrawLoadImage 中的 tex.width/tex.height
```

这解决了远处 pivot 的主要问题，但测试服装的中心仍然偏低，落在服装底部附近。

### 5.1 透明纹理的几何问题

服装 PNG 通常不是紧贴可见像素的裁剪图，而是放在一个统一的角色画布中：

```text
完整纹理画布：500 × 1000
实际可见服装：可能只占上半部分
```

如果直接使用完整纹理四边：

```text
left   = drawX
right  = drawX + tex.width
top    = drawY
bottom = drawY + tex.height
```

大量透明区域会参与联合包围盒，使整体中心向透明留白方向移动。

当服装可见内容主要集中在上半区域时，完整纹理矩形中心可能落在服装底部或服装外部。

### 5.2 与旧最大图层算法的关系

用户观察到，第二阶段的中心位置与第一次修复前“最大图层中心”相似。

当前取证结论是：

- 当前代码没有重新复用旧的“最大面积图层中心”算法；
- 相似位置来自测试服装自身的纹理布局；
- 旧算法与“完整纹理矩形中心”在这件服装上恰好产生了接近结果；
- 真正需要排除的是透明留白，而不是继续修改最大图层选择规则。

最终中心语义已经从“最大图层中心”明确改为：

```text
同一素材所有图层的可见 Alpha 内容联合包围盒中心
```

---

## 6. 最终修复方案

### 6.1 运行时采集真实图层几何

在 `CommonDrawAppearanceBuild` 回调包装器中，为每个 synthetic 图层携带内部诊断字段：

```js
transformed.__coeGeometryCharacter = character;
transformed.__coeGeometryMaterialId = marker.materialId;
transformed.__coeGeometryLayerKey = `${marker.sourceLayerIndex}:${marker.sourceOrder}`;
transformed.__coeGeometryIsBlink = name.includes("Blink");
```

进入 `GLDrawImage` 后，插件取得：

```text
url
dstX
dstY
offsetX
tex.width
tex.height
Mirror
Invert
```

运行时缓存结构为：

```js
WeakMap<Character, Map<MaterialId, Map<LayerKey, Rect>>>
```

每个角色和素材各自维护一份缓存，避免相同素材在不同角色之间串用几何数据。

### 6.2 Alpha 边界扫描

纹理加载后复用 BC 的图片缓存：

```js
globalThis.GLDrawImageCache.get(url)
```

通过临时 Canvas 读取像素 Alpha：

```text
Alpha >= 16 才视为有效像素
有效像素数量少于 4 时认为扫描结果不可靠
```

扫描结果为：

```js
{
  minX,
  minY,
  maxX,
  maxY,
  count,
}
```

为了避免每帧读像素，结果按 URL 缓存：

```js
textureContentPivotCache
```

缓存中的最终结构包括：

```js
{
  status: "ready",
  pivot: { x, y },
  bounds: {
    left,
    top,
    right,
    bottom,
  },
}
```

`bounds` 是纹理归一化坐标：

```text
left   ∈ [0, 1]
top    ∈ [0, 1]
right  ∈ [0, 1]
bottom ∈ [0, 1]
```

### 6.3 将 Alpha 边界映射到屏幕空间

对于普通图层：

```js
contentLeft   = drawX + bounds.left  * texW
contentRight  = drawX + bounds.right * texW
contentTop    = drawY + bounds.top   * texH
contentBottom = drawY + bounds.bottom * texH
```

Mirror 和 Invert 使用带符号尺寸：

```js
signedW = Mirror ? -texW : texW;
signedH = Invert ? -texH : texH;
```

通过四个角点映射后再取最小、最大值，可以正确处理反向坐标：

```js
const corners = [
  { x: drawX + left  * signedW, y: drawY + top    * signedH },
  { x: drawX + right * signedW, y: drawY + top    * signedH },
  { x: drawX + right * signedW, y: drawY + bottom * signedH },
  { x: drawX + left  * signedW, y: drawY + bottom * signedH },
];
```

### 6.4 将局部图层变换纳入整体中心

如果某个图层存在局部旋转或缩放：

```js
layer.rotation
layer.scale
```

则先围绕该图层的局部内容中心变换四个 Alpha 边界角点，再参与素材整体包围盒计算。

局部内容中心为：

```js
pivotX = drawX + contentPivot.x * signedW;
pivotY = drawY + contentPivot.y * signedH;
```

局部点变换为：

```text
Q' = P + s × R × (Q - P)
```

其中：

```text
P = 图层可见内容中心
Q = Alpha 边界四角之一
R = 图层局部旋转
s = 图层局部等比缩放
```

这样整体 pivot 代表的是所有图层完成局部变换之后的可见内容范围。

### 6.5 求素材整体联合中心

对同一素材的所有有效图层矩形求联合范围：

```js
left   = min(layer.left)
top    = min(layer.top)
right  = max(layer.right)
bottom = max(layer.bottom)
```

最终中心：

```js
centerX = (left + right) / 2;
centerY = (top + bottom) / 2;
```

这不是各图层中心的平均值，也不是最大图层中心。

它是所有图层可见内容的几何联合包围盒中心。

### 6.6 首帧与加载状态

BC 的 `GLDrawLoadImage()` 在纹理还没有加载完成时可能暂时返回：

```js
{ width: 1, height: 1 }
```

插件对此进行两重保护：

1. `1 × 1` 不写入整体几何缓存；
2. Alpha 扫描尚未完成时，不使用不完整的整体中心应用旋转和缩放。

纹理真实尺寸和 Alpha 边界准备好后，通过角色刷新重新构建 synthetic item，下一帧应用正确 pivot。

### 6.7 Blink 处理

Blink 绘制使用第二个 500px 画布区域。

基础几何缓存只保存普通绘制区域，不保存 Blink 的 `offsetX`：

```text
普通帧 pivot：基础中心
Blink 帧 pivot：基础中心 + 当前 Blink offsetX
```

这样不会出现：

```text
offsetX 被写入缓存一次
GLDrawImage 消费时又加一次
```

同时 Blink 图层不会覆盖普通图层缓存，避免闭眼纹理尺寸不同导致普通中心跳动。

---

## 7. 整体矩阵最终语义

整体变换使用固定的屏幕空间 pivot：

```text
C = 素材整体 pivot
O = 素材整体偏移
R = 素材整体旋转
S = 素材整体缩放
P = 图层局部内容中心
```

整体变换后的局部中心满足：

```text
P' = C + O + S × R × (P - C)
```

当 `P = C` 时：

```text
P' = C + O
```

因此旋转和缩放不会使整体 pivot 自身漂移，只有整体偏移会移动它。

当前 GL 矩阵实现先计算每个图层局部内容中心的整体变换后位置，再以此作为图像变换锚点：

```text
1. 真实纹理位置与 Alpha 内容中心
2. 局部图层变换
3. 素材整体 pivot 变换
4. 合并局部与整体旋转
5. 合并局部与整体等比缩放
6. 写入 WebGL u_matrix
```

---

## 8. 为什么之前的测试没有发现问题

当前测试曾经全部通过，但仍然存在两类建模缺陷。

### 8.1 测试素材人工提供了 BC 不存在的字段

Node 测试 helper 中人为构造过：

```js
DrawingWidth
DrawingHeight
Width
Height
```

这使旧算法在测试环境中获得了合法尺寸，但真实 BC R130 不会提供这些字段。

因此测试证明的是：

```text
当测试数据包含假定尺寸字段时，中心公式正确
```

没有证明：

```text
真实 BC 运行时可以得到这些尺寸字段
```

### 8.2 测试没有覆盖透明留白

旧测试大多把整个纹理矩形当作可见内容，没有模拟：

```text
完整 PNG 画布很大
服装只占局部 Alpha 区域
```

因此“完整纹理矩形中心”与“服装视觉内容中心”的差异没有暴露出来。

### 8.3 当前新增覆盖

最终测试覆盖了：

```text
真实纹理尺寸来自 GLDrawImage
R130 Asset 不含尺寸字段
1 × 1 加载占位纹理
Alpha 可见边界
透明留白
多图层 Alpha 联合范围
局部旋转和缩放
Mirror
Invert
Blink
远端角色几何隔离
```

最终结果：

```text
73 项测试通过
0 项失败
npm run build 通过
npm run check 通过
```

---

## 9. 失败方案与经验

### 9.1 只修改矩阵顺序

没有解决问题。

矩阵公式可以完全正确，但如果输入的 pivot 不属于实际绘制几何空间，最终画面仍然会围绕错误位置运动。

排查顺序应当是：

```text
先验证 C、P、drawX、drawY、纹理尺寸是否同空间
再验证矩阵顺序
```

### 9.2 只使用 Asset 元数据

不可靠。

BC R130 的 Asset 元数据不保存最终 PNG 尺寸；动态 pose、BodyStyle、CanvasUpperOverflow、Mirror 和 Invert 也会影响最终屏幕坐标。

整体中心必须尽量靠近真实绘制点采集。

### 9.3 只使用完整纹理矩形

只能解决“100 × 100 fallback”问题，不能解决“透明留白导致 pivot 偏低”的问题。

服装整体中心的对象是：

```text
可见服装内容
```

而非：

```text
PNG 文件的完整画布
```

### 9.4 只取最大图层中心

不符合素材组语义。

一个素材组可能包含：

```text
主体图层
装饰图层
边缘图层
覆盖图层
```

最大面积图层无法代表所有图层的整体范围。

### 9.5 使用各图层中心的平均值

也不正确。

图层中心平均值没有反映图层尺寸和边界范围。两个很小的装饰图层可能把一个巨大主体图层的中心拉偏。

正确语义是联合包围盒：

```text
所有图层最外侧四条边决定整体中心
```

### 9.6 直接使用当前变换后的边界更新 pivot

危险。

如果每帧用已经应用整体变换的结果重新计算下一帧 pivot，会形成反馈循环：

```text
本帧变换结果
→ 作为下一帧中心输入
→ 中心变化
→ 再次改变变换结果
```

缓存必须保存：

```text
未应用素材整体旋转和缩放的基础绘制几何
```

局部图层变换可以按明确语义纳入，但不能把整体变换后的结果再次反馈给整体 pivot。

---

## 10. 以后遇到类似问题的排查顺序

### 第一步：确认整体参数是否到达 GLDrawImage

检查：

```text
OverallRotation
OverallScale
OverallOffsetX
OverallOffsetY
OverallCenterX
OverallCenterY
```

链路应逐段一致：

```text
material
→ marker.overall
→ synthetic item.Property
→ CommonDraw callback options
→ ExtendedItemGetDrawingOptions
→ GLDrawImage options
```

### 第二步：确认 GLDrawImage hook 是否真的安装

检查：

```js
GLDrawImage._coeTransformWrapped === true
```

如果是 `false`，先解决 hook 安装、初始化竞态或外部覆盖，不要继续调 pivot 数学。

### 第三步：记录真实几何

至少记录：

```js
{
  url,
  dstX,
  dstY,
  offsetX,
  texW,
  texH,
  Mirror,
  Invert,
  OverallCenterX,
  OverallCenterY,
}
```

### 第四步：区分三种中心

必须分别确认：

```text
完整纹理矩形中心
Alpha 可见内容中心
用户主观视觉中心
```

它们可以完全不同。

### 第五步：检查是否复用了旧算法

搜索：

```text
largest area
max area
largest layer
DrawingWidth
DrawingHeight
asset.Width
asset.Height
```

确认整体中心没有回退到：

```text
最大面积图层
虚构尺寸 fallback
完整纹理矩形
```

### 第六步：隔离特殊坐标变换

依次测试：

```text
单图层、无 Mirror、无 Invert、无 Blink
多图层
局部图层旋转和缩放
Mirror
Invert
Blink
```

不要一开始同时打开全部特殊情况。

---

## 11. 当前实现的边界与限制

### 11.1 Alpha 读取依赖浏览器 Canvas

如果纹理跨域导致 Canvas 无法读取像素，插件会将 Alpha 扫描状态标记为失败，并退回完整纹理矩形中心。

这是安全的降级路径，但视觉中心可能再次受到透明留白影响。

### 11.2 Alpha 阈值不是视觉质心

当前算法取的是：

```text
Alpha 可见内容包围盒中心
```

不是：

```text
Alpha 加权质心
```

因此不透明区域左右或上下严重不均匀时，几何中心与视觉重心仍可能不同。

这属于中心定义选择，不应与 pivot 漂移混为一谈。

### 11.3 动画或动态 URL

当前缓存按 URL 保存 Alpha 边界。若同一个 URL 的内容会动态变化，则需要额外引入纹理版本或失效策略。

普通 BC 服装静态 PNG 不受此限制。

### 11.4 首帧存在测量延迟

纹理和 Alpha 边界异步准备期间，整体旋转和缩放可能暂缓一帧。

这是为了避免围绕错误中心显示，不应改回固定 `100 × 100` fallback。

---

## 12. 最终文件状态

本次最终修复涉及：

```text
src/07-renderer.js
src/15-bootstrap.js
tests/transform.test.js
dist/CustomOutfitEditorEchoMirror.user.js
```

相关研究和历史资料：

```text
docs/COE-Echo-Mirror-整体变换中心漂移-深度研究交接.md
docs/变换渲染与持久化诊断-2026-07-27.md
docs/task-layer-transform-center-and-group-rotation.md
```

最终验证：

```text
73 项测试通过
0 项失败
npm run build 通过
npm run check 通过
```

---

## 13. 一句话结论

**素材服装组整体变换中心不能从 BC Asset 元数据、最大图层或完整 PNG 画布推测，必须在真实 `GLDrawImage` 绘制阶段取得纹理尺寸，读取 Alpha 可见边界，并以所有图层可见内容的联合包围盒中心作为唯一整体 pivot。**
