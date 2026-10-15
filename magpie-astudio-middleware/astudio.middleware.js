/**
 * magpie 网关中间件 — AStudio（讯飞 AstronClaw）兼容层。
 *
 * AStudio 的模型面是一个 OpenAI chat-completions 网关（MaaS），它对请求字段
 * 极其宽容，却在两件事上很挑，且两处都只能靠实测得到：
 *
 * 1. **模型 id 必须是精确的 wire id。** 同一个模型有三个名字——桌面端显示的
 *    `GLM-5.2`、工作室内部 id 的 `lm_glm52`、以及请求体里真正要求的
 *    `xopglm52`——只有最后一个被接受。传显示名或内部 id 会得到
 *    `400 {"error":{"code":10404,"message":"no category route found"}}`，
 *    这句话既不指出是哪个模型，也不给出可用列表。
 * 2. **思考开关是 Qwen 风格的 `enable_thinking`，不是 `reasoning_effort`。**
 *    GLM / DeepSeek / Kimi / MiniMax 只收到 `reasoning_effort` 时完全不产出
 *    `reasoning_content`（推理被折叠进正文或干脆没有），必须同时下发
 *    `enable_thinking: true`。而 agent 通常只会发 `reasoning_effort`。
 *
 * 因此本中间件做三件事，全部由 `ctx.options` 控制：
 *
 * - **别名归一化**：显示名 / 工作室 id / 大小写 → wire id，并在回复里把
 *   agent 当初请求的名字还原回去（agent 看到的仍是自己发的那一个）。
 * - **思考开关补全**：只对 AStudio 的模型、且只在 chat 协议、且请求里没有
 *   自带 `enable_thinking`/`thinking` 时，按 `reasoning_effort` 补上
 *   `enable_thinking`。其它供应商的请求一个字节都不动。
 * - **可读报错**：把上面那句 10404 改写成"你写的名字不是 wire id，可用的是 …"。
 *
 * 运行环境是 magpie 网关自带的 moejs：**没有 fetch、没有定时器、没有 Node API**，
 * 因此这里只做纯文本层面的判断，不查任何远端信息。
 *
 * 说明：中间件看到的是 **agent 自己的 API 格式**（`ctx.protocol`）而不是供应商
 * 格式。所以别名/路由改写对所有协议都生效，而思考开关补全只对 `chat` 协议有意义
 * ——Anthropic Messages / Responses 的请求体会被网关翻译成 chat，翻译之后的字段
 * 已经不是本中间件能触碰到的东西了。
 */

/**
 * 显示名 / 工作室 id → wire id。
 *
 * 这张表来自一个生产账号上实测的 `bot/models/configs` 与 `/v2/models` 两份名册
 * （`slug | name` 与 `id | model`），加上桌面端本地模型目录里的名字。键一律小写，
 * 查表前会把请求里的模型名折叠成小写。
 *
 * 账号名册是动态的：新模型不会出现在这里，但**旧名字不会被改写错**——查不到就
 * 原样放行，让上游按它自己的规则回答。
 */
