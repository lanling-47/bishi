# Screen Codex Bridge

一个运行在 Windows 上的局域网屏幕分析工具。手机打开网页并点击“截图并分析”后，电脑才会截取当前主屏幕，调用本机已登录的 Codex CLI 进行视觉推理，再将截图和回答显示到手机网页。

```text
手机点击按钮 -> 网站创建任务 -> Windows worker 领取任务
             -> 截取主屏幕 -> Codex CLI 分析图片
             -> 上传截图和回答 -> 手机页面自动刷新
```

## 特性

- 按需截图，不进行定时或持续截屏
- 使用本机 Codex CLI 登录状态，无需在项目中保存 OpenAI API Key
- 手机网页无需密码，适合受信任的家庭或办公局域网
- worker 上传接口使用独立 `INGEST_TOKEN` 验证
- 截图和回答保存在本机 `website/data/captures/`
- Codex 调用失败时，网页任务会显示失败原因

## 环境要求

- Windows 10/11
- [Node.js](https://nodejs.org/) 18 或更高版本
- PowerShell 7 (`pwsh.exe`)
- 已安装并登录 Codex CLI

确认 Codex CLI 可用：

```powershell
codex --version
codex login
codex login status
```

## 安装

```powershell
git clone git@github.com:lanling-47/bishi.git
cd .\bishi
```

### 1. 配置网站

```powershell
Copy-Item .\website\.env.example .\website\.env
notepad .\website\.env
```

将 `INGEST_TOKEN` 替换为一个足够长的随机值。`HOST=0.0.0.0` 允许同一局域网中的手机访问网站。

启动网站：

```powershell
cd .\website
node .\server.js
```

网站默认监听 `8787` 端口。使用管理员 PowerShell 添加仅限本地子网的防火墙规则：

```powershell
New-NetFirewallRule `
  -DisplayName "Screen Codex Website 8787" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787 `
  -RemoteAddress LocalSubnet -Profile Any
```

查看电脑的局域网 IPv4 地址：

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' }
```

手机与电脑连接同一 Wi-Fi 后，打开 `http://电脑局域网IP:8787`。

### 2. 配置 worker

回到仓库根目录：

```powershell
Copy-Item .\config.example.psd1 .\config.psd1
notepad .\config.psd1
```

至少检查以下配置：

- `CodexCommand`：`codex.exe` 可执行文件名或绝对路径
- `Model`：留空时使用 Codex CLI 当前默认模型
- `Delivery.WebsiteUrl`：本机网站地址，例如 `http://127.0.0.1:8787`
- `Delivery.IngestToken`：必须与 `website/.env` 中的 `INGEST_TOKEN` 完全一致
- `Prompt`：发送给 Codex 的屏幕分析提示词

前台启动 worker：

```powershell
pwsh -NoProfile -File .\screen-codex.ps1
```

隐藏窗口后台启动：

```powershell
$pwsh = (Get-Command pwsh.exe).Source
Start-Process $pwsh -WindowStyle Hidden `
  -ArgumentList '-NoProfile -File "D:\path\to\bishi\screen-codex.ps1"'
```

worker 空闲时只轮询任务，不会截图。手机点击按钮后，网页状态依次变为 `queued`、`processing` 和 `completed`。

### 3. 设置登录后自动启动

必须从 PowerShell 7 执行：

```powershell
pwsh -NoProfile -File .\screen-codex.ps1 -InstallStartup
```

移除启动任务：

```powershell
pwsh -NoProfile -File .\screen-codex.ps1 -UninstallStartup
```

计划任务运行在当前交互式桌面会话中，无法截取 Windows 锁屏或 UAC 安全桌面。

## 目录结构

```text
.
|-- screen-codex.ps1       # 截图、Codex 调用、任务轮询和结果上传
|-- config.example.psd1    # worker 配置模板
|-- website/
|   |-- server.js          # 无第三方依赖的 Node.js 网站/API
|   |-- package.json
|   `-- .env.example       # 网站配置模板
`-- README.md
```

运行时生成且不会提交到 Git：

- `config.psd1`
- `website/.env`
- `website/data/`

## 常见问题

### 手机无法打开网站

确认手机和电脑连接同一局域网，网站正在监听 `0.0.0.0:8787`，并检查防火墙规则的 `RemoteAddress` 是否为 `LocalSubnet`。

### 页面一直显示“请求已排队”

说明网站没有检测到 worker。确认 `screen-codex.ps1` 正在运行，并检查 `Delivery.WebsiteUrl` 和两侧的 `INGEST_TOKEN` 是否一致。

### Codex 无法推理

先在启动 worker 的同一 Windows 账户中运行：

```powershell
codex exec --ephemeral --skip-git-repo-check --sandbox read-only "回复 CODEX_OK"
```

如果该命令失败，重新执行 `codex login`。模型留空时使用 CLI 默认模型，也可以在 `config.psd1` 的 `Model` 中指定模型。

## 安全说明

手机页面按需求不设置密码，因此不要把 `8787` 端口直接暴露到公网。只应在受信任局域网中使用；远程访问时应放在带 HTTPS 和身份验证的反向代理或 VPN 后面。

截图可能包含敏感信息，并会发送到 Codex 服务进行分析。请勿用于不允许上传的屏幕内容。截图保留在 `website/data/captures/`，可以通过网页删除。
