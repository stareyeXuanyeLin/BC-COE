# COE Remote 1.8.1 架构

## 模块边界

- `01-runtime`：共享常量、状态和基础工具。
- `02-data`：当前衣柜与服装结构的归一化、compact 序列化。
- `02-schema-migrations`：持久化衣柜的版本识别、逐级迁移和迁移后校验。
- `03-storage`–`06-adapters`：双来源存储、迁移备份与写回闸门、Asset 解析、诊断及静态视觉代理。
- `07-renderer`：本地/远端两条 synthetic 构建路径、稳定图层插入、CommonDraw 隔离和 Bundle 防护。
- `08-ui-shell`–`10-editor`：UI、衣柜、独立 RemotePrefs 和编辑器。
- `11-remote-protocol`：无网络副作用的 envelope/snapshot validator、canonical、SHA-256、base64url、分片。
- `12-remote-store`：roomGeneration、peer、pending、assembly、active snapshot、预算、限流和统计。
- `13-remote-transport`：Hidden handler、ServerSend 封装、高优先级控制队列及按目标轮转的 8 片快照突发队列；不读衣柜、不操作 Appearance。
- `14-remote-controller`：本地快照、revision、STATE/REQUEST/CHUNK/CLEAR 状态机、偏好和房间生命周期。
- `15-bootstrap`：重复实例检测、Hook 安装、初始化、API/status 接线。

## 正式 Appearance 边界

COE Mirror 的当前架构由本地衣柜、`COE_RVP/1` Room Visual Publication、绘制阶段 Synthetic Rendering 和原版服装格标签组成。运行时不会把来源素材本体作为正式服装穿到 Appearance，也不读取旧 `CustomComposition` 或安装旧容器入站过滤 Hook；启用方案时只会在对应服装格穿上无图片的 `COECustomOutfit` 标签，用于参与 BC 原生穿脱互动和控制该格自定义服装的可见性。

`ServerAppearanceBundle` Hook 只过滤带 `__coeMaterialId` 的临时 Synthetic Item，不会筛除 `COECustomOutfit` 标签或其它正式服装项目。每个客户端都必须在启动阶段注册同名标签 Asset；安装或更新后需刷新页面并重新入房，确保在线 Appearance 能按新的 Asset 注册表解析。

## 数据流

```text
activeComposition
  → resolveOverallTransform（逐素材中心与素材整体变换，默认取该素材最大可见内容图层）
  → buildLocalRemoteSnapshot（只取可见静态视觉）
  → strict canonical → async SHA-256
  → STATE → REQUEST → 定向 CHUNK

Hidden Content
  → prefix/长度/Sender/限流
  → envelope parse + strict validate
  → pending/assembly/预算
  → snapshot parse + strict validate + canonical/hash
  → Store<MemberNumber, validated snapshot>
  → CharacterRefresh(character, false, false)

变换数据分为两个层级：图层保存 `rotation/scale/mirrorX/mirrorY/offsetX/offsetY`，material 保存 `overallRotation/overallScale/overallMirrorX/overallMirrorY/overallOffsetX/overallOffsetY`。镜像采用原地语义，单图层围绕纹理 Alpha 有效内容中心翻转，素材整体围绕同一 material 全部可见图层的联合包围盒中心翻转；素材镜像会同时改变各图层内容及其相对位置。GL 绘制严格按 `素材整体 × 单图层 × 原始图片` 组合，镜像会改变坐标系手性，因此两级旋转与带符号缩放保持独立矩阵阶段，不再合并角度。Alpha 扫描未完成或失败时单图层回退到纹理中点，素材整体中心由真实绘制几何缓存计算；编辑器按图层和素材分别提供水平、垂直镜像操作。
```

网络对象不会进入 `normalizeComposition()`；AssetGet 只发生在 validated snapshot 已进入 Store 后的绘制解析阶段。编辑器重绘使用非破坏性的字段规范化，素材/图层身份过滤只在衣柜加载、导入和持久化边界执行，避免临时解析失败时从正在编辑的对象中静默删层。

## 绘制路径

```text
CharacterAppearanceSortLayers(character)
  → next(args) 得 baseLayers
  ├─ Player: buildLocalSyntheticItems
  ├─ remote + active snapshot: buildRemoteSyntheticItems
  └─ remote + no snapshot: 原 baseLayers 引用返回
  → makeSyntheticLayers
  → stableInsertSyntheticLayers（不重排 base）

CommonDrawAppearanceBuild(character)
  → WeakMap 取本次 groups
  → 无 groups：next(args)
  → 临时替换 Appearance / AppearanceLayers
  → next(args)
  → finally 恢复两个原引用
```

远端 Store 键是 MemberNumber，不是 Character 对象；`syntheticByCharacter` WeakMap 仅是当前 Character 实例的短期绘制缓存。Character 重建后 snapshot 自动按 MemberNumber 重绑。

## 远端 material 解析

1. `AssetGet(character.AssetFamily, group, asset)`；
2. layer index 必须存在，给定 name 必须与该 index 的本机 layer 一致；
3. 仅 `HasImage && !LockLayer`；
4. capability analysis 仅诊断；
5. 创建 Visual Asset Proxy，动态标志固定 false，Extended/Archetype 清空；
6. 网络 Property 再经 `sanitizeVisualProperty()`；
7. 构建 static synthetic；
8. 正式 Appearance 已穿同一 source Asset 时跳过；
9. material 异常局部降级。

## 生命周期与竞态

ChatRoomSync 在调用下游前递增 generation 并清空旧房状态；完成后才调度 STATE。join 定向 jitter STATE；leave 清单成员；ChatRoomLeave/ServerDisconnect 清 timers、队列和全部房状态；CharacterLoadOnline 只失效 WeakMap。

异步 hash、snapshot hash、request retry 和 timer 在提交前检查 generation；本地 hash 还检查 build token。
