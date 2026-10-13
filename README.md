# Codex Speed HUD · Codex 本机速率码表

在 Codex 桌面聊天界面查看**首流延迟、实时 tok 速率、本次对话平均速率、累计 tok 和估算费用**。面板可以拖动、收起和隐藏，右上角工具栏的紫色码表按钮可随时重新打开。

[快速中文说明](docs/README.zh-CN.md) · [指标与架构详解](docs/architecture.md) · [原生采集补丁](docs/native-observer.md) · [本机隐私说明](PRIVACY.md) · [English](docs/README.en.md)

这是独立社区项目。工具栏按钮通过本机 Electron 调试接口加入界面，并非 OpenAI 官方插件扩展入口。

## 功能

- **首流延迟**：测量模型开始响应所需的时间，不等待正文出现第一个字。
- **速率码表**：显示最近输出的 tok/s；输出结束后保留最后一次有效快照。
- **本次平均**：只统计当前用户消息对应的整轮回复，包含中间的多次模型调用；下一条消息重新统计，避免混入历史 Fast 模式。
- **累计用量与费用**：显示当前聊天历史的总输入＋总输出，例如 `27.25M/12.34$`，缓存输入和推理输出不重复相加。
- **模型记录卡片**：只读显示上一次已结束输出的模型、推理强度、Fast／标准模式，不随当前输入框的选择实时变化。
- **工具调用与上下文压缩**：可选原生补丁采集模型生成工具参数的速率，以及压缩的首流和完成后吞吐，复用现有字段。
- **聊天隔离**：按主机、聊天和用户轮次分别统计，新聊天第一轮即可开始测速，不混入后台聊天。

## 支持范围与环境要求

目前已验证 **Linux** 下使用 `/usr/share/applications/chatgpt.desktop` 的 ChatGPT／Codex 桌面发行版。其他安装路径可能需要适配。macOS 和 Windows 尚未验证，也没有自动配置持久启动入口。

需要：

- **Node.js 22.15 或更高版本**。
- 支持 `plugin marketplace`、`plugin add` 命令的 Codex CLI。
- 支持本机 Electron 调试端口的桌面 App。

可选原生补丁目前**只支持 `codex-cli 0.162.0-alpha.17.2`**。普通 HUD 安装不会自动构建或启用该补丁。

## 安装

### 使用发布包

