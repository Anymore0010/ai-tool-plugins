# dsh 插件（预留）

本目录放 **DeepSeek Harness（`dsh`）** 的插件。目前**没有插件**——只有落位与发布约定，避免以后各机器各写一套。

## 目录约定

```
dsh/
  dsh-<name>/            # 一个插件 = 一个独立 npm 包，目录名 = package.json#name
    package.json         # 含 main / exports；dsh 侧通过 profile bundle 或 patch 挂载
    src/                 # 源码
    README.md            # 原理、安装、风险
    tsconfig.json
```

- 目录名**必须**带 `dsh-` 前缀，与 `omp/`、`magpie/` 的命名保持一致（目录名 = 包名）。
- 运行时依赖尽量为零；只为类型引入 dsh 的包时，放 `devDependencies`。
- **不进** `.omp-plugin/marketplace.json`（那是 omp 的 catalog），版本号独立。
- 发布用本仓库统一流程：`<包名>-v<semver>` tag + `git archive` 出的 portable zip，见根 [`AGENTS.md`](../AGENTS.md#版本更新流程子目录内操作)。

## 接入方式（事实，来自本机 dsh 安装）

- 桌面端把 profile 放在 `~/.dsh/profiles/<profile>/`，结构为 `package.json`（含 `dsh.profile.bundles` 列表）、`cordis.yml`（组合结果，**不要手改**）、`cordis.patch.yml`（你自己的补丁层）、`pnpm-workspace.yaml`。
- 插件包进 profile 的标准做法是 `dsh plugin --profile <profile> add <package|path>`（等价于 pnpm 加依赖）；要让 dsh 真正加载，需要把包名加进 `package.json` 的 `dsh.profile.bundles`，或用 `cordis.patch.yml` 按 `id` 做配置覆盖/插入。
- `~/.dsh/profiles/node_modules` 是 dsh 管理的 **fallback junction 树**：里面每个条目**必须是 junction/symlink**。为改源码而把它替换成真实目录，会让 dsh 启动直接报 `exists and is not a symlink`；要打补丁就改 junction 指向的 npx 缓存副本（流程见 `skill://dsh-profile-junction-patch`）。
- 本地开发：先 `dsh plugin --profile <profile> add <本目录绝对路径>`，再改源码重启 dsh；发版后改回包名安装。

## 待办（新增插件时）

1. 建 `dsh/dsh-<name>/`，写 `package.json`（`name`、`version`、`main`、`files`）。
2. 写 README：它桥接哪个桌面应用 / 服务、读哪些凭据、失败时如何提示。
3. 在根 `README.md` 的 dsh 表格里加一行。
4. 本机验证：`dsh plugin --profile desktop add ./dsh/dsh-<name>` → 重启 dsh → 观察插件是否加载（必要时 `dsh --dump-config` 看组合结果）。
