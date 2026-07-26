# 远端协议预存测试失败说明

> 目的：将当前协议测试的两个失败交给其他窗口修复。
>
> 项目：`BC-Plugin/COE-Echo-Mirror`
>
> 当前分支：`layer-transform`
>
> 检查基线：提交 `8759261`

## 一、当前测试结果

运行：

```powershell
npm test
```

当前结果：

```text
53 tests
51 pass
2 fail
```

失败项：

1. `tests/protocol.test.js:13`
   - `content length and namespace are rejected before JSON parsing`
2. `tests/transport.test.js:9`
   - `Hidden handler validates the real sender and internally consumes damaged protocol messages`

这两个失败与图层旋转、等比缩放、数据版本迁移无关，属于远端协议测试没有跟随协议版本升级。

---

## 二、协议当前实际版本

实现位置：

```text
src/11-remote-protocol.js:1
```

当前定义：

```js
const REMOTE_PROTOCOL = "COE_RVS/3";
const REMOTE_PREFIX = `${REMOTE_PROTOCOL}|`;
```

解析入口：

```text
src/11-remote-protocol.js:194-199
```

当前逻辑：

```js
function parseRemoteContent(content) {
  if (
    typeof content !== "string" ||
    content.length > REMOTE_LIMITS.content ||
    !content.startsWith(REMOTE_PREFIX)
  ) {
    throw new Error("remote-content");
  }

  let parsed;
  try {
    parsed = JSON.parse(content.slice(REMOTE_PREFIX.length));
  } catch (_) {
    throw new Error("remote-json");
  }
  return validateRemoteEnvelope(parsed);
}
```

因此错误分类是：

| 输入 | 当前结果 |
|---|---|
| 长度超过限制 | `remote-content` |
| 前缀不是 `COE_RVS/3\|` | `remote-content` |
| 前缀是 `COE_RVS/3\|`，JSON 损坏 | `remote-json` |

旧版本前缀 `COE_RVS/1|` 和 `COE_RVS/2|` 当前都会被视为不属于当前协议命名空间，返回 `remote-content`。这是当前协议严格版本隔离的预期行为。

---

## 三、失败一：`protocol.test.js`

测试位置：

```text
tests/protocol.test.js:12-18
```

当前测试：

```js
test('content length and namespace are rejected before JSON parsing', () => {
  const { api } = load();
  assert.throws(() => api.parseRemoteContent('x'.repeat(1801)), /remote-content/);
  assert.throws(() => api.parseRemoteContent('OTHER|{'), /remote-content/);
  assert.throws(() => api.parseRemoteContent('COE_RVS\\/1|{'), /remote-json/);
});
```

实际失败信息：

```text
AssertionError: The input did not match the regular expression /remote-json/.
Input: Error: remote-content
```

### 根因

测试使用了旧前缀：

```text
COE_RVS/1|{
```

但当前解析器只接受：

```text
COE_RVS/3|{
```

由于前缀检查发生在 JSON.parse 之前，`COE_RVS/1|{` 会先触发：

```text
remote-content
```

根本不会进入损坏 JSON 的 `remote-json` 分支。

### 推荐修复

将测试输入改为当前协议前缀：

```js
assert.throws(() => api.parseRemoteContent('COE_RVS/3|{'), /remote-json/);
```

更稳妥的做法是避免测试硬编码版本字符串。可以让测试辅助 API 暴露当前协议，或者从一个合法序列化内容中提取前缀。例如项目测试 API 增加：

```js
remoteProtocol: REMOTE_PROTOCOL
```

测试写成：

