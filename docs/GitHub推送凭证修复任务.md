# GitHub 推送凭证修复任务

## 任务背景

COE-Echo-Mirror 已完成“移除旧 CustomOutfit 容器机制”的源码、测试、构建产物和文档更新，自动化验证全部通过：

```text
npm test       51/51 通过
npm run build  通过
npm run check  通过
```

修改已经提交到本地 Git，但推送到 GitHub 时失败。

## 当前 Git 状态

仓库目录：

```text
D:/agentData/佩拉的书桌/BC-Plugin/COE-Echo-Mirror
```

远程仓库：

```text
origin https://github.com/stareyeXuanyeLin/BC-COE-Echo-Mirror.git
```

本地提交：

```text
e53fe68 refactor: remove legacy CustomOutfit container
```

当前状态：

```text
main...origin/main [ahead 1]
```

工作区已经干净，本地提交等待推送。

## 已确认的失败信息

执行：

```powershell
git push origin main
```

失败：

```text
fatal: unable to access 'https://github.com/stareyeXuanyeLin/BC-COE-Echo-Mirror.git/': schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e) - 安全包中没有可用的凭证
```

这表示当前 Git HTTPS 通道没有可用的 GitHub 身份凭证。问题位于认证环境，不是代码、测试或提交内容。

## 任务目标

修复当前 Windows 环境下 GitHub 的 Git 推送认证，使下列命令能够成功执行：

```powershell
git push origin main
```

推送完成后确认远程 `origin/main` 指向：

```text
e53fe68 refactor: remove legacy CustomOutfit container
```

## 安全要求

1. 不要把 GitHub Personal Access Token、密码或私钥写入仓库文件。
2. 不要把 Token 直接写入远程 URL、Shell 历史或脚本。
3. 优先使用 Windows Git Credential Manager 或 SSH key。
4. 如果使用 HTTPS Token，Token 只应通过 Git Credential Manager 的交互式认证保存。
5. 不要修改仓库源码、测试、构建产物或提交内容来绕过认证问题。
6. 不要执行强制推送：

```powershell
git push --force
```

## 建议排查顺序

### 1. 检查 Git 与 Credential Manager

```powershell
git --version
git config --show-origin --get-all credential.helper
git config --show-origin --get-regexp "credential|http\\."
where.exe git
git credential-manager --version
```

如果 Git Credential Manager 可用，确认 helper 已配置，例如：

```powershell
git config --global credential.helper manager
```

具体 helper 名称应以本机 Git 版本支持情况为准，不要盲目覆盖已有企业环境配置。

### 2. 检查是否存在错误或过期凭证

Windows 凭据管理器中检查与以下目标相关的旧凭证：

```text
git:https://github.com
https://github.com
```

如果明确确认凭证已过期或错误，可以删除对应的 GitHub 凭据，让下一次 `git push` 重新触发登录。

不要删除无关的系统凭据、浏览器凭据或其它项目凭据。

### 3. 重新执行推送

```powershell
cd "D:/agentData/佩拉的书桌/BC-Plugin/COE-Echo-Mirror"
git push origin main
```

如果弹出 GitHub 登录流程，使用具有该仓库写权限的账号完成认证。

### 4. 如果 HTTPS 仍然失败，考虑 SSH

仅在用户已经配置或愿意配置 SSH key 时使用 SSH 方案。

检查：

```powershell
ssh -T git@github.com
git remote -v
```

确认 SSH 认证成功后，可以将远程地址改为 SSH 格式：

```powershell
git remote set-url origin git@github.com:stareyeXuanyeLin/BC-COE-Echo-Mirror.git
git push origin main
```

修改远程 URL 前先确认目标仓库和账号正确。

## 推送后验证

执行：

```powershell
git status --short --branch
git log -2 --oneline --decorate
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
```

完成标准：

```text
工作区干净
HEAD 与 origin/main 相同
origin/main 指向 e53fe68
```

也可以通过 GitHub 仓库页面确认提交已经出现。

## 不需要重新执行的工作

以下内容已经完成，不需要为了凭证问题重复修改：

- 移除旧 `CustomOutfit` 正式容器机制；
- 删除旧容器迁移、识别和入站/出站过滤逻辑；
- 保留 Synthetic Item 的 `__coeMaterialId` Bundle 过滤；
- 保留本地衣柜、Remote Snapshot、远端 Synthetic Rendering 和 LSCG 兼容代理；
- `npm test` 51/51 通过；
- `npm run build` 通过；
- `npm run check` 通过。

## 最终记录模板

```text
认证方式：HTTPS Credential Manager / SSH
GitHub 账号：
推送时间：
远程仓库：https://github.com/stareyeXuanyeLin/BC-COE-Echo-Mirror.git
本地提交：e53fe68
远程提交：
推送结果：成功 / 失败
失败信息：
```
