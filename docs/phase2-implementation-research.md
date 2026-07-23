# COE-Echo Remote：阶段一之后的实现研究与技术路线（历史档案）

> **档案说明（2026-07-22 更新）：** 本文基于 v1.7.0 形成，记录实施前的分阶段路线。后续任务已确定采用“线路二”静态能力投影，而不是本文曾建议的严格 Vanilla/Echo allowlist 路线；v1.8.0 已完成协议、Store、Transport、Controller、Renderer 和 UI 源码。当前状态见 `implementation-status.md`，现行设计以 `protocol-spec.md`、`threat-model.md` 和 `architecture.md` 为准。

日期：2026-07-22  
研究目标：在 Phase 1 已确认 R130 Hidden ChatRoomChat 可用的基础上，确定当时的 Phase 2–8 实现路线。  
研究范围：任务文档、Phase 1 通信参考、COE-Echo-Remote v1.7.0 源码、当时测试、R130 `CharacterLoadOnline` / `ChatRoomSync` / `ChatRoomLeave` / `ChatRoomSyncMemberJoin` / `ChatRoomSyncMemberLeave` / `ServerDisconnect`。

---

## 1. 结论

任务目标可以实现，且不需要恢复 `CustomOutfit/CustomComposition` 容器，也不需要修改正式 Appearance。

推荐数据流冻结为：

```text
activeComposition
→ 独立、严格、确定性的 Remote Snapshot Builder
→ canonical JSON + SHA-256 + 单调 revision
→ STATE 广播 / REQUEST 定向 / CHUNK 定向
→ Hidden ChatRoomChat Transport
→ 真实 Sender + roomGeneration + peerSessionId 验证
→ 严格快照验证（不得先调用现有宽松 normalizeComposition）
→ 当前房间 Remote Store
→ 接收方按本机 Asset 重新做远端专用能力门禁
→ 静态 Visual Asset Proxy + Synthetic Layers
→ CommonDrawAppearanceBuild 同步 try/finally 临时注入
→ 正式 Character.Appearance 始终不变
```

实现时应采用以下关键决策：

1. **Phase 2 只实现纯函数和文档，不连接网络。**
2. **协议 v1 不使用压缩。** 消除压缩炸弹和跨实现差异；超预算方案拒绝共享，而不是放宽 Dictionary。
3. **使用 SHA-256，而不是现有 FNV-1a 诊断指纹。** hash 虽不用于认证，但它承担缓存一致性和整体验证，SHA-256 更适合；输出 base64url 43 字符。
4. **协议必须有随机 `peerSessionId`。** revision 在页面刷新后会重置，仅靠 MemberNumber + revision 无法区分旧实例和新实例。
5. **不实现逐片 ACK，也不实现自动 ERROR 回复。** Hidden/socket.io 已是有序可靠连接；逐片 ACK 只会放大消息量。
6. **STATE 同时承担 HELLO。** 不再增加独立 HELLO 消息，减少状态机和广播数量。
7. **快照统一使用 CHUNK，单片快照也是 `count=1`。** 避免 SNAPSHOT 和 CHUNK 两套重复解析路径。
8. **远端验证器与本地衣柜 normalize 必须分离。** 现有 `normalizeComposition()` 会访问 `AssetGet`、补建 material、生成随机 uid，并且材料数组没有独立上限；它不适合作为不可信网络输入的第一道验证器。
9. **本地渲染策略与远端渲染策略必须分离。** 当前本地路径允许把诊断为 unsupported 的已加载素材投影成静态代理；远端路径必须 fail closed，Phase 4 只开放通过远端专用门禁的 Vanilla 静态素材。
10. **Phase 6 Echo 不能沿用“中国名称/已检测 Echo”启发式直接放行。** 必须使用接收方本机的明确 Echo 运行时、固定候选清单、非空签名和逐资产实机证据。

---

## 2. 当前源码可复用部分与必须改造部分

### 2.1 可直接复用的安全构件

