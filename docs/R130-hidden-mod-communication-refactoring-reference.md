# Bondage Club R130 Hidden Mod 通信机制与 COE Remote 重构参考

> 文档性质：独立技术参考，不依赖开发对话、阶段日志或既有实现上下文。  
> 适用任务：后续对 Custom Outfit Editor Echo Remote Edition（COE Remote）进行正式通信层、协议层、远端状态层与生命周期重构。  
> 目标客户端：Bondage Club R130。  
> 编写日期：2026-07-22。  
> 证据状态：客户端核心结论来自生产 R130 静态源码；服务端结论来自公开服务端仓库当前 master，未取得明确标注为生产 R130 部署版本的不可变 commit。  
> 本文自身不构成多人实机证据，也不授权绕过后续安全闸门。后续实现已于 2026-07-22 完成双账号私人房核心互见，现行验收状态以 `implementation-status.md` 与 `regression-record.md` 为准。

---

## 1. 执行摘要

Bondage Club R130 提供了一个适合 Mod 间同房间瞬时通信的现成通道：

```js
ServerSend("ChatRoomChat", {
  Content: "<协议命名空间和受限载荷>",
  Type: "Hidden",
  Target: targetMemberNumber, // 可选；省略或 null 表示房间广播
});
```

该通道具备 COE Remote 后续重构所需的核心性质：

1. 消息经过 BC 自带的 `ServerSend` 队列和 socket.io 连接，不需要直接操作 socket；
2. 服务端根据发送连接所对应的账号生成最终 `Sender`，不信任客户端自填 Sender；
3. 广播只进入发送者当前聊天室；定向发送只查找该房间中的目标 MemberNumber；
4. R130 客户端把 Hidden 消息放在 pre-handler 阶段处理，并在聊天显示、通知和 post-processing 之前终止；
5. 未安装 COE Remote 的 R130 客户端也会吞掉未知 Hidden 消息，不应显示协议正文；
6. 该消息链与 `Character.Appearance`、`ServerAppearanceBundle`、账号外观保存无关；
7. R130 自带的远端 Mod 列表查询已经采用 Hidden + Target + RequestId + timeout，证明此模式不是依靠未定义行为的孤立技巧；
8. BCX 也长期使用同类 Hidden query/reply 模式。

因此，后续正式代码重构应以 **Hidden ChatRoomChat Transport** 为唯一网络基础，不恢复旧版 `CustomOutfit` 容器，不借 Appearance Bundle 传播 COE 数据，也不使用普通可见聊天消息。

同时必须认识到：Hidden 只解决“如何隐形地传输瞬时消息”，并不自动解决不可信输入、重放、消息洪泛、快照大小、分片、缓存、换房竞态、远端资源兼容或绘制安全问题。这些仍必须由 COE Remote 自己实现硬限制。

---

## 2. 证据来源与可信度边界

### 2.1 本地 R130 客户端源码

主要路径：

```text
D:/agentData/佩拉的书桌/BC-Plugin/参考源码/
  Bondage-College-master/BondageClub/Scripts/Server.js
  Bondage-College-master-BondageClub-Scripts/BondageClub/Scripts/Messages.d.ts
  Bondage-College-master-BondageClub-Scripts/BondageClub/Scripts/Typedef.d.ts
  Bondage-College-master/BondageClub/Scripts/DictionaryBuilder.js
  Bondage-College-master/BondageClub/Scripts/PortalLink.js
```

这些文件用于确认：

- `ServerSend()` 的客户端队列；
- 客户端发送速率窗口；
- `ServerChatRoomMessage` 字段类型；
- Sender/Target 的类型注释；
- Hidden 在 handler 流程中的设计语义；
- R130 内置 Hidden 消息使用实例；
- Mod SDK 远端列表查询所用的 Dictionary 条目类型。

### 2.2 生产 R130 客户端静态源码

直接读取：

```text
https://www.bondageprojects.elementfx.com/R130/BondageClub/Screens/Online/ChatRoom/ChatRoom.js
https://www.bondageprojects.elementfx.com/R130/BondageClub/Screens/Online/ChatRoom/Commands.js
https://www.bondageprojects.elementfx.com/R130/BondageClub/Scripts/lib/bcmodsdk.min.js
```

这些文件用于确认本地稀疏源码中缺少的关键实现：

- `ChatRoomMessage(data)` 的真实入口验证；
- `ChatRoomRegisterMessageHandler(handler)`；
- pre/post handler 的排序规则；
- 内建 Hidden handler 的优先级与截断行为；
- Hidden 消息之后的显式 return；
- R130 `/mods remote` 的 Hidden query/reply；
- bcModSdk 1.2.0 的真实 Hook 排序。

客户端结论置信度：高。

