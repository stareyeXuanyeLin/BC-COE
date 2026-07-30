# COE 远端自定义服装加载性能优化进度

> **历史档案：** 本文记录 `COE_RVS/4` 阶段的性能排查与修补过程。当前代码已硬切为 `COE_RVP/1` 房间级内容发布协议，现行规范见 `protocol-spec.md`，本文中的“当前架构”和后续建议均不再代表现状。

> 文档用途：为下一窗口继续迭代 COE Remote 性能问题提供完整上下文、当前代码状态、实测证据和未完成事项。
>
> 当前仓库：`D:/agentData/佩拉的书桌/BC-Plugin/BC-COE-dev`
>
> 当前分支：`dev`
>
> 文档整理时的最新远程提交：`1b0c74fb201e28243d992518ccf07dbb5f9417c6`

---

## 1. 任务目标

当前任务是解决 COE 自定义服装在多人房间中加载缓慢的问题。

已知体感现象：

- 相同设备、相同浏览器、不同标签页、不同账号。
- 双人房间中只有一位 COE 用户时，对方自定义服装大约需要 2～3 秒出现。
- 六人房间中只有一位 COE 用户时，普通用户服装已经加载完成后，COE 用户的自定义服装仍可能继续等待 15～20 秒。
- 这些时间最初是体感估计，后续通过采集器得到了一次比较完整的真实时间线。

目标不是改变 COE 的服装表现、变换算法或 Appearance 语义，而是缩短：

```text
房间同步
→ Remote STATE 握手
→ REQUEST
→ CHUNK 快照传输
→ 快照验收
→ CharacterRefresh
→ 自定义服装纹理加载
```

中的网络和调度等待，同时避免多人房间消息拥堵、旧快照覆盖新快照以及失败重试放大流量。

---

## 2. 当前 Remote 架构

主要文件：

```text
src/11-remote-protocol.js
src/12-remote-store.js
src/13-remote-transport.js
src/14-remote-controller.js
src/15-bootstrap.js
src/07-renderer.js
```

### 2.1 协议消息

当前协议是：

```text
COE_RVS/4|
```

使用 BC Hidden ChatRoomChat：

```js
ServerSend("ChatRoomChat", {
  Type: "Hidden",
  Content: "COE_RVS/4|" + JSON.stringify(envelope),
  Target: memberNumber,
});
```

消息类型：

```text
STATE   广播或定向发送当前 session、revision、hash、大小和 sharing 状态
REQUEST 接收端向发布端请求某个 revision/hash 的完整快照
CHUNK   定向传输快照的一个 base64url 分片
CLEAR   发布端清除当前投影
```

快照结构使用紧凑 JSON：

```js
{
  v: 1,
  m: [
    { g: "Cloth", a: "Dress", c: ["#FFFFFF"] }
  ],
  l: [
    { m: 0, n: "Base", i: 0, p: 10, x: 0, y: 0, o: 1 }
  ]
}
```

`m` 是素材表，`l` 是图层表。隐藏素材和图层不会进入远端快照。快照发送前会 canonicalize，接收后进行严格 schema 校验、canonical 比较和 SHA-256 校验。

### 2.2 当前协议硬限制

定义于 `src/11-remote-protocol.js`：

```js
content: 1800,
chunkData: 1200,
chunks: 32,
snapshotBytes: 32768,
materialBytes: 8192,
materials: 32,
layers: 120,
```

Store 还有以下限制：

```text
每个 Sender 同时一个 assembly
房间最多 4 个 assembly
所有 active snapshot 合计最多 256 KiB
assembly 20 秒过期
peer 最多 10 个
```

---

## 3. 已完成的实测证据

### 3.1 接收端采集文件

曾使用 Tampermonkey 采集器得到接收端文件：

```text
coe-remote-timeline-2026-07-29T22-12-38-317Z.json
```

页面：

