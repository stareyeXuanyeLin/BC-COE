# COE-Echo-Mirror 素材整体旋转/缩放中心漂移问题：深度研究交接文档

> 文档时间：2026-07-27 19:50（Asia/Shanghai）  
> 项目：`BC-Plugin/COE-Echo-Mirror`  
> BC 目标版本：R130  
> 当前目的：将现象、代码链路、已尝试修复、数学约束和下一步取证方案完整交接给新窗口的高性能模型。

---

## 1. 当前用户现象

用户反馈素材服装整体的旋转和缩放已经有明显效果，当前表现大致如下：

- 服装会按照某个旋转中心旋转；
- 缩放也会围绕某个中心发生；
- 但在旋转或缩放过程中，服装的中心仍然发生漂移；
- 视觉上像地球自转，同时围绕另一个远处的点公转；
- 旋转角度或缩放比例变化时，服装整体位置会沿弧线或斜向移动；
- 用户认为当前“中心点位置会改变”，希望旋转与缩放始终围绕同一个固定中心。

这条反馈发生在已经完成以下修复之后：

1. 整体变换由原先无效变为可见；
2. 整体中心由“最大面积图层中心”改成多图层联合包围盒中心；
3. 坐标管线加入 `DynamicGroupName`、姿势移动、`CanvasUpperOverflow`、`BodyStyle.DrawOffset` 等处理；
4. 修复数字型 `DrawingLeft` / `DrawingTop` 的图层偏移；
5. 修复 Mirror、Invert 和 Blink 区域的中心处理；
6. 将原先多段嵌套矩阵改写为“先计算整体变换后的局部中心，再绘制图像”。

当前问题因此已经从“整体变换完全无效”进入“整体变换有效，但中心仍然漂移”的阶段。

---

## 2. 当前源码状态

当前涉及的主要文件：

```text
BC-Plugin/COE-Echo-Mirror/src/02-data.js
BC-Plugin/COE-Echo-Mirror/src/04-assets.js
BC-Plugin/COE-Echo-Mirror/src/07-renderer.js
BC-Plugin/COE-Echo-Mirror/src/15-bootstrap.js
BC-Plugin/COE-Echo-Mirror/tests/transform.test.js
BC-Plugin/COE-Echo-Mirror/dist/CustomOutfitEditorEchoMirror.user.js
```

当前测试结果：

```text
71 项通过
0 项失败
```

当前构建检查：

```text
npm run build 通过
npm run check 通过
```

注意：测试全部在 Node 模拟环境中运行，尚未证明 BC 页面中的真实 `GLDrawImage` 矩阵几何完全正确。现有测试主要验证参数传递、中心函数输入输出和部分 hook 行为，缺少真实纹理尺寸、真实 WebGL 顶点矩阵和实际回调坐标的闭环验证。

---

## 3. 完整渲染链路

### 3.1 数据层

素材整体变换字段位于 material：

```js
material.overallRotation
material.overallScale
material.overallOffsetX
material.overallOffsetY
```

图层局部变换字段位于 layer：

```js
layer.rotation
layer.scale
layer.offsetX
layer.offsetY
```

当前没有持久化的显式 `overallPivotX/Y` 字段，整体中心每次由几何函数自动计算。

### 3.2 中心计算

入口：

```js
resolveOverallTransform(composition, character, material)
```

其内部调用：

```js
computeDefaultOverallCenter(composition, character, materialId)
```

当前计算逻辑：

```text
遍历当前 material 的所有可绘制 layer
→ 获取 Asset 和 sourceLayer
→ 尝试调用 CommonDrawComputeDrawingCoordinates
→ 得到 layer 左上角
→ 叠加 DrawingWidth / DrawingHeight
→ 处理 Mirror / Invert
→ 计算所有 layer 的联合包围盒
→ 返回联合包围盒中心
```

相关代码位于：

```text
src/02-data.js
resolveOverallLayerRect()
computeDefaultOverallCenter()
```

### 3.3 参数注入

`buildStaticSynthetic()` 为素材的每一个图层创建独立的 synthetic item，但将同一个 `overall` 对象注入所有图层：

```js
perLayerProperty.OverallRotation = overall.rotation;
perLayerProperty.OverallScale = overall.scale;
perLayerProperty.OverallOffsetX = overall.offsetX;
perLayerProperty.OverallOffsetY = overall.offsetY;
perLayerProperty.OverallCenterX = overall.centerX;
perLayerProperty.OverallCenterY = overall.centerY;
```