### 2.3 公开服务端源码

研究源：

```text
https://github.com/Ben987/Bondage-Club-Server/blob/master/app.js
```

用于确认：

- `ChatRoomChat(data, socket)`；
- `ChatRoomMessage(CR, Sender, Content, Type, Target, Dictionary)`；
- Sender 的服务端生成方式；
- 广播与定向路由；
- Content 上限；
- socket.io 总包上限；
- 默认连接级消息频率限制；
- ChatRoomChat 路径没有数据库或 Appearance 写入。

服务端结论置信度：中高。原因是公开 master 与当前生产服务端高度相关，但尚未锁定一个明确声明为“R130 部署版本”的 commit；部署环境还可以覆盖部分环境变量限额。

### 2.4 社区 Mod 对照

BCX：

```text
https://raw.githubusercontent.com/Jomshir98/bondage-club-extended/master/src/modules/messaging.ts
```

用于确认成熟社区 Mod 的实际通信模式：

- `Content: "BCXMsg"`；
- `Type: "Hidden"`；
- 可选 `Target`；
- Dictionary 中携带 `{ type, message }`；
- UUID query id；
- request/answer 目标绑定；
- 10 秒 timeout；
- 变化通知防抖；
- 使用 ModSDK Hook 截获自己的 Hidden 消息。

LSCG、WCE 和 Echo 动作扩展的完整源码不在当前工作区，本文不对其私有通信协议作未经证实的描述。

---

## 3. 客户端发送链

### 3.1 实际入口

R130 客户端签名：

```js
function ServerSend(Message, ...args)
```

`ServerSend` 不立即无条件调用 socket，而是把消息放入：

```js
ServerSendRateLimitQueue
```

随后由：

```js
ServerSendQueueProcess()
```

在限流窗口允许时执行：

```js
ServerSocket.emit(item.Message, ...item.args)
```

COE Remote 必须调用 `ServerSend("ChatRoomChat", message)`，不得直接调用 `ServerSocket.emit()`。直接操作 socket 会绕过 BC 队列，增加与游戏本身及其他 Mod 争抢服务端频率预算的风险。

### 3.2 R130 客户端队列上限

本地 R130：

```js
ServerSendRateLimit = 14;
ServerSendRateLimitInterval = 1200;
```

含义是所有使用 `ServerSend` 的消息共享 1200 ms 窗口，最多发送 14 条，超出的进入队列。该上限不是 COE 的可用额度。

正式重构必须另建远低于 BC 上限的 COE 自身预算，例如：

- 状态变化防抖；
- 每种消息类型独立冷却；
- 每个目标独立请求上限；
- 分片发送调度；
- 单次换装最多一个完整快照响应流程；
- 有上限的重试次数；
- 不在帧循环、姿势刷新或普通 CharacterRefresh 中发包。

具体数值应在协议阶段定义并通过私人房压力测试校准，不能把 14/1200 ms 直接照抄为 COE 协议额度。

### 3.3 Hidden 不自动获得 MsgId

`ServerSendQueueProcess()` 只为以下类型自动向 Dictionary 添加 `MsgId`：

```text
Chat
Emote
Whisper
```

Hidden 不会自动获得 MsgId。COE Remote 必须自行定义 message id、request id、snapshot id、revision 和 hash，不能假设 BC 会为 Hidden 去重。

---

## 4. 服务端验证与转发

### 4.1 ChatRoomChat

公开服务端的核心逻辑等价于：

```js
function ChatRoomChat(data, socket) {
  if (
    data != null
    && typeof data === "object"
    && data.Content != null
    && data.Type != null
    && typeof data.Content === "string"
    && typeof data.Type === "string"
    && ChatRoomMessageType.includes(data.Type)
    && data.Content.length <= ServerChatMessageMaxLength
  ) {
    const account = AccountGet(socket.id);
    if (account != null) {
      ChatRoomMessage(
        account.ChatRoom,
        account.MemberNumber,
        data.Content.trim(),
        data.Type,
        data.Target,
        data.Dictionary,
      );
    }
  }
}
```

由此得到几个不可忽略的协议事实。

#### Sender 不来自正文

最终 Sender 使用：

```js
AccountGet(socket.id).MemberNumber
```

即使发送方在 data 中自填 Sender，最终转发身份也由服务端账号连接决定。接收端仍应检查：

```js
typeof data.Sender === "number"
sender.MemberNumber === data.Sender
```

并确认发送者仍在当前房间。

#### Content 会被 trim

服务端执行：

```js
data.Content.trim()
```

正式协议不能依赖 Content 的首尾空格，也不能用尾部空格作为长度填充、签名输入或分片内容。Canonical 序列化必须在发送前避免首尾空白歧义。

#### Content 明确限制为 2000 字符