| 文件 | 函数/状态 | 用途 |
|---|---|---|
| `src/06-adapters.js` | `createVisualAssetProxy()` | 创建未注册视觉代理，清空 Extended/Archetype，并锁死 Dynamic Before/After/ScriptDraw |
| `src/06-adapters.js` | `sanitizeVisualProperty()` | 在本机 Asset schema 下二次清洗 Property；远端 MVP 应先只允许空 Property |
| `src/06-adapters.js` | `buildStaticSynthetic()` | 生成临时 Synthetic Item 和 drawable layer 组 |
| `src/07-renderer.js` | `stableInsertSyntheticLayers()` | 保持 base layer 原顺序，只稳定插入 Synthetic Layers |
| `src/07-renderer.js` | `makeSyntheticLayers()` | 生成带绘制 marker 的临时 layer |
| `src/07-renderer.js` | `CommonDrawAppearanceBuild` Hook | 同步临时替换 Appearance/Layers，并由 `finally` 恢复 |
| `src/07-renderer.js` | `ServerAppearanceBundle` Hook | 最后一道 Synthetic/旧容器过滤保护 |
| `src/05-capabilities.js` | `analyzeSourceAsset()` | 提供动态/WebGL/语义诊断信号；远端需在其上增加更严格策略层 |
| `src/02-data.js` | compact 字段思路 | 可作为快照字段选择参考，但不能直接把存储格式当协议格式 |

### 2.2 必须改造的接入点

#### `getComposition(character)`

当前只允许本地 Player：

```js
if (!isLocalPlayer(character)) return null;
```

不要简单改成“远端从 Map 取 composition”后继续走当前 `buildSyntheticItems()`。推荐拆成：

```text
getLocalComposition(character)
getRemoteResolvedComposition(character)
buildLocalSyntheticItems(character)
buildRemoteSyntheticItems(character, resolvedSnapshot)
```

两条路径最终只共享安全的低层视觉代理与稳定插入函数，避免本地开放策略意外泄漏到远端。

#### `CharacterAppearanceSortLayers` Hook

推荐控制流：

```js
const baseLayers = next(args) || [];

if (isLocalPlayer(character)) {
  // 保持现有本地/编辑器逻辑
}

const remote = remoteStore.getActive(character.MemberNumber, roomGeneration);
if (!remote) return baseLayers;                // 必须返回原引用

const groups = getOrBuildRemoteGroups(character, remote);
if (!groups.length) return baseLayers;
syntheticByCharacter.set(character, groups);
return stableInsertSyntheticLayers(baseLayers, makeSyntheticLayers(groups));
```

远端没有活动快照时，不得 `slice()`、排序或创建新数组。

#### `CommonDrawAppearanceBuild` Hook

现有逻辑天然可以服务本地和远端，只要 `syntheticByCharacter` 中是当前 Character 对应的 groups。必须继续满足：

```text
保存原 Appearance 引用
保存原 AppearanceLayers 引用
同步调用 next(args)
finally 恢复两个原引用
```

远端 Store 清理、Character 重建和快照更新时要同时执行：

```js
syntheticByCharacter.delete(character);
CharacterRefresh(character, false, false); // 仅本地重绘，不进行服务器同步
```

禁止调用 `ChatRoomCharacterUpdate`、`ChatRoomCharacterItemUpdate` 或 `ServerPlayerAppearanceSync`。

### 2.3 不能直接复用的函数

#### `normalizeComposition()` 不能作为网络边界验证器

原因：

- 接受字段较宽松，许多非法数值会被静默 clamp；
- material 没有先执行独立数量上限；
- material id 缺失时调用 `uid()`，破坏 canonical 确定性；
- 会调用 `AssetGet`，违反“结构预算通过后才接触 Asset”的顺序；
- 会根据本机 Asset 补建 material，混合协议验证与本地解析；
- 会处理 recycle/default/UI 兼容字段，而远端协议不应接受这些字段。

正确顺序：