这一步的设计目标是：

```text
同一个 material 的所有图片层共享同一个 overall pivot
```

### 3.4 CommonDraw 回调

`CommonDrawAppearanceBuild` hook 会替换四个图像回调：

```js
drawImage
drawImageBlink
drawImageColorize
drawImageColorizeBlink
```

回调中把图层局部变换和素材整体变换写入 `options`：

```js
transformed.Rotation = ref.rotation;
transformed.Scale = ref.scale;
transformed.OverallRotation = overall.rotation;
transformed.OverallScale = overall.scale;
transformed.OverallOffsetX = overall.offsetX;
transformed.OverallOffsetY = overall.offsetY;
transformed.OverallCenterX = overall.centerX;
transformed.OverallCenterY = overall.centerY;
```

### 3.5 GLDrawImage hook

`GLDrawImage` hook 从 options 读取：

```js
Rotation
Scale
OverallRotation
OverallScale
OverallOffsetX
OverallOffsetY
OverallCenterX
OverallCenterY
```

然后获取纹理真实尺寸：

```js
GLDrawLoadImage(gl, url)
```

并计算：

```js
drawX
drawY
signedW
signedH
localCenterScreenX
localCenterScreenY
```

当前矩阵实现已经改为：

```text
1. 计算局部图层中心经过 overall 变换后的最终位置
2. 以该最终位置作为图像平移锚点
3. 合并整体旋转和局部旋转
4. 合并整体缩放和局部缩放
5. 绘制纹理
```

相关代码位于：

```text
src/07-renderer.js
transformPointAroundOverallPivot()
installGLDrawImageTransformHook()
```

---

## 4. 理论上必须满足的几何不变量

定义：

```text
C = 整体 pivot
O = 整体偏移
R = 整体旋转
S = 整体缩放
P = 任意图层局部中心
```

整体变换后的局部中心应为：

```text
P' = C + O + S × R × (P - C)
```

当 `P = C` 时，必须满足：

```text
P' = C + O
```

也就是说：

- 旋转不会移动 pivot；
- 缩放不会移动 pivot；
- 只有整体偏移会移动 pivot；
- `R` 和 `S` 的变化不能让 pivot 围绕第三个点运动。

当前纯函数实现：

```js
function transformPointAroundOverallPivot(
  x, y,
  pivotX, pivotY,
  rotation, scale,
  offsetX = 0,
  offsetY = 0,
) {
  const dx = x - pivotX;
  const dy = y - pivotY;
  const cos = Math.cos(rotation || 0);
  const sin = Math.sin(rotation || 0);
  return {
    x: pivotX + offsetX + scale * (cos * dx - sin * dy),
    y: pivotY + offsetY + scale * (sin * dx + cos * dy),
  };
}
```

这条纯数学函数的测试已经通过，但它只证明“点变换公式正确”，不能证明 `P`、`C` 和 WebGL 中真正使用的像素坐标属于同一个空间。

当前研究重点应转向：

```text
公式可能正确，但输入的 P / C / drawX / drawY / textureWidth 不在同一个几何空间
```

---

## 5. 已实施但未能解决现象的修复

### 5.1 从最大面积图层改为联合包围盒

旧实现：

```js
area = width * height;
largest = area 最大的图层;
center = largest 图层中心;
```

新实现：

```js
left = min(all layer left)
top = min(all layer top)
right = max(all layer right)
bottom = max(all layer bottom)
center = ((left + right) / 2, (top + bottom) / 2)
```

这个修改符合用户提出的“四条边取所有图层最大范围”的要求，但当前用户反馈表明，仅修正联合包围盒仍不足以消除漂移。

### 5.2 复用 BC 原生坐标函数

当前会尝试调用：

```js
globalThis.CommonDrawComputeDrawingCoordinates
```

传入：

```js
character
asset
positionedLayer
asset.DynamicGroupName
material.sourceProperty
```

如果调用失败，则回退到 COE 自己复现的坐标管线。

风险点：

- 新窗口需要确认这个函数在真实 Tampermonkey / ModSDK 执行环境中是否真的可通过 `globalThis` 访问；
- 如果函数没有暴露到当前用户脚本 realm，当前代码实际一直在使用 fallback；
- fallback 与 BC R130 的完整坐标计算仍可能存在细节差异。