const WIRE_ID_ALIASES = {
  // 桌面端显示名 → wire id
  "auto": "astronclaw-auto",
  "spark-x2-agent": "xsparkx2agent",
  "spark-x2-flash": "spark-x",
  "spark-x2.5": "spark-x2.5",
  "spark-x2.6-preview": "spark-x2.6-preview",
  "glm-5.2": "xopglm52",
  "glm-5.1": "xopglm51",
  "minimax-m2.5": "xminimaxm25",
  "kimi-k2.6": "xopkimik26",
  "qwen3.6-35b-a3b": "xopqwen36v35b",
  "deepseek-v4-pro": "xopdeepseekv4pro",
  "deepseek-v4-flash": "xopdsv4flash0731in",
  // 工作室内部 id → wire id
  "lm_auto": "astronclaw-auto",
  "lm_sparkx2agent": "xsparkx2agent",
  "lm_sparkx2": "spark-x",
  "lm_glm52": "xopglm52",
  "lm_glm51": "xopglm51",
  "lm_minimax25": "xminimaxm25",
  "lm_kimi26": "xopkimik26",
  "lm_qwen36": "xopqwen36v35b",
  "lm_deepseekv4pro": "xopdeepseekv4pro",
  // wire id 本身（允许 agent 用裸名请求）
  "astronclaw-auto": "astronclaw-auto",
  "xsparkx2agent": "xsparkx2agent",
  "spark-x": "spark-x",
  "spark-x2.5": "spark-x2.5",
  "spark-x2.6-preview": "spark-x2.6-preview",
  "xopglm52": "xopglm52",
  "xopglm51": "xopglm51",
  "xminimaxm25": "xminimaxm25",
  "xopkimik26": "xopkimik26",
  "xopqwen36v35b": "xopqwen36v35b",
  "xopdeepseekv4pro": "xopdeepseekv4pro",
  "xopdeepseekv4pro0813": "xopdeepseekv4pro0813",
  "xopdsv4flash0731in": "xopdsv4flash0731in"
}

/** 这些 id 已经是 wire id，不需要任何改写。 */
const WIRE_IDS = {
  "astronclaw-auto": true,
  "xsparkx2agent": true,
  "spark-x": true,
  "spark-x2.5": true,
  "spark-x2.6-preview": true,
  "xopglm52": true,
  "xopglm51": true,
  "xminimaxm25": true,
  "xopkimik26": true,
  "xopqwen36v35b": true,
  "xopdeepseekv4pro": true,
  "xopdeepseekv4pro0813": true,
  "xopdsv4flash0731in": true
}

/** 上游对"不是 wire id"的回答；见文件头的实测记录。 */
const UNKNOWN_MODEL_MARK = "no category route found"

function optionsOf(ctx) {
  const options = ctx.options
  return options === null || typeof options !== "object" ? {} : options
}

function textOf(value) {
  return typeof value === "string" ? value.trim() : ""
}

/** 别名表 = 内置表 + 用户覆盖（`options.aliases` 的键也按小写匹配）。 */
function aliasEntry(bare, aliases) {
  const key = bare.toLowerCase()
  if (aliases !== null && typeof aliases === "object") {
    const override = aliases[key]
    if (textOf(override) !== "") return textOf(override)
    for (const name in aliases) {
      if (name.toLowerCase() === key && textOf(aliases[name]) !== "") return textOf(aliases[name])
    }
  }
  const builtin = WIRE_ID_ALIASES[key]
  return textOf(builtin)
}

/**
 * 把一个请求里的模型名解析成路由用的名字。
 *
 * 三种输入分别处理：`provider/名字`（替换后缀）、裸名（补上 `provider/`）、
 * 别的供应商前缀（原样放行）。查不到别名时一律原样放行。
 */
function resolveModel(asked, provider, aliases) {
  const slash = asked.indexOf("/")
  const bare = slash < 0 ? asked : asked.slice(slash + 1)
  const hit = aliasEntry(bare, aliases)
  if (hit === "") return { resolved: asked, wire: "", changed: false }
  if (slash < 0) return { resolved: provider + "/" + hit, wire: hit, changed: true }
  const head = asked.slice(0, slash)
  if (head.toLowerCase() !== provider.toLowerCase()) return { resolved: asked, wire: "", changed: false }
  return { resolved: head + "/" + hit, wire: hit, changed: hit !== bare }
}

/** 这个请求打的是不是 AStudio：前缀匹配，或裸名本身就是一个 wire id。 */
function targetsAstron(asked, provider, wire) {
  const slash = asked.indexOf("/")
  if (slash >= 0) return asked.slice(0, slash).toLowerCase() === provider.toLowerCase()
  if (wire !== "") return true
  return WIRE_IDS[asked.toLowerCase()] === true
}