```text
原始 Content 长度检查
→ 消息 envelope 严格验证
→ 分片预算/重组
→ base64url 解码后的字节预算
→ JSON.parse
→ 污染键/深度/键数/数组数/字符串数检查
→ validateRemoteSnapshotStrict（纯函数）
→ SHA-256 整体校验
→ Store 接受
→ Resolver 才调用 AssetGet
```

---

## 3. 推荐源文件结构

现有 `11-bootstrap.js` 应后移，避免 bootstrap 早于远端模块拼接：

```text
src/
  00-userscript-header.js
  01-runtime.js
  02-data.js
  03-storage.js
  04-assets.js
  05-capabilities.js
  06-adapters.js
  07-renderer.js
  08-ui-shell.js
  09-wardrobe.js
  10-editor.js
  11-remote-protocol.js     纯协议、canonical、hash、消息/快照验证、分片
  12-remote-store.js        generation、peer、request、assembly、snapshot/cache
  13-remote-transport.js    Hidden handler、ServerSend、发送调度；不理解服装
  14-remote-controller.js   本地快照、STATE/REQUEST 状态机、生命周期、设置
  15-bootstrap.js           原 11-bootstrap，最后初始化所有模块
```

测试拆分：

```text
tests/protocol.test.js
tests/transport.test.js
tests/remote-store.test.js
tests/remote-renderer.test.js
tests/core.test.js
```

职责约束：

- protocol 不访问 BC、DOM、Asset、Character、ServerSend；
- transport 不访问 wardrobe、activeComposition、Appearance；
- store 只保存 plain data，不保存 Character/Asset/DOM；
- controller 不绘制；
- renderer 不发消息、不管理请求；
- bootstrap 只组装和暴露 API。

---

## 4. 协议 v1 具体设计

### 4.1 命名空间与承载

```text
Content prefix: COE_RVS/1|
Type: Hidden
Dictionary: 不使用
单条 Content 硬上限: 1800 字符
```

接收器先做：

```js
if (data.Type !== "Hidden") return false;
if (typeof data.Content !== "string" || !data.Content.startsWith(PREFIX)) return false;
```

识别自己的 prefix 后，无论载荷是否合法都 `return true`；所有错误内部计数，绝不向 BC 主循环抛出。

### 4.2 公共 envelope 字段

采用短键降低开销，但规范文档必须给出语义：

| 键 | 含义 |
|---|---|
| `t` | 消息类型：`s` STATE、`q` REQUEST、`c` CHUNK、`x` CLEAR |
| `s` | 发送插件实例的随机 peerSessionId（base64url，96 bit） |
| `r` | 当前视觉 revision，正安全整数 |
| `h` | canonical snapshot 的 SHA-256 base64url |
| `q` | requestId（base64url，96 bit） |

正文不携带 sender MemberNumber。唯一身份来自：

```text
data.Sender
+ sender.MemberNumber
+ 当前 ChatRoomCharacter 成员关系
```

### 4.3 STATE（同时承担 HELLO）

示例：

```json
{"t":"s","s":"peerSession","r":12,"h":"sha256-base64url","z":14820,"a":1}
```

字段：

- `a`: 是否共享有效快照（0/1）；
- `z`: canonical snapshot UTF-8 字节数；
- `h`: `a=1` 时必须存在；
- 不包含插件版本，除非诊断确有需要。协议主版本已在 prefix，插件版本不参与兼容判断。

入房行为：

1. 本机 sharing 或 receiving 任一开启时，防抖后广播一次 STATE；
2. 收到未知 peerSession 的 STATE 后，已有客户端只向新成员定向回复一次 STATE，并加 100–500 ms jitter；
3. 不对每个 STATE 继续回复，避免乒乓；
4. 忽略自己 MemberNumber 的回送广播。

### 4.4 REQUEST

```json
{"t":"q","s":"requesterSession","q":"requestId","ps":"publisherSession","r":12,"h":"expectedHash"}
```

接收方仅在以下全部满足时发送：

