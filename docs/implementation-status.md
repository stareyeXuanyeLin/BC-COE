# COE Remote 1.8.1 实施状态

更新日期：2026-07-22

## 当前结论

线路二的源码、Node 自动化、构建、语法检查和上游基线复核已经完成。1.8.0 已完成一次双账号私人房实测：双方同时安装并开启插件后，可以互相看见真实自定义服装，未弹出 BC/BCX 错误窗口。1.8.1 在此基础上过滤 R130 已移除的旧姿势键，避免合成图层重复放大 Echo 的 `LegsOpen` 警告。

```text
实现完成 → 自动化门禁通过 → 1.8.0 双客户端真实方案互见通过 → 1.8.1 等待页面复测
```

这足以确认核心共享链路可用，但 Appearance/Bundle 隔离、CLEAR/重进/断线、缺失素材及三客户端等阶段仍未实机完成。公共多人房测试尚未获准，也尚未执行。

## 已完成

- `COE_RVS/1` Hidden STATE / REQUEST / CHUNK / CLEAR；
- 严格 envelope/snapshot validator、SHA-256 base64url、canonical 和分片；
- roomGeneration、peerSessionId、pending request、assembly、限流、预算和生命周期；
- 本地/远端 synthetic 构建路径分离；
- BC、Echo、其他本机已加载静态图片素材的线路二投影；
- 动态/Extended/Archetype 禁用及 Property 二次清洗；
- Appearance/Bundle 隔离和 CommonDraw `try/finally`；
- 默认关闭、彼此独立的共享/接收开关；
- RemotePrefs 与 wardrobe schema v4 隔离；
- status plain summary；
- 协议、Store、Transport、Renderer 自动化测试；
- 1.8.0 双账号私人房真实方案双向互见，BCX、LSCG、WCE、Echo 同时加载，且无错误窗口。

## 自动化门禁

```text
npm test                 47/47 通过
npm run build            通过
npm run check            通过
上游 COE-Echo v1.6.2    24/24 SHA-256 一致
```

产物：

```text
dist/CustomOutfitEditorEchoRemote.user.js
140,518 bytes
SHA-256 8f1ea6a60f1bc3c5846fc19ae3dfcd44ec34c060e78f556a857881f0cea6dd6d
```

## 尚未完成

- 1.8.1 页面复测，确认合成图层不再重复输出 `Layer.PoseMapping ... LegsOpen`；
- Appearance/Bundle/status 固定检查；
- 单客户端 BC 页面内虚拟远端 Character和固定 snapshot；
- Vanilla 单/多 material 的逐项视觉核对；
- 换装、CLEAR、刷新、重进和断线重连；
- 一方无插件与缺失/异常素材；
- `Pussy/Hard/Pussy1_White.png` 404 的来源素材及实际缺图影响确认；
- 三名兼容客户端私人房；
- 用户明确同意后的公共多人房。

详细顺序与记录模板见 `multiplayer-test-plan.md`。

## 文档效力

- `protocol-spec.md`、`threat-model.md`、`architecture.md`、`known-limitations.md` 描述当前 1.8.1 实现。
- `communication-research.md`、`phase2-implementation-research.md` 是实施前研究档案；其中阶段停止点、严格 Vanilla/Echo allowlist 路线和旧测试数量不再代表当前实现。
- 若研究档案与当前规范冲突，以任务文档、当前源码和上述四份 1.8.1 文档为准。