```js
assert.throws(() => api.parseRemoteContent(`${api.remoteProtocol}|{`), /remote-json/);
```

如果不想扩展测试 API，也可以在 `tests/protocol.test.js` 中暂时直接使用 `COE_RVS/3|{`。

### 不推荐的修复

不建议为了让旧测试通过而让生产解析器把 `COE_RVS/1|` 或 `COE_RVS/2|` 当作当前命名空间接受。当前协议已经升级到 v3，旧协议不应继续进入 JSON 解析流程，除非明确设计协议兼容层。

---

## 四、失败二：`transport.test.js`

测试位置：

```text
tests/transport.test.js:9-16
```

当前测试：

```js
test('Hidden handler validates the real sender and internally consumes damaged protocol messages', () => {
  const sender = {
    MemberNumber: 7,
    Appearance: [],
    AppearanceLayers: [],
    AssetFamily: 'Female3DCG',
  };
  const { api } = load({ characters: [sender] });

  assert.equal(
    api.onRemoteMessage({
      Type: 'Hidden',
      Sender: 9,
      Content: state(api),
    }),
    true,
  );
  assert.equal(api.getRemoteStoreForTest().peers.size, 0);

  assert.equal(
    api.onRemoteMessage({
      Type: 'Hidden',
      Sender: 7,
      Content: 'COE_RVS/1|{',
    }),
    true,
  );
  assert.equal(api.getRemoteStoreForTest().stats.messagesRejected, 2);

  assert.equal(
    api.onRemoteMessage({ Type: 'Chat', Sender: 7, Content: 'hello' }),
    false,
  );
});
```

### 实际执行路径

`onRemoteMessage` 位于：

```text
src/13-remote-transport.js:56-92
```

它首先检查：

```js
if (
  data?.Type !== "Hidden" ||
  typeof data.Content !== "string" ||
  !data.Content.startsWith(REMOTE_PREFIX)
) return false;
```

当前 `REMOTE_PREFIX` 是：

```text
COE_RVS/3|
```

所以第二条输入：

```text
COE_RVS/1|{
```

会在最前面的前缀判断处直接返回：

```text
false
```

并且不会增加 `messagesRejected`。

### 第一条断言为什么正常

测试发送者 `9` 不在测试房间角色列表中，实际只有 `MemberNumber: 7` 的角色。当前实现会：

1. 识别消息类型为 `Hidden`
2. 确认内容以当前协议前缀开头
3. 找不到真实发送者 9
4. 增加一次 `messagesRejected`
5. 返回 `true`，表示该协议消息已被内部消费

因此第一条断言和当前设计一致：

```js
api.onRemoteMessage({ Type: 'Hidden', Sender: 9, Content: state(api) }) === true
```

### 推荐修复

将旧前缀改为当前前缀：

```js
Content: 'COE_RVS/3|{'
```

这样消息会进入 `parseRemoteContent`，因为 JSON `{` 不完整而抛出 `remote-json`，`onRemoteMessage` 会：

1. 捕获解析错误
2. 增加一次 `messagesRejected`
3. 记录 `invalid-envelope` 诊断
4. 返回 `true`

此时预期统计值重新变为：

```js
api.getRemoteStoreForTest().stats.messagesRejected === 2
```

### 更稳妥的测试改法

和 `protocol.test.js` 一样，最好不要在测试中硬编码版本号。可向测试 API 暴露 `REMOTE_PROTOCOL` 或 `REMOTE_PREFIX`，然后：

```js
Content: `${api.remoteProtocol}|{`
```

或者提供一个测试辅助函数：

```js
api.remotePrefix + '{'
```

---

## 五、建议的最小修改清单

如果只想修测试，不改生产逻辑：

### `tests/protocol.test.js`

```diff
- assert.throws(() => api.parseRemoteContent('COE_RVS/\\/1|{'), /remote-json/);
+ assert.throws(() => api.parseRemoteContent('COE_RVS/3|{'), /remote-json/);
```

注意实际 JavaScript 字符串应保持为：

```js
'COE_RVS/3|{'
```

不需要写反斜杠转义 `/`。

### `tests/transport.test.js`

```diff
- Content: 'COE_RVS/1|{'
+ Content: 'COE_RVS/3|{'
```

修改后运行：

```powershell
npm test
```

预期：

```text
53 tests
53 pass
0 fail
```

如果另一个窗口同时重构了测试数量，重点确认这两个失败项消失即可。

---

## 六、是否应该修改生产代码？

按照当前协议设计，**不需要修改生产代码**。

生产逻辑严格要求当前版本前缀，原因是：

- 避免旧版本消息进入新版本解析器
- 避免不同协议字段被误解释
- 版本升级后保持明确的命名空间隔离
- 当前项目仍处于测试阶段，没有外部用户需要旧协议兼容

只有在明确要求兼容 `COE_RVS/1` 或 `COE_RVS/2` 时，才应设计独立的协议兼容层，而不是简单放宽 `startsWith(REMOTE_PREFIX)`。

---

## 七、与本次图层缩放改动的关系

没有关系。

本次图层变换版本的协议调整包括：

```text
COE_RVS/2 → COE_RVS/3
```

并将远端图层缩放字段改为：

```js
s
```

旧测试仍写着：

```text
COE_RVS/1
```

因此这两个测试失败本质上是测试夹具没有跟随协议版本更新，不是远端传输逻辑被图层缩放改坏。