- receivingEnabled；
- STATE 的 `a=1`；
- 当前 generation 下仍存在该 Sender；
- 本地没有同 hash 已验证快照；
- 同一 sender/hash 没有 pending request；
- 请求冷却与重试预算允许。

发送方只响应：

- sharingEnabled；
- `ps/r/h` 与自己当前状态完全一致；
- requestId 合法且此前未响应；
- 对该 Sender 的响应限流允许。

自动重试最多 1 次，且只对完整请求超时重试；坏分片不逐片重请求。

### 4.5 CHUNK

无独立 SNAPSHOT 类型，`n=1` 即单片快照：

```json
{
  "t":"c",
  "s":"publisherSession",
  "q":"requestId",
  "r":12,
  "h":"expectedHash",
  "i":0,
  "n":12,
  "z":14820,
  "d":"base64url-chunk"
}
```

设计：

- canonical JSON 先按 UTF-8 编码，再 base64url；
- 不压缩；
- 每片 `d` 最多 1200 字符，确保完整 Content 明显低于 1800；
- 每个 Sender 同时最多一个 assembly；
- `n` 初始硬上限 32；
- `z` 初始硬上限 32768 bytes；
- assembly 超时 20 秒；
- 重复片若内容完全相同则忽略且不重复计费；同 index 不同内容立即废弃 assembly；
- 完成后先验证 base64url 总编码长度和 `z`，再解码、parse、严格验证、重算 SHA-256；
- `q` 必须匹配本机发出的 pending request，拒绝 unsolicited snapshot。

任务文档给出的 64 KiB 是“初始建议上界”，不是必须达到的容量。考虑 2000 字符 Content 和 BC/服务器共享消息频率预算，v1 将网络快照限制为 32 KiB 更安全。超过预算时 UI 显示“当前外观过大，未共享”，不能改用大型 Dictionary 绕过。

### 4.6 CLEAR

```json
{"t":"x","s":"publisherSession","r":13}
```

适用：

- 卸下全部方案；
- 关闭共享；
- 当前可共享子集为空；
- 本地快照构建失败或超预算且此前曾共享有效状态。

接收方只清该 Sender 当前 peerSession 的活动状态。离房不依赖 CLEAR，因为离房时可能无法发送；`ChatRoomSyncMemberLeave` 和 generation 清理才是权威生命周期。

### 4.7 不实现 ACK / ERROR

v1 不发送 ACK/ERROR。错误默认静默丢弃并增加有上限诊断计数。这样可避免恶意输入诱导回复放大和分片 ACK 风暴。

---

## 5. Remote Visual Snapshot 格式

推荐固定键顺序的 compact object，不直接复用衣柜 scheme：

```json
{
  "v":1,
  "m":[
    {"g":"Cloth","a":"Dress","c":["#FFFFFF"]}
  ],
  "l":[
    {"m":0,"n":"Base","i":0,"p":10,"x":0,"y":0,"o":1}
  ]
}
```

### 5.1 字段

material：

- `g`: sourceGroup；
- `a`: sourceAsset；
- `c`: 颜色数组；
- v1 Vanilla MVP 不发送 Property；后续经协议小版本能力扩展时可加入 `p`，但接收方仍按本机 Asset schema 重验。

layer：

- `m`: material 数组索引，不发送任意 materialId；
- `n`: sourceLayer 名称，可为 `null`；
- `i`: sourceLayerIndex；
- `p`: priority；
- `x/y`: offset；
- `o`: opacity。

省略：

```text
name / scheme id / equippedIds / recycle / updatedAt / default* / hidden 条目
label / provider / version / compatibility / reasons / analysis cache
sourceColor 重复字段 / Character / Asset / Item / Canvas / Function
```

隐藏 material/layer 在构建快照时直接排除。

### 5.2 严格预算

```text
materials <= 32
layers <= 120
完整 canonical JSON <= 32768 UTF-8 bytes
单 material（含引用层）<= 8192 bytes
字符串 <= 64 字符（颜色 <= 16）
对象深度 <= 3
对象总键数 <= 1024
TypeRecord（未来）<= 16 primitive keys
```