```text
https://www.bondageprojects.elementfx.com/R130/BondageClub/
```

采集摘要：

```json
{
  "eventCount": 700,
  "remotePeers": 1,
  "activeRemoteCompositions": 1,
  "messagesSent": 3,
  "messagesReceived": 4,
  "chunksExpired": 0,
  "rateLimited": 0,
  "bytesSent": 309,
  "bytesReceived": 2025
}
```

### 3.2 关键时间线

房间 Remote 状态重置：

```text
约 91.534 秒
```

收到有效 STATE：

```text
约 94.025 秒
```

发出 REQUEST：

```text
约 94.031 秒
```

收到 CHUNK 0/2：

```text
约 94.528 秒
```

收到 CHUNK 1/2：

```text
约 95.564 秒
```

快照进入 `activeRemoteCompositions`：

```text
约 95.616 秒
```

因此：

```text
Remote 初始化 → STATE：约 2492ms
REQUEST → 快照完成：约 1585ms
最后一个 CHUNK → 快照验收：约 52ms
```

两片 CHUNK 的真实间隔：

```text
约 1036ms
```

### 3.3 纹理加载证据

快照完成后，检测到的相关资源大约 12 个：

```text
平均 duration：约 76.8ms
最慢 duration：约 111.1ms
```

本次纹理大多命中缓存，`transferSize` 为 0。自定义服装资源在快照验收后约百毫秒级完成。

所以本次证据支持：

```text
主要瓶颈在 Remote 握手、发送队列和 CHUNK 调度
```

而不是：

```text
SHA-256
JSON 校验
CommonDraw 合成
纹理首次加载
```

---

## 4. 初始发现的主要瓶颈

### 4.1 原有逐片 400ms 调度

旧版 `src/14-remote-controller.js`：

```js
chunks.forEach((data, index) =>
  enqueueRemoteEnvelope(
    { ... },
    memberNumber,
    { earliest: now + index * 400 }
  )
);
```

旧版 `src/13-remote-transport.js` 还有全局 token bucket：

```js
remoteSendTokens = Math.min(
  2,
  remoteSendTokens + elapsed * 2.5 / 1000
);
```

这使 CHUNK 天然串行。后台标签页中，Chrome 会对 `setTimeout` 进行批量调度，实测 400ms 目标间隔被放大成约 1036ms。

### 4.2 所有 Remote 消息共用一个发送队列

旧版将以下消息全部放入同一个 `remoteSendQueue`：

```text
STATE
REQUEST
CHUNK
CLEAR
```

多人房间中，新成员进入、状态回执、多个 REQUEST 和多个 CHUNK 会互相等待。

### 4.3 初始同步可能为每个成员发送 STATE

如果 `ChatRoomSyncMemberJoin` 在初始房间同步期间对每个已有成员都发送定向 STATE，会在六人房间中制造不必要的消息峰值，并挤占 BC 原生发送队列。

### 4.4 过早重试会造成消息放大

如果在 CHUNK 仍然有进度时过早触发 REQUEST 重试：

```text
旧 requestId 的 assembly 被删除
→ 后续旧 CHUNK 被拒绝
→ 新 REQUEST 再发送整套快照
→ 消息数翻倍
→ 队列更加拥堵
```

这类重试可能让优化后的多人房间比原版更慢。

---

## 5. 已经实施的第一阶段优化

当前最新提交：

```text
1b0c74fb201e28243d992518ccf07dbb5f9417c6
```

提交说明：

```text
修复多人房间远端同步回归
```

此前的性能优化提交：

```text
5bd242884b3727affca5b07a6bf0a1cd3b9fa549
```

提交说明：

```text
优化远端服装快照传输性能
```

### 5.1 控制消息和快照队列分离

`src/13-remote-transport.js` 现在有：

```js
let remoteControlQueue = [];
let remoteSnapshotQueue = [];
```

控制消息：