### 5.3 修复 `DynamicGroupName`

当前已经将：

```js
asset.DynamicGroupName || asset.Group?.Name
```

作为坐标管线的 groupName 来源。

### 5.4 修复数字型 DrawingLeft / DrawingTop

当前 `shiftOrigin()` 同时支持：

```js
100 + offset
{ Default: 100, Kneel: 120 } + offset
```

### 5.5 修复 Mirror / Invert / Blink

当前整体中心计算和 GL 矩阵分别尝试处理：

```text
Mirror 的 X 反射
Invert 的 Y 反射
Blink 的第二画布区域偏移
```

这些逻辑仍然需要真实 BC 画面验证。

### 5.6 将矩阵改写为显式最终中心

旧矩阵大致为：

```text
整体平移
→ 整体旋转
→ 整体缩放
→ 整体反向平移
→ 局部中心平移
→ 局部旋转
→ 局部缩放
→ 局部反向平移
→ 图像位置平移
→ 纹理尺寸缩放
```

新矩阵先计算：

```js
transformedLocalCenter = overallTransform(localCenterScreen)
```

再用：

```text
最终局部中心
→ 合并旋转
→ 合并缩放
→ 反向移动到局部中心
→ 图像位置
→ 纹理尺寸
```

这个改法把 pivot 不变量显式化了，但它在数学上仍然等价于原先的 `Overall × Local × Image` 组合。因此当前用户仍然看到漂移时，不能继续默认归因于矩阵嵌套顺序，必须采集真实运行时几何数据。

---

## 6. 当前最可疑的根因排序

### 6.1 计算中心使用的矩形，与 GL 实际绘制矩形不是同一个矩形

当前中心计算使用：

```js
sourceLayer.DrawingWidth
sourceLayer.DrawingHeight
asset.Width
asset.Height
```

当前 GL 实际绘制使用：

```js
GLDrawLoadImage(gl, url).width
GLDrawLoadImage(gl, url).height
```

这两个尺寸来源可能不同。

如果：

```text
DrawingWidth != 实际纹理 width
DrawingHeight != 实际纹理 height
```

那么中心计算虽然稳定，实际图像仍会围绕错误位置旋转和缩放。

这会产生用户描述的典型效果：

```text
看起来图层自身在旋转，同时整个图层绕另一个点运行
```

这是当前最高优先级的待证假设。

需要在真实 `GLDrawImage` hook 中记录：

```js
{
  materialId,
  layerIndex,
  url,
  dstX,
  dstY,
  offsetX,
  textureWidth,
  textureHeight,
  OverallCenterX,
  OverallCenterY,
  Mirror,
  Invert,
}
```

然后计算实际矩形：

```text
normal:
  left = dstX
  top = dstY
  right = dstX + textureWidth
  bottom = dstY + textureHeight

mirror:
  left = 500 - dstX - textureWidth
  right = 500 - dstX

invert:
  drawY = canvasHeight - dstY + 550
  top = drawY - textureHeight
  bottom = drawY
```

再将这些真实矩形与 `OverallCenterX/Y` 比较。

### 6.2 整体 pivot 在原始 layer 空间，实际整体变换发生在局部变换后的空间

当前整体中心由未应用图层级旋转和缩放的矩形计算：

```text
source layer 原始矩形联合包围盒中心
```

而实际绘制顺序是：

```text
局部图层旋转/缩放
→ 素材整体旋转/缩放
```

如果同一素材的某些图层已经具有：

```js
layer.rotation
layer.scale
```

那么整体变换接收到的几何输入已经被局部变换改变，原始矩形中心可能不再是局部变换后的素材组中心。

当前代码没有把图层局部旋转/缩放后的四角重新计算到整体包围盒中。

需要验证两组情况：

```text
A. 所有 layer.rotation = undefined，layer.scale = undefined
B. 存在局部图层旋转或缩放
```

如果 A 正常、B 漂移，根因就在“整体 pivot 位于局部变换前空间”。

### 6.3 纹理透明区域导致“几何中心”和“视觉中心”不同

单图层局部变换会尝试使用纹理 Alpha 内容中心：

```js
resolveTextureContentPivot(url)
```

整体素材中心当前使用的是：

