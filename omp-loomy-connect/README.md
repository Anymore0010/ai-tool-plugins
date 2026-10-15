# omp-loomy-connect

把 **Loomy 桌面版的账号**接入 [omp](https://omp.sh/)，**零配置** —— 插件直接复用桌面应用自身的登录态，你无需在 omp 里再登录一次，也不需要 API Key。

可用的模型以 `loomy/<id>` 形式出现在 omp 的 `/model` 选择器中，例如 `loomy/DeepSeek-V4.1-Flash`、`loomy/GLM-5.3-Flash`、`loomy/spark-x`、`loomy/mimo-v2.5`、`loomy/qwen-3.8-max`；**模型列表来自账号本身**，不是硬编码。

> ⚠️ 仅供个人研究/学习用途 —— 驱动的是**你自己的** Loomy 账号，仅在本机运行。与讯飞 / xfinfr / Loomy 无任何关联；请遵守相应服务条款。

## 工作原理

Loomy 没有推理 API Key：它登录讯飞账号后把 **账号 session 令牌**存进一个普通的 `electron-store` 文件，而这个令牌**本身就是**每次模型请求带的凭据（没有换取步骤）。本扩展只做三件事：

1. **读登录态** —— `{Loomy 配置根}/userData/auth-session.json` 里的 `session`（32 位十六进制）。文件**只读**，不复制、不改写。

   > 配置根不是常见的 Electron 目录：**Windows 上是 `C:\Users\Public\Loomy\<sha256(用户名) 前 12 位>\`**（`%APPDATA%\Loomy` 只放 Chromium 缓存）。可用 `LOOMY_CONFIG_ROOT` 覆盖。

2. **Loopback shim** —— 加载时在 `127.0.0.1:<随机端口>` 起一个 OpenAI 兼容面：`POST /v1/chat/completions`（透明转发）、`GET /v1/models`、`GET /v1/status`。请求体原样转发，SSE 帧逐块回传。

3. **Provider 注册** —— 通过 `pi.registerProvider("loomy", { api: "openai-completions" })` 把 loopback 面接入 omp。令牌归 shim 管理，因此 provider 以占位密钥注册。

### 实测到的上游行为（逆向结论）

以下每一条都在一个已登录账号上实测过，写在这里是因为它们决定了插件的行为：

| 观察 | 实测结果 | 插件的应对 |
| --- | --- | --- |
| 推理协议 | `POST {base}/chat/completions`，OpenAI chat-completions；SSE `chat.completion.chunk`、工具调用、`reasoning_content` 均为标准形态 | 直接透明转发，不做协议翻译 |
| 鉴权 | 账号 session 同时以 `token` 与 `Authorization: Bearer` **两个头**发出（不同接口读不同的那个） | shim 两个都发，并丢掉调用方传的凭据 |
| `traceparent` | **缺失时 `chat/completions` 会挂死到超时**（桌面端源码里就写着这条实测） | shim 每个请求新铸一个 W3C traceparent |
| 基址 | 生产 `https://loomyad.xunfei.cn/api/v1`；集成环境模板 `https://ossptest.voicecloud.cn/loomy/integration/api/v1` | 优先读桌面端**实际部署**的 `opencode.json` 里的 `baseURL`，其次生产默认值；`LOOMY_API_BASE` 可覆盖 |
| 模型名册 | `GET {base}/models` 由**服务端控制**，比 OpenAI 的格式丰富：`protocol`、`context_length`、`max_output_tokens`、`reasoning_efforts`、`default_reasoning_effort`、`capabilities{reasoning,vision,function_calling,streaming,input_modalities}` | 全部如实映射到 omp 的模型配置（上下文/输出上限、推理档位、图片输入） |
| 模型类型 | `type` 有 `chat` 与 `image` 两种；生图模型（`Hy-Image-3.5-preview`、`doubao-seedream-5-lite`、`qwen-image-3.0-pro`）不是对话模型 | 只把 `type === "chat"` 的模型注册给 omp |
| 点数倍率 | **印在显示名里**：`DeepSeek V4.1 Flash(x2.0)`、`qwen 3.8 flash（x0.8）`（全角/半角括号都有）；`x0.0` 表示限时免费 | 解析出来显示在模型名后面（omp 的 cost 是美元概念，装不下点数） |
| 计费 | 按**点数**，响应的 `usage.points_consumed` 给出每次请求实际消耗 | `/loomy-refresh` 与 `/v1/status` 报告剩余点数 |
| 剩余点数 | 个人账号**没有**独立的余额接口：`/api/v1/team-points/balance` 会回 `当前未切换到团队`；`GET /api/v1/points/records?pageNo=1&pageSize=1&recordType=all` 的 `data.availableBalance` 才是可用总额 | 用后者，且点数服务基址取推理同源（`points-config.json` 里存的可能是**另一个环境**、会拒绝当前登录态） |
| 思考开关 | `enable_thinking`（Qwen 风格）与 `reasoning_effort` 都接受；名册为每个模型声明了 `reasoning_efforts`（`none`…`xhigh`）与默认档 | `compat.thinkingFormat = "qwen"` 同时下发两者；推理从 `reasoning_content` 读回 |

### 名册即配置

`context_length` / `max_output_tokens` / `reasoning_efforts` 全部来自 `/models`，所以无需维护任何静态表：账号换套餐、服务端加模型，重启 omp 后 `/loomy-refresh` 即可看到。`src/catalog.ts` 里的静态表只在**读不到账号**时用于把选择器填上（否则会是空的），它不会覆盖实时名册。

## 环境变量（可选）

| 变量 | 作用 |
| --- | --- |
| `LOOMY_CONFIG_ROOT` | 直接指定 Loomy 配置根（跳过按用户名算出的路径） |
| `LOOMY_SESSION` | 直接给出账号 session，完全跳过桌面应用 |
| `LOOMY_API_BASE` | 覆盖推理基址（默认取桌面端部署配置，其次生产） |
| `LOOMY_POINTS_BASE` | 覆盖点数服务基址（默认取推理同源） |

## 安装

### 方式 A：从 marketplace 安装（推荐）

```bash
omp plugin marketplace add Anymore0010/omp-plugins
omp plugin install omp-loomy-connect@omp-plugins
```

### 方式 B：本地开发

```bash
cd /path/to/omp-plugins/omp-loomy-connect
omp plugin link .          # 或 omp -e ./src/index.ts 临时加载
```

确认已加载：

```bash
omp plugin list
omp --model loomy/spark-x -p --no-session "只回答：OK"
```

> Windows 上若 `omp plugin link` 因符号链接权限（EPERM）失败，可改用 `~/.omp/agent/config.yml`
> 的 `extensions:` 绝对路径挂载（见仓库根 `README.md`）。

## 排查

```bash
# 会话内：重新读取登录态与模型列表，并强刷（会打印剩余点数与基址）
/loomy-refresh

# shim 状态（端口见 omp 启动日志）
curl -s http://127.0.0.1:<port>/v1/status
```

- `signed-out` —— 桌面端没有登录态：先在 Loomy 桌面端登录，或设置 `LOOMY_SESSION`。
- `unreadable` —— 找到了文件但读不出（路径猜测失败或文件损坏）：用 `LOOMY_CONFIG_ROOT` 指路。**换过 Windows 用户名**的机器会命中这一条，因为Loomy 用的是改名前的用户名哈希。

## 开发

本包为纯 TypeScript，无运行时依赖（仅用 Node 内置模块）；`@oh-my-pi/pi-coding-agent` 仅作 dev 依赖提供类型。

```bash
npm install
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json   # 类型检查
```

omp 加载的入口是 `src/index.ts`。其余模块：

- `src/auth.ts` — 定位 Loomy 配置根（环境变量 → 按用户名哈希）并解析 `auth-session.json`
- `src/config.ts` — 从桌面端**实际部署**的配置里取推理基址与点数服务基址
- `src/upstream.ts` — 平台客户端：模型名册、点数；含凭据头、traceparent 与错误归一化
- `src/store.ts` — 名册的进程内缓存 + 失效重取 + 状态描述
- `src/server.ts` — loopback OpenAI 面：路由、请求头治理、流式转发
- `src/catalog.ts` — 静态兜底目录（仅账号不可读时用于展示）

## 关于对话记录

通过本插件发出的对话**会像桌面端一样被服务端记录**，这**不是插件行为**，无法从插件侧关闭：

- 插件唯一的落盘是**无** —— 账号 session 来自桌面端文件，插件不复制、不改写。
- 记录发生在**服务端，按账号归档**，因此落在同一个云端会话/用量历史里。
- 结论：这是**上游账号属性**，不是可配置项。

## 免责声明

- 本项目**仅供个人学习与研究使用**。它驱动的是**你自己**机器上**你自己的** Loomy 账号，不适用于任何商业用途或超出个人合理使用范围的情形。
- 它依赖的是 Loomy **客户端端点**（并非官方公开 API）。上游随时可能更改协议，届时本插件可能需要跟进适配。通过第三方客户端使用你的账号，须遵守相应服务条款；由此产生的一切后果（包括但不限于账号限制、点数扣除、服务中断）由你自行承担。
- 本项目与 讯飞 / xfinfr / Loomy **无关联、未经授权、亦未获其背书**。产品名称仅用于描述兼容性；其商标归各自所有者所有。
- 作者对因使用或误用本项目造成的任何直接或间接损失不承担任何责任。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
