# magpie-loomy-connect

把 **Loomy 账号**接入 [magpie](https://usemagpie.ai/)，**零配置** —— 复用桌面应用自身的登录态，你无需在 magpie 里再登录一次，也不需要 API Key，**不依赖 omp**。

模型以 `loomy/<id>` 出现（例如 `loomy/DeepSeek-V4.1-Flash`、`loomy/GLM-5.3-Flash`、`loomy/spark-x`），与其它供应商一样可供所有 agent 使用。

> ⚠️ 仅供个人研究/学习用途 —— 驱动的是**你自己的** Loomy 账号，仅在本机运行。与讯飞 / xfinfr / Loomy 无任何关联；请遵守相应服务条款。

## 工作原理

Loomy 没有推理 API Key：登录讯飞账号后拿到的 **账号 session 令牌**就是每次模型请求的凭据，直接存在一个普通的 `electron-store` 文件里。本插件在 magpie 自己的插件宿主里读这个文件（**只读**），把账号当成一个 OpenAI 兼容供应商接进来：

1. **读登录态** —— `{Loomy 配置根}/userData/auth-session.json` 的 `session`（32 位十六进制）。配置根在 **Windows 上是 `C:\Users\Public\Loomy\<sha256(用户名) 前 12 位>\`**（`%APPDATA%\Loomy` 只有 Chromium 缓存），可用 `LOOMY_CONFIG_ROOT` 覆盖。
2. **取基址** —— 优先读桌面端**实际部署**的 `opencode.json` 里 `provider.imodel.options.baseURL`（生产为 `https://loomyad.xunfei.cn/api/v1`），其次生产默认值。
3. **按模型直连** —— magpie 用 `@ai-sdk/openai-compatible` 与平台对话，模型名册来自 `GET /models`（服务端控制）。
4. **补齐两个必要头** —— 账号 session 同时以 `token` 与 `Authorization: Bearer` 发出（不同面读不同的那个），并且**每个请求新铸一个 `traceparent`**：缺了它 `chat/completions` 会挂死到超时（桌面端源码里就写着这条实测）。

### 实测到的上游行为（逆向结论）

| 观察 | 实测结果 | 插件的应对 |
| --- | --- | --- |
| 推理协议 | `POST {base}/chat/completions`，标准 OpenAI chat-completions（SSE、工具调用、`reasoning_content`） | 不做协议翻译 |
| 鉴权 | 账号 session 以 `token` + `Authorization: Bearer` 双头发送 | loader 两个都设，并覆盖调用方传来的凭据 |
| `traceparent` | 缺失即挂死到超时 | 每请求新铸 |
| 模型名册 | `GET /models` 带 `protocol` / `context_length` / `max_output_tokens` / `reasoning_efforts` / `default_reasoning_effort` / `capabilities` | 全量映射到模型配置（上限、推理档位、图片输入、工具调用） |
| 模型类型 | `type` 分 `chat` 与 `image`；生图模型不是对话模型 | 只暴露 `chat` |
| 点数倍率 | **印在显示名里**（`DeepSeek V4.1 Flash(x2.0)`、`（x0.8）`），`x0.0` 为限时免费 | 解析为 magpie 的 `rate`（模型选择器会显示）；`x0.0` 标为 `free` |
| 点数模型 | **两个池子**：**每日积分**（平台每天赠送 **5000** 分，按 `dailyCycleDate` 每日重置）与**长期积分**（做任务或「重置」获得，无上限）。可用总额 = 两者之和 | 额度卡片把**两个池子都画成进度条**（见下） |
| 点数结构 | 个人账号**没有**独立余额接口（`team-points/balance` 回 `当前未切换到团队`），但 `GET /api/v1/points/records?...&recordType=all` 同时给出两个桶：`balance`（长期池）、`dailyBalance`（**每日池**）、`availableBalance`（两者之和）；每条记录带 `dailyCycleDate` 与 `consumeSource` | 额度卡片用这个接口 |
| 两个池子的总量 | **都不发布**（`dailyLimitPoints` 那一族字段服务端从不返回） | 都用账本反推：每日 `grant = dailyBalance + 今日 daily 净消耗`（实测 `4962 + 38 = 5000` 整数自证）；长期 `longEarned = balance + 从长期池的累计扣减`。两者的"读够"标准不同：每日只要走出今天这个周期即可，长期要读到账本末尾；整本账在 **4 秒预算**内读不完时，长期那条就不显示比例（不给假分母），每日那条不受影响 |
| 点数服务基址 | 桌面端 `points-config.json` 里存的可能是**另一个环境**（会拒绝当前登录态） | 默认取推理同源（可用 `LOOMY_POINTS_BASE` 覆盖） |
| 思考开关 | `enable_thinking` 与 `reasoning_effort` 都接受 | 名册的 `reasoning_efforts` → magpie variants（`reasoningEffort`） |

## 安装

```bash
magpie plugin add /path/to/omp-plugins/magpie-loomy-connect
magpie plugin login loomy            # 只有一个方式：用桌面端的登录态
magpie plugin                        # loomy (Loomy, N models)  signed in as <手机号>
magpie provider test loomy           # 每个 API 发一个很小的请求
magpie quota                         # 两条进度条：每日 4962/5000 分（1%）、长期 10500/10500 分（0%）
```

装好后 agent 就能用 `loomy/<model>`，和其它供应商的模型一样。

## 环境变量（可选）

| 变量 | 作用 |
| --- | --- |
| `LOOMY_CONFIG_ROOT` | 直接指定 Loomy 配置根（跳过按用户名算出的路径） |
| `LOOMY_SESSION` | 直接给出账号 session，完全跳过桌面应用 |
| `LOOMY_API_BASE` | 覆盖推理基址 |
| `LOOMY_POINTS_BASE` | 覆盖点数服务基址 |

## 测试

沙箱里跑，别碰你正在用的 magpie：

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add /path/to/omp-plugins/magpie-loomy-connect </dev/null
m plugin
m plugin login loomy
m provider test loomy
m provider test loomy spark-x       # 指定模型
m quota
```

## 与 omp 插件的关系

本仓库另有 [`omp-loomy-connect`](../omp-loomy-connect)，把同一个账号接进 **omp**。两者互不依赖、可同时安装，也可只装其一：magpie 侧不需要 omp 在跑。

## 关于对话记录

通过本插件发出的对话**会像桌面端一样被服务端记录**，这**不是插件行为**，无法从插件侧关闭：

- 插件唯一的落盘是**无** —— 账号 session 来自桌面端文件，插件不复制、不改写（magpie 自己会把"已登录"状态写进它的 `plugin-auth.json`，其中不含令牌）。
- 记录发生在**服务端，按账号归档**。
- 结论：这是**上游账号属性**，不是可配置项。

## 免责声明

- 本项目**仅供个人学习与研究使用**。它驱动的是**你自己**机器上**你自己的** Loomy 账号，不适用于任何商业用途或超出个人合理使用范围的情形。
- 它依赖的是 Loomy **客户端端点**（并非官方公开 API）。上游随时可能更改协议，届时本插件可能需要跟进适配。通过第三方客户端使用你的账号，须遵守相应服务条款；由此产生的一切后果（包括但不限于账号限制、点数扣除、服务中断）由你自行承担。
- 本项目与 讯飞 / xfinfr / Loomy **无关联、未经授权、亦未获其背书**。产品名称仅用于描述兼容性；其商标归各自所有者所有。
- 作者对因使用或误用本项目造成的任何直接或间接损失不承担任何责任。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
