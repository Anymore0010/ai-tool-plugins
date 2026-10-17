# magpie-sub2api-claudecode

把 **限定只放行 Claude Code 客户端**的 [sub2api](https://github.com/Wei-Shaw/sub2api) 站点接成 [magpie](https://usemagpie.ai) 的 provider：填站点地址和 API key 登录，magpie 就能用这个 key 所在分组的模型，并按 key 的剩余额度做路由 —— **每一个请求都伪装成 Claude Code CLI 发出去**。

普通用法（不限定客户端的站点）请用 [magpie-sub2api](https://github.com/broven/magpie-sub2api)；本插件是为「分组开了 `claude_code_only`」这类站点准备的。

## 为什么需要插件

sub2api 的分组可以只放行 Claude Code 客户端。这时任何不「像 Claude Code」的请求都会拿到：

```
503 {"error":{"message":"No available accounts: this group only allows Claude Code clients"}}
```

在 magpie 里给自定义 provider 手写一套伪装请求头（`user-agent: claude-cli/…`、`x-app: cli`、`anthropic-beta`…）**不够**。sub2api 的判定（`backend/internal/service/claude_code_validator.go`，其注释称学习自 claude-relay-service）对 `POST /v1/messages` 要求**四条同时成立**：

| # | 条件 | 只改请求头能过吗 |
|---|---|---|
| 1 | `user-agent` 匹配 `^claude-cli/<主>.<次>.<修订>`（大小写不敏感） | 能 |
| 2 | `x-app`、`anthropic-beta`、`anthropic-version` 三个头都非空 | 能 |
| 3 | `metadata.user_id` 能被解析（JSON 形式 `{device_id, account_uuid, session_id}`，或旧式 `user_<64位hex>_account_<uuid>_session_<uuid>`） | **不能**（要改请求体） |
| 4 | `system` 是**数组**，且其中一段以计费归因块 `x-anthropic-billing-header`（含 `cc_entrypoint=`）开头，或与官方 Claude Code 提示词前缀相似度 ≥ 0.5 | **不能**（要改请求体） |

magpie 的自定义 provider 只能设请求头，所以第 3、4 条永远过不了 —— 这就是为什么「一般的伪装不太行」。本插件的 `auth.loader` 自己持有请求（返回自定义 `fetch`），请求头与请求体一起改，四条才都成立。

## 伪装的具体形态

对齐真实 Claude Code 2.1.280 的流量，而不是自己发明：

- **请求头**：`user-agent: claude-cli/2.1.280 (external, cli)`、`x-app: cli`、`anthropic-version: 2023-06-01`、`anthropic-beta: claude-code-20250219,oauth-2025-04-20,…`、一组 `x-stainless-*`、`x-claude-code-session-id`，以及 `authorization: Bearer <key>`（真机在订阅下用 bearer，不发 `x-api-key`）。
- **请求体**（仅 `/v1/messages`）：`system` 变成数组，`system[0]` 是计费块、`system[1]` 是身份横幅 `You are Claude Code, Anthropic's official CLI for Claude.`，原有内容依次排在后面且**不改动**；`metadata.user_id` 写成本次账号的 JSON 形式。
- **计费块版本号与 UA 版本号同源**，指纹用 sub2api 自己的算法（盐 + 首条 user 消息的第 4、7、20 个**字节** + 版本号，取 SHA-256 前 3 位十六进制），所以这一块和站点自己注入的流量读起来一致。
- 已经带计费块或身份横幅的请求会被**重建而不是叠加**，重复经过也不会留下两份。
- `/v1/messages/count_tokens` 与其他端点只改请求头：前者站点只验 UA，后者改了只会把伪装块算成额外 token。

## 安装

```sh
magpie plugin add ./magpie-sub2api-claudecode
```

或把文件夹路径填进 magpie 的**插件 › 添加插件**。

## 登录

```sh
magpie plugin login sub2api-cc
```

依次问站点地址（如 `https://api.example.com`，带不带 `/v1` 都可以）、账号名（可留空），最后问 API key（`sk-…`）。应用里添加账号时填同样几项。

账号名填了就用它；留空则显示为「站点域名 …key 后四位」。magpie 按账号名记各账号的模型和能力，**登录后别改名**，要改就删掉重新登录。

模型统一叫 `sub2api-cc/<模型>`（如 `sub2api-cc/claude-opus-4-6`）。

## 选项

```sh
magpie plugin options sub2api-cc '{"cliVersion":"2.1.280"}'
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `cliVersion` | `2.1.280` | 伪装成哪个 Claude Code 版本：UA 与计费块里的 `cc_version` 都用它。站点开始拒绝旧版本时改这里。 |
| `masquerade` | `true` | 设为 `false` 只发认证、不做任何伪装 —— 用来确认「能用」确实是伪装带来的（对限定客户端的分组会重新拿到 503）。 |

## 用量

用量取自 `GET /v1/usage`，按 key 的情况换成 magpie 的用量窗口：

| sub2api 的情况 | magpie 里看到的 | 窗口 |
|---|---|---|
| **订阅分组**（group 设了日/周/月额度） | 套餐名 = 分组名，到期时间 = 订阅到期 | `24 hours` / `7 days` / `30 days`，只列设了额度的 |
| **key 自带额度或限速**（`mode: quota_limited`） | 套餐名 `API key limits` | `Key quota` + `5 hours` / `24 hours` / `7 days` |
| **余额分组** | 套餐名 + 钱包余额 | 无（余额没有时间窗口，不参与路由） |

各窗口的重置时间：

| 窗口 | 重置于 | 依据 |
|---|---|---|
| `24 hours` | 站点时区的**下一个零点** | 站点的每日数字是按自然日算的，且它的时间戳自带时区（如 `+08:00`），所以这一个不用猜 —— 站点自己的卡片也是这么倒计时的 |
| `7 days` | `weekly_reset_at`，站点没给就用「本周窗口开始 + 7 天」 | 接口返回 `weekly_window_start` |
| `30 days` | 只有站点返回 `monthly_reset_at` 时才有 | 站点的月窗口是固定的 30 天块，但接口只返回周窗口的起点（见限制） |

思考等级取自站点的 `GET /backend-api/codex/models`，站点给不出时沿用 magpie 已有的等级，再没有就给会思考的模型 `low` / `medium` / `high`。

## 限制

- **只为 `claude-*` 模型伪装请求体**：非 Claude 模型走 `/v1/chat/completions` 或 `/v1/responses`，只带伪装请求头 —— 限定客户端的分组本来也只放行 Claude 模型。
- **余额模式不参与路由**（余额没有时间窗口）。
- 一个 key 只看得到它绑定分组的订阅。
- 同一个 key 重复登录会多出一个账号，删掉多余的即可。
- 站点判决与协议随时可能变化；如果哪天返回 503 而 key 本身可用，先试 `cliVersion`。
- **月窗口没有倒计时**（除非站点返回 `monthly_reset_at`）：站点的月窗口是固定的 30 天块（不是自然月，也不是「用满才滚动」），而接口只返回 `weekly_window_start`。按用量数据反推块起点会落在该块内第一个有流量的日子上 —— 中间空闲几天就偏几天，所以不猜。
- **套餐到期时间在 magpie 卡片上只显示月日**：插件交出去的是完整时间戳（`magpie quota --json` 与网关的 `GET /v1/magpie/quotas` 里能看到年份与时刻），magpie 的卡片把它格式化成「`N月N日`」而不带年份 —— 那是 magpie 自己的显示格式，插件改不了。

## 兼容性

sub2api **≥ 0.2.14**。插件只调用上游的公开接口（`/v1/models`、`/backend-api/codex/models`、`/v1/usage`），不依赖任何站点的私有改动。

## 参考

- [broven/magpie-sub2api](https://github.com/broven/magpie-sub2api)（MIT）：模型清单、用量窗口映射与账号命名沿用它的做法。
- [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)：判定条件与计费块形态的依据（`claude_code_validator.go`、`gateway_billing_block.go`）。
- [router-for-me/EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI)：Claude Code 客户端配置的对照来源。

## 免责声明

本插件**非官方**，仅供个人学习研究；驱动的是 sub2api 站点的公开接口，协议可能随时变化；与 sub2api、Anthropic、Claude Code 项目**无关联**。请遵守你所接入站点的使用条款。

## 许可证

MIT
