# COE Remote Visual Snapshot Protocol v1

## 传输

BC Hidden 消息：

```js
ServerSend("ChatRoomChat", {
  Type: "Hidden",
  Content: "COE_RVS/4|" + JSON.stringify(envelope),
  Target: memberNumber // 定向消息才有
});
```

最大 Content 1800 字符，不使用 Dictionary。接收器在 JSON.parse 前检查 Type、namespace、原始长度和 Sender 房间成员身份；识别本 namespace 后始终内部消费。

## Envelope

```js
// HELLO + 状态
{ t:"STATE", s:peerSessionId, r:revision, h:hashOrEmpty, z:bytes, sharing:boolean }
// 请求当前发布版本
{ t:"REQUEST", requestId, session, revision, hash }
// 每片均定向；单片也 count=1
{ t:"CHUNK", requestId, session, revision, hash, index, count, data }
// 清除发送者当前投影
{ t:"CLEAR", s:peerSessionId }
```

未知键、非法类型、过深对象、污染键和不一致 STATE 均拒绝。`peerSessionId` 为页面实例随机 96 bit id；身份为 `roomGeneration + MemberNumber + peerSessionId`。

## Snapshot

固定键序：

```js
{
  v: 1,
  m: [{ g:"Cloth", a:"Dress", c:["#FFFFFF"], r:0.35, s:1.2, x:0, y:0, p:{ Type:"A", TypeRecord:{ typed:1 } } }],
  l: [{ m:0, n:"Base", i:0, p:10, x:0, y:0, o:1, r:0.2, s:1.1 }]
}
```

`m` 是连续重映射后的 material 数组；`l.m` 仅引用其索引。隐藏 material/layer 在发送前省略。数字必须 finite、消除 `-0`、最多四位小数。

`m.r/m.s/m.x/m.y` 表示一个 source Asset 的素材整体旋转、缩放和偏移；`l.r/l.s` 属于单图层。素材整体变换只作用于同一 material 的全部图片层，不会把整个自定义方案作为一个整体旋转。两层字段同时存在时，渲染顺序为 `素材整体 × 单图层 × 原始图片`，不会把任一层级的角度烘焙到另一层。素材整体中心由接收端按该 material 最大可见内容图层自动计算，单图层中心由各接收端按本地纹理 Alpha 有效内容包围盒自动计算，扫描未完成或失败时回退到纹理中点。

整体/图层偏移范围为 `[-1200, 1200]`；越界输入在严格规范化阶段裁剪，非法类型、NaN 和 Infinity 直接拒绝。

Property 只允许 `Type`、`Mirror`、`Invert`、`TypeRecord`。TypeRecord 最多 16 键；键匹配 `A-Za-z0-9_` 且最长 24；值只允许 boolean、绝对值不大于 9999 的整数、最长 40 的字符串。

## Canonical 与完整性

builder 创建全新固定键序对象；canonical 为验证后对象的 `JSON.stringify()`。hash 为 canonical UTF-8 的 SHA-256 base64url。hash 用于去重和完整性，不提供身份认证。

接收端重组后：base64url 解码 → UTF-8 → JSON.parse → 严格 schema → 再序列化必须与原 canonical 完全相同 → SHA-256 必须匹配 pending REQUEST。

## 状态机

- 入房、共享开关变化、视觉 hash 变化时发送 STATE；视觉变化防抖 500 ms。
- 新 peer 的首次 STATE 只定向回复一次 STATE，避免 ping-pong。
- 仅在接收开启、peer sharing、无同 hash 缓存且无匹配 pending 时发送 REQUEST。
- REQUEST 12 秒超时，最多自动重试一次。
- 发布端只响应与当前 session/revision/hash 完全一致的 REQUEST。
- CHUNK 仅接受与本机 pending REQUEST 完全匹配的定向数据；unsolicited CHUNK 拒绝。
- 重复同片忽略且不重复计入 assembly；冲突重复片废弃 assembly。
- CLEAR、离房、成员离开或 generation 变化清理对应状态。

## 硬预算

- materials 32、layers 120；snapshot 32768 UTF-8 bytes；单 material+refs 8192 bytes；
- chunk data 1200 base64url 字符、count 32；每 Sender 1 assembly、房间 4 assemblies；
- assembly 20 秒上限；房间全部 active snapshot 256 KiB；peers 10；诊断 100 条；
- REQUEST 每 peer 5 秒最多一次；响应 snapshot 每 peer 10 秒最多一次；CHUNK 间隔至少 400 ms；
- 发送全局 burst 2，持续不超过 2.5 条/秒；接收按 Sender 与房间双 token bucket。