```text
STATE
REQUEST
CLEAR
```

快照队列：

```text
CHUNK batch
```

单个快照批次最多同步发送 8 片：

```js
const REMOTE_BURST_SIZE = 8;
```

超过 8 片时，剩余批次目标间隔：

```js
const REMOTE_NEXT_BURST_DELAY = 250;
```

不同目标的批次会轮转，避免一个大快照一直独占队列。

### 5.2 全局发送窗口

最新修复增加了：

```js
const REMOTE_SEND_WINDOW_MS = 1200;
const REMOTE_SEND_WINDOW_CAPACITY = 12;
```

目的：避免多个接收端同时请求时，COE 在 1200ms 内提交过多 Hidden 消息，给 BC 原生发送队列保留空间。

当前策略：

```text
每 1200ms 最多提交 12 条 COE 消息
```

这 12 条包括：

```text
STATE
REQUEST
CLEAR
CHUNK
```

这是当前方案中的重要取舍：

- 单人、两片快照应能在一个同步批次内完成。
- 多个接收端同时请求时，不允许无限制地把 8 片批次相乘。
- 仍可能受 BC 原生发送队列、服务器限制和其它插件消息影响。

### 5.3 合法 CHUNK 使用请求级预算

接收端现在先解析 envelope，再区分控制消息与 CHUNK。

控制消息继续使用：

```js
acceptRemoteInboundRate(senderNumber)
```

CHUNK 则必须匹配本机 pending request：

```text
requestId
session
revision
hash
sender
```

每个 pending request 使用独立的消息计数，允许：

```text
最多 REMOTE_LIMITS.chunks + 4
即 36 条消息
```

assembly 和字节预算仍然生效。

### 5.4 本地快照缓存

`src/14-remote-controller.js` 现在缓存：

```js
localRemoteCanonical
localRemoteEncoded
localRemoteChunks
localRemoteHash
localRemoteSnapshot
```

收到 REQUEST 时直接使用：

```js
localRemoteChunks
```

不会重复执行：

```text
encodeRemoteText
splitRemoteData
```

### 5.5 本地快照 dirty/in-flight 状态

最新回归修复增加：

```js
let localRemoteBuildInFlight = null;
let localRemoteDirty = true;
```

设计意图：

```text
activeComposition 变化
→ localRemoteDirty = true
→ 500ms 防抖构建

新成员加入时发现缓存 clean
→ 直接发送缓存 STATE

新成员加入时发现缓存 dirty
→ 取消等待中的 500ms 定时器
→ 立即构建最新快照
→ 等构建完成后再发送 STATE
```

多个成员同时触发时，共用同一个 build promise，避免重复构建。

### 5.6 初始房间同步抑制定向 STATE

增加：

```js
let remoteRoomSyncing = false;
```

行为：

```text
ChatRoomSync 开始：remoteRoomSyncing = true
ChatRoomSyncMemberJoin：初始 hydration 期间不逐个发送定向 STATE
ChatRoomSync 完成：只发送一次广播 STATE
```

普通新成员在房间已经完成同步后加入，才会收到定向 STATE。

### 5.7 请求超时改成“按进度”判断

曾经尝试过 4 秒/8 秒短超时，但在多人房间中可能造成重试风暴，已回退到更保守的逻辑。

当前代码：

```js
scheduleRemoteRequestTimeout(..., delay = 12000)
```

`pending` 会记录：

```js
lastProgressAt
```

每收到一个新 CHUNK，`src/12-remote-store.js` 更新：

```js
pending.lastProgressAt = now;
```

如果超时回调触发时仍然有近期分片进度，则重新等待，而不是立即废弃 assembly。

当前实际语义：

```text
连续约 12 秒没有 CHUNK 进度，才进入一次重试
```

自动重试最多一次。

---

## 6. 当前代码中需要特别注意的风险

### 6.1 `protocol-spec.md` 可能与最终代码有轻微不同步