数值：

```text
priority: integer [-99, 99]
offsetX/Y: finite integer [-1200, 1200]
opacity: finite number [0, 1]，canonical 时固定到最多 4 位小数并去掉 -0
layer index: integer [0, 255]
```

颜色 v1 只接受：

```text
Default
#RRGGBB
#RRGGBBAA
```

非法字段不做“尽量修复”，网络快照整体拒绝；Asset 不存在或单 material 本地不兼容则是解析后的局部降级。

### 5.3 canonical 与 hash

快照 builder 按以下顺序创建新 plain object：

1. material 保持当前组合中的视觉顺序；
2. material id 重映射为连续数组索引；
3. layer 保持活动 composition 的图层顺序；
4. 每个对象按规范固定插入键；
5. 默认值仍建议保留为固定字段，避免“省略规则变化”造成 hash 不一致；
6. `JSON.stringify()` 只作用于 builder 创建的无额外字段对象；
7. SHA-256 覆盖 canonical JSON 的 UTF-8 字节，不覆盖 revision、requestId、peerSessionId。

WebCrypto 是异步的，因此本地快照更新需要 generation/token 防陈旧提交：

```js
const token = ++localSnapshotBuildToken;
const generation = roomGeneration;
const snapshot = buildRemoteSnapshot(activeComposition);
const canonical = canonicalize(snapshot);
const hash = await sha256(canonical);
if (token !== localSnapshotBuildToken || generation !== roomGeneration) return;
if (hash !== localState.hash) localState.revision += 1;
commitAndDebounceState();
```

Node 测试使用 `crypto.webcrypto.subtle` 或 `node:crypto.createHash` 适配器，协议函数本身接收 hash provider，避免把环境判断散落在验证代码中。

---

## 6. 远端素材解析与安全门禁

### 6.1 两阶段处理

```text
阶段 A：纯协议验证
只得到 validatedSnapshot plain data，不访问 AssetGet。

阶段 B：本地 resolver
逐 material 执行 AssetGet → remote policy → layer identity → visual proxy。
```

每个 material 独立 try/catch；失败只跳过自身。

### 6.2 Phase 4 Vanilla 门禁

必须满足：

- 本机 `AssetGet` 存在；
- Wear 且 Appearance group；
- source layer index 存在，名称与快照一致；
- 目标 layer `HasImage && !LockLayer`；
- 无 DynamicBeforeDraw/AfterDraw/ScriptDraw；
- 无 WebGL/Canvas 信号；
- 无功能性非图片层依赖；
- 无 SetPose/OverrideHeight/HeightModifier/FixedPosition 等主动 Appearance 语义；
- v1 MVP Property 必须为空；
- 正式 Character.Appearance 中不存在同一 source Asset。

`analyzeSourceAsset()` 的结果不能直接作为唯一门禁，因为当前实现把 provider 识别和 Echo 授权做了面向本地编辑器的启发式处理。应新增：

```js
analyzeRemoteAsset(asset, policy)
```

该函数显式区分 `vanilla-v1` 与 `echo-static-v1`，不得修改本地素材选择器行为。

“是否确为 R130 原版 Asset”若要形成强证明，不能只靠 `Family === Female3DCG`；Mod 也可能注册进原组。推荐在 Phase 4 测试夹具/发布构建中加入由 R130 官方 Asset 定义生成的 tuple/fingerprint allowlist，至少先固定 MVP 测试资产。未进入 allowlist 的已加载静态 Mod Asset 在 Phase 4 仍拒绝。

### 6.3 Phase 6 Echo 门禁

当前 `ECHO_MANIFEST` 的候选签名仍为 `null`，因此 Phase 6 尚不具备直接全量放行条件。必须先：