公开服务端：

```js
ServerChatMessageMaxLength = 2000;
```

这是 JavaScript 字符串长度，不应未经验证地等同为 UTF-8 字节数。COE 协议应同时限制：

- 原始 Content 字符数；
- UTF-8 字节数；
- JSON 解析后的对象预算；
- 解压后的预算（若未来使用压缩）；
- 分片总预算。

单条协议消息应预留服务器和协议头空间，建议设计上限低于 2000，例如 1800–1900 字符。最终值由协议规范确定。

### 4.2 广播

当 Target 为 null/undefined：

```js
IO.to("chatroom-" + room.ID).emit("ChatRoomMessage", {
  Sender,
  Content,
  Type,
  Dictionary,
});
```

消息只进入当前房间 socket.io room。广播是否在所有生产节点都回送发送者本人，需要实机确认；代码和标准 socket.io room 语义表明预期会回送。

正式协议不得依赖“发送者一定不会收到自己的广播”。应显式忽略：

```js
data.Sender === Player.MemberNumber
```

### 4.3 定向

当 Target 是数字时，服务端在当前 `CR.Account` 中寻找相同 MemberNumber，只向该账号 socket emit。目标不在房间时不会转发，也没有自动错误响应。

服务端转发包当前不包含请求中的 Target：

```js
{ Sender, Content, Type, Dictionary }
```

因此接收端不能通过 `data.Target` 判断该消息原来是广播还是定向。若协议语义确实需要知道模式，必须在受验证的协议载荷中显式携带，但不能把该字段当作身份或授权依据。

### 4.4 Dictionary 的验证边界

服务端 ChatRoomChat 仅对 Content 做明确的 2000 字符限制，并把 Dictionary 原样转发。socket.io 配置的总包上限为：

```js
maxHttpBufferSize = 180000
```

这意味着 Dictionary 的宽松承载能力不能被当作 COE 安全预算。大型 Dictionary 会绕开 Content 的窄上限，并增加服务端、接收端和其他 Mod 的解析风险。

正式建议：

- Content 包含协议命名空间和受限 compact payload；
- Dictionary 为空或仅保存极少量固定 schema 元数据；
- 不发送任意嵌套对象、Character、Asset、Appearance Item 或完整快照对象；
- 在进入 JSON.parse、解压、AssetGet 或缓存前先检查原始消息长度。

### 4.5 服务端连接级频率限制

公开服务端默认：

```js
CLIENT_MESSAGE_RATE_LIMIT = 20; // per second
```

超过窗口时服务端发送：

```text
ForceDisconnect: ErrorRateLimited
```

并断开连接。该限制统计客户端连接上的所有消息类型，不只统计 COE。部署环境可以用环境变量覆盖默认值。

因此：

- COE 不能靠“让服务器拒绝”来实现限流；
- 分片不能瞬间连续发完；
- 不得每个分片都要求 ACK；
- 请求、响应和状态广播必须有共享总预算；
- 必须给游戏本身和其他 Mod 留出足够空间。

---

## 5. R130 客户端接收链

### 5.1 ChatRoomMessage 入口验证

生产 R130 实际签名：

```js
function ChatRoomMessage(data)
```

入口首先检查：

```js
typeof data === "object"
typeof data.Content === "string"
typeof data.Sender === "number"
```

然后检查：

```js
ChatRoomData 存在
ChatRoomCharacter 中存在 MemberNumber == data.Sender 的角色
```

不在房间的 Sender 会被直接丢弃。这个机制提供了第一层房间身份校验，但不能替代 COE 自己的 room generation：快速换房、异步队列和 Character 重建仍可能产生状态竞态。

### 5.2 Handler 的 pre/post 模型

R130 提供公开扩展点：

```js
function ChatRoomRegisterMessageHandler(handler)
```

handler 格式：

```js
{
  Description?: string,
  Priority: number,
  Callback(data, sender, msg, metadata?)
}
```

消息处理分为：

- `Priority < 0`：pre-handler；
- `Priority >= 0`：post-handler。

排序规则：

```js
handlers.sort((a, b) => a.Priority - b.Priority)
```

数值越小越先执行。这与 bcModSdk Hook 的方向相反。

### 5.3 Hidden 的内建截断

R130 内建 Hidden handler：

```text
Priority: -1
Description: Process hidden messages
```

其识别 `data.Type === "Hidden"` 后调用内建 Hidden 处理器并返回 true。`ChatRoomMessage()` 在 pre-handler 后还有第二道边界：

```js
if (data.Type === "Hidden") return;
```

因此 Hidden 不会进入：

- metadata/post-handler；
- 感官处理后的聊天输出；
- 优先级 500 的 `ChatRoomMessageDisplay()`；
- Chat/Whisper 本地聊天日志处理；
- 普通聊天通知。