```text
DrawingLeft / DrawingTop / DrawingWidth / DrawingHeight 的联合包围盒
```

如果服装纹理包含大量透明留白，那么：

```text
纹理矩形中心
≠ Alpha 内容中心
```

多个图层又可能拥有不同的透明留白，最终联合矩形中心可能偏离用户眼中的服装中心。

这会让服装看起来绕外部点旋转，即使数学 pivot 对矩形而言是固定的。

需要区分两种现象：

1. 实际 pivot 坐标发生变化；
2. pivot 固定，但不对称服装的视觉质心随旋转移动。

当前编辑器没有显示素材整体中心十字，因此无法仅凭肉眼判断两者。

### 6.4 `CommonDrawComputeDrawingCoordinates` 可能没有被真实调用

当前代码使用：

```js
const coordinateResolver = globalThis.CommonDrawComputeDrawingCoordinates;
```

但用户脚本环境可能存在 realm 隔离、函数未导出或函数名称被 ModSDK 包装的情况。

必须在真实页面确认：

```js
typeof globalThis.CommonDrawComputeDrawingCoordinates
```

如果结果不是 `"function"`，则当前所谓“复用 BC 原生坐标”没有发生，全部依赖 fallback。

### 6.5 `OverallCenterX/Y` 可能在 callback 传递链上被覆盖

需要逐段记录：

```text
buildStaticSynthetic 中的 overall.centerX/Y
→ CommonDraw callback 包装后的 options
→ ExtendedItemGetDrawingOptions 返回值
→ GLDrawImage hook 收到的 options
```

如果这四处数值不一致，问题属于数据穿线或 hook 顺序，而非矩阵几何。

### 6.6 实际加载的 dist 与当前 src 不一致

当前源码和 dist 已重新构建，但实机仍需确认加载的 userscript 是：

```text
BC-Plugin/COE-Echo-Mirror/dist/CustomOutfitEditorEchoMirror.user.js
```

不能仅根据本地文件内容推断浏览器当前运行版本。

建议在插件初始化时记录：

```js
pluginVersion
build marker
GLDrawImage._coeTransformWrapped
```

---

## 7. 当前代码中需要特别注意的数学细节

### 7.1 真实矩形与局部中心

GL 中的图像位置为：

```js
drawX = Mirror ? 500 - dstX : dstX;
drawY = Invert ? gl.canvas.height - dstY + 550 : dstY;
```

纹理尺寸为：

```js
signedW = (Mirror ? -1 : 1) * texW;
signedH = (Invert ? -1 : 1) * texH;
```

局部中心为：

```js
localCenterScreenX = drawX + localPivotX * signedW;
localCenterScreenY = drawY + localPivotY * signedH;
```

因此中心不能简单使用：

```js
DrawingLeft + DrawingWidth / 2
```

必须保证 `DrawingLeft`、`dstX`、`texW` 和 `OverallCenterX` 处于相同的最终画布空间。

### 7.2 Blink 偏移

Blink callback 的 `offsetX` 通常是第二画布区域的偏移。当前代码对：

```js
drawX
localCenterScreenX
overallCenterX
```

分别处理了 blink 偏移。

必须确认不会出现以下任意一种情况：

```text
overallCenterX 加了 offsetX，localCenterScreenX 没加
localCenterScreenX 加了两次 offsetX
overallCenterX 加了两次 offsetX
```

当前代码中的意图是：

```js
drawX 已包含 off
localCenterScreenX 基于 drawX
overallCenterX 在显式 options 中时额外加 off
```

这条逻辑需要真实 Blink 帧测试。

### 7.3 Mirror 变换

BC 的镜像形式不是简单把宽度取负即可，还会先执行：

```js
dstX = 500 - dstX
```

所以镜像矩形的中心应为：

```text
500 - dstX - textureWidth / 2
```

如果整体中心使用的是未镜像中心，而图像局部中心使用镜像中心，则整体旋转天然会产生绕点运动。

---

## 8. 下一窗口应优先进行的真实运行时取证

建议新模型不要先继续改矩阵，而是先加入短期诊断输出，获取一帧完整数据。

### 8.1 在 CommonDraw callback 记录实际回调输入

在 `src/07-renderer.js` 的 image callback wrapper 中临时加入：