1. 固定 Echo 实测版本；
2. 选择至少三个静态候选；
3. 记录本机实际 runtime fingerprint；
4. 将非空签名写入 remote 专用 manifest；
5. 验证 Echo runtime/CharacterTag/AssetManager 授权边界；
6. Typed 候选额外固定允许的 Type/TypeRecord schema；
7. 逐资产私人房验证。

禁止仅因名称是中文、`echoRuntimeInfo().detected === true` 或发送方自报 provider=echo 就放行。

---

## 7. Store、身份和房间生命周期

### 7.1 Store 主键

```text
roomGeneration
+ Sender MemberNumber
+ peerSessionId
+ revision
+ hash
```

Character 对象只用于当前帧 WeakMap 绘制缓存，绝不作为远端状态主键。

建议结构：

```js
remoteRuntime = {
  generation: 0,
  peers: Map<MemberNumber, PeerState>,
  contentByHash: Map<Hash, ValidatedSnapshot>,
  resolvedByKey: Map<member/session/hash/assetEnvironmentRevision, ResolvedGroups>,
  pendingRequests: Map<MemberNumber, PendingRequest>,
  assemblies: Map<MemberNumber, ChunkAssembly>,
  sendQueue: [],
};
```

v1 的 content/resolved cache 仅在当前房间 generation 内有效，离房全部清除。这样最容易证明不会跨房激活旧状态。跨房 hash 缓存若以后加入，必须与 active peer state 分离且仍重新验证本机 Asset 环境。

### 7.2 R130 生命周期 Hook

已确认的 R130 函数：

| Hook | 处理 |
|---|---|
| `ChatRoomSync` | 进入新房：先 `newGeneration()` 清状态；原函数完成后防抖广播 STATE |
| `ChatRoomSyncMemberJoin` | 原函数完成后，若本机协议启用，向新 MemberNumber 定向回复一次 STATE（带 jitter） |
| `ChatRoomSyncMemberLeave` | 清除该 SourceMemberNumber 的 peer/request/assembly/cache 激活和绘制 WeakMap |
| `ChatRoomLeave` | 调用前 `newGeneration()` 并清空发送队列、timer、assembly、peer；不要依赖 CLEAR |
| `ServerDisconnect` | 调用前执行同样的 generation 失效和清理 |
| `CharacterLoadOnline` | Store 无需迁移；必要时删除旧 Character 的 WeakMap 缓存，新对象按 MemberNumber 自动重绑 |

`ChatRoomSync` 在 R130 是异步路径，Hook 若要在完成后发送 STATE，必须保留原 Promise 语义：

```js
const generation = beginRoomGeneration();
const result = next(args);
return Promise.resolve(result).then(value => {
  if (generation === roomGeneration && isInChatRoom()) scheduleState();
  return value;
});
```

如果不希望改变异常语义，不加 catch；BC 原异常继续向原调用者传播。COE 自己的 schedule 必须内部捕获。

### 7.3 Character 重建

本地 R130 `CharacterLoadOnline` 会优先复用 Character；重复登录时也可能删除旧对象并新建。正确做法不是把 Snapshot 搬到 Character 上，而是每次绘制使用：

```js
const memberNumber = character?.MemberNumber;
remoteStore.getActive(memberNumber, roomGeneration);
```

快照接受或 CLEAR 后，查找当前 `ChatRoomCharacter` 中相同 MemberNumber 的对象，仅调用本地 `CharacterRefresh(C, false, false)` 触发重绘。

---

## 8. 限流与发送调度

外部边界：

```text
BC ServerSend: 14 / 1200 ms（所有游戏消息共享）
公开服务端默认: 20 / s（所有连接消息共享，超限可能断线）
Content: 2000 字符
```

建议 COE v1 自身更保守：

### 发送侧

```text
STATE 变化防抖: 500 ms
同 hash STATE: 不重复广播
入房 STATE: 每 generation 最多 1 次广播
对新 peer 的定向 STATE: 每 peer/session 最多 1 次
REQUEST: 每 peer 5 秒最多 1 次；同 hash pending 时不重复
自动重试: 最多 1 次，超时 12 秒
响应 REQUEST: 每 peer 10 秒最多 1 个 snapshot
CHUNK 调度: 最快 400 ms/片（2.5 条/秒）
COE 全局突发: 2 条；持续: 2.5 条/秒
CLEAR: 状态转换时最多 1 次
```