未知 Hidden Content 即使没有对应 Mod，也会被内建流程吞掉。这是未安装插件客户端保持无感的核心依据。

### 5.4 COE 接收优先级

推荐注册：

```js
ChatRoomRegisterMessageHandler({
  Description: "COE Remote protocol",
  Priority: -50,
  Callback: receiveCOERemoteMessage,
});
```

理由：

- `-50 < 0`，属于 pre-handler；
- `-50 < -1`，早于内建 Hidden handler；
- 晚于 ghosted player cutoff `-200`，不会绕过玩家 GhostList 的基础截断；
- 识别自己的消息后返回 true，未知消息返回 false，让 BC 或其他 Mod 继续处理。

不应注册为 `-1`：与内建 handler 同优先级时，稳定顺序依赖数组插入顺序，容易在加载顺序变化时先被 BC 截断。

### 5.5 异常传播风险

`ChatRoomMessageRunHandlers()` 调用 handler Callback 时没有为每个第三方 handler 提供独立 try/catch。若 COE handler 抛出异常，可能中断当前 ChatRoomMessage 流程。

因此 COE 的顶层接收 callback 必须满足：

```js
function receiveCOERemoteMessage(data, sender) {
  if (!isOurNamespace(data)) return false;
  try {
    receiveUntrustedMessage(data, sender);
  } catch (error) {
    recordBoundedDiagnostic(error);
  }
  return true;
}
```

禁止把解析、验证、分片或业务异常抛回 BC 主消息循环。

### 5.6 Handler 生命周期限制

R130 的公开 API 提供注册，但没有公开 unregister。重构时必须处理：

- userscript 双实例；
- 热重载；
- disable/unload；
-重复调用 bootstrap；
-旧 handler 残留。

推荐方式：

1. 全局重复实例检测必须先于注册；
2. handler 只注册一次；
3. handler 内检查 transport 的 active/generation 标记；
4.禁用功能时清状态并让 handler 快速返回 false，而不是重复注册；
5. 若未来必须支持真正卸载，评估是否改用单一 ModSDK `ChatRoomMessage` Hook；不得同时安装原生 handler 和 ModSDK Hook 两套接收链。

---

## 6. bcModSdk 1.2.0 与原生 Handler 的区别

生产 R130 的 bcModSdk 版本为 1.2.0。ModSDK 对同一函数的 hooks 执行：

```js
hooks.sort((a, b) => b.priority - a.priority)
```

即数值越大越先进入 Hook 链。

两种优先级方向必须严格区分：

| 系统 | 负/正语义 | 排序方向 |
|---|---|---|
| `ChatRoomRegisterMessageHandler` | 负数 pre，非负 post | 数值越小越先 |
| `modApi.hookFunction` | 无 pre/post 固定语义 | 数值越大越先 |

BCX 使用：

```js
hookFunction("ChatRoomMessage", 10, ...)
```

识别 `BCXMsg` 后不调用 next。该模式具备 ModSDK unload 支持，但修改面比 R130 原生 handler 更宽。

COE Remote 的优先顺序建议：

1. R130：优先原生 `ChatRoomRegisterMessageHandler`；
2. 未来版本若原生入口缺失或行为改变：显式版本适配后使用单一 ModSDK Hook；
3. 不要为了“保险”同时装两套；
4. 不要使用 `patchFunction` 文本替换 ChatRoomMessage；
5. 不要覆盖 `globalThis.ChatRoomMessage`。

---

## 7. R130 自带 Mod 发现协议的启示

R130 `/mods remote` 使用 Hidden query/reply：

```js
ServerSend("ChatRoomChat", {
  Content: "ModSdkModsQuery",
  Type: "Hidden",
  Dictionary: [{
    Tag: "ModSdkModsQueryPayload",
    RequestId: requestId,
  }],
  Target: target?.MemberNumber,
});
```

回复：

- 定向到 `data.Sender`；
- 带相同 RequestId；
- 有 ok/declined/error 状态；
- 等待方保存 pending MemberNumber 集合；
- 有 timeout；
- 只接受当前 pending 中的发送者；
- 解析失败局部降级。

对 COE Remote 可直接借鉴的模式：

```text
命名空间
+ request id
+ sender MemberNumber
+ pending target 绑定
+ timeout
+ 过期请求丢弃
+ 定向响应
+ 未响应不无限重试
```

不能直接照抄的部分：

- COE 快照显著大于 Mod 列表小消息；
- COE 需要严格分片和总预算；
- COE 需要 revision/hash 与房间 generation；
- COE 不能把远端载荷直接交给 Asset 或渲染器；
- COE 需要每发送者限流和缓存淘汰。