文档中的状态机部分曾记录过：

```text
首次 4 秒超时，重试 8 秒
```

但在最新回归修复中，代码已经改为按 `lastProgressAt` 的 12 秒无进度逻辑。

下一窗口继续工作时，应先统一：

```text
src/14-remote-controller.js
protocol-spec.md
测试描述
```

不要依据旧文档判断当前超时语义。

### 6.2 当前“全局 12 条/1200ms”仍可能过于保守

这个窗口是根据 BC 原生发送队列的安全尺度设计的，但还没有通过六人房间的新采集结果验证最优值。

可能的结果：

- 如果六人房间有多个 COE 接收端，12 条窗口仍然让大型快照排队。
- 如果 BC 原生队列自身已经有 14/1200ms 限制，COE 的 12/1200ms 是安全但保守的。
- 如果 `ServerSend` 本身已经异步排队，COE 端同步提交 12 条并不代表服务器立即送达。
- 如果房间中还有 Echo、LSCG、SugarChain 等插件发送 Hidden 消息，COE 无法从自身计数得知 BC 原生队列的真实占用。

下一步需要用发送端和接收端采集器同时测量，而不能只看接收端。

### 6.3 当前仍未实现压缩

当前快照流程仍然是：

```text
canonical JSON
→ UTF-8/base64url
→ 每片 1200 字符
```

还没有实现：

```text
canonical JSON
→ 压缩
→ base64url
→ CHUNK
```

所以复杂服装仍可能生成大量 CHUNK。压缩应作为第二阶段，在 RVS/4 调度问题稳定后再做。

### 6.4 当前仍未增大动态 CHUNK 容量

当前：

```js
chunkData: 1200
```

还没有实现根据 envelope 头部动态计算最大 data 长度。后续可以在保持 `content <= 1800` 的前提下适度提高有效负载，但必须先确认 BC 服务端和客户端的实际 Content 限制。

### 6.5 发送端采集非常重要

接收端只能看到：

```text
消息何时到达
```

发送端才能区分：

```text
ServerSend 何时被 COE 调用
```

如果发送端日志显示 CHUNK 在本地就相隔 1000ms，问题是 COE/BC 客户端调度。

如果发送端本地连续调用，接收端却间隔很大，问题更可能位于：

```text
BC 原生客户端发送队列
服务器消息队列
目标路由
```

---

## 7. 当前测试状态

最新回归测试结果：

```text
165 项测试全部通过
```

执行命令：

```powershell
npm test
npm run build
npm run check
```

构建结果：

```text
dist/CustomOutfitEditor.user.js 构建成功
```

语法检查：

```text
通过
```

新增测试覆盖：

```text
8 片快照同步发送
超过 8 片时延迟批次
控制消息抢占延迟批次
多个接收端不能突破 12 条/1200ms 窗口
合法 CHUNK 独立预算
CHUNK 进度更新时间
REQUEST 使用缓存分片
缓存 clean 时成员加入立即发送 STATE
缓存 dirty 时成员加入触发最新快照重建
初始房间 hydration 抑制定向 STATE
```

测试主要位于：

```text
tests/transport.test.js
```

这些测试验证逻辑关系，但不能模拟真实 BC 服务端、多标签页后台节流和第三方插件消息竞争。

---

## 8. Git 当前状态

已经推送的远程分支：

```text
origin/dev
```

最新提交：

```text
1b0c74fb201e28243d992518ccf07dbb5f9417c6
```

提交说明：

```text
修复多人房间远端同步回归
```

前一个性能优化提交：

```text
5bd242884b3727affca5b07a6bf0a1cd3b9fa549
```

提交说明：

```text
优化远端服装快照传输性能
```

最新推送后状态：

```text
dev 与 origin/dev 一致
工作区干净
```

