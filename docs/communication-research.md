# COE-Echo Remote：BC R130 Mod 通信研究（Phase 1，历史档案）

> **档案说明（2026-07-22 更新）：** 本文记录 v1.7.0 实施前的通信研究与当时的阶段门禁，不是当前状态页。线路二已在 v1.8.0 接入真实远端静态同步、通过 Node 门禁，并于 2026-07-22 完成双账号私人房真实方案双向互见；当前状态见 `implementation-status.md`，现行协议见 `protocol-spec.md`。

日期：2026-07-22  
目标客户端：Bondage Club R130  
基线：COE-Echo v1.6.2  
研究时副本版本：COE-Echo Remote v1.7.0

## 1. 结论

R130 存在满足 COE 后续研究条件的聊天室 Mod 通道：

```text
ServerSend("ChatRoomChat", {
  Content: "<命名空间与受限载荷>",
  Type: "Hidden",
  Target?: memberNumber
})
```

接收端优先使用 R130 的公开扩展点 `ChatRoomRegisterMessageHandler()`，以负优先级在内建 Hidden 处理器之前识别自己的命名空间并返回 `true`。该通道的关键性质是：

- `Sender` 由服务器根据 socket 对应账号的 `MemberNumber` 填入，不采信客户端正文；
- `Target == null/undefined` 时广播到当前房间，数字目标时只发给该房间中对应 MemberNumber；
- `Hidden` 在客户端 pre-handler 阶段处理，之后立即返回，不进入 post-handler、聊天 DOM 或 `ChatRoomChatLog`；
- 未安装 COE 的 R130 客户端仍由内建 Hidden 处理器吞掉未知 Content，不显示协议正文；
- 该路径不读取、写入或同步 Character Appearance；
- Content 服务端上限为 2000 字符；客户端和服务端另有连接级速率限制。

**因此不存在“必须恢复 CustomOutfit 容器”的阻塞。** 本结论已被 v1.8.0 实现采用。本文当时设定的“实施前停止点”已由后续任务决策取代；双客户端私人房核心互见已于 2026-07-22 完成，但完整生命周期和公共多人房仍须按现行计划继续验收。

## 2. 推荐通道与承载规则

### 2.1 推荐

使用 `ChatRoomChat` + `Type: "Hidden"`：

```js
ServerSend("ChatRoomChat", {
  Content: "COE_RVS/1|" + compactPayload,
  Type: "Hidden",
  Target: targetMemberNumber, // 省略或 null 表示房间广播
});
```

接收建议：

```js
ChatRoomRegisterMessageHandler({
  Description: "COE Remote protocol",
  Priority: -50,
  Callback(data, sender) {
    if (data.Type !== "Hidden" || !data.Content.startsWith("COE_RVS/1|")) return false;
    try {
      // 验证 data.Sender === sender.MemberNumber、原始长度、速率、结构和预算
    } catch (error) {
      // 只记有限本地诊断，不向 ChatRoomMessage 抛出
    }
    return true;
  },
});
```

`-50` 的理由：低于 0，属于 pre-handler；又早于内建 Hidden 处理器的 `-1`。R130 的 handler 排序是数值升序，负数越小越早。

### 2.2 承载选择

后续正式协议建议把命名空间和 compact 消息放在 `Content`，单条总长度硬限制显著低于服务端 2000 字符（建议 1800–1900 字符），不要把任意大型对象塞入 `Dictionary`。

R130 与 BCX 都证明 `Dictionary` 可以承载 Mod 数据，R130 自带 `/mods remote` 也用结构化 Dictionary；但服务端 `ChatRoomChat()` 只对 `Content` 做明确的 2000 字符校验，Dictionary 仅受 socket.io 总包 180000 字节限制。COE 不应把这个较宽松的总包上限当成协议预算。

### 2.3 重要语义

- 服务端会对 `Content` 调用 `.trim()`；协议不得依赖首尾空格。
- 服务端转发包包含 `Sender/Content/Type/Dictionary`，当前实现不会把请求中的 `Target` 回传给接收端。接收端不得依赖 `data.Target` 判断定向与否。
- 定向只保证路由到房内目标，不是加密；服务器仍可见正文。
- 广播由 `IO.to("chatroom-" + room.ID).emit(...)` 完成，预期包含发送者本身；实机探针需确认生产部署行为。
- Hidden 不是离线消息；换房/断线后不补发，不应承担持久存储。

## 3. R130 客户端证据

### 3.1 ServerSend

本地源码：

```text
BC-Plugin/参考源码/Bondage-College-master/BondageClub/Scripts/Server.js
```

实际签名：

```js
function ServerSend(Message, ...args)
```

行为：先入 `ServerSendRateLimitQueue`，再调用 `ServerSendQueueProcess()`；发送入口最终为：

```js
ServerSocket.emit(item.Message, ...item.args)
```

