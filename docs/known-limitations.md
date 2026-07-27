# 已知限制

## 静态投影边界

COE Remote 只复制本机已加载 Asset 的普通图片层。以下内容不会同步：

- DynamicBeforeDraw / DynamicAfterDraw / DynamicScriptDraw；
- Canvas、WebGL、动画和仅由脚本产生的画面；
- ExtendedItem、锁、活动、SetPose、Hide、Block、Effect 等物品语义；
- 复杂 Property；只保留颜色、Mirror/Invert 和有限 Type/TypeRecord 图片变体。

接收端没有对应 Asset、layer index/name 不一致、layer 无图或锁定时，对应 material 会缺失。正式 Appearance 已穿同一 source Asset 时也会跳过远端 material，避免同源争用。

## 协议与发现

- 双方必须安装兼容 `COE_RVS/3` 插件并主动开启相应开关。
- 开关默认关闭；一方未安装时不会显示协议 UI 或普通聊天。
- snapshot hash 只校验完整性，不认证现实身份。
- 本版本不做跨房/跨页面缓存，不压缩 snapshot，不传输图片。
- 硬预算之外的方案不会共享；不会用 Dictionary 绕过限制。
- 自动请求只重试一次；持续丢包时需等待新的 STATE、切换接收开关或重新入房。
- 素材整体变换以该素材最大可见图片层为自动中心；BC 版本若未暴露完整坐标管线字段，极少数姿势或自定义 BodyStyle 可能仍需要真实绘制复测。

## 旧版数据兼容

正常运行时不再自动导入或清理旧 `CustomOutfit` / `CustomComposition` 数据。需要从旧容器恢复方案时，应使用独立的一次性迁移工具；Mirror 启动流程不会为兼容旧数据而修改或同步 `Player.Appearance`。

## 本地与 Mod 兼容

- Remote Edition 与旧 COE/COE-Echo 不能同时启用。
- 视觉代理已针对 LSCG `smartGetAssetGroup` 回退和动态标志写入做防护；拥有同等页面权限的其它 Mod 仍可能改变 BC 绘制链。
- Character/Asset Family 不匹配时按素材缺失局部降级。
- capability/provider/version 分析仅用于诊断，不保证第三方素材的静态图片路径在所有版本一致。
- R130 已移除但旧 Echo 素材仍携带的姿势键（实测为 `LegsOpen`）会被合成视觉图层过滤；源 Asset 不修改，Echo 自身加载期仍可能输出少量同类警告。
- 实测出现过 `Assets/Female3DCG/Pussy/Hard/Pussy1_White.png` 404。它不影响协议与其它 material，但对应 Type 图片变体可能缺失；确认来源素材前不做全局移除 `Type` 的破坏性降级。

## 验收状态

Node 协议、Store、transport 边界和 renderer 隔离测试已覆盖；1.8.0 已确认真实双客户端私人房在 Echo、BCX、LSCG、WCE 同开时可双向看见自定义服装。Appearance/Bundle/status、完整生命周期、缺失素材、1.8.1 页面复测及三客户端仍须按 `multiplayer-test-plan.md` 执行。
