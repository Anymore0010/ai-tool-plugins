# magpie-astudio-middleware

[magpie](https://usemagpie.ai/) 的**网关中间件**：给走 AStudio（讯飞 AstronClaw）模型的请求补上它真正需要的东西。

一个包、一个文件（`astudio.middleware.js`），在 magpie 自己的进程里用 [moejs](https://github.com/Calcium-Ion/moejs) 运行 —— 不在 Bun 里，**没有 fetch、没有定时器、没有 Node API**。因此它只做纯文本层面的判断，不查任何远端信息。

> ⚠️ 中间件管的是**已经进入网关的请求**。它**不能**新增供应商（那需要能联网的供应商插件）。所以：先用某种方式让 magpie 能用到 AStudio 的模型（见 [怎么让 magpie 用上 AStudio 模型](#provider)），本中间件再负责把请求修对。

## 它修什么（每条都有实测依据）

AStudio 的模型面是一个 OpenAI chat-completions 网关，对请求字段极其宽容，却在两处很挑：

### 1. 模型 id 必须是精确的 wire id

同一个模型有三个名字：桌面端显示的 `GLM-5.2`、工作室内部 id 的 `lm_glm52`、请求体里真正要求的 `xopglm52`。**只有最后一个被接受**；传前两个（或大小写变体）返回：

```
400 {"error":{"code":10404,"message":"no category route found"}}
```

这句话既不说是哪个模型，也不给可用列表。中间件把显示名/id/大小写归一成 wire id（回复路上再还原成 agent 当初请求的名字，agent 只看到自己发的那一个）；遇到这句 10404 时，改写成"你写的不是 wire id，可用的是 …"。

### 2. 思考开关是 `enable_thinking`，不是 `reasoning_effort`

GLM-5.2 / DeepSeek-V4-Pro / Kimi-K2.6 / MiniMax-M2.5 在只收到 `reasoning_effort` 时**完全不产出 `reasoning_content`**（推理被折进正文，或干脆没有）；加上 `enable_thinking: true` 之后才返回推理。而 agent 通常只会发 `reasoning_effort`。中间件据此补上开关：

- 只对 **AStudio 的模型**生效（`provider/` 前缀匹配，或裸名本身是已知 wire id）；
- 只在 **chat 协议**下生效（`ctx.protocol === "chat"`）——Anthropic Messages / Responses 的请求体会被网关在**中间件之后**翻译成 chat，那时字段已经不归中间件管了；
- 请求里**已经**带了 `enable_thinking` 或 `thinking` 时一个字节都不动（显式意图优先）；
- `reasoning_effort: "none"` 补的是 `enable_thinking: false`。

其它供应商的请求完全不受影响。

## 安装

```bash
# 单文件也可以直接用：magpie plugin add /path/to/astudio.middleware.js
magpie plugin add /path/to/omp-plugins/magpie-astudio-middleware
magpie plugin            # 应显示：gateway middleware  onRequest, onEvent, onResponse
```

从 git 添加（`package.json` 在仓库根目录时才适用 —— 本 monorepo 不满足，用路径或先发布到 npm）：

```bash
magpie plugin add <npm 包名>
```

在应用里也可以：插件 → 添加插件 → 填文件夹路径；装好后到**网关中间件**下能看到它。

## 选项

选项放在 `plugins.json` 里这一项的 `options`，在应用里点中间件那一行的选项按钮用 JSON 编辑，或：

```bash
magpie plugin options astudio-middleware '{"provider":"astudio","thinking":true}'
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `provider` | `"astudio"` | 哪个供应商 id 下的模型算 AStudio。中间件用它判断前缀、给裸名补前缀 |
| `thinking` | `true` | 是否补思考开关；`false` 则只做别名归一化 |
| `aliases` | `{}` | 追加/覆盖别名，键为**小写**的裸名，值为 wire id。如 `{"fast":"xopdsv4flash0731in"}` |
| `blocked` | `[]` | 命中即 `403` 拒绝的 wire id 列表（例如想避开 `point_multiplier` 为 `x2.0` 的模型） |
| `models` | 内置表 | 改写成"可用列表"时用的模型清单；不写则用内置的 wire id 表 |

内置别名表来自一个生产账号实测的 `bot/models/configs`、`/v2/models` 与桌面端本地模型目录（显示名、内部 id、wire id 三套都收）。账号名册是动态的：**新模型不会出现在表里，但也不会被改错**——查不到就原样放行。

## <a id="provider"></a>怎么让 magpie 用上 AStudio 模型

中间件不提供模型，供应商得另找。两条现成路子：

1. **omp 插件的 loopback 面**（本仓库的 [`omp-astudio-connect`](../omp-astudio-connect)）。它在 omp 进程内以 `127.0.0.1:<随机端口>` 暴露 OpenAI 兼容面，把它作为 magpie 的自定义 provider 写进 `~/.config/magpie/providers.json` 即可（密钥随意，shim 会丢弃调用方传的凭证）。代价：**omp 必须在跑**，端口每次启动都变。
2. **magpie 供应商插件**（OpenCode v1 形式，跑在 Bun 里、能读文件、能发请求），可以直接复用同一个账号会话把 AStudio 变成一等供应商。本仓库暂未包含；需要的话可以按 `omp-astudio-connect` 的逆向结论直接改写。

## 测试

在沙箱里跑，别碰你正在用的 magpie：

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add /path/to/omp-plugins/magpie-astudio-middleware </dev/null
m plugin                     # 应列出 gateway middleware 及其三个钩子
m plugin options astudio-middleware '{"provider":"astudio","thinking":true}'
```

改动后 magpie **每秒检查一次**这些文件和 `plugins.json`，有变化就重新加载；应用里把插件关掉再打开同样生效。钩子抛异常、超时或返回了别的对象，都当作它不存在（请求/事件原样发送），排查时看 设置 → 插件 里每个中间件的调用次数与最近一次错误。

## 免责声明

- 本项目**仅供个人学习与研究使用**，驱动的是**你自己**机器上**你自己的** AStudio 账号。
- 它依赖的是 AStudio **客户端端点**（并非官方公开 API）：`agent.xfyun.cn` 的工作室接口与 MaaS 网关的 OpenAI 兼容面。上游随时可能更改协议，届时本中间件可能需要跟进适配。
- 本项目与 科大讯飞（iFlytek）、AStudio、AstronClaw **无关联、未经授权、亦未获其背书**。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
