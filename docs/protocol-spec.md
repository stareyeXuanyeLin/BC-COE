# COE Room Visual Publication Protocol v1

协议命名空间：

```text
COE_RVP/1|
```

RVP/1 与旧 `COE_RVS/4` 不兼容。当前实现硬切主版本，不注册、不解析、不发送 RVS/4 消息。

## 1. 传输

协议只使用 BC Hidden ChatRoomChat：

```js
ServerSend("ChatRoomChat", {
  Type: "Hidden",
  Content: "COE_RVP/1|" + JSON.stringify(envelope),
  Target: memberNumber, // 仅定向公告或晚加入者补发时存在
});
```

- Content 最大协议预算 1800 字符；
- 不使用 Dictionary 承载快照；
- Sender 只采用 BC 服务端提供的 `data.Sender`；
- 接收端在 JSON.parse 前检查 Type、namespace、Content 长度和 Sender 房间成员身份；
- 识别本 namespace 后始终内部消费，错误不会抛回 BC 消息循环；
- DATA 默认广播，使同一对象由所有等待者共同消费；
- COE 不使用 timer 对 DATA 分片做二次节拍，完整批次直接交给 BC 原生 ServerSend 队列。

## 2. 内容对象

快照身份：

```text
ObjectId = SHA-256(canonical uncompressed snapshot UTF-8)
```

发布身份：

```text
roomGeneration + Sender MemberNumber + publisherSession + revision + ObjectId
```

同一 ObjectId 是不可变内容，可在当前 room generation 的 ObjectCache 中复用。缓存命中只复用已验证快照，角色发布归属仍由真实 Sender 的 ADVERTISE 决定；缓存节点不能替原始发布者发送 DATA。

## 3. 消息

字段使用紧凑单字母消息类型。

### DISCOVER

```js
{ t:"D", s:peerSession, rx:true, e:"gz" }
```

入房同步完成或重新开启接收时广播一次。发布者只在 `rx:true` 时定向补发当前 ADVERTISE。DISCOVER 不做对称回复，不产生 HELLO ping-pong。

### ADVERTISE

```js
{
  t:"A", s:publisherSession, r:revision, h:objectHash,
  u:uncompressedBytes, z:compressedBytes, n:chunkCount,
  d:optionalInlineGzipBase64Url
}
```

- 本地可见快照变化时广播；
- 新接收者 DISCOVER 时可定向补发；
- `d` 存在时 `n` 必须为 1，接收端无需 WANT；
- 同 session/revision 不允许不同 hash；
- 更旧 revision 拒绝。

### WANT

```js
{ t:"W", o:ownerMemberNumber, s:publisherSession, r:revision, h:objectHash }
```

本地没有 ObjectId 且 ADVERTISE 未内联时广播。其他接收者观察到相同 WANT 后抑制自己的重复请求。只有 BC Sender 等于 `o` 的原始发布者可以产生有效 DATA。

发布者对一个同步波次中的首个 WANT 广播一套完整 DATA；2 秒 cohort 窗口内的重复 WANT 不产生逐接收者复制。窗口后的 WANT 视作晚加入/晚启用补发，可定向发送给请求者。

### DATA

```js
{ t:"X", s:publisherSession, r:revision, h:objectHash, i:index, n:count, d:data }
```

- gzip bytes 经 base64url 后分片；
- 单片 data 最多 1400 字符；
- 最多 24 片；
- 只接受与该 Sender 当前 ADVERTISE 完全匹配的数据；
- 同 index 同内容幂等；同 index 冲突内容废弃该对象 assembly；
- DATA 不绑定 receiver requestId，房间内所有接收者共同组装同一发布。

### NACK

```js
{ t:"N", o:ownerMemberNumber, s:publisherSession, r:revision, h:objectHash, m:[missingIndexes] }
```

只用于异常缺片修复：

- 正常路径不逐片 ACK；
- assembly 12 秒仍不完整时最多发送一轮 NACK；
- missing index 去重并排序；
- 发布者只广播请求的缓存分片；
- 单对象 DATA 接收预算允许完整发布加一轮修复和少量重复；
- 不进行无限重试。

### REVOKE

```js
{ t:"R", s:publisherSession, r:revision }
```

关闭分享或当前无可见自定义服装时广播，只解除对应 Sender 的 Publication 与 ActiveBinding。ObjectCache 可保留到 room generation 重置。

## 4. 快照与 canonical

快照 schema 继续使用：

```js
{
  v: 1,
  m: [{ g:"Cloth", a:"Dress", c:["#FFFFFF"], r:0.35, s:1.2, x:0, y:0 }],
  l: [{ m:0, n:"Base", i:0, p:10, x:0, y:0, o:1, r:0.2, s:1.1 }]
}
```

- builder 生成固定键序新对象；
- canonical 为严格验证后对象的 `JSON.stringify()`；
- 数字必须 finite，消除 `-0`，最多四位小数；
- 隐藏 material/layer 不进入快照；
- hash 针对未压缩 canonical，不针对 gzip bytes；
- gzip 只作为传输编码，不改变快照身份。

## 5. 解码与验收

接收顺序：

```text
Content 字符预算
→ envelope schema
→ base64url 压缩输入预算
→ gzip 解压输出预算
→ UTF-8 fatal decode
→ uncompressed byte size
→ JSON.parse
→ snapshot schema
→ canonical 再序列化完全相等
→ SHA-256 等于 ADVERTISE hash
→ ObjectCache
→ ActiveBinding
→ CharacterRefresh
```

任何一步失败都只隔离该 Sender/ObjectId，不修改正式 Appearance。

## 6. 状态模型

Store 分为：

```text
Discovery       节点能力与接收意愿
Publication     Sender 当前 session/revision/ObjectId
Assembly        Sender/ObjectId 的临时分片
ObjectCache     按 ObjectId 保存的已验证不可变快照
ActiveBinding   MemberNumber 当前激活的发布
```

换房、离房和断线增加 room generation 并清除 Publication、Assembly、ActiveBinding、WANT/NACK 状态。旧异步 gzip、解压、hash 或校验完成后必须检查 generation，不能重新激活。

## 7. 硬预算

```text
Content：1800 字符
inline data：1300 base64url 字符
chunk data：1400 base64url 字符
chunks：24
canonical snapshot：32768 UTF-8 bytes
gzip bytes：24576 bytes
materials：32
layers：120
单 material + refs：8192 bytes
房间同时 assembly：8
ObjectCache：262144 canonical bytes
peer/publication：20
assembly 无进度过期：30 秒
缺片 NACK：12 秒后最多一轮
```

控制消息使用 Sender 与房间 token bucket。与当前 ADVERTISE 匹配的 DATA 使用独立对象级预算，避免合法大对象被控制消息桶截断。

## 8. 快速路径

### 内联对象

```text
ADVERTISE(d)
→ 解压/验证
→ 激活
```

一条消息完成，不需要 WANT、DATA 或 timer。

### 分片对象

```text
ADVERTISE
→ 第一个接收者广播 WANT
→ 发布者广播一套 DATA
→ 所有接收者共同验收
```

完整 DATA 不按接收者复制。

## 9. 禁止项

- 不兼容或回退到 COE_RVS/4；
- 不为每个接收者创建完整快照会话；
- 不逐片 ACK；
- 不用 timer 推进正常 DATA；
- 不绕过 ServerSend 直接操作 socket；
- 不用大型 Dictionary 承载快照；
- 不把协议或 Synthetic 数据写入 Appearance；
- 不允许缓存节点冒充原始发布者；
- 不执行任何远端动态代码。
