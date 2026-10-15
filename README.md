# omp-plugins

我自用的 [omp](https://omp.sh/)（`@oh-my-pi`）扩展集合，以 **marketplace monorepo** 形式发布：仓库根放置 marketplace 目录（`.omp-plugin/marketplace.json`），每个插件是仓库根下的一个独立子目录（各自带 `package.json`、入口、README）。

omp 插件都是**零配置桥接**：复用本机桌面应用已有的登录态，把它的模型接进 omp 的 `/model` 选择器，不在 omp 侧再登录一次、也不需要 API Key。仓库另带一组 **magpie 供应商插件**，用同一套做法把同样几个账号接进 magpie（**不依赖 omp**）。

## 安装

```bash
# 1. 订阅本仓库作为 marketplace
omp plugin marketplace add Anymore0010/omp-plugins

# 2. 按需安装（可分别安装 / 升级 / 卸载）
omp plugin install omp-workbuddy-connect@omp-plugins
omp plugin install omp-mimo-connect@omp-plugins
omp plugin install omp-wingwork-connect@omp-plugins
omp plugin install omp-astudio-connect@omp-plugins
omp plugin install omp-loomy-connect@omp-plugins
omp plugin install omp-fast-update@omp-plugins

# 查看与升级
omp plugin list
omp plugin upgrade
```

## omp 插件

| 插件 | 说明 | 前提 |
| --- | --- | --- |
| [`omp-workbuddy-connect`](./omp-workbuddy-connect) | 把 **WorkBuddy 桌面版**的模型接入 omp（`workbuddy/*`）。loopback shim + 复用桌面端鉴权文件。 | 已安装并登录 WorkBuddy 桌面版；omp ≥ 17.4.0 |
| [`omp-mimo-connect`](./omp-mimo-connect) | 把 **小米 MiMo 桌面版**的模型接入 omp（`mimo/*`）。Chromium Cookie 解密 + SSO 换 serviceToken。 | 已安装并登录 MiMo 桌面版；首次读取 Cookie 需关闭 MiMo |
| [`omp-wingwork-connect`](./omp-wingwork-connect) | 把 **iKooky（WingWork）桌面版**账号的模型接入 omp（`wingwork/*`）。读取桌面端 Local Storage 里的账号 JWT，换取网关令牌后按 Anthropic 协议透明转发。 | 已安装并登录 iKooky（WingWork）桌面版 |
| [`omp-astudio-connect`](./omp-astudio-connect) | 把 **AStudio（讯飞 AstronClaw）桌面版**账号的模型接入 omp（`astudio/*`）。读桌面端 `astron-session.json`，向工作室接口换取每模型 `base_url`+令牌，再按 OpenAI chat-completions 透明转发。 | 已安装并登录 AStudio 桌面版 |
| [`omp-loomy-connect`](./omp-loomy-connect) | 把 **Loomy 桌面版**账号的模型接入 omp（`loomy/*`）。读桌面端 `auth-session.json`，按名册直连 OpenAI 兼容面（含双凭据头与 traceparent）。 | 已安装并登录 Loomy 桌面版 |
| [`omp-fast-update`](./omp-fast-update) | **并发分片自更新**：`/omp-update` 多连接 Range 下载 GitHub release 二进制，绕过 `omp update` 的单连接限速（实测 0.3 → 3.6 MB/s）。 | 独立二进制安装（非 bun/npm/brew/mise 管理） |

各插件的原理、风险与限制见各自子目录的 `README.md`（MiMo 的上游协议细节见其 `RESEARCH.md`）。

## magpie 供应商插件（不依赖 omp）

| 目录 | 说明 |
| --- | --- |
| [`magpie-wingwork-connect`](./magpie-wingwork-connect) | 把 **iKooky（WingWork）** 接进 magpie（`wingwork/*`）。按其家族改写思考协议（5.5 一代要自适应，旧一代要 budget）。 |
| [`magpie-astudio-connect`](./magpie-astudio-connect) | 把 **AStudio（讯飞 AstronClaw）** 接进 magpie（`astudio/*`）。按模型路由到它各自的后端网关，含额度卡片。 |
| [`magpie-loomy-connect`](./magpie-loomy-connect) | 把 **Loomy** 接进 magpie（`loomy/*`）。名册里的上下文/输出上限、推理档位、点数倍率全部如实映射。 |
| [`magpie-sub2api-claudecode`](./magpie-sub2api-claudecode) | 把**只放行 Claude Code 客户端的 [sub2api](https://github.com/Wei-Shaw/sub2api) 站点**接进 magpie（`sub2api-cc/*`）。填站点地址与 API Key 登录，请求头与请求体一并伪装成 Claude Code CLI（端点判定逐条对齐 sub2api 自己的校验）。 |

它们跑在 magpie 自己的插件宿主（Bun）里，**与 omp 无关**：omp 不必安装、也不必运行。安装用 `magpie plugin add ./<目录名>`，**不在** `.omp-plugin/marketplace.json` 里（它们不是 omp 插件）。

## 仓库结构

```
.omp-plugin/marketplace.json   # marketplace 目录：omp 插件清单（name / source / version）
AGENTS.md                      # 本仓库的开发与发布规范（提交身份、版本流程、tag 命名）
omp-workbuddy-connect/         # omp 插件 A（独立 npm 包，独立版本号）
omp-mimo-connect/              # omp 插件 B
omp-wingwork-connect/          # omp 插件 C
omp-astudio-connect/           # omp 插件 D
omp-loomy-connect/             # omp 插件 E
omp-fast-update/               # omp 插件 F（工具类）
magpie-wingwork-connect/       # magpie 供应商插件（不是 omp 插件，不进 marketplace）
magpie-astudio-connect/        # 同上
magpie-loomy-connect/          # 同上
magpie-sub2api-claudecode/     # 同上（站点 API Key 登录 + Claude Code 伪装）
```

约定：

- **一个插件 = 一个子目录 = 一个独立包**。根目录不放源码、依赖或构建产物。
- 每个 omp 插件的入口是它自己 `package.json` 的 `omp.extensions` 指向的 TS 文件。
- `marketplace.json` 里每个条目的 `version` **必须**与该子目录 `package.json` 的 `version` 保持一致——否则 `omp plugin upgrade` 与开机自动更新会静默跳过该插件（详见 `AGENTS.md`）。
- 插件可分别安装、升级、卸载；互不牵连。

## 本地开发（不经过 marketplace）

改源码时直接让 omp 加载工作副本，`omp` 重启即生效：

```yaml
# ~/.omp/agent/config.yml
extensions:
  - D:/Projects/omp-plugins/omp-workbuddy-connect
  - D:/Projects/omp-plugins/omp-mimo-connect
  - D:/Projects/omp-plugins/omp-wingwork-connect
  - D:/Projects/omp-plugins/omp-astudio-connect
  - D:/Projects/omp-plugins/omp-loomy-connect
  - D:/Projects/omp-plugins/omp-fast-update
```

不改配置的临时加载：

```bash
omp -e D:/Projects/omp-plugins/omp-loomy-connect/src/index.ts --model loomy/spark-x -p --no-session "只回答：OK"
```

类型检查（在每个子目录内）：

```bash
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```

## 免责声明

- 本仓库插件**仅供个人学习与研究使用**，驱动的是**你自己**机器上**你自己**的账号，不得用于商业用途或超出个人合理使用范围的情形。
- 各插件依赖的是对应**客户端私有端点**（并非官方公开 API），上游随时可能变更协议，届时需跟进适配。使用第三方客户端访问你的账号须遵守相应服务条款，由此产生的后果由使用者自行承担。
- 与腾讯 / WorkBuddy / CodeBuddy / 小米 / MiMo / 科大讯飞 / AStudio / AstronClaw / Kooky / WingWork / Loomy / xfinfr / sub2api / Anthropic / Claude Code **无关联、未经授权、亦未获其背书**；产品名称仅用于描述兼容性，商标归各自所有者。
- 作者对因使用或误用本项目造成的任何直接或间接损失不承担任何责任。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
