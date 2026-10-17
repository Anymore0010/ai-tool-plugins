# magpie-wingwork-connect

把 **iKooky（WingWork）账号**接入 [magpie](https://usemagpie.ai/)，**零配置** —— 复用桌面应用自身的登录态，你无需在 magpie 里再登录一次，也不需要 API Key，**不依赖 omp**。

模型以 `wingwork/<id>` 出现（例如 `wingwork/ds-v4.1-flash`、`wingwork/snt-5.5`、`wingwork/os-5.5`、`wingwork/km-k3`），与其它供应商一样可供所有 agent 使用。

> ⚠️ 仅供个人研究/学习用途 —— 驱动的是**你自己的** iKooky 账号，仅在本机运行。与科大讯飞 / iFlytek / Kooky / WingWork 无任何关联；请遵守相应服务条款。

## 工作原理

WingWork 桌面端把模型请求发往 One 平台网关上的一个 **Anthropic Messages 兼容面**，并用一个 `sk-…` 令牌鉴权。那个令牌**不落盘**：桌面端每次启动时用渲染进程里的**账号 JWT** 去换取它。本插件做同样的事，只是跑在 magpie 自己的插件宿主里：

1. **读账号 JWT** —— 从桌面端 Chromium 的 LevelDB `Local Storage` 里读出 `super-assistant-userInfo.access_token`（Windows：`%APPDATA%\Kooky\Local Storage\leveldb`）。文件**只读**。
2. **换取令牌与名册** —— `GET {origin}/kooky-api/api/client/v3/cli/config`，带 `Authorization: Bearer <账号 JWT>`；响应里的 `ANTHROPIC_AUTH_TOKEN` 是推理用的 `sk-…` 令牌，`ANTHROPIC_BASE_URL` 是推理入口，`models[]` 是账号自己的模型名册。令牌**只驻留内存**。
3. **按 Anthropic 协议直连** —— magpie 用 `@ai-sdk/anthropic` 与网关对话，基址取换取结果；没有协议翻译。
4. **补齐思考协议** —— 网关的 Claude 5.5 一代模型**拒绝** `thinking.type: "enabled"`（400），要的是自适应线格式（`thinking.type: "adaptive"` + `output_config.effort`）；旧一代两种都收。loader 按家族改写这一处，其余请求原样透传。
5. **失效自愈** —— 上游返回 401/403 时丢弃内存令牌、重新换取一次并重放该请求。

插件发出的每个请求都带 `User-Agent: WingWork`：One 平台的 `/kooky-api/*` 面对**明显的脚本客户端 UA**（`curl/…`、`Python-urllib`）返回 HTML 403 拦截页，与令牌无关。

## ⚠️ 当前上游状态：网关要求令牌带 `tid`（暂不可用）

实测（2026-10-15）：本机桌面端 `Local Storage` 里保存的账号 JWT（签发于 2026-06-30）在换取令牌时被网关拒绝：

```
GET https://one.iflytek.com/kooky-api/api/client/v3/cli/config
  Authorization: Bearer <账号 JWT>
→ 401 {"detail":"Token tid required"}
```

已排除的可能：`token` / `bk_token` / `tid` / `X-Tenant-Id` / `tenantId` / `domain` / `clientType` 等请求头组合**都不能**满足它（逐一实测），且桌面端自己的 `cli/config` 调用只发 `Authorization: Bearer`。也就是说 **`tid` 是令牌本身必须携带的声明**，而现存令牌没有该声明。

补充实测（同日）：**整个 `/kooky-api` 面都这样** —— `/kooky-api/api/models`、`/kooky-api/api/client/v1/ai-tool-platform` 等一律 `401 Token tid required`，加 `?tid=…` 查询参数同样无效；另一条 `client-config` 面则要 SSO cookie（`未提供 SSO token`）。

**这对额度显示的影响**：WingWork 的月度额度（每月 $20）只能从这些面读，因此**当前无法显示额度**。本插件的 `usage` 钩子会在能读到时给出额度窗口，现在会返回一条明确的错误说明而不是空白。等桌面端重新登录、`/kooky-api` 面恢复后即可用。

这**不是本插件引入的问题**：本仓库的 omp 插件 [`omp-wingwork-connect`](../../omp/omp-wingwork-connect) 现在报同样的错（它会把网关的原话带回给 omp）。

### 顺带修好的一件事：令牌读取

排查期间发现桌面端把 `Local Storage` 压缩成了 `.ldb` 表文件（15:43 发生一次 compaction），旧的读取器只认未压缩的写前日志，于是**读不到令牌**。现在两个插件都按 LevelDB 表格式解析（footer → index block → data block，含 Snappy 解压），实测已能从压缩后的 `000003.ldb` 读出 866 字符的账号 JWT。

**修复方式**：在 iKooky（WingWork）桌面端**重新登录一次**（让桌面端重新签发一份带 `tid` 的令牌），然后：

```bash
magpie plugin login wingwork      # 不需要重新登录 magpie，只是重新读取桌面端登录态
magpie provider test wingwork
```

如果重新登录后仍然报 `Token tid required`，说明新令牌同样不带该声明，那就是客户端版本落后于服务端——需要等桌面端更新。

## 额度（每月额度）

WingWork 的额度是**每月 $20 一档**（`quota.total`），桌面端设置页读的是：

```
GET {origin}/kooky-api/api/client/v1/provider-config/providers/kooky?channel=all
  Authorization: Bearer <账号 JWT>
  X-KC-Account: <账号名>
→ data.quota = { balance, used, total, used_percent, fixed_quota,
                 quota_type, reset_date, short_term_temp_quota }
```

本插件的 `usage` 钩子就用它，把 `used_percent` 映射成 `每月额度` 进度条（`$已用 / $总额`，带 `reset_date`）。

⚠️ 但**当前读不到**：这个接口属于 `/kooky-api` 面，与换取令牌那一步一样回 `401 Token tid required`。此时额度卡显示的是这条原因，而不是空白。等桌面端重新登录、该面恢复后即自动显示。

> 本轮按你的要求**没有**做模型连通性测试（本月额度已用尽）。

## 安装

```bash
magpie plugin add /path/to/ai-tool-plugins/magpie/magpie-wingwork-connect
magpie plugin login wingwork           # 只有一个方式：用桌面端的登录态
magpie plugin                          # wingwork (WingWork, N models)  signed in as <账号>
magpie provider test wingwork          # 每个 API 发一个很小的请求
```

## 环境变量（可选）

| 变量 | 作用 |
| --- | --- |
| `WINGWORK_USER_DATA` | 覆盖桌面端 Chromium user-data 根目录（默认 `%APPDATA%\Kooky`） |
| `WINGWORK_ACCESS_TOKEN` | 直接指定账号 JWT，跳过 LevelDB 读取（容器 / 非默认安装路径） |
| `WINGWORK_ORIGIN` | 覆盖 One 平台网关 origin（默认 `https://one.iflytek.com`） |

## 模型与思考协议

模型列表来自账号自己的名册（不是硬编码），只有拉取失败时才回退到代码内的静态兜底列表。思考协议按后端分两套线格式，插件在 loader 里按家族改写请求：

| 模型 | 思考协议 | 可选 effort |
| --- | --- | --- |
| `wingwork/snt-5.5`、`os-5.5`、`os-5`、`os-4.8` | 自适应（`thinking.type: "adaptive"` + `output_config.effort`） | low / medium / high / xhigh / max |
| `wingwork/snt-4.6` | 自适应 | low / medium / high |
| 其余（DeepSeek / Grok / Qwen / Kimi） | 传统 budget（`thinking.type: "enabled"` + `budget_tokens`） | 由 magpie 侧统一映射 |

> 经典 budget 形式只有 token 预算、没有档位，而自适应面没有预算字段；插件把预算分段映射到该模型接受的档位（≤2048 → low，≤8192 → medium，≤16384 → high，≤32768 → xhigh，更高 → max）。

**上下文窗口**：名册下发真实窗口时采用之，但一律不超过网关前端的 **500k** 输入上限；没有下发的按 200k 保守上报。

## 测试

沙箱里跑，别碰你正在用的 magpie：

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add /path/to/ai-tool-plugins/magpie/magpie-wingwork-connect </dev/null
m plugin
m plugin login wingwork
m provider test wingwork
```

## 与 omp 插件的关系

本仓库另有 [`omp-wingwork-connect`](../../omp/omp-wingwork-connect)，把同一个账号接进 **omp**。两者互不依赖、可同时安装（令牌各自只在各自进程内存里），也可只装其一。

## 关于对话记录

通过本插件发出的对话**会像桌面端一样被服务端记录**，这**不是插件行为**，无法从插件侧关闭：

- 插件唯一的落盘是**无** —— 换取的令牌只驻留内存；账号 JWT 来自桌面端文件，插件不复制、不改写。
- 记录发生在**服务端，按账号归档**，因此落在同一个云端会话/用量历史里。
- 结论：这是**上游账号属性**，不是可配置项。

## 免责声明

- 本项目**仅供个人学习与研究使用**。它驱动的是**你自己**机器上**你自己的** iKooky 账号，不适用于任何商业用途或超出个人合理使用范围的情形。
- 它依赖的是 iKooky **客户端端点**（并非官方公开 API）。上游随时可能更改协议，届时本插件可能需要跟进适配。通过第三方客户端使用你的账号，须遵守相应服务条款；由此产生的一切后果（包括但不限于账号限制、额度扣除、服务中断）由你自行承担。
- 本项目与 科大讯飞（iFlytek）、Kooky、WingWork **无关联、未经授权、亦未获其背书**。产品名称仅用于描述兼容性；其商标归各自所有者所有。
- 作者对因使用或误用本项目造成的任何直接或间接损失不承担任何责任。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
