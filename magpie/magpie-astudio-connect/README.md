# magpie-astudio-connect

把 **AStudio（讯飞 AstronClaw）账号**接入 [magpie](https://usemagpie.ai/)，**零配置** —— 复用桌面应用自身的登录态，你无需在 magpie 里再登录一次，也不需要 API Key，**不依赖 omp**。

模型以 `astudio/<id>` 出现（例如 `astudio/astronclaw-auto`、`astudio/xopglm52`、`astudio/spark-x`），与其它供应商一样可供所有 agent 使用。

> ⚠️ 仅供个人研究/学习用途 —— 驱动的是**你自己的** AStudio 账号，仅在本机运行。与科大讯飞 / iFLYTEK / AstronClaw 无任何关联；请遵守相应服务条款。

## 工作原理

AStudio 桌面端**不把推理密钥落盘**：它只保存登录时拿到的**账号会话**（安装器记录的数据目录下 `userdata/astron-session.json`），每次启动再用这个会话去**换取**推理令牌与模型名册。本插件做的是同一件事，只是跑在 magpie 自己的插件宿主里：

1. **读登录态** —— 数据目录取自注册表 `HKCU\Software\AStudioStorage` 的 `<Profile>DataRoot`（本机为 `D:\App\AStudio Data`），也可用 `ASTUDIO_DATA_ROOT` 指定。会话文件**只读**，不复制、不改写。
2. **换取令牌 + 名册** —— `GET {studio}/xingchen-studio/bot/models/configs`，带账号 Cookie。每个模型自带 `base_url`（后端网关）、账号级 `api_key`、以及 `point_multiplier`（点数倍率）。令牌**只驻留内存**。
3. **按模型路由** —— 账号的模型分布在两个网关（MaaS 与 iFLYTEK 开放 Spark 网关），所以每个模型在 magpie 里都带自己的 `api.url`；请求由插件的 `fetch` 按名册改写目标地址并注入 `Authorization: Bearer <api_key>`。
4. **补齐思考开关** —— 网关的思考开关是 Qwen 风格 `enable_thinking`，**不是** `reasoning_effort`；请求里带 effort 却没有开关时补上（详见下表）。
5. **额度卡片** —— `points/balance` + `membership/me` 给出套餐与剩余积分，显示在 `magpie quota` 与网关的 `GET /v1/magpie/quotas`。

### 实测到的上游行为（逆向结论）

以下每一条都在一个生产账号上实测过，写在这里是因为它们决定了插件的行为：

| 观察 | 实测结果 | 插件的应对 |
| --- | --- | --- |
| 推理协议 | `POST {base_url}/chat/completions`，OpenAI chat-completions；SSE delta、工具调用、`reasoning_content` 均为标准形态 | 用 `@ai-sdk/openai-compatible`，不做协议翻译 |
| 鉴权 | `Authorization: Bearer <api_key>`；伪造密钥返回 `401 {"message":"HMAC signature cannot be verified: apikey not found"}` | loader 注入令牌；401/403 时重取一次再重放 |
| 模型 id | **必须**是 wire id（`xopglm52`）。传显示名（`GLM-5.2`）、内部 id（`lm_glm52`）或大小写变化都返回 `400 {"code":10404,"message":"no category route found"}` | 按 `slug`/`name`/`id` 三套名字匹配，再把请求改成 wire id |
| 思考开关 | `enable_thinking`（Qwen 风格）才真正开推理；GLM-5.2 / DeepSeek-V4-Pro / Kimi-K2.6 / MiniMax-M2.5 只收到 `reasoning_effort` 时**完全不产出** `reasoning_content` | 请求带 `reasoning_effort` 而无开关时补 `enable_thinking`；`none` → `false`；已显式给出 `enable_thinking`/`thinking` 时不动 |
| `max_tokens` 上限 | 后端拒绝超限值并**在报错里给出准确上限**：`astronclaw-auto`/`xopdeepseekv4pro` ≤ 393216；GLM/MiniMax/Kimi/Qwen ≤ 131072 | 按实测值上报 `limit.output` |
| 上下文窗口 | 没有任何端点公布 | 一律保守报 200k（少报只会更早压缩；多报会让请求被网关直接拒掉） |
| 计费 | 按**点数**（`points/balance`：本机实测 1200 / 1194）与每模型 `point_multiplier`（`x0.5`…`x2.0`）计，不按美元 | `cost` 全 0；`rate` 填 `point_multiplier`（magpie 自有字段）；额度卡片显示剩余积分 |
| 名册范围 | 账号名册（9 个）比网关实际服务范围**窄**：`spark-x2.5` 等只出现在桌面端自带目录里，但用同一把令牌可正常调用 | 名册外的已知 id 也列出，并按其家族网关路由 |
| 登录态失效 | `ssoSessionId` 与 `token` 同值，来自微信登录，有效期未公开 | 不做 refresh（协议未逆向）；失效时明确提示"回桌面端重新登录" |

## 安装

```bash
# 本地目录
magpie plugin add /path/to/ai-tool-plugins/magpie/magpie-astudio-connect

# 从 git（package.json 在仓库根目录时才适用；本 monorepo 用路径或 npm）
magpie plugin add owner/repo

magpie plugin login astudio     # 只有一个方式：用桌面端的登录态
magpie plugin                   # astudio (AStudio, 13 models)  signed in as <账号>
magpie provider test astudio    # 每个 API 发一个很小的请求
magpie quota                    # astudio · 体验版 · 积分 0% (1194 / 1200 分)
```

装好后 agent 就能用 `astudio/<model>`，和其它供应商的模型一样；应用里在 插件 → 已安装 的 `astudio` 那一行登录。

## 环境变量（可选）

| 变量 | 作用 |
| --- | --- |
| `ASTUDIO_DATA_ROOT` | 直接指定 AStudio 数据目录，跳过注册表探测 |
| `ASTUDIO_SSO_SESSION_ID` | 直接给出账号 SSO 会话 id，完全跳过桌面应用（容器 / 非默认安装路径） |
| `ASTUDIO_ACCOUNT_TOKEN` | 配合上一项；账户接口（积分/套餐）需要 |
| `ASTUDIO_STUDIO_ORIGIN` | 覆盖工作室 API origin（默认 `https://agent.xfyun.cn`） |

## 测试

在沙箱里跑，别碰你正在用的 magpie：

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add /path/to/ai-tool-plugins/magpie/magpie-astudio-connect </dev/null
m plugin                          # 供应商、登录方式、模型、加载错误
m plugin login astudio
m provider test astudio           # 每个 API 一个最小请求
m provider test astudio spark-x   # 指定模型（这条走的是另一个网关）
m quota                           # usage 钩子
```

插件宿主由 magpie 用 Bun 启动（TS 入口可直接加载），改动后重新添加或开关插件即可生效。钩子抛错时，magpie 会保留原列表并把它记进日志（`plugin: …`）。

## 与 omp 插件的关系

本仓库另有 [`omp-astudio-connect`](../../omp/omp-astudio-connect)，把同一个账号接进 **omp**。两者互不依赖，可同时安装：

- 都读同一份桌面登录态、都做同样的令牌换取；**令牌各自只在各自进程的内存里**。
- 都可用；只是 omp 侧以 `astudio/*` 出现在 omp 的 `/model`，magpie 侧出现在 magpie 的供应商列表。
- 不想同时装两个，也可以只装一个：magpie 侧不需要 omp 在跑。

## 关于对话记录

通过本插件发出的对话**会像桌面端一样被服务端记录**，这**不是插件行为**，无法从插件侧关闭：

- 插件唯一的落盘是**无** —— 换取的令牌只驻留内存；账号会话来自桌面端文件，插件不复制、不改写（magpie 自己会把"已登录"这个状态写进它的 `plugin-auth.json`，其中不含任何令牌）。
- 记录发生在**服务端，按账号归档**，因此落在同一个云端会话/用量历史里。
- 结论：这是**上游账号属性**，不是可配置项。

## 免责声明

- 本项目**仅供个人学习与研究使用**。它驱动的是**你自己**机器上**你自己的** AStudio 账号，不适用于任何商业用途或超出个人合理使用范围的情形。
- 它依赖的是 AStudio **客户端端点**（并非官方公开 API），包括 `agent.xfyun.cn` 的工作室接口与 MaaS 网关的 OpenAI 兼容面。上游随时可能更改协议，届时本插件可能需要跟进适配。通过第三方客户端使用你的账号，须遵守相应服务条款；由此产生的一切后果（包括但不限于账号限制、点数扣除、服务中断）由你自行承担。
- 本项目与 科大讯飞（iFlytek）、AStudio、AstronClaw **无关联、未经授权、亦未获其背书**。产品名称仅用于描述兼容性；其商标归各自所有者所有。
- 作者对因使用或误用本项目造成的任何直接或间接损失不承担任何责任。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