/** `options.models` 给出的可用列表，缺省回落到内置 wire id 表。 */
function knownModels(options) {
  const declared = options.models
  if (Array.isArray(declared) && declared.length > 0) {
    const listed = []
    for (const item of declared) {
      const name = textOf(item)
      if (name !== "") listed.push(name)
    }
    if (listed.length > 0) return listed
  }
  const known = []
  for (const id in WIRE_IDS) known.push(id)
  return known.sort()
}

/**
 * 请求钩子：别名归一化 + 屏蔽名单 + 思考开关补全。
 *
 * 路由发生在钩子之后，所以改了 `model` 就等于换了目标；把 agent 原来的写法记进
 * `ctx.state`，回复路上再还原，agent 始终看到自己发出去的那个名字。
 */
export function onRequest(body, ctx) {
  if (body === null || typeof body !== "object") return
  const options = optionsOf(ctx)
  const provider = textOf(options.provider) === "" ? "astudio" : textOf(options.provider)
  const asked = textOf(body.model)
  if (asked === "") return

  const resolved = resolveModel(asked, provider, options.aliases)
  if (resolved.changed) {
    body.model = resolved.resolved
    ctx.state.astudioAskedModel = asked
    ctx.state.astudioResolvedModel = resolved.resolved
  }

  const blocked = options.blocked
  if (Array.isArray(blocked)) {
    const wire = resolved.wire === "" ? asked.toLowerCase() : resolved.wire.toLowerCase()
    for (const item of blocked) {
      if (textOf(item).toLowerCase() === wire) {
        return ctx.reject(403, "AStudio 模型 " + wire + " 已被中间件屏蔽（options.blocked）")
      }
    }
  }

  if (options.thinking !== false && ctx.protocol === "chat" && targetsAstron(asked, provider, resolved.wire)) {
    applyThinkingSwitch(body)
  }
  return body
}

/**
 * 补上 `enable_thinking`。
 *
 * 实测：`reasoning_effort` 从 `minimal` 到 `max` 全部返回 200，但对 GLM-5.2 /
 * DeepSeek-V4-Pro / Kimi-K2.6 都不产出 `reasoning_content`；加上
 * `enable_thinking: true` 之后三者都开始返回推理。请求已经自带
 * `enable_thinking` 或 `thinking` 时一律不动（显式意图优先）。
 */
function applyThinkingSwitch(body) {
  if (body.enable_thinking !== undefined || body.thinking !== undefined) return
  const effort = textOf(body.reasoning_effort)
  if (effort === "") return
  body.enable_thinking = effort.toLowerCase() !== "none"
}

/** 回复钩子（流式）：把 agent 当初请求的名字写回事件里。 */
export function onEvent(event, ctx) {
  if (event === null || typeof event !== "object") return
  const asked = textOf(ctx.state.astudioAskedModel)
  if (asked === "") return
  const resolved = textOf(ctx.state.astudioResolvedModel)
  if (resolved === "") return
  if (event.model === resolved) event.model = asked
  const message = event.message
  if (message !== null && typeof message === "object" && message.model === resolved) message.model = asked
  return event
}

/**
 * 回复钩子（非流式）：还原模型名，并把上游那句 10404 改写成能照着修的话。
 *
 * 只改写**确实**是"名字不认识"这一种失败：其它错误是上游的真实回答，原样放行
 * 才能让用户看到供应商自己的话。
 */
export function onResponse(body, ctx) {
  if (body === null || typeof body !== "object") return
  const resolved = textOf(ctx.state.astudioResolvedModel)
  const asked = textOf(ctx.state.astudioAskedModel)
  if (resolved !== "" && asked !== "" && body.model === resolved) body.model = asked

  const error = body.error
  if (error === null || typeof error !== "object") return body
  const message = textOf(error.message)
  if (message.indexOf(UNKNOWN_MODEL_MARK) < 0) return body
  const known = knownModels(optionsOf(ctx))
  if (known.length === 0) return body
  error.message = "AStudio 只接受精确的 wire 模型 id（不接受显示名或工作室 id）；可用：" + known.join(", ")
  return body
}
