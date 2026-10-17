# ai-tool-plugins

把**桌面应用的模型账号**接入各家 AI 工具的插件集合（**monorepo**）。仓库根放规范与 omp 的 marketplace 目录，第一层按**宿主工具**分层：`omp/`、`magpie/`、`dsh/`。

所有插件都是**零配置桥接**：复用本机桌面应用已有的登录态，不在工具侧再登录一次、也不需要 API Key。

> 原名 `omp-plugins`。改名后 omp 的 marketplace 名也变成 `ai-tool-plugins`，**已安装的机器需要迁移一次**，见 [`AGENTS.md`](./AGENTS.md#仓库改名后的迁移每台机器做一次)。

## 安装

### omp 插件

```bash
# 1. 订阅本仓库作为 marketplace
omp plugin marketplace add Anymore0010/ai-tool-plugins

# 2. 按需安装（可分别安装 / 升级 / 卸载）
omp plugin install omp-workbuddy-connect@ai-tool-plugins
omp plugin install omp-mimo-connect@ai-tool-plugins
omp plugin install omp-wingwork-connect@ai-tool-plugins
omp plugin install omp-astudio-connect@ai-tool-plugins
omp plugin install omp-loomy-connect@ai-tool-plugins
omp plugin install omp-fast-update@ai-tool-plugins

# 查看与升级
omp plugin list
omp plugin upgrade
```

### magpie 供应商插件

```bash
magpie plugin add /path/to/ai-tool-plugins/magpie/magpie-loomy-connect
magpie plugin login loomy
```

## omp 插件（`omp/`）

| 插件 | 说明 | 前提 |
| --- | --- | --- |
| [`omp-workbuddy-connect`](./omp/omp-workbuddy-connect) | 把 **WorkBuddy 桌面版**的模型接入 omp（`workbuddy/*`）。loopback shim + 复用桌面端鉴权文件。 | 已安装并登录 WorkBuddy 桌面版；omp ≥ 17.4.0 |
| [`omp-mimo-connect`](./omp/omp-mimo-connect) | 把 **小米 MiMo 桌面版**的模型接入 omp（`mimo/*`）。Chromium Cookie 解密 + SSO 换 serviceToken。 | 已安装并登录 MiMo 桌面版；首次读取 Cookie 需关闭 MiMo |
| [`omp-wingwork-connect`](./omp/omp-wingwork-connect) | 把 **iKooky（WingWork）桌面版**账号的模型接入 omp（`wingwork/*`）。读取桌面端 Local Storage 里的账号 JWT，换取网关令牌后按 Anthropic 协议透明转发。 | 已安装并登录 iKooky（WingWork）桌面版 |
| [`omp-astudio-connect`](./omp/omp-astudio-connect) | 把 **AStudio（讯飞 AstronClaw）桌面版**账号的模型接入 omp（`astudio/*`）。读桌面端 `astron-session.json`，向工作室接口换取每模型 `base_url`+令牌，再按 OpenAI chat-completions 透明转发。 | 已安装并登录 AStudio 桌面版 |
| [`omp-loomy-connect`](./omp/omp-loomy-connect) | 把 **Loomy 桌面版**账号的模型接入 omp（`loomy/*`）。读桌面端 `auth-session.json`，按名册直连 OpenAI 兼容面（含双凭据头与 traceparent）。 | 已安装并登录 Loomy 桌面版 |
| [`omp-fast-update`](./omp/omp-fast-update) | **并发分片自更新**：`/omp-update` 多连接 Range 下载 GitHub release 二进制，绕过 `omp update` 的单连接限速（实测 0.3 → 3.6 MB/s）。 | 独立二进制安装（非 bun/npm/brew/mise 管理） |

各插件的原理、风险与限制见各自子目录的 `README.md`（MiMo 的上游协议细节见其 `RESEARCH.md`）。

## magpie 供应商插件（`magpie/`，不依赖 omp）

| 目录 | 说明 |
| --- | --- |
| [`magpie-wingwork-connect`](./magpie/magpie-wingwork-connect) | 把 **iKooky（WingWork）** 接进 magpie（`wingwork/*`）。按其家族改写思考协议（5.5 一代要自适应，旧一代要 budget）。 |
| [`magpie-astudio-connect`](./magpie/magpie-astudio-connect) | 把 **AStudio（讯飞 AstronClaw）** 接进 magpie（`astudio/*`）。按模型路由到它各自的后端网关，含额度卡片。 |
| [`magpie-loomy-connect`](./magpie/magpie-loomy-connect) | 把 **Loomy** 接进 magpie（`loomy/*`）。名册里的上下文/输出上限、推理档位、点数倍率全部如实映射。 |
| [`magpie-sub2api-claudecode`](./magpie/magpie-sub2api-claudecode) | 把**只放行 Claude Code 客户端的 [sub2api](https://github.com/Wei-Shaw/sub2api) 站点**接进 magpie（`sub2api-cc/*`）。填站点地址与 API Key 登录，请求头与请求体一并伪装成 Claude Code CLI（端点判定逐条对齐 sub2api 自己的校验）。 |

它们跑在 magpie 自己的插件宿主（Bun）里，**与 omp 无关**：omp 不必安装、也不必运行。安装用 `magpie plugin add ./magpie/<目录名>`，**不在** `.omp-plugin/marketplace.json` 里（它们不是 omp 插件）。

## dsh 插件（`dsh/`，预留）

DeepSeek Harness 的插件层目前**还没有插件**，只有落位约定（npm 包命名、入口、如何挂进 profile）。新增时按 [`dsh/README.md`](./dsh/README.md) 的规则建子目录；它们不进 omp marketplace，版本号独立。

## 仓库结构

```
.omp-plugin/marketplace.json   # omp marketplace 目录（name / source / version）
AGENTS.md                      # 本仓库的开发与发布规范（提交身份、分层规则、版本流程、tag 命名）
omp/omp-workbuddy-connect/     # omp 插件（独立 npm 包，独立版本号）
omp/omp-mimo-connect/
omp/omp-wingwork-connect/
omp/omp-astudio-connect/
omp/omp-loomy-connect/
omp/omp-fast-update/           # omp 工具类
magpie/magpie-wingwork-connect/    # magpie 供应商插件（不是 omp 插件，不进 marketplace）
magpie/magpie-astudio-connect/
magpie/magpie-loomy-connect/
magpie/magpie-sub2api-claudecode/
dsh/README.md                  # dsh 插件落位约定（尚无插件）
```

约定：

- **第一层 = 宿主工具**，**第二层 = 插件**，目录名 = `package.json#name`（保留工具前缀）。新增工具就新建一层，不要把插件塞进 `omp/`。
- 每个 omp 插件的入口是它自己 `package.json` 的 `omp.extensions` 指向的 TS 文件。
- `marketplace.json` 里每个条目的 `source` 必须写成 `./omp/<子目录>`，`version` **必须**与该子目录 `package.json` 的 `version` 保持一致——否则 `omp plugin upgrade` 与开机自动更新会静默跳过该插件（详见 `AGENTS.md`）。
- 插件可分别安装、升级、卸载；互不牵连。

## 本地开发（不经过 marketplace）

改源码时直接让 omp 加载工作副本，`omp` 重启即生效：

```yaml
# ~/.omp/agent/config.yml
extensions:
  - D:/Projects/ai-tool-plugins/omp/omp-workbuddy-connect
  - D:/Projects/ai-tool-plugins/omp/omp-mimo-connect
  - D:/Projects/ai-tool-plugins/omp/omp-wingwork-connect
  - D:/Projects/ai-tool-plugins/omp/omp-astudio-connect
  - D:/Projects/ai-tool-plugins/omp/omp-loomy-connect
  - D:/Projects/ai-tool-plugins/omp/omp-fast-update
```

不改配置的临时加载：

```bash
omp -e D:/Projects/ai-tool-plugins/omp/omp-loomy-connect/src/index.ts --model loomy/spark-x -p --no-session "只回答：OK"
```

类型检查（在每个子目录内）：

```bash
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```

## 免责声明

- 本仓库插件**仅供个人学习与研究使用**，驱动的是**你自己**机器上**你自己**的账号，不得用于商业用途或超出个人合理使用范围的情形。
- 各插件依赖的是对应**客户端私有端点**（并非官方公开 API），上游随时可能变更协议，届时需跟进适配。使用第三方客户端访问你的账号须遵守相应服务条款，由此产生的后果由使用者自行承担。
- 与腾讯 / WorkBuddy / CodeBuddy / 小米 / MiMo / 科大讯飞 / AStudio / AstronClaw / Kooky / WingWork / Loomy / xfinfr / sub2api / Anthropic / Claude Code / DeepSeek **无关联、未经授权、亦未获其背书**；产品名称仅用于描述兼容性，商标归各自所有者。
- 作者对因使用或误用本项目造成的任何直接或间接损失不承担任何责任。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