```js
const url = callbackArgs[0];
const actualX = Number(callbackArgs[1]);
const actualY = Number(callbackArgs[2]);
const options = callbackArgs[3] || {};

console.debug("[COE overall geometry]", {
  materialId: marker.item?.__coeMaterialId,
  sourceLayerIndex: marker.sourceLayerIndex,
  url,
  actualX,
  actualY,
  offsetX: callbackArgs[4],
  OverallCenterX: options.OverallCenterX,
  OverallCenterY: options.OverallCenterY,
  OverallRotation: options.OverallRotation,
  OverallScale: options.OverallScale,
  Rotation: options.Rotation,
  Scale: options.Scale,
  Mirror: options.Mirror,
  Invert: options.Invert,
});
```

注意：不要每帧无限刷屏，建议按：

```text
character + materialId + layerIndex + 当前变换参数
```

去重，或只记录第一帧和变换参数发生变化的帧。

### 8.2 在 GLDrawImage hook 记录纹理尺寸

在得到 `dim` 后记录：

```js
console.debug("[COE overall gl]", {
  url,
  dstX,
  dstY,
  off,
  texW,
  texH,
  drawX,
  drawY,
  signedW,
  signedH,
  localCenterScreenX,
  localCenterScreenY,
  overallCenterX,
  overallCenterY,
});
```

### 8.3 检查整体中心是否在变换过程中变化

在仅改变整体旋转或整体缩放时，以下字段必须恒定：

```text
OverallCenterX
OverallCenterY
local geometry
actual dstX / dstY
```

允许变化的字段只有：

```text
OverallRotation
OverallScale
```

如果 `OverallCenterX/Y` 数值本身变化，问题在中心计算或角色绘制坐标环境。

如果 `OverallCenterX/Y` 恒定，但图像仍然漂移，问题在：

```text
实际纹理尺寸
矩阵坐标空间
Mirror / Invert / Blink 转换
局部 transform 组合
```

### 8.4 用单层最小样本隔离

按以下顺序测试：

#### 样本 A：单素材、单图层

```text
无 layer.rotation
无 layer.scale
无 Mirror
无 Invert
无 Blink
```

只设置：

```text
overallRotation = 90°
overallScale = 2
```

如果此时仍漂移，优先检查：

```text
OverallCenter 与真实 dstX + texW/2 是否一致
```

#### 样本 B：单素材、多图层

保持所有局部变换为默认值，仅增加第二图层。

如果 A 正常、B 漂移，优先检查：

```text
联合包围盒算法
各图层的坐标是否处于同一空间
```

#### 样本 C：单层局部变换 + 素材整体变换

同时设置：

```text
layer.rotation
layer.scale
overallRotation
overallScale
```

如果只有 C 漂移，优先检查：

```text
整体 pivot 是否应该基于局部变换后的几何
```

#### 样本 D：Mirror / Invert

逐个开启，不要同时开启。

#### 样本 E：Blink

比较普通帧与 Blink 帧的：

```text
overallCenterX
localCenterScreenX
drawX
```

---

## 9. 推荐的最终架构方向

### 9.1 不再从 Asset 元数据猜测最终中心

最稳妥的方案是：

```text
在真实 CommonDraw 绘制阶段采集每个 synthetic layer 的最终 X/Y
结合该帧实际纹理尺寸
建立 material 的最终屏幕空间矩形
用所有矩形求联合包围盒
```

当前 GLDrawImage hook 已经能拿到：

```text
实际 url
实际 dstX / dstY
实际纹理宽高
实际 Mirror / Invert
```

可以建立如下运行时几何缓存：

```js
Map<character, Map<materialId, {
  layers: Map<layerKey, {
    left, top, right, bottom,
    url, width, height,
    mirror, invert,
  }>,
  bounds: { left, top, right, bottom },
  pivot: { x, y },
}>>
```

变换使用上一帧已经确认的 geometry，绘制结束后更新下一帧 geometry。首次绘制可以使用 Asset 元数据 fallback。

### 9.2 将 pivot 与变换矩阵解耦

推荐让每个 material 在一个渲染周期中先确定：

```js
groupPivot = resolveMaterialRenderPivot(material, character, frameGeometry)
```

之后该帧所有图层只读取这一份：

```js
overall.centerX = groupPivot.x
overall.centerY = groupPivot.y
```

不要让每个 `GLDrawImage` 调用独立推导整体中心。

### 9.3 明确中心的语义