本地 R130 数值：

```js
ServerSendRateLimit = 14;
ServerSendRateLimitInterval = 1200;
```

即客户端全消息共享 1200 ms 窗口最多发送 14 条，超出的排队；这不是 COE 可用配额，正式协议必须远低于此值并自行防抖、限流。

### 3.2 消息类型与发送者

本地源码：

```text
BC-Plugin/参考源码/Bondage-College-master-BondageClub-Scripts/BondageClub/Scripts/Messages.d.ts
```

关键定义：

```ts
interface ServerChatRoomMessageBase {
  /** The sender number. Provided by the server to the client, ignored otherwise. */
  Sender?: number;
}

interface ServerChatRoomMessage extends ServerChatRoomMessageBase {
  /** null means broadcast to the room */
  Target?: number;
  Content: string;
  Type: "Action" | "Chat" | "Whisper" | "Emote" | "Activity" | "Hidden" |
        "LocalMessage" | "ServerMessage" | "Status";
  Dictionary?: ChatMessageDictionary;
  Timeout?: number;
}
```

`Sender` 注释明确说明由服务器提供、客户端发送值被忽略。

### 3.3 ChatRoomMessage 接收路径

直接读取生产 R130 客户端：

```text
https://www.bondageprojects.elementfx.com/R130/BondageClub/Screens/Online/ChatRoom/ChatRoom.js
```

实际签名：

```js
function ChatRoomMessage(data)
```

入口先验证：

```js
typeof data === "object"
typeof data.Content === "string"
typeof data.Sender === "number"
ChatRoomData 存在
ChatRoomCharacter 中存在同 MemberNumber 的发送者
```

随后调用 pre-handlers。若消息未被更早处理，内建优先级 `-1` 的处理器调用 `ChatRoomMessageProcessHidden()` 并返回 `true`。主函数在 pre-handler 后还有第二道明确边界：

```js
if (data.Type === "Hidden") return;
```

所以 Hidden 不进入 metadata/post-handler，不进入优先级 500 的 `ChatRoomMessageDisplay()`，也不进入只处理 Chat/Whisper 的 `ChatRoomChatLog` 保存处理器。

### 3.4 公开消息扩展点

生产 R130：

```js
function ChatRoomRegisterMessageHandler(handler) {
  if (!handler || typeof handler.Priority !== "number" || typeof handler.Callback !== "function") {
    console.error("Invalid message handler registration");
    return;
  }
  ChatRoomMessageHandlers.push(handler);
}
```

运行时分为 pre/post 两组，并执行：

```js
handlers.sort((a, b) => a.Priority - b.Priority);
```

因此这是比直接覆盖 `ChatRoomMessage` 更窄、更符合 R130 设计的接收入口。限制是没有公开 unregister；Remote 正式版必须依赖双实例防护，或保存 handler 引用并使用安全禁用标志，不能重复注册。

### 3.5 R130 自带成熟握手样例

生产 R130 的 `CommandsModsList` 使用：

```js
ServerSend("ChatRoomChat", {
  Content: "ModSdkModsQuery",
  Type: "Hidden",
  Dictionary: [{ Tag: "ModSdkModsQueryPayload", RequestId: requestId }],
  Target: target?.MemberNumber,
});
```

回复定向到 `data.Sender`，带同一 `RequestId`，并设置超时；`ChatRoomMessageProcessHidden()` 识别 `ModSdkModsQuery/Reply` 后交给 `CommandsModsList.ProcessHiddenRemote()`。这证明 R130 官方客户端本身已经把 Hidden + Target + request id + timeout 用作 Mod 发现协议。

## 4. 服务端证据

研究源：

```text
https://github.com/Ben987/Bondage-Club-Server/blob/master/app.js
```

该仓库 master 在 2026-07-22 的关键实现如下；它是公开生产服务端源的当前证据，但未取得一个明确标记为“R130 部署提交”的不可变 commit，版本对应置信度为中高。

### 4.1 Sender 与路由

实际函数：

```js
function ChatRoomChat(data, socket) {
  if (... && data.Content.length <= ServerChatMessageMaxLength) {
    var Acc = AccountGet(socket.id);
    if (Acc != null)
      ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber,
        data.Content.trim(), data.Type, data.Target, data.Dictionary);
  }
}
```

客户端不能指定最终 Sender；服务端使用 `AccountGet(socket.id).MemberNumber`。

广播与定向：

```js
function ChatRoomMessage(CR, Sender, Content, Type, Target, Dictionary) {
  if (Target == null) {
    IO.to("chatroom-" + CR.ID).emit("ChatRoomMessage",
      { Sender, Content, Type, Dictionary });
  } else {
    for (const Acc of CR.Account) {
      if (Target === Acc.MemberNumber) {
        Acc.Socket.emit("ChatRoomMessage", { Sender, Content, Type, Dictionary });
        return;
      }
    }
  }
}
```