---

## 8. BCX 通信实现的启示

BCX 实际发送：

```js
ServerSend("ChatRoomChat", {
  Content: "BCXMsg",
  Type: "Hidden",
  Target,
  Dictionary: { type, message },
});
```

其 query 系统包含：

- UUID；
- pending map；
- target MemberNumber；
- timeout；
- query/queryAnswer；
-变化通知 100 ms debounce；
-对不支持或无权限请求返回失败。

适合借鉴：

- 统一消息入口；
- type → handler 映射；
- 请求与响应分离；
- pending request 生命周期；
- timeout 后清理；
- 变化合并；
- 远端 MemberNumber 作为关联条件。

不应照搬：

- 任意 Dictionary 对象作为大型载荷；
- 缺少 COE 所需的字符/字节/对象深度预算；
- 缺少分片内存总预算；
- 缺少房间 generation；
- 缺少快照 canonical/hash 规则；
- 缺少接收者 Asset/Property 安全分析。

社区实现只能证明通道可行，不能替代 COE 的威胁模型。

---

## 9. 推荐重构模块边界

正式重构不得把网络、协议、缓存和渲染逻辑全部放入 `07-renderer.js`。建议形成以下单向依赖：

```text
Local Composition Source
  ↓
Remote Snapshot Builder
  ↓
Protocol Encoder / Decoder
  ↓
Transport Adapter
  ↓
Inbound Validator
  ↓
Remote Store
  ↓
Remote Composition Resolver
  ↓
Renderer
```

### 9.1 Transport Adapter

只负责：

- 注册一个接收入口；
- `ServerSend("ChatRoomChat", ...)`；
- 广播/定向；
- Content 原始长度初筛；
- 从 BC 元数据提取真实 Sender；
- 顶层 try/catch；
- 基础发送调度与 transport 统计；
- 房间进入/离开时启停。

不得负责：

- 理解 materials/layers；
- 调用 AssetGet；
- 写衣柜；
- 写 Appearance；
- 生成 Synthetic Layers；
- 决定 Echo 资产安全性。

### 9.2 Protocol

只负责 plain-data 消息：

```text
HELLO / STATE
REQUEST
SNAPSHOT / CHUNK
CLEAR
必要时的有限 ERROR
```

应提供纯函数：

- namespace 识别；
- 版本解析；
- canonical serialization；
- hash；
- message encode/decode；
- schema 验证；
- 分片描述；
- revision 比较。

Protocol 不直接发送消息，也不接触 Character/Asset。

### 9.3 Inbound Validator

分层执行：

```text
原始字符/字节长度
→ namespace
→ JSON parse
→ plain-object/prototype 检查
→ 主版本
→ 消息类型
→ 每类字段预算
→ per-sender rate limit
→ room generation
→ revision/hash
→ chunk 预算
```

任何超限消息必须在进入 AssetGet、缓存和绘制前拒绝。

### 9.4 Remote Store

主键至少包含：

```text
room/session generation
+ MemberNumber
+ protocol major
+ revision
+ composition hash
```

不得只用 Character 对象作身份。Character 可以作为短期 WeakMap 绘制缓存，但角色重建后必须根据 MemberNumber 重新绑定。

### 9.5 Resolver

对每个远端 material：

```text
AssetGet
→ 本地能力分析
→ Property 清洗
→ 静态视觉代理
→ 单 material 错误隔离
```

发送方关于“安全”“静态”“Echo兼容”的声明不具备可信度。

### 9.6 Renderer

Renderer 只消费已经验证、解析、限额和本地解析过的远端 composition。必须保持：

- 无远端数据时返回原 baseLayers 引用；
- 不修改正式 Appearance；
- 临时 Synthetic Items 只存在于同步 draw 调用；
- try/finally 恢复 Character.Appearance 和 AppearanceLayers；
- 单 material 失败只跳过自身；
- 本地编辑预览与远端角色互不干扰。

---

## 10. Transport 接口建议

以下是模块契约示意，不是已经冻结的 Phase 2 协议：

```js
transport.start({
  onMessage(envelope) {
    // envelope 只含 plain data：
    // senderMemberNumber, content, receivedAt, roomGeneration
  }
});

transport.sendBroadcast(encodedMessage);
transport.sendTo(memberNumber, encodedMessage);
transport.stop();
transport.status();
```

`onMessage` 应输出：

```js
{
  senderMemberNumber: 123456,
  content: "COE_RVS/1|...",
  receivedAt: 1750000000000,
  roomGeneration: 7
}
```

不得输出：

- Character 对象；
- Asset 对象；
- 原始 BC mutable message 对象；
- DOM；
- socket；
- Dictionary 任意引用。