需要在以下两个定义中选择一个，并写入文档与测试：

#### 定义一：几何联合包围盒中心

```text
以所有图层最终矩形的四条边求联合范围
```

优点：稳定、可解释、不会受像素扫描失败影响。  
缺点：透明留白较多时，视觉中心可能偏移。

#### 定义二：可见 Alpha 内容联合包围盒中心

```text
以每个图层实际可见 Alpha 内容的边界求联合范围
```

优点：更接近用户看到的服装中心。  
缺点：需要纹理读取、异步缓存和跨域失败 fallback。

用户之前明确提出“四条边取各个图层最大范围”，当前倾向定义一，但如果实机确认几何 pivot 固定而视觉中心仍移动，则需要讨论是否切换为定义二。

### 9.4 必须增加实际矩阵测试

当前 71 项测试不够，需要增加：

```text
单图层真实尺寸与 DrawingWidth 不同
多图层联合包围盒
整体 pivot 不变量
局部 + 整体变换组合
Mirror
Invert
Blink offset
透明 Alpha 内容中心
```

测试不能只检查：

```js
options.OverallCenterX === expected
```

还要检查经过矩阵变换后的关键点：

```text
pivot 点旋转前后位置一致
pivot 点缩放前后位置一致
非 pivot 点符合旋转缩放方程
```

---

## 10. 当前不能直接接受的结论

### 10.1 “矩阵顺序已经正确，所以问题一定在中心算法”

这个结论目前不充分。

当前显式矩阵公式与原始矩阵链在数学上等价。两次改写都没有使用真实 GL 顶点结果验证，因此仍需检查：

```text
输入的整体中心是否正确
输入的局部中心是否正确
输入的纹理尺寸是否正确
最终矩阵是否作用于预期 program / vertex buffer
```

### 10.2 “测试全部通过，所以实际几何正确”

当前测试没有覆盖真实 BC 页面中的：

```text
CommonDraw 实际 X/Y
GLDrawLoadImage 实际尺寸
真实 WebGL matrix
Mirror / Invert / Blink 最终画布
```

71 项通过只能证明当前模拟契约没有破坏，不能证明实机视觉已正确。

### 10.3 “联合包围盒中心一定等于用户眼中的中心”

对于透明留白严重或形状不对称的服装，联合矩形中心与视觉质心可能不同。必须使用中心标记或运行时日志区分：

```text
数学 pivot 漂移
视觉质心移动
```

---

## 11. 建议新窗口的第一条任务指令

可以将以下内容直接交给新模型：

> 请基于 `BC-Plugin/COE-Echo-Mirror/docs/COE-Echo-Mirror-整体变换中心漂移-深度研究交接.md` 继续研究。不要先假设矩阵顺序错误。请先在真实 `CommonDrawAppearanceBuild` / `GLDrawImage` 链路中采集同一 material 的每个图层的 `dstX/dstY`、实际纹理宽高、Mirror/Invert、`OverallCenterX/Y`、局部中心和矩阵输入，验证整体 pivot 是否在旋转缩放过程中保持不变。重点排查 Asset 的 `DrawingWidth/Height` 与 `GLDrawLoadImage` 实际纹理尺寸不一致、局部图层变换前后空间不一致、CommonDraw 原生坐标函数是否真正可访问，以及透明留白导致的几何中心与视觉中心差异。只有完成这些取证后再决定修复矩阵、改用真实绘制几何缓存，或改变 pivot 语义。

---

## 12. 交接结论

当前最重要的事实是：

```text
整体变换参数已经能够到达 GLDrawImage。
整体旋转和缩放已经能够产生画面效果。
联合包围盒中心和显式 pivot 变换公式的 Node 测试均通过。
实机仍然出现服装整体绕外部点运行。
```

因此下一阶段应从“继续猜测矩阵”切换为：

```text
采集真实绘制矩形
确认 C 与真实图像几何是否同空间
确认 pivot 数值是否随变换变化
确认可见视觉中心与数学 pivot 的区别
```

只有这四项数据明确后，才能判断最终修复属于：

```text
A. 真实纹理尺寸修正
B. 运行时绘制几何缓存
C. 局部变换后重新计算 material pivot
D. Mirror / Invert / Blink 坐标修正
E. Alpha 内容中心定义调整
F. WebGL 最终矩阵或 program 状态修正
```
