# omp-astudio-connect

把 **AStudio（讯飞 AstronClaw）桌面版的账号**接入 [omp](https://omp.sh/)，**零配置** —— 插件直接复用桌面应用自身的登录态，你无需在 omp 里再登录一次，也不需要 API Key。

可用的模型以 `astudio/<id>` 形式出现在 omp 的 `/model` 选择器中，例如 `astudio/Auto`（`astronclaw-auto`）、`astudio/GLM-5.2`（`xopglm52`）、`astudio/Kimi-K2.6`（`xopkimik26`）、`astudio/DeepSeek-V4-Pro`（`xopdeepseekv4pro`）等；**模型列表来自账号本身**，不是硬编码。

> ⚠️ 仅供个人研究/学习用途 —— 驱动的是**你自己的** AStudio 账号，仅在本机运行。与科大讯飞 / iFLYTEK / AstronClaw 无任何关联；请遵守相应服务条款。

## 工作原理

AStudio 桌面端由 Electron 外壳、随附的本地 server（`apps/server/dist/index.mjs`）和一个 `acode` 内核（[OpenAI Codex](https://github.com/openai/codex) 的定制分支）组成。**模型流量不经过本地 server**：内核直接打讯飞的网关，凭证是登录后从账号接口**换取**的。本扩展做的是同一件事：

1. **读登录态** —— `{AStudio 数据目录}/userdata/astron-session.json`。数据目录由安装器写在注册表 `HKCU\Software\AStudioStorage` 的 `<Profile>DataRoot`（本机为 `D:\App\AStudio Data`），未写注册表时回退到安装目录旁的 `AStudio Data`。文件**只读**，不复制、不改写。
2. **换取模型凭证** —— `GET {studio}/xingchen-studio/bot/models/configs`，带上账号 Cookie（`ssoSessionId…`）。响应里每个模型都带**自己的** `base_url`、`api_key`（推理令牌）与 `point_multiplier`（点数倍率）。这与桌面端每次启动所做的完全一致，因此**令牌不落盘**：只驻留内存，进程退出即消失。
3. **Loopback shim** —— 加载时在 `127.0.0.1:<随机端口>` 起一个 OpenAI 兼容面：`POST /v1/chat/completions`（透明转发 + 按模型选网关 + 注入令牌）、`GET /v1/models`、`GET /v1/status`。请求体只改 `model` 一处（解析别名用），SSE 帧逐块回传。
4. **Provider 注册** —— 通过 `pi.registerProvider("astudio", { api: "openai-completions" })` 把 loopback 面接入 omp；令牌归 shim 管理，因此 provider 以占位密钥注册，omp 永远看不到真正计费的那个令牌。
5. **失效自愈** —— 上游返回 401/403 时 shim 自动重新换取一次令牌并重放该请求（桌面端登出或轮换令牌后不会卡死）。
6. **强制刷新** —— `/astudio-refresh` 重新换取凭据、调 `ctx.modelRegistry.refreshProvider(...)`（默认 `online` 策略，绕过 omp 对动态模型列表的 24 小时缓存），并顺带报告套餐与剩余积分。

扩展进程内运行、**不沙箱化**，且只接受 loopback 来源的请求（拒绝非 loopback 的 `Host` 头，防止 DNS rebinding 攻击）。

### 桌面端自己是怎么走的（决定了插件为什么绕开本地 server）

打开应用时，Electron 外壳会用随机端口和随机令牌拉起随附的本地 server，而那个 server **不提供任何 LLM HTTP 面**：它是个认证/账户经纪（`/api/auth/*`、`/api/astron-auth/*`）加一个 MCP 工具面（`/mcp`，暴露 `astron_capabilities`、`astron_create_threads` 等），真正的推理由它拉起的 `acode` 内核完成 —— 内核是 OpenAI Codex 的定制分支（Rust crate 名 `codex_protocol` / `codex_http_client` 可在运行日志里看到），按 Codex 的 wire 协议直连讯飞网关，凭证就是桌面端每次启动写进 `acode-home-overlay/config.toml` 的 `[model_providers.astron-spark] experimental_bearer_token`（与该 token 同源的字段在会话文件里叫 `modelBearerToken`）。

所以「反代桌面端」有两条路：复刻内核那套 Codex/Responses 面，或直接走账号令牌能访问的 **OpenAI 兼容面**。本插件选后者 —— 同一把令牌、同一个 MaaS 网关，但协议是通用的，omp 不需要任何特殊适配；也不再依赖本地 server（它随应用启动、端口随机、令牌随机，进程退出即失效）。

### 实测到的上游行为（逆向结论）

以下每一条都在一个生产账号上实测过，写在这里是因为它们决定了插件的行为：

| 观察 | 实测结果 | 插件的应对 |
| --- | --- | --- |
| 推理协议 | `POST {base_url}/chat/completions`，OpenAI chat-completions；`/v2/chat/completions` 与 `/v1/chat/completions` 都能通 | 直接透明转发，不做协议翻译 |
| 鉴权 | `Authorization: Bearer <api_key>`；伪造密钥返回 `401 {"message":"HMAC signature cannot be verified: apikey not found"}` | shim 注入令牌，401/403 时重取一次 |
| 模型 id | **必须**是 wire id（`xopglm52`）。传显示名（`GLM-5.2`）、内部 id（`lm_glm52`）或大小写变化都返回 `400 {"code":10404,"message":"no category route found"}` | 按 `slug`/`name`/`id` 三套名字匹配，再把请求改成 wire id |
| 思考开关 | 是 Qwen 风格的 `enable_thinking`（`true`/`false`），**不是** `reasoning_effort`：GLM-5.2 / DeepSeek-V4-Pro / Kimi-K2.6 / MiniMax-M2.5 只收到 `reasoning_effort` 时完全不产出 `reasoning_content`，加上 `enable_thinking` 才开始返回推理 | `compat.thinkingFormat = "qwen"`，由 omp 下发该字段；推理从 `reasoning_content` 读回 |
| 字段宽容度 | 未知字段一律忽略：`reasoning_effort` 的 `minimal`…`max`、`thinking`、`chat_template_kwargs`、`max_completion_tokens`、`developer` 角色、`response_format`、`tool_choice`、`parallel_tool_calls`、`cache_control`、`user`/`seed`/`logprobs` 全部返回 200 | 不做字段裁剪 |
| `max_tokens` 上限 | 后端会拒绝超限值并**在报错里给出准确上限**：`astronclaw-auto` / `xopdeepseekv4pro` ≤ 393216；GLM / MiniMax / Kimi / Qwen ≤ 131072；`spark-x` / `xsparkx2agent` 未设限 | 按实测值上报 `maxTokens`（如实上报比少报更安全：omp 会原样发送该值） |
| 图片输入 | 只验证了默认模型：1×1 的 data URL 被拒是**分辨率**校验（`image resolution 1x1 limit [50x50-6000x6000]`），说明图片链路可用 | 仅对 `astronclaw-auto` 声明图片输入 |
| 模型名册 | `bot/models/configs`（9 个，含 `base_url`/`api_key`）与网关 `GET /v2/models`（8 个）、桌面端本地目录（6 个）**三份列表并不一致**；`spark-x2.5`、`spark-x2.6-preview` 等只出现在后两者 | 名册以 `bot/models/configs` 为准；名册外的已知 id 仍按其家族网关路由（见下） |
| 计费 | 按**点数**（`points/balance` 返回 `totalAmount`/`totalBalance`，本机实测 1200 / 1194）与每个模型的 `point_multiplier`（`x0.5`…`x2.0`）计，不按美元 | `cost` 全 0；积分在 `/astudio-refresh` 与 `/v1/status` 里报告 |

### 名册外模型

账号名册（`bot/models/configs`）比网关实际服务的范围**窄**：桌面端自带的模型目录里还有 `spark-x2.5`、`spark-x2.6-preview` 等，它们在 MaaS 上用同一把令牌可以正常调用（已实测）。因此请求名册外的已知 id 时，shim 不返回 404，而是按 `src/catalog.ts` 里该模型的家族（`maas` / `iflytek`）选网关，让上游自己给出结论——这比插件替上游拒绝更好。

## 模型与上限

`maxTokens` 是**实测**的后端上限（见上表）；`contextWindow` 一律按 **200k 保守上报**——没有任何端点公布上下文窗口，少报只会让 omp 更早压缩，多报会让请求直接被网关拒掉。

模型列表与名字以账号返回的为准（上例来自一个已登录账号）：

| wire id | 显示名 | 后端 | 输出上限 |
| --- | --- | --- | --- |
| `astronclaw-auto` | Auto | maas | 393216 |
| `xsparkx2agent` | Spark-X2-Agent | maas | 未设限 |
| `spark-x` | Spark-X2-Flash | iflytek（`spark-api-open`） | 未设限 |
| `xopglm52` / `xopglm51` | GLM-5.2 / GLM-5.1 | maas | 131072 |
| `xminimaxm25` | MiniMax-M2.5 | maas | 131072 |
| `xopkimik26` | Kimi-K2.6 | maas | 131072 |
| `xopqwen36v35b` | Qwen3.6-35B-A3B | maas | 131072 |
| `xopdeepseekv4pro` | DeepSeek-V4-Pro | maas | 393216 |

**思考等级**：omp 侧提供 `minimal`…`max` 六档（网关对每一档都返回 200，实测），实际只有"开/关"对后端有区别，与桌面端自身只有"关闭思考/开启思考"两个选项一致；默认档位取 **high**（与桌面端 `defaultReasoningEffort` 相同）。

## 环境变量（可选）

| 变量 | 作用 |
| --- | --- |
| `ASTUDIO_DATA_ROOT` | 直接指定 AStudio 数据目录，跳过注册表探测 |
| `ASTUDIO_SSO_SESSION_ID` | 直接给出账号 SSO 会话 id，完全跳过桌面应用（容器/非默认安装路径） |
| `ASTUDIO_ACCOUNT_TOKEN` | 配合上一项使用；账户接口（积分/套餐）需要 |
| `ASTUDIO_STUDIO_ORIGIN` | 覆盖工作室 API origin（默认 `https://agent.xfyun.cn`，dev/test 环境可改） |

## 安装

### 方式 A：从 marketplace 安装（推荐）

```bash
omp plugin marketplace add Anymore0010/omp-plugins
omp plugin install omp-astudio-connect@omp-plugins
```

### 方式 B：本地开发

```bash
cd /path/to/omp-plugins/omp-astudio-connect
omp plugin link .          # 或 omp -e ./src/index.ts 临时加载
```

确认已加载：

```bash
omp plugin list
omp models | grep astudio        # 选择器里应出现 astudio/*
omp --model astudio/xopglm52 -p --no-session "只回答：OK"
```

> Windows 上若 `omp plugin link` 因符号链接权限（EPERM）失败，可改用 `~/.omp/agent/config.yml`
> 的 `extensions:` 绝对路径挂载（见仓库根 `README.md`）。

## 排查

```bash
# 会话内：重新换取凭据 + 强刷模型列表（会打印套餐与剩余积分）
/astudio-refresh

# shim 状态（端口见 omp 启动日志）
curl -s http://127.0.0.1:<port>/v1/status
```

未登录 / 读不到登录态 / 凭据交换失败会分别给出不同的提示，不会清空已有模型列表：

- `signed-out` —— 桌面端没有登录态：先登录 AStudio，或设置 `ASTUDIO_SSO_SESSION_ID`。
- `unreadable` —— 找到了会话文件但读不出（路径猜测失败或文件损坏）：用 `ASTUDIO_DATA_ROOT` 指路。
- `unreachable` —— 有登录态但工作室 API 拒绝：通常是登录过期，回桌面端重新登录。

## 开发

本包为纯 TypeScript，无运行时依赖（仅用 Node 内置模块）；`@oh-my-pi/pi-coding-agent` 仅作 dev 依赖提供类型。

```bash
npm install
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json   # 类型检查
```

omp 加载的入口是 `src/index.ts`。其余模块：

- `src/auth.ts` — 定位数据目录（环境变量 → 注册表 → 安装目录旁）并解析 `astron-session.json`
- `src/upstream.ts` — 工作室 API 客户端：模型名册（换取令牌）、积分、套餐；含信封/错误归一化
- `src/store.ts` — 换取结果的进程内缓存 + 失效重取（互斥、失败可重试）+ 状态描述
- `src/server.ts` — loopback OpenAI 面：路由、请求头治理、按模型选网关、流式转发、401 重取重放
- `src/catalog.ts` — 静态兜底目录（仅上游不可达时用于展示；含实测的输出上限）

## 关于对话记录

通过本插件发出的对话**会像桌面端一样被服务端记录**，这**不是插件行为**，无法从插件侧关闭：

- 插件唯一的落盘是**无** —— 换取得到的推理令牌只驻留内存；账号会话来自桌面端文件，插件不复制、不改写。
- 记录发生在**服务端，按账号归档**。插件以你的桌面端身份发起请求，因此落在同一个云端会话/用量历史里。
- 结论：这是**上游账号属性**，不是可配置项。介意记录的话，唯一可控手段是**改用不共享该账号的渠道**。

## 免责声明

- 本项目**仅供个人学习与研究使用**。它驱动的是**你自己**机器上**你自己的** AStudio 账号，不适用于任何商业用途或超出个人合理使用范围的情形。
- 它依赖的是 AStudio **客户端端点**（并非官方公开 API），包括 `agent.xfyun.cn` 的工作室接口与 MaaS 网关的 OpenAI 兼容面。上游随时可能更改协议，届时本插件可能需要跟进适配。通过第三方客户端使用你的账号，须遵守相应服务条款；由此产生的一切后果（包括但不限于账号限制、点数扣除、服务中断）由你自行承担。
- 本项目与 科大讯飞（iFlytek）、AStudio、AstronClaw **无关联、未经授权、亦未获其背书**。产品名称仅用于描述兼容性；其商标归各自所有者所有。
- 作者对因使用或误用本项目造成的任何直接或间接损失不承担任何责任。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