接收 callback 应在同步返回前完成最小复制和排队，不能让后续异步代码继续持有 BC 的可变消息对象。

---

## 11. 协议命名空间建议

命名空间必须：

- 短；
- 唯一；
- 带主版本；
- 能在 JSON.parse 前识别；
- 不与现有 BC/BCX Hidden Content 冲突。

示意：

```text
COE_RVS/1|
```

Content 示例：

```text
COE_RVS/1|{"t":"state","r":12,"h":"..."}
```

Transport 首先检查：

```js
content.startsWith("COE_RVS/1|")
```

未知命名空间返回 false，让 BC/其他 Mod 继续处理。已识别为自己的命名空间后，即使载荷损坏也应在内部拒绝并返回 true，避免未知损坏数据继续落入其它处理器。

主协议版本与插件版本必须分离：

```text
插件 1.7.x / 1.8.x 可以继续支持 COE_RVS/1
插件版本变化不等于协议主版本变化
```

---

## 12. 身份、Target 与授权模型

### 12.1 可信身份

可作为发送者身份依据：

```text
服务端提供的 data.Sender
+ R130 解析出的 sender.MemberNumber
+ 当前 ChatRoomCharacter 成员关系
```

必须一致：

```js
data.Sender === sender.MemberNumber
```

### 12.2 不可信身份

不得信任：

- JSON 正文中的 sender/memberNumber；
- Dictionary 自报 SourceCharacter；
- 快照内的 owner 字段；
- 自报 target；
- 自报 room id；
- 自报“我已安装 Echo/我有权限/素材安全”。

正文身份字段最多用于一致性检测，不能覆盖真实 Sender。

### 12.3 Target 不是授权

Target 只负责服务端路由，不代表目标已经同意接收。接收端仍必须检查本地设置：

```text
receivingEnabled
协议兼容
发送者速率
当前房间 generation
缓存预算
素材安全
```

发送端也必须检查：

```text
sharingEnabled
当前方案存在
目标已通过握手声明兼容（正式快照按需定向时）
```

---

## 13. 房间与重连生命周期

Hidden 消息是瞬时房间消息：

- 不离线补发；
- 不跨房保证；
- 目标必须在发送时位于相同房间；
-客户端不在 ChatRoomData 状态时直接丢弃；
- Sender 不在当前 ChatRoomCharacter 时直接丢弃。

正式重构需要自己的 generation：

```js
let roomGeneration = 0;

onRoomEnter() {
  roomGeneration += 1;
  clearActiveRemoteState();
}

onRoomLeaveOrDisconnect() {
  roomGeneration += 1;
  cancelPendingRequests();
  expireChunkAssemblies();
  clearActiveRemoteState();
}
```

每个异步任务捕获 generation：

```js
const generation = roomGeneration;
await something();
if (generation !== roomGeneration) return;
```

必须覆盖：

- 入房；
- 离房；
- 快速换房；
- socket 断开；
- 重连；
- CharacterLoadOnline 重建；
- 目标离房；
-插件关闭接收；
-发送方 CLEAR；
-快照分片超时。

跨房缓存如未来保留，只能作为按 hash 复用的非活动内容缓存，不能自动在新房激活旧玩家状态。

---

## 14. 限流与预算设计原则

研究确认的外部边界：

```text
客户端 ServerSend：14 / 1200 ms，共享
服务端默认连接消息：20 / s，共享，超限可能断线
Content：2000 字符
socket.io 总包：180000 bytes
```

COE 内部必须更严格。正式规范至少定义：

### 14.1 发送侧

- STATE 最小间隔；
-换装防抖；
-同 hash 不重复 STATE；
-每目标 REQUEST 响应冷却；
-每秒/每分钟 COE 总消息数；
-分片发送节奏；
-最大自动重试次数；
-共享关闭后的 CLEAR 只发有限次数。

### 14.2 接收侧

每发送者独立限制：

- STATE/HELLO；
- REQUEST；
- SNAPSHOT；
- CHUNK；
- CLEAR；
-非法消息诊断数量。

房间总限制：

- 活跃发送者数；
- 待组装快照数；
- chunk 总字节；
-缓存总字节；
-每分钟解析次数；
-错误日志长度。

### 14.3 解析侧

在 JSON.parse 前：

- Content 字符数；
- UTF-8 字节数；
-命名空间；
-消息类型前缀（若采用）。

JSON 后：

- 只允许 plain object/array；
-拒绝 `__proto__`、`prototype`、`constructor` 等污染键；
-限制深度、键数、数组长度和字符串长度；
-拒绝 NaN/Infinity；
-限制 materials/layers；
-限制 TypeRecord；
-限制偏移、透明度和颜色格式。

---

## 15. 错误隔离要求

接收链的错误不能传播到 BC 主循环。至少建立以下隔离层：

