# omp-wingwork-connect

把 **iKooky（WingWork）桌面版的账号**接入 [omp](https://omp.sh/)，**零配置** —— 插件直接复用桌面应用自身的登录态，你无需在 omp 里再登录一次，也不需要 API Key。

可用的模型以 `wingwork/<id>` 形式出现在 omp 的 `/model` 选择器中，例如 `wingwork/ds-v4.1-flash`（DeepSeek V4.1 Flash）、`wingwork/snt-5.5`（Claude Sonnet 5.5）、`wingwork/os-5.5`（Claude Opus 5.5）、`wingwork/gk-4.6`（Grok 4.6）、`wingwork/km-k3`（Kimi K3）等。

> ⚠️ 仅供个人研究/学习用途 —— 驱动的是**你自己的** iKooky 账号，仅在本机运行。与科大讯飞 / iFlytek / Kooky / WingWork 无任何关联；请遵守相应服务条款。

## 工作原理

iKooky 桌面端把模型请求发往 One 平台网关上的一个 **Anthropic Messages 兼容面**，并用一个 `sk-…` 令牌鉴权：

- **推理端点**：`{ANTHROPIC_BASE_URL}/v1/messages`，其中 `ANTHROPIC_BASE_URL` 形如
  `https://one.iflytek.com/api/llm/console/chat`。桌面端会把它连同令牌一起写进随附 Claude Code 的
  `settings.json`，也就是说这条路径**原生就是 Anthropic 协议**（含 thinking、工具调用 `strict`、
  prompt cache 断点、SSE 流式）。
- **令牌来源**：该 `sk-…` 令牌**不落盘**。桌面端每次启动时用渲染进程里的账号 JWT
  （`localStorage.super-assistant-userInfo.access_token`）去
  `GET /kooky-api/api/client/v3/cli/config` **换取**它，以及当前账号的可用模型列表。

因此本扩展做的是同样的事，而不是「转换协议」：

1. **Loopback shim** —— 加载时在本机启动一个绑定 `127.0.0.1:<随机端口>` 的 HTTP 服务，
   暴露 `POST /v1/messages`（透明转发）、`GET /v1/models`、`GET /v1/status`。
2. **凭据复用** —— 从 Chromium 的 LevelDB `Local Storage` 里读出桌面端写入的账号 JWT
   （Windows：`%APPDATA%\Kooky\Local Storage\leveldb`），再用它向网关换取 `sk-…` 令牌与模型列表。
   令牌**只驻留内存**，不写任何文件；桌面端的文件**只读不写**。
3. **透明转发** —— 请求体原样转发（网关已验证接受 thinking 标签、`strict` 工具、
   `output_config.effort`、`context_management`、`?beta=true` 等），SSE 帧逐块回传，
   只改两件事：注入 `x-api-key`（凭据由 shim 持有，调用方传什么都丢弃）与补上
   `anthropic-version`。`request-id` 等端到端响应头原样带回，便于排查。
4. **Provider 注册** —— 通过 `pi.registerProvider(...)` 把 `wingwork` provider 以
   `api: "anthropic-messages"` 指向 loopback。由于令牌归 shim 管理，该 provider 以**无密钥**方式注册。
5. **失效自愈** —— 上游返回 401/403 时 shim 自动重新换取一次令牌并重放该请求（桌面端登出或轮换令牌后不会卡死）。
6. **强制刷新** —— 提供 `/wingwork-refresh` 命令重新换取凭据并调用
   `ctx.modelRegistry.refreshProvider(...)`（默认 `online` 策略），绕过 omp 对动态模型列表的 24 小时缓存。

扩展进程内运行、**不沙箱化**，且只接受 loopback 来源的请求（拒绝非 loopback 的 `Host` 头，防止 DNS rebinding 攻击）。

### 关于请求头

网关的 `/kooky-api/*` 会对**明显是脚本客户端的 `User-Agent`**（如 `curl/8.4.0`、`Python-urllib`）返回
One 平台的 HTML 403 拦截页 —— 与令牌无关。插件因此固定发送 `User-Agent: WingWork`。
`/v1/messages` 面无此限制（`curl` 亦可）。

## 模型与思考等级

模型列表来自账号自身的 roster（不是硬编码），只有拉取失败时才回退到 `src/catalog.ts` 的静态兜底目录。

**思考（thinking）** 按后端分两套线协议，插件已在模型注册时标注，omp 会据此选择正确的请求形态：

| 模型 | 思考协议 | 可选 effort |
| --- | --- | --- |
| `wingwork/snt-5.5`、`os-5.5`、`os-5`、`os-4.8` | 自适应（`thinking.type: "adaptive"` + `output_config.effort`） | low / medium / high / xhigh / max |
| `wingwork/snt-4.6` | 自适应 | low / medium / high |
| 其余（DeepSeek / Grok / Qwen / Kimi） | 传统 budget（`thinking.type: "enabled"` + `budget_tokens`） | 由 omp 统一映射 |

> Sonnet 5.5 与 Opus 5.5 **拒绝** `thinking.type: "enabled"`（返回 400），
> Opus 5.5 还拒绝 `between_tools`；自适应系列则反过来。这正是上表按模型区分的原因。

**上下文窗口** 默认按 200k 上报（保守值），若 roster 下发了真实窗口则采用之，但一律不超过网关前端的
**500k 输入上限** —— 该前端对过大的请求直接 400，因此宁可少报（提前压缩）也不多报。

**图片输入** 仅对 Claude 系列声明；网关的非 Claude 后端会拒绝图片，声明支持只会让会话在发送时才失败。

## 依赖环境

- Windows（LevelDB 直读路径已实测）。macOS / Linux 的 `Application Support` / `~/.config` 路径已按同一布局实现，未经实测。
- **已安装并登录** iKooky（WingWork）桌面应用。
- omp 17.4.0 或更新版本（需支持扩展 `registerProvider`）。本仓库针对内置的 `@oh-my-pi/pi-coding-agent` 类型锁定版本。

### 环境变量（可选）

| 变量 | 作用 |
| --- | --- |
| `WINGWORK_ACCESS_TOKEN` | 直接指定账号 JWT，跳过 LevelDB 读取（容器 / 非默认安装路径下有用） |
| `WINGWORK_ORIGIN` | 覆盖 One 平台网关 origin（默认 `https://one.iflytek.com`；dev/test 环境可改） |
| `WINGWORK_USER_DATA` | 覆盖 iKooky 的 Chromium user-data 根目录（默认 `%APPDATA%\Kooky`） |

## 安装

### 方式 A：从 marketplace 安装（推荐）

```bash
omp plugin marketplace add Anymore0010/omp-plugins
omp plugin install omp-wingwork-connect@omp-plugins
```

### 方式 B：本地开发

```bash
cd /path/to/omp-plugins/omp-wingwork-connect
omp plugin link .
```

确认已加载：

```bash
omp plugin list
omp plugin doctor omp-wingwork-connect
omp models | grep wingwork
```

启动新的 omp 会话（`omp`），打开 `/model`，选择 `wingwork/ds-v4.1-flash` 或任意 WingWork 模型。

> 注：Windows 上若 `omp plugin link` 因符号链接权限（EPERM）失败，可改用 `~/.omp/agent/config.yml`
> 的 `extensions:` 绝对路径挂载（见仓库根 `README.md`）。

### 排查

会话内执行 `/wingwork-refresh` 可以看到凭据交换与模型拉取的真实结果；也可以直接查看 shim 的状态：

```bash
# 端口见 omp 启动日志，或从 /model 的 wingwork 条目推导
curl -s http://127.0.0.1:<port>/v1/status
```

未登录 / 读不到登录态 / 网关不可达会分别给出不同的提示，不会清空已有模型列表。

## 开发

本包为纯 TypeScript，无运行时依赖（仅用 Node 内置模块）；`@oh-my-pi/pi-coding-agent` 仅作 dev 依赖提供类型。

```bash
npm install
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json   # 类型检查
```

omp 加载的入口是 `src/index.ts`。其余模块：

- `src/auth.ts` — 从 Chromium LevelDB 的 `Local Storage` 里解析桌面端账号 JWT（含 varint 帧解析与多编码兜底）
- `src/upstream.ts` — One 平台网关客户端：凭据交换（`cli/config`）与错误归一化
- `src/store.ts` — 换取结果的进程内缓存 + 失效重取（互斥、失败可重试）
- `src/server.ts` — loopback Anthropic 面：路由、请求头治理、流式转发、401 重取重放
- `src/catalog.ts` — 静态兜底模型目录（仅上游不可达时使用）

## 关于对话记录

通过本插件发出的对话**会像桌面端一样被服务端记录**，这**不是插件行为**，无法从插件侧关闭：

- 插件唯一的落盘是**无** —— 交换得到的 `sk-…` 令牌只驻留内存，进程退出即消失；账号 JWT 来自桌面端文件，插件不复制、不改写。
- 记录发生在**服务端，按账号归档**。插件以你的桌面端身份发起请求，因此落在同一个云端会话/用量历史里。
- 结论：这是**上游账号属性**，不是可配置项。介意记录的话，唯一可控手段是**改用不共享该账号的渠道**。

## 免责声明

- 本项目**仅供个人学习与研究使用**。它驱动的是**你自己**机器上**你自己的** iKooky 账号，不适用于任何商业用途或超出个人合理使用范围的情形。
- 它依赖的是 iKooky **客户端**端点（并非官方公开 API）。上游随时可能更改协议，届时本插件可能需要跟进适配。通过第三方客户端使用你的账号，须遵守相应服务条款；由此产生的一切后果（包括但不限于账号限制、额度扣除、服务中断）由你自行承担。
- 本项目与 科大讯飞（iFlytek）、Kooky、WingWork **无关联、未经授权、亦未获其背书**。产品名称仅用于描述兼容性；其商标归各自所有者所有。
- 作者对因使用或误用本项目造成的任何直接或间接损失不承担任何责任。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
