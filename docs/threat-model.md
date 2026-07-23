# 威胁模型

## 信任边界

聊天室 Hidden 消息、Sender 声明、快照字段、分片内容和本机 Mod Asset 都不被当作可信代码。协议只提供完整性检查，不提供端到端认证；BC 房间成员身份是可用的传输身份边界。

## 主要威胁与控制

### 可见消息与协议滥用

只使用 `ChatRoomChat/Hidden` 和 `COE_RVS/1` namespace，不使用普通 Chat/Whisper/Emote、Dictionary 或 `ServerSocket.emit`。namespace 在 parse 前检查，非本协议返回 false，本协议即使损坏也返回 true。

### Sender 伪造与跨房重放

要求 `data.Sender` 是整数、与当前 `ChatRoomCharacter` 中成员的 `MemberNumber` 相等，并忽略自身回送。Store 以 roomGeneration、MemberNumber、随机 peerSessionId 组合隔离；离房/换房使旧异步 hash、pending、assembly 和 snapshot 失效。

### JSON、原型污染与资源耗尽

原始 Content、对象深度、键数、字符串、数值、数组、snapshot、material、chunk、assembly、peer、房间总 bytes 和诊断 ring 均有硬上限。拒绝 `__proto__`、`prototype`、`constructor`，拒绝非 plain object、NaN、Infinity、循环、未知 envelope/schema 键和非法 Property。限流发生在 JSON.parse 前。

### 非请求快照与分片混淆

CHUNK 必须匹配本机 pending REQUEST 的 requestId/session/revision/hash；每 Sender 同时仅一个 assembly。同 index 同内容忽略，冲突内容废弃整组。完整 canonical 经 SHA-256 校验后才进入 Store。

### 动态代码与 Asset 行为

网络层不接受函数、Canvas、PNG、WebGL、Asset 或 Character 对象。Store 接受后才允许 `AssetGet`。接收端仅使用指定本机图片层，创建 Visual Asset Proxy，并把 DynamicBeforeDraw、DynamicAfterDraw、DynamicScriptDraw 固定为 false；清空 Extended/Archetype，再次调用 `sanitizeVisualProperty()`。不存在 eval、Function 或远端脚本调用。

### Appearance 泄漏

快照不写入正式 Appearance。Synthetic Item 只在同步 CommonDraw 调用内临时替换 Appearance/AppearanceLayers，并通过 finally 恢复。`ServerAppearanceBundle` 过滤 synthetic/旧容器；远端刷新使用 `CharacterRefresh(character, false, false)`，不触发服务器 Appearance 同步。

## 不覆盖的威胁

- 恶意本地 Mod 可直接篡改 BC 运行时；本插件无法在同一 JS realm 对抗拥有等价权限的代码。
- SHA-256 不证明发送者的人类身份，也不防止已在房间中的恶意客户端发送合法但误导性的静态引用。
- 本地已经加载的恶意 Asset 元数据仍可能影响 BC/其它 Mod；本插件只保证不由远端数据重新启用其动态入口。