```text
Transport callback try/catch
Protocol decode try/catch
Per-message validation result（不抛异常到 transport）
Per-sender chunk assembly isolation
Per-material resolver isolation
Renderer try/finally
Bounded diagnostics
```

错误处理要求：

- 协议错误默认静默丢弃；
-只在本地记录有限计数和最后少量摘要；
-不把远端原始消息全文写入长期日志；
-不向对方逐条发送 ERROR；
-不因每个坏分片触发重请求；
-一个恶意发送者不能阻塞其他发送者；
-一个坏 material 不能清除整名角色的正式 Appearance。

---

## 16. 与 Appearance 的绝对隔离

Hidden 通道可行不意味着可以放松 Appearance 红线。正式重构必须持续证明：

```text
Player.Appearance
ServerAppearanceBundle(Player.Appearance)
远端 Character.Appearance
```

均不包含：

- `CustomOutfit`；
- `CustomComposition`（旧容器清理读取除外）；
- Remote Snapshot；
- protocol/version/hash/revision/chunk 私有字段；
- Synthetic Item；
- `__coeMaterialId`；
- Echo PersistentData；
- Canvas/WebGL/DOM/Function。

严禁用于远端显示：

```js
AssetAdd(...CustomOutfit...)
InventoryWear(...CustomOutfit...)
CharacterRefresh(Player, true)
ChatRoomCharacterUpdate(Player)
ChatRoomCharacterItemUpdate(...)
```

当前基线中的 `CustomComposition` 和 `ChatRoomCharacterUpdate(Player)` 只允许继续存在于精确旧容器清理路径；后续重构不得复用该路径传播 Remote 数据。

---

## 17. 不推荐与禁止方案

### 普通 Chat/Whisper/Emote/Action

会进入显示、通知或聊天日志；未安装插件用户可见。禁止承载协议。

### AccountBeep

具有跨房/通知/离线语义，不符合当前同房间视觉状态同步的最小需求。除非未来另立需求与威胁模型，否则不使用。

### 直接 socket.emit

绕过 BC 客户端发送队列。禁止。

### 覆盖 ChatRoomMessage

破坏多 Mod 兼容。禁止。

### ModSDK patchFunction 文本替换

脆弱且冲突风险高。禁止用于通信主路径。

### Appearance Bundle

污染正式角色状态并重现旧容器风险。禁止。

### 大型 Dictionary

绕开 Content 的窄限制，只受更宽松总包限制。禁止作为完整快照承载。

### 每帧广播

会造成消息风暴和断线风险。禁止。

### 无上限 ACK

每片双向确认可能放大消息量。除非协议研究证明必要，不实现。

### 远端动态执行

不得根据远端消息启用 DynamicBeforeDraw、DynamicAfterDraw、DynamicScriptDraw、WebGL、eval、Function 或任意函数名调用。

---

## 18. 独立探针及其用途

隔离探针：

```text
COE-Echo-Remote/probes/communication-probe.user.js
```

探针特性：

- 默认 disabled；
-不自动发送；
-无循环任务；
-只允许显式 API；
-广播/定向可区分；
-3 秒最小间隔；
-固定长度集合：16、64、256、512、1024、1400；
-仅发送 protocol、sequence、timestamp、mode 和重复文本；
-记录发送/接收、真实 Sender、延迟和聊天 UI 可见性观察；
-不读取真实衣柜或 Appearance。

探针不是正式 transport，不得复制其简单 envelope 直接充当生产协议。它只用于确认：

- Hidden 在生产房间是否不可见；
-广播与定向行为；
-真实 Sender；
-长度边界；
-一方无插件时的行为；
-换房与重连；
-与其它 Mod 共存。

---

## 19. 正式重构前的实机闸门

在实现真实协议前，必须在两个测试账号的私人房完成：

1. 两边安装探针，广播 16；
2. A 定向 B，确认 A/B/第三方接收范围；
3. 按 16、64、256、512、1024、1400 逐级测试；
4. 每条至少间隔 3 秒；
5. 检查双方聊天 DOM 无协议正文；
6. 一方卸载探针，再发 Hidden，确认无显示、无异常；
7. 快速换房，确认旧消息不进入新房状态；
8. 刷新/重连，确认无离线补发；
9. 同时启用 BCX、LSCG、WCE、Echo，确认无冲突；
10. 比较测试前后的 Appearance 与 Bundle；
11. 记录首错日志、消息数量、延迟和是否断线。

任一失败即停止：

- 未安装插件用户看见正文；
- Sender 无法验证；
-定向泄漏；
-解析异常中断 ChatRoom；
-出现 Appearance 变化；
-出现持续重连或 ErrorRateLimited；
-需要恢复 CustomOutfit 容器才能继续。