### 接收侧

使用每 Sender 独立 token bucket，再加房间总预算。消息类型成本可设：

```text
STATE 1
REQUEST 2
CLEAR 1
CHUNK 2
非法消息 1（但日志只保留摘要）
```

初始限制：

```text
每 Sender 容量 12，恢复 0.5 token/s
房间容量 40，恢复 2 token/s
最多 10 peers
每 Sender 1 assembly
房间最多 4 assemblies
房间 chunk/validated cache <= 256 KiB
每 Sender 最多 2 个 revision metadata；活动内容只保留 1 个
诊断 ring buffer <= 100 条，不保存原始正文
```

这些数值必须通过 Phase 3 私人房和 Phase 5 压力测试校准；不能声称为生产服务器硬阈值。

---

## 9. 设置与用户控制

Remote 设置不要塞进现有 wardrobe schema v4，否则基线版本回退时会遇到 newer-schema 或镜像冲突。建议新增一个**仅保存布尔偏好的本地键**：

```text
BC.CustomOutfitEditor.RemotePrefs.v1.<accountId>
```

它不是第二份衣柜，不包含方案、快照或远端缓存。只保存：

```json
{"sharingEnabled":false,"receivingEnabled":false}
```

默认两项均 false。用户明确启用后才产生协议消息。UI 说明：

- 只共享当前启用外观的最小静态描述；
- 不共享衣柜、未启用方案或 PNG；
- 服务器可转发 Hidden 正文，通道不是端到端加密；
- 只有兼容客户端解释；
- 素材缺失或不安全时接收方会局部跳过；
- 关闭共享会广播 CLEAR；离房也会由接收方生命周期清理。

---

## 10. 具体实施顺序

### Phase 2：协议纯函数

交付：

```text
src/11-remote-protocol.js
docs/protocol-spec.md
docs/threat-model.md
tests/protocol.test.js
```

先完成：strict validator、canonical、SHA-256、base64url、envelope、chunk/reassembly、预算、污染键扫描、token bucket 纯函数。不得调用 ServerSend，不得修改 renderer。

退出：所有恶意输入、乱序/重复/超时、hash/revision 测试通过。

### Phase 3：Transport + 虚拟状态

交付：

```text
src/12-remote-store.js
src/13-remote-transport.js
src/14-remote-controller.js
tests/transport.test.js
tests/remote-store.test.js
```

只发送固定虚拟 hash/小快照，不读取 activeComposition，不改 renderer。完成私人房握手、定向请求、分片、离房/重连和一方无插件测试。

### Phase 4：Vanilla MVP

接入 Snapshot Builder 和远端 renderer。最初只允许固定的 R130 Vanilla 静态候选、空 Property、1 material/1 layer；通过后逐步放宽至预算上限。

必须新增 mock：Player、Remote A/B、Character 重建、CLEAR、离房、缺失 Asset、同 Asset 正式冲突、CommonDraw 抛错、Bundle 过滤。

### Phase 5：缓存与多人生命周期

加入同 hash 去重、当前房间缓存、TTL/淘汰、10 人压力测试和性能计数。不要提前实现跨房激活。

### Phase 6：Echo 静态候选

先补齐 remote Echo manifest 非空签名和实机证据，再开放三个候选；不做动态/WebGL/身体替换。

### Phase 7：UI 与诊断

扩展 `status()`，只返回 plain summary：

```text
remoteProtocol / sharingEnabled / receivingEnabled
roomGeneration / peers / activeRemoteCompositions
sent / received / rejected / rateLimited / chunksExpired
bytesSent / bytesReceived / materialsSkipped
```

不得输出原始消息、快照正文、Character 或 Asset。