### 4.2 大小和频率

公开服务端常量：

```js
ServerChatMessageMaxLength = 2000;
maxHttpBufferSize = 180000;
CLIENT_MESSAGE_RATE_LIMIT = 20; // default, per second
```

连接级 bucket 在超过每秒 20 个所有类型客户端消息时发送 `ForceDisconnect: ErrorRateLimited` 并断开连接。COE 必须使用远低于此上限的自身限流；不能把服务器断线机制当正常流控。

### 4.3 是否持久化

`ChatRoomChat()` 和 `ChatRoomMessage()` 只验证并通过 socket.io emit 转发，没有数据库写入或聊天历史写入。客户端 Hidden 又在显示/聊天日志处理前终止。因此源码证据表明该消息是房间会话瞬时消息，不写入 Appearance、账号外观或 BC 客户端聊天记录。

## 5. bcModSdk 1.2.0

生产 R130：

```text
https://www.bondageprojects.elementfx.com/R130/BondageClub/Scripts/lib/bcmodsdk.min.js
```

版本头为 `Bondage Club Mod Development Kit (1.2.0)`。对同一函数的 hook 执行：

```js
hooks.sort((a, b) => b.priority - a.priority)
```

即数值越高越先进入 hook 链。API 为：

```js
modApi.hookFunction(functionName, priority, (args, next) => { ... })
```

BCX 使用 `hookFunction("ChatRoomMessage", 10, ...)` 接收自己的 Hidden 消息，并在识别后不调用 `next(args)`。对 COE Remote 而言，R130 已提供 `ChatRoomRegisterMessageHandler`，优先采用原生扩展点；ModSDK Hook 只作为未来版本缺失该入口时的显式兼容方案，不同时安装两套接收器。

## 6. 主流 Mod 对照

### 6.1 BCX

读取：

```text
https://raw.githubusercontent.com/Jomshir98/bondage-club-extended/master/src/modules/messaging.ts
```

BCX 的房间消息：

```js
ServerSend("ChatRoomChat", {
  Content: "BCXMsg",
  Type: "Hidden",
  Target,
  Dictionary: { type, message },
});
```

接收时验证 `Type/Content/Sender/Dictionary`，用 `data.Sender` 作为对端身份；query 使用 UUID、目标 MemberNumber、10 秒 timeout 和定向 reply。`notifyOfChange()` 还用 100 ms debounce 合并变化通知。

可借鉴：命名空间、请求 id、目标绑定、timeout、变化防抖。不可直接照搬：Dictionary 任意对象和缺少 COE 所需的严格字节/结构/速率预算。

### 6.2 Echo 服装扩展

本地源码：

```text
BC-Plugin/参考源码/echo-clothing-ext-main/src/**
```

未发现 COE 可复用的通用远端快照协议。服装扩展主要依靠双方注册同名正式 Asset 后由标准 Appearance 同步 `Group/Name/Color/Property`；这不适用于用户生成的 COE 图层组合。`itemDialog.js` 使用的是可见 CustomAction，不是私有数据通道。

### 6.3 LSCG、WCE、Echo 动作扩展

当前工作区没有它们的可读源码副本，因此不能把用户实机安装版本当作源码证据。Phase 1 不据此声称兼容。后续私人房测试必须与 LSCG 0.8.18、WCE 6.3.18、Echo 动作扩展 0.36.1 同时启用观察，但不得因此修改第三方 Mod。

## 7. 不推荐通道

### 7.1 普通 Chat/Whisper/Emote/Action

会进入聊天显示、通知或本地聊天日志；未安装插件用户可见，违反红线。

### 7.2 Appearance Bundle / ChatRoomCharacterUpdate

会污染正式 Appearance 或账号/房间角色更新链，重现旧 CustomOutfit 架构风险，严格禁止。

### 7.3 AccountBeep

BCX 能用自定义 beep 做跨房通信，但它不是同房间视觉状态的最小通道，可能产生通知、离线/跨房语义和额外隐私面；不采用。

### 7.4 直接 socket.emit 或覆盖 ChatRoomMessage

绕过 `ServerSend` 的客户端队列会与 BC 限流冲突；直接覆盖函数会破坏多 Mod 兼容。应使用 `ServerSend` 和公开 handler（或单一 ModSDK hook fallback）。

### 7.5 Dictionary 大对象

服务端没有对 Dictionary 做与 Content 同等级的 2000 字符限制，只受 180000 字节 socket 总包限制；这使它不适合作为 COE 的安全预算边界。只允许少量、固定 schema 元数据，或全部放进有硬上限的 Content。

## 8. 消息样例（仅研究探针）

广播：

```js
ServerSend("ChatRoomChat", {
  Type: "Hidden",
  Content: "COE_REMOTE_PROBE/1|{...固定探针字段...}"
});
```