---

## 20. 后续重构验收清单

### Transport

- [ ] 只使用 `ServerSend("ChatRoomChat", ...)`；
- [ ] 只使用 `Type: "Hidden"`；
- [ ] namespace 在 JSON.parse 前识别；
- [ ] 真实 Sender 来自 BC 元数据；
- [ ] 顶层 callback 永不向 BC 抛异常；
- [ ] 原生 handler 和 ModSDK fallback 不双装；
- [ ] 发送总量远低于 BC/服务器上限；
- [ ] 禁用/换房/重连后状态正确失效。

### Protocol

- [ ] 独立主版本；
- [ ] request id / snapshot id；
- [ ] revision/hash；
- [ ] canonical serialization；
- [ ] 原始和解析后双重预算；
- [ ] 每发送者限流；
- [ ] 分片总量、数量和超时上限；
- [ ] 未知版本安全忽略；
- [ ] 无无限重试或 ACK 风暴。

### Store

- [ ] room generation + MemberNumber 作为主身份；
- [ ] Character 重建可重绑；
- [ ] 离房立即停止绘制；
- [ ] CLEAR 只清对应发送者；
- [ ] 缓存有 TTL、单人预算和房间总预算；
- [ ] 旧房间异步结果不能重新激活。

### Renderer

- [ ] 无远端数据时返回原 baseLayers 引用；
- [ ] 不写正式 Appearance；
- [ ] try/finally 恢复临时状态；
- [ ] 单 material 错误隔离；
- [ ] 缺失 Asset 局部跳过；
- [ ] 远端 Property 不能恢复动态能力；
- [ ] Bundle 无协议或 Synthetic 数据。

### 兼容与用户控制

- [ ] sharingEnabled/receivingEnabled 独立；
- [ ] 默认行为与隐私说明明确；
- [ ] 一方无插件完全无感；
- [ ] Echo/LSCG/WCE/BCX 共存测试；
- [ ] 不修改第三方 Mod；
- [ ] 不承诺未安装对应素材的客户端完全一致。

---

## 21. 已证实事实、设计建议与待验证项

### 已证实事实

- R130 支持 Hidden ChatRoomChat；
-服务端生成 Sender；
-服务端支持广播与房内定向；
-客户端 Hidden 在显示前截断；
-R130 有公开 ChatRoom message handler；
-R130 自带 Hidden Mod query/reply；
-bcModSdk 1.2.0 Hook 为数值降序；
-原生 ChatRoom handler 为数值升序；
-客户端发送队列为 14/1200 ms；
-公开服务端 Content 上限为 2000；
-公开服务端默认连接限制为 20/s；
-ChatRoomChat 路径不写 Appearance。

### 设计建议，尚未冻结

- 命名空间 `COE_RVS/1|`；
-原生 handler priority `-50`；
-Content 单条预算 1800–1900；
-大型数据使用有上限分片；
-Transport 输出 plain envelope；
-room generation + MemberNumber 主键；
-按需定向快照，广播只发小型 STATE；
-避免大型 Dictionary。

这些建议必须在协议规范和测试中正式冻结，不能因为出现在本文就跳过 Phase 2 设计评审。

### 待实机验证

- 生产服务器确切 Content 边界及 Unicode 行为；
-广播是否稳定回送发送者；
-定向在所有生产节点的行为；
-一方无插件时 UI 和控制台表现；
-不同房间/重连竞态；
-与 BCX、LSCG、WCE、Echo 同开；
-长度增长对延迟的影响；
-生产部署实际频率阈值；
-私人房内长时间运行是否有消息积压。

---

## 22. 最终结论

R130 的 Hidden ChatRoomChat 通道足以作为 COE Remote 正式重构的网络基础。它提供服务端 Sender、房间广播、房内定向以及对未安装插件客户端不可见的接收路径，同时不要求修改 Appearance。

后续重构的正确方向是：

```text
当前本地视觉方案
→ 最小远端快照
→ 版本化且有预算的协议
→ Hidden ChatRoomChat Transport
→ 接收者按真实 Sender 验证
→ 房间 generation 与缓存
→ 本地 Asset/Property 再验证
→ 远端角色 Synthetic Layers
→ 正式 Appearance 始终不变
```

Hidden 通道只是一条运输管道，不是安全边界的全部。真正决定实现是否合格的，是 COE 自身能否建立明确的版本、大小、频率、分片、缓存、生命周期、Property 清洗和绘制恢复不变量。

任何需要恢复 `CustomOutfit/CustomComposition` 容器、写入正式 Appearance、向普通聊天显示协议正文、绕过 Echo 授权或执行远端动态脚本的实现，都与本研究结论和重构目标相违背，应立即停止。