注意：当前工作目录是开发仓库，远程加载器如果指向 GitHub 正式 `main` 分支，不会自动加载 `dev` 分支的新代码。测试 dev 版本时必须确认加载器或测试页面实际获取的是 `dev` 构建产物。

---

## 9. Tampermonkey 采集器

文件：

```text
probes/coe-remote-timeline.user.js
```

当前采集器版本曾更新到：

```text
1.0.2
```

脚本头部必须匹配 BC 实际页面域名：

```text
bondageprojects.com
bondageprojects.elementfx.com
bondage-europe.com
bondage-asia.com
localhost
```

并使用：

```js
// @grant        unsafeWindow
```

原因：篡改猴沙箱的 `globalThis` 不等于 BC 页面环境，必须通过：

```js
const pageWindow = unsafeWindow;
```

采集器主要暴露：

```js
COEProbe.start()
COEProbe.stop()
COEProbe.clear()
COEProbe.status()
COEProbe.data()
COEProbe.download()
```

测试完成后：

```js
COEProbe.download()
```

下载 JSON。

### 采集器当前注意事项

采集器会包装：

```text
ServerSend
ChatRoomRegisterMessageHandler
PerformanceObserver
```

它应该在页面早期加载，否则可能错过 COE 注册 Message Handler 的时刻。测试前建议：

```text
两个标签页都安装采集器
完整刷新两个页面
确认控制台出现 [COE Probe] 已启动
再进入房间
```

最好同时提交：

```text
提供方 JSON
接收方 JSON
```

单独只有接收端日志，无法完全判断发送端是否在本地已经延迟。

---

## 10. 下一轮建议测试方案

### 10.1 双人房间基线

测试变量：

```text
提供方标签页是否前台
接收方标签页是否前台
```

至少测试：

```text
两边前台
提供方后台，接收方前台
提供方前台，接收方后台
两边均后台
```

记录：

```text
STATE 发出时间
STATE 到达时间
REQUEST 发出时间
REQUEST 到达时间
CHUNK 0～最后一片的发送端时间
CHUNK 0～最后一片的接收端时间
activeRemoteCompositions 变化时间
```

### 10.2 六人房间测试

建议准备：

```text
1 个提供方 COE 账号
1 个接收方 COE 账号
4 个普通账号
```

测试两轮：

#### 轮次 A：普通用户先在房间

```text
先让 4 个普通账号进入
提供方进入
接收方进入
```

#### 轮次 B：COE 用户先在房间

```text
提供方进入
接收方进入
再加入 4 个普通账号
```

对比：

```text
初始 ChatRoomSync
成员逐个加入
COE STATE 数量
REQUEST 数量
CHUNK 是否重复发送
是否发生 request-timeout
是否发生 messagesRejected
```

### 10.3 重点看哪些指标

接收端 `CustomOutfitEditor.status()`：

```js
remotePeers
activeRemoteCompositions
messagesSent
messagesReceived
messagesRejected
rateLimited
chunksExpired
bytesSent
bytesReceived
```

如果优化后仍然更慢，重点判断：

#### A. `remotePeers` 很晚才从 0 变成 1

说明 STATE 本身延迟，检查：

```text
房间初始广播
STATE 是否被 BC 原生队列延迟
第三方插件 Hidden 消息竞争
```

#### B. `remotePeers` 很快变成 1，但 `activeRemoteCompositions` 很晚变成 1

说明 REQUEST/CHUNK 阶段延迟，重点查看：

```text
发送端是否收到 REQUEST
发送端 CHUNK 是否连续调用
接收端是否出现 rejected
是否出现重复 requestId
```

#### C. `activeRemoteCompositions` 很快变成 1，但画面晚出现

才继续查：

```text
CharacterRefresh
纹理加载
CommonDraw
GL 纹理缓存
```

当前已有的双人日志中，这一类延迟只有百毫秒级。

---

## 11. 下一阶段优先级建议

### P0：先取得优化后六人房间双端日志

