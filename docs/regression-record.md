# 回归记录

日期：2026-07-22  
环境：Windows / Node 24.16.0 / PowerShell / BC R130 目标。

## 1.8.1 自动化结果

```powershell
npm test
npm run build
npm run check
node scripts/verify-upstream.mjs
```

结果：

- Node：47/47 通过；
- 构建：通过；
- dist `node --check`：通过；
- COE-Echo v1.6.2 只读基线：24/24 SHA-256 一致；
- 产物：`dist/CustomOutfitEditorEchoRemote.user.js`；
- 大小：140,518 bytes；
- SHA-256：`8f1ea6a60f1bc3c5846fc19ae3dfcd44ec34c060e78f556a857881f0cea6dd6d`。

## 覆盖范围

### 继承的本地回归

无 synthetic 原引用、base 顺序和同 priority 稳定插入；静态视觉代理；动态标志不可重新启用；LSCG `Asset.Group` 回退；Property 清洗；compact wardrobe；存储损坏/冲突保护；正式同 Asset 冲突；Bundle synthetic/旧容器过滤；CommonDraw finally 恢复。

### Protocol

相同视觉 canonical/hash；Content namespace/原始长度；污染键、非 finite 数、非法 Property；解码后预算；chunk 拆分；同 revision/hash 冲突与新 peerSession revision 重置。

### Store / Transport

乱序重组；重复片不重复计费；冲突片废弃；timeout 清理；unsolicited CHUNK；MemberNumber 隔离；generation reset；真实 Sender；自身回送；损坏协议内部消费；STATE 首次回复且不 ping-pong；CLEAR 不串成员。

### Remote Renderer

无 snapshot 原 base 引用；BC/Echo/其它本机静态 Asset 投影；Visual Asset Proxy 动态入口固定 false；缺失 material 局部跳过；MemberNumber A/B 隔离；CommonDraw 抛错引用恢复；CLEAR 后不再绘制；正式同 Asset 冲突保护；合成视觉图层过滤当前 BC `PoseRecord` 不存在的旧姿势键且不修改源 Asset。

## 1.8.0 双客户端私人房记录

- 日期/BC/插件：2026-07-22 / R130 / 1.8.0；
- 客户端：两个真实账号，双方均开启共享与接收；控制台显示 Echo 1.129.4、BCX 1.1.16、LSCG 0.8.18、WCE 6.3.18；
- 可见结果：双方均能看见彼此的真实自定义服装；
- 错误窗口：无；
- 核心链路结论：STATE/REQUEST/CHUNK、快照接收与远端静态绘制已经实机跑通；
- 尚缺证据：未记录 Appearance/Bundle/status，未覆盖 CLEAR、重进、断线与三客户端；
- 控制台：插件没有 `handler-rejected`、`remote-render-failed` 或自身未捕获异常。Echo 旧素材产生 6 条初始化期 `Layer.Alpha ... LegsOpen`；远端刷新后旧姿势键被合成图层放大为 100 条 `Layer.PoseMapping ... LegsOpen`，已在 1.8.1 过滤。另有 `Pussy/Hard/Pussy1_White.png` 404，需单独确认对应素材与实际缺图；Edge `content_main.js` 快捷键异常及 preload 警告不属于 COE Remote。

## 静态红线复核

未发现 `ServerSocket.emit`、Dictionary 协议、普通 Chat/Whisper/Emote 承载、eval/Function、远端动态标志启用、网络对象进入 `normalizeComposition()`、snapshot 写入正式 Appearance。服务器 Appearance 同步调用只保留在继承的**旧 CustomOutfit 容器精确迁移/清理**路径，不用于远端显示或传播。

## 尚未执行的实机阶段

- [ ] 单客户端虚拟 Character 的 BC 页面内验证；
- [x] 双客户端私人房真实方案双向互见（1.8.0；尚缺固定 snapshot 与 Appearance/Bundle/status 记录）；
- [ ] Vanilla 1 material/1 layer；
- [ ] 多 material/layer、换装、CLEAR、刷新、重进；
- [ ] 一方无插件；
- [x] Echo 静态素材真实方案互见（1.8.0；存在待定位的 `Pussy1_White` 404）；
- [x] BCX + LSCG + WCE + Echo 组合下核心双向互见（1.8.0；完整生命周期仍待测）；
- [ ] 三兼容客户端私人房；
- [ ] 用户明确同意后的公共多人房。

当前可以表述为“1.8.0 双客户端私人房核心共享链路已实机确认，1.8.1 自动化通过并等待页面复测”；不能扩展表述为完整生命周期、三客户端或公共多人房已经验收。