从 [Releases 下载页](https://github.com/Creative-developer-single/codex-speed-hud/releases)下载 `codex-speed-hud-版本号.zip`，解压后进入 `codex-speed-hud/` 目录，运行：

```bash
node scripts/install.mjs
```

安装包已经包含构建后的运行依赖，无需另外运行 `npm install`。文件完整性可以对照下载页的 `SHA256SUMS` 检查。

### 从源码安装

```bash
git clone https://github.com/Creative-developer-single/codex-speed-hud.git
cd codex-speed-hud
npm ci --no-audit --no-fund
npm run build
node scripts/install.mjs
```

安装器会注册本地插件，配置**当前用户的应用菜单启动入口**，并启动检测器。它不修改系统 App 安装文件，也不会强制退出 App 或中断聊天。

如果正在运行的 App 尚未开启调试端口，需要你正常退出后，再通过配置好的原应用图标打开一次。以后正常启动就会自动开启本机调试端口和检测器，无需每次输入调试命令。

## 日常使用

- **打开／隐藏面板**：点击右上角工具栏、「新标签＋」旁边的紫色码表按钮。
- **移动面板**：拖动面板顶部。工具栏按钮不会随面板移动。
- **收起内容**：点击面板上的「−」。
- **隐藏面板**：点击「×」。工具栏按钮保留，隐藏期间仍继续采集。

需要排查时，可以在插件目录运行：

```bash
# 查看检测器状态
node scripts/control.mjs status

# 停止检测器并移除界面
node scripts/control.mjs stop

# 启动检测器
node scripts/control.mjs start
```

## 指标怎么算

| 字段 | 仅安装 HUD | 启用原生采集补丁后 |
| --- | --- | --- |
| **首流** | 从回合开始到第一次观察到模型流通知；缺少完整事件时可使用已有原生计时记录补齐 | 从原生模型请求开始到第一条解码响应事件，包含 `response.created` |
| **速率** | 最近约两秒可见正文的 token 增长率，本机估算 | 还可估算流式工具参数；压缩没有明文增量时，完成后显示输出 tok ÷ 请求总耗时 |
| **本次平均** | 本轮已观察到的正文 tok ÷ 正文流式输出时间 | 同一用户轮次所有已完成调用的总输出 tok ÷ 总请求耗时，包含等待、推理、工具参数和压缩 |
| **累计** | 当前聊天历史总输入＋总输出，以及估算费用 | 相同口径，采用原生用量记录 |

模型生成的工具参数和工具执行后产生的程序输出是两种数据；程序的标准输出、错误输出不计入模型生成速率。

压缩速率是**完成后计算的整次调用平均吞吐**，包含等待时间。压缩内容不可见时，无法据此得到每一瞬间的模型生成速率，也不会给加密内容分词。手动压缩有独立轮次，不会混入你随后发送的新消息的平均值。

首流和速率在输出结束后保留最后一次有效快照，直到出现新的有效测量。本机分词估算可能与服务端计数不同；累计用量采用 Codex 记录的用量，不靠重新分词推算历史。

### 费用说明

费用按公开 API 价格估算，**不代表订阅账号的实际账单**。价格每天从公开文档刷新；无法确认价格的模型显示未知费用，不误报为零。

GPT-6.1 Sol 的长上下文阈值默认设为 **500,000 个输入 tok**。这是本项目要求保留的覆盖配置，并非对官方当前计费阈值的确认。可通过 `CODEX_SPEED_HUD_SOL_CONTEXT_THRESHOLD` 按所使用的价格表调整，配置后重启检测器生效。

## 工具调用与压缩采集

仅安装 HUD、连上调试端口，并不代表原生采集已经启用。默认 App 通知没有工具参数的逐块增量，完整功能需要另外构建并启用**与安装版本完全匹配**的原生客户端观察补丁。

补丁在原客户端解码响应之后采集选定字段，通过后台线程发布本机数字快照。当前支持的版本、构建步骤、启用与关闭方式见[原生补丁说明](docs/native-observer.md)。构建需要 Rust、Python 及官方源码的构建依赖，也需要较多磁盘空间和时间；发布包不携带原生客户端二进制。

## 本机隐私与连接方式

插件不使用模型流量转发代理，不改写后端地址、鉴权、请求头或正文、TLS、连接池、重试逻辑，也不强制切换 HTTP／WebSocket。原生补丁不启用隐藏的 `runtime_metrics`，也不添加 `x-responsesapi-include-timing-metrics` 请求头。

正文和工具参数会短暂进入本机进程内存用于估算，写出的状态包含标识、时间、数字和枚举，不保存正文或参数文本。数字状态文件并不意味着采集进程从未接触内容。读取哪些文件、写入哪些信息，见[本机隐私说明](PRIVACY.md)。

调试端口只能绑定 **127.0.0.1**，请勿转发或暴露到外网。能访问该端口的本机进程可以检查或控制 App。

App 升级可能导致界面适配或原生补丁失效。启动器每次校验原版和补丁版二进制的哈希，文件变化后自动回退原客户端。保留已审查的连接源码逻辑，不意味着重建后的二进制、连接时序逐字节相同，也不构成对账号状态的保证。

## 开发、测试与打包

```bash
npm ci --no-audit --no-fund
npm test
npm run build
npm run check:release
npm run package
```

打包产物位于 `release/`，包含运行包、源码包和 SHA-256 校验和。打包检查采用公开文件清单，排除本机状态、凭据、会话数据和构建缓存。

查看不连接模型的合成演示：

```bash
node scripts/preview.mjs
```

浏览器打开 `http://127.0.0.1:4198/`。演示中的聊天与流数据均为合成数据。

GitHub Actions 在 Node 22.15 和 24 上运行构建、测试及打包检查；推送版本标签后自动生成发布包。耗时的原生客户端构建需要主动执行，不在常规 JavaScript CI 中运行。

[参与开发](CONTRIBUTING.md) · [更新记录](CHANGELOG.md)

## 卸载

```bash
node scripts/control.mjs stop
node scripts/desktop.mjs remove
codex plugin remove codex-speed-hud@agent-cost-monitor-local
```

如果启用了原生观察补丁，先将本机 `native-client/enabled.json` 的 `enabled` 改为 `false`，下次正常打开 App 时恢复原客户端。需要删除插件运行目录时，先保留你还需要的本机文件。

## 开源许可证

项目原创 HUD 和观察器代码使用 [MIT 许可证](LICENSE)。修改过的官方 Codex 源码片段保留 [Apache-2.0 许可证](licenses/codex-LICENSE)及其 [NOTICE](licenses/codex-NOTICE)。打包的分词依赖保留各自声明，详见[第三方许可证说明](THIRD_PARTY_NOTICES.md)。