在没有新日志前，不要继续盲目调整参数。当前已经发生过“理论上优化、实际多人更慢”的回归，必须先拿到：

```text
发送端时间线
接收端时间线
```

### P1：确认 BC 原生发送队列真实行为

需要用采集器比较：

```text
COE 调用 ServerSend 的时间
Network/WebSocket 实际出现时间
接收端收到 Hidden 的时间
```

如果 BC 原生队列对同步突发 12 条也会延迟，应降低窗口或改用更细的调度；如果它能顺利接受，则当前延迟可能来自第三方消息竞争。

### P2：完善队列去重

当前控制队列虽有 generation 清理，但还没有完整的按状态键去重层。后续可以考虑：

```text
相同 target + session + revision + hash 的 STATE 只保留一条
相同 target + requestId 的 snapshot batch 不重复排队
旧 revision 的 batch 立即丢弃
```

这对多人房间和重复 STATE 尤其重要。

### P3：压缩快照

建议新增 RVS/5 或兼容扩展：

```text
canonical JSON
→ 压缩
→ base64url
→ CHUNK
```

哈希仍针对未压缩 canonical JSON。

必须保留：

```text
压缩输入大小限制
解压输出大小限制
最大 materials/layers
最大 chunk 数
```

目标是把复杂服装的 CHUNK 数从 8～32 降低到 1～4。

### P4：动态计算单片容量

当前 `chunkData=1200` 较保守。可以根据 envelope 固定开销动态计算：

```text
1800 - prefix - JSON envelope overhead - safety margin
```

但必须先通过真实 BC 服务端测试确认 1800 上限和非 ASCII 内容行为。

---

## 12. 不要重复采用的方向

以下方向已经被分析为风险较高或收益有限：

### 不要只把 400ms 改小

后台标签页仍可能将定时器对齐到约 1 秒。

### 不要使用 requestAnimationFrame 发送网络分片

后台页面通常暂停 `requestAnimationFrame`。

### 不要用静音音频规避后台节流

兼容性、侵入性和平台策略风险都不合适。

### 不要在每个 CHUNK 上增加 ACK

底层 WebSocket 已经可靠有序。逐片 ACK 会增加消息量，在多人房间可能进一步恶化。

### 不要在未确认进度时快速重试

必须使用 `lastProgressAt` 或等价的进度判断，避免废弃仍在传输的合法 assembly。

### 不要直接绕过 BC 的 ServerSend 发送原始 socket

这会破坏 BC 自身消息队列、协议边界和兼容性，不应作为性能修复手段。

---

## 13. 交接给下一窗口的最短摘要

当前工作已经完成 RVS/4 第一阶段调度重构，但性能任务尚未完成，原因是优化后的多人房间实测反而更慢。

已知可靠事实：

1. 原始双人测试中，两片 CHUNK 间隔约 1036ms，符合后台标签页 timer 对齐现象。
2. 快照验收和纹理加载只有百毫秒级，不是主要瓶颈。
3. 上一版优化曾引入三个重要回归：脏缓存被取消、初始同步逐成员发送 STATE、过早重试造成消息放大。
4. 最新提交 `1b0c74f` 已修复这些回归，并增加全局 12 条/1200ms 发送窗口和按进度超时。
5. 最新本地测试 165 项通过，构建和语法检查通过。
6. 还没有拿到最新修复版本的六人房间双端采集结果。

下一步不要先改更多代码，先完成：

```text
安装最新 dev 构建
两个 COE 标签页都加载 Tampermonkey 采集器 1.0.2
完整刷新
进行双人和六人房间测试
同时导出提供端与接收端 JSON
对比 ServerSend 提交时间和消息到达时间
```

根据新日志再决定是：

```text
调整全局发送窗口
进一步拆分控制/数据调度
增加状态去重
修改 BC 原生队列交互方式
还是进入 RVS/5 压缩协议设计
```
