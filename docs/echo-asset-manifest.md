# Echo Asset Manifest

## 证据边界

- 目标参考版本：Echo 1.129.4。
- 本地源码快照没有 Git 元数据，也没有 `1.129.4` 版本字符串。
- `package.json` 仅证明 `bc-stubs 129.0.0-Beta.1`、`@sugarch/bc-asset-manager ^1.4.0`；锁文件解析到 AssetManager 1.4.0。
- 因此本文件是候选清单，不冒充实际 1.129.4 运行时最终清单。

## A 类候选（当前 unverified）

| tuple | 源码结论 | 运行时签名 | 诊断状态 | 选择器状态 |
|---|---|---|---|---|
| `Shoes/鱼嘴高跟鞋` | 6 个静态图片层，无 Extended/Hook | 待从实际 1.129.4 导出 | unverified | 可选择静态层 |
| `Bra/女仆胸罩` | 2 个静态图片层，有 ParentGroup/PoseMapping，无 Hook | 待导出 | unverified | 可选择静态层 |

第三个 A 类签名候选仍必须从实际运行时扫描筛选，不能用花园连衣裙（ArmMask 生成器）、洞洞鞋（非图片 Alpha）或玛丽珍皮鞋（BeforeDraw）冒充“完整安全”；但这些诊断结论不会阻止其普通 `HasImage` 层进入静态选择器。

## B 类研究

- `Shoes/洞洞鞋`：Typed 静态图片选择，同时含 `HasImage:false` Alpha mask；COE 只提取普通图片层，不复制该 Alpha 功能层。
- `Shoes/玛丽珍皮鞋`：Modular TypeRecord 且有 BeforeDraw；COE 可保留受限 Type/TypeRecord 图片变体，但不会执行 BeforeDraw。

## 诊断不兼容（不作为选择门禁）

动态/Canvas/WebGL、替换身体、额外身高、家具/坐具/床/监狱/玻璃罐/马车、配对关系资产，以及版本/授权/签名未知的 Echo Asset，仍会在 `analyzeAsset()` 中报告 unsupported/unverified/limited。只要存在普通 `HasImage && !LockLayer` 层，选择器仍允许静态投影；被诊断的功能不会复制。

代表证据：

- 监控机器人：PersistentData + Canvas + GLImageRenderer + 动态 Hook；只可能提取其普通图片层。
- 幽灵：身体组替换 + partialDraw 完整角色重绘；不会复制完整角色重绘。
- 交领右衽：动态延长层；不会复制动态延长行为。

## 签名采集要求

实际 Echo 1.129.4 中调用：

```js
CustomOutfitEditor.analyzeAsset(group, asset)
```

记录返回的 `signature`、版本、授权和最终 Layer 结构；完成姿势、颜色、偏移、透明度、同 Asset 冲突、Echo 开关和私人房回归后，才允许把签名填入 `ECHO_MANIFEST`。签名变化自动回到 `unverified`。