### Phase 8：审计与发布

静态扫描、Bundle 证明、兼容矩阵、基线 SHA-256 复核、构建产物 SHA-256、README/限制/回归文档。

---

## 11. 关键测试补充

除任务文档已有清单外，必须新增：

1. peerSessionId 改变时允许 revision 从 1 重新开始；旧 session 的异步 hash/assembly 不得提交；
2. 同 MemberNumber 新 Character 对象自动获得当前 active snapshot；
3. 收到自己广播回送时不创建 peer、不请求自己；
4. STATE 响应只发生一次，不形成 STATE ping-pong；
5. unsolicited CHUNK 即使格式正确也拒绝；
6. requestId 对但 publisher session/revision/hash 任一不符时拒绝；
7. base64url 解码前、解码后、JSON 后三层大小预算分别生效；
8. duplicate chunk 相同内容不重复计费，不同内容废弃 assembly；
9. `normalizeComposition()`、`AssetGet()` 在结构预算失败时均未被调用；
10. local unsupported 静态投影行为保持不变，但相同 Asset 在 remote policy 下被拒绝；
11. remote material id/marker 在不同 Sender 间不会冲突；诊断 key 应包含 Sender/session/hash，而不是仅 material.id；
12. CLEAR/leave 后 `syntheticByCharacter` 不保留可绘制 groups；
13. CharacterRefresh 只使用 `(C,false,false)`，没有任何 ChatRoom Appearance 同步；
14. build/hash 多次并发时只有最新 token 能提交 revision；
15. 开关默认关闭时完全不注册定时发送、不产生网络消息。

---

## 12. 研究时的阻塞与非阻塞项

### 非阻塞

- Hidden transport、服务器 Sender、房内广播/定向、未安装插件隐藏、Appearance 隔离均已有 Phase 1 证据；
- 当前 renderer 已具备稳定插入、视觉代理、Bundle 过滤和 try/finally 基础；
- Vanilla 静态最小闭环可按上述路线实现。

### 需要在对应阶段完成的闸门

1. Phase 3 前：确认 Phase 1 私人房探针记录已归档；
2. Phase 4：固定至少一组 R130 Vanilla MVP allowlist/fingerprint；
3. Phase 6：Echo manifest 不能继续使用 null signature；
4. 公共多人房前：两客户端私人房、小方案、恶意消息、换房/重连、一方无插件、兼容 Mod 共存全部通过。

若 Echo 无法建立本机授权和固定静态候选边界，只停止 Phase 6，不应阻塞 Vanilla Remote 的 Phase 4/5 成果。

---

## 13. 验证记录

研究形成时，v1.7.0 副本为 26/26 测试且尚未连接真实远端同步。该记录只描述历史快照。

后续 v1.8.0 实施结果：

```text
npm test      → 46/46 通过
npm run build → 成功生成 dist/CustomOutfitEditorEchoRemote.user.js
npm run check → Node 语法检查通过
基线复核      → COE-Echo v1.6.2 24/24 SHA-256 一致
```

v1.8.0 已连接真实远端静态同步源码，并于 2026-07-22 完成 BC R130 双账号私人房真实方案双向互见；这确认了核心共享链路，但不替代 Appearance/Bundle/status、生命周期、缺失素材与三客户端等后续验收。

---

## 14. 当时的最终推荐（历史）

下一步严格进入 **Phase 2：协议、威胁模型与纯函数实现**，不要直接把探针改造成生产 transport，也不要先改 `getComposition()` 显示远端服装。

优先完成顺序：

```text
strict snapshot validator
→ canonical + SHA-256
→ envelope + chunk/reassembly
→ token bucket + generation-safe store 纯函数
→ protocol/threat-model 文档
→ Node 恶意输入测试
```

Phase 2 全部通过后，再安装正式 Hidden handler 进入 Phase 3。这样可以把最大的风险——不可信输入、分片、revision/session、预算和生命周期——在完全离线的 Node 环境中先封死，然后才接触真实聊天室。
