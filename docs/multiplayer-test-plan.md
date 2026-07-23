# 多客户端实机测试计划

公共多人房测试必须等私人房阶段通过，并获得用户明确同意。

## 每轮固定检查

```js
Player.Appearance
ServerAppearanceBundle(Player.Appearance)
JSON.stringify(ServerAppearanceBundle(Player.Appearance)).length
CustomOutfitEditor.status()
```

Appearance/Bundle 不得出现 `CustomOutfit`、`CustomComposition`、`__coeMaterialId`、`COE_RVS`、revision/hash/chunk/snapshot、Canvas/WebGL/Function 或 Echo PersistentData。启动前后还应对比 `Player.Appearance`，确认插件未执行旧容器迁移，也未主动触发服务器 Appearance 或聊天室角色同步。

## 阶段

1. **Node 门禁**：`npm test`、`npm run build`、`npm run check`；静态扫描确认正常运行源码无旧容器常量、识别/迁移函数、`CustomComposition` 和主动 Appearance/聊天室同步调用。
2. **单客户端虚拟远端 Character**：transport 不启用；验证 A/B 按 MemberNumber 隔离、无 snapshot 原引用、CLEAR/leave 后消失、CommonDraw throw 后引用恢复。
3. **双客户端私人房，仅握手**：两项偏好默认关闭；Hidden 消息不可见；一方无插件无聊天/异常；STATE 不 ping-pong；双方启动时正式 Appearance 保持不变。
4. **固定虚拟 snapshot**：先 1 Vanilla material/1 layer；确认接收端静态显示、发送端与接收端正式 Appearance 不变。
5. **真实当前方案**：多 material/layer、颜色、Type、优先级、偏移、透明度；换装 hash/revision、关闭共享 CLEAR、关闭接收、本地刷新。
6. **生命周期**：成员离开/重进、换房、刷新页面、断线重连；旧 session/revision/chunk 不得复活。
7. **缺失与异常素材**：接收端缺 Asset、缺 layer、同 Asset 正式穿戴、动态素材；只允许局部缺失，动态 callback 不执行。
8. **Echo 静态素材**：双方同版本与一方缺素材两种情况；验证普通 HasImage 层尽量投影。
9. **兼容 Mod**：BCX、LSCG、WCE、Echo 同开；重复素材、透明度 Hook、Character 重建和 Bundle 检查。
10. **三名兼容客户端私人房**：A/B/C 不串数据；单发送者限流不影响其它人；leave 只清对应 MemberNumber。
11. **公共多人房**：仅在前十项记录通过且用户明确同意后进行；先短时、低复杂度、随时可关闭共享/接收。

## 已执行记录

```text
日期/BC版本/插件版本：2026-07-22 / R130 / 1.8.0
客户端与 Mod 组合：两个真实账号；双方均加载 Echo 1.129.4、BCX 1.1.16、LSCG 0.8.18、WCE 6.3.18、COE Remote
阶段：真实当前方案双向共享（覆盖阶段 3/5/8/9 的核心互见，未覆盖各阶段全部检查项）
共享/接收开关：双方均开启
素材：真实自定义衣服；具体 material 清单未记录
可见结果：双方均可看见彼此自定义衣服
Appearance/Bundle 检查：未记录
status 摘要：未记录
控制台异常：无 COE Remote handler/render 异常，无错误窗口；旧 LegsOpen 警告被刷新放大，1.8.1 已过滤合成层旧键；另有 Pussy1_White 404 待定位
通过/失败/阻塞：核心共享与显示通过；完整阶段验收仍未完成
```

## 记录模板

```text
日期/BC版本/插件版本：
客户端与 Mod 组合：
阶段：
共享/接收开关：
素材：
可见结果：
Appearance/Bundle 检查：
status 摘要：
控制台异常：
通过/失败/阻塞：
```