定向：

```js
ServerSend("ChatRoomChat", {
  Type: "Hidden",
  Target: 123456,
  Content: "COE_REMOTE_PROBE/1|{...固定探针字段...}"
});
```

探针只允许：协议名、sequence、timestamp、broadcast/targeted 标记和固定长度重复文本；不读取或发送衣柜、Appearance、ExtensionSettings、localStorage、真实 composition。

## 9. 房间切换与重连边界

从服务端路由可知，消息只发到发送时的 `Acc.ChatRoom`，定向目标也必须存在于该房间的 `CR.Account`。客户端 `ChatRoomMessage()` 在 `ChatRoomData` 为空或 Sender 不在 `ChatRoomCharacter` 时立即丢弃。

因此：

- 消息不具备离线补发；
- 离房后旧发送者消息不会通过当前客户端成员校验；
- 重连后必须重新握手；
- 正式协议仍需独立 `room generation`，因为异步队列和快速换房的竞态不能只靠当前成员校验完全排除；
- 不应跨房持久激活远端状态。

## 10. 置信度

| 结论 | 置信度 | 证据 |
|---|---:|---|
| R130 Hidden 不显示、不进入 post-handler | 高 | 直接读取生产 R130 ChatRoom.js |
| Sender 由服务器账号 MemberNumber 产生 | 高 | R130 Messages.d.ts + 公开服务端 ChatRoomChat |
| 广播/定向路由存在 | 高 | 服务端 ChatRoomMessage + R130 `/mods remote` |
| Content 上限 2000 | 中高 | 当前公开服务端 master；待生产探针边界确认 |
| 客户端发送队列 14/1200 ms | 高 | 本地 R130 Server.js |
| 服务端默认 20 客户端消息/秒后断线 | 中高 | 当前公开服务端 master；部署环境可覆盖 env |
| 未安装插件客户端不显示未知 Hidden | 高（源码） | R130 内建 Hidden handler + 主函数 return；仍需双客户端实测 |
| 不写聊天记录/Appearance | 高（源码） | 服务端仅 emit；客户端 Hidden 在显示前终止 |
| 生产广播会回送发送者 | 中 | socket.io room emit 语义；待实机确认 |

## 11. 隔离实机探针计划

文件：

```text
probes/communication-probe.user.js
```

默认关闭，不自动发包。只在两个测试账号的私人房中加载。控制台步骤：

```js
COERemoteCommunicationProbe.enable()
COERemoteCommunicationProbe.status()
```

按顺序测试，每次发送至少间隔 3 秒：

```js
COERemoteCommunicationProbe.sendBroadcast(16)
COERemoteCommunicationProbe.sendTo(对方MemberNumber, 16)
COERemoteCommunicationProbe.sendBroadcast(64)
COERemoteCommunicationProbe.sendBroadcast(256)
COERemoteCommunicationProbe.sendBroadcast(512)
COERemoteCommunicationProbe.sendBroadcast(1024)
COERemoteCommunicationProbe.sendBroadcast(1400)
```

每一步记录双方：

```js
COERemoteCommunicationProbe.status()
```

验收项：

- [ ] 广播双方收到，Sender 等于真实发送账号 MemberNumber；
- [ ] 定向只有目标收到；
- [ ] 两边聊天 UI 都不出现 `COE_REMOTE_PROBE/1`；
- [ ] 一方不装探针时，该方聊天 UI 仍无可见正文、无报错；
- [ ] 16–1400 body 的逐级长度行为已记录；
- [ ] 3 秒间隔无断线、无消息风暴；
- [ ] 换房后旧消息不出现，重连后需重新启用/测试；
- [ ] `Player.Appearance` 和 `ServerAppearanceBundle(Player.Appearance)` 前后不变；
- [ ] 与 BCX/LSCG/WCE/Echo 同开时无 handler 冲突。

测试后：

```js
COERemoteCommunicationProbe.disable()
```

若任一未安装探针客户端看见正文、Sender 不可信、定向泄漏、异常冒泡中断 ChatRoom、或出现断线/Appearance 变化，立即停止并提交阻塞报告。

## 12. Phase 1 当时状态与停止点（历史）

已完成：

- R130 发送、接收、Hidden、Sender、Target、Dictionary、限流源码研究；
- bcModSdk 1.2.0 priority 研究；
- BCX、Echo 与 R130 自带 `/mods remote` 对照；
- 默认关闭、无自动循环、有限长度/间隔/记录的隔离探针；
- 推荐与禁止通道结论。

当时尚未执行两客户端私人房最小探针，并据此要求开发停在 Phase 1。后续线路二实施任务已明确授权进入源码实现，因此 v1.8.0 已接入 activeComposition 快照与远端渲染；私人房和兼容 Mod 实测依然保留为交付前待办。
