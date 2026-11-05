# Plan Completion（计划补全）

[![test](https://github.com/Xumi0920/dsh-plan-completion/actions/workflows/test.yml/badge.svg)](https://github.com/Xumi0920/dsh-plan-completion/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/dsh-plan-completion?style=flat-square&color=4D6BFE)](https://www.npmjs.com/package/dsh-plan-completion)
[![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![release](https://img.shields.io/github/v/release/Xumi0920/dsh-plan-completion?style=flat-square)](https://github.com/Xumi0920/dsh-plan-completion/releases/latest)
[![tests](https://img.shields.io/badge/tests-292%20pass-brightgreen?style=flat-square)](.github/workflows/test.yml)
[![requirements](https://img.shields.io/badge/requires-Node%20%3E%3D20%20%7C%20DSH%20%3E%3D0.2.1--rc.5-4D6BFE?style=flat-square)](package.json)

DSH 计划/补全插件，为会话维护计划，在输入框上方展示下一步建议；Tab 只填入草稿，不自动发送。保留 DSH 原生回复、工具与长上下文。

开发或修改插件界面前，阅读 [设计规范读取入口](docs/ui-design-contract.md)。完整通用设计体系统一维护在私密仓库 `Xumi0920/dsh-plugin-design-system`；入口固定规范版本与 commit，并保留本插件的业务边界。[AGENTS.md](AGENTS.md) 和 [开发说明](CONTRIBUTING.md) 均指向该入口；插件运行无需访问规范仓库。

当前为 **0.4.3**：具备同包六组件（root / observer / embedding / retrieval / generator / api）与独立托管 Q8；计划面板与 DSH 原生主题对齐，支持严格回执校验与人工验收。

- **0.4.3**：README 补齐安装/界面预览/核心交互/环境配置/文档导航；设计规范入口固定到私密仓库 v1.0.0；文档站内跳转与仓库行尾格式统一。
- **0.4.2**：npm 包纳入 `docs/ui-design-contract.md` 入口；`engines.dsh` 放宽为 `>=0.2.1-rc.5`。
- **0.4.1**：计划面板 DSH 主题对齐、完成状态可读性、头部/底栏固定与窄窗口适配。
- **0.4.0**：Q8 运行服务拆分独立 `embedding` 组件；六组件补齐中英文名称/职责/icon 元信息。
- **0.3.0**：零配置托管 Q8（默认关闭，确认后自动下载/校验/拉起）。
- **0.2.0**：兼容进度协议、人工验收、同包多组件。

## 安装与升级

插件以 DSH Cordis bundle 发布，推荐在 DSH 内安装：

1. **DSH 插件页**：打开「插件 → 添加插件」，选择/输入 npm 包 `dsh-plan-completion`，按 DSH 提示完成安装与启用。
2. **源码 / 本地开发**：
   ```powershell
   plugin_manager install_bundle target='<absolute path to this repo>'
   ```
   也可以按 `cordis.patch.yml` 把六组件行加入 profile。

升级：更新 bundle 后，Host 代码需要 toggle 一次插件（`plugin_manager set_plugin` 关闭再开启）或重新安装以重组 profile；Client 代码刷新 DSH 页面即可。设置页版本行显示当前 `vX.Y.Z · build ...`；本地链接 bundle 不会热更新 `client.js`。

## 界面预览

计划面板与输入框上方的常驻入口（当前 0.4.x，真实 DSH 截图）：

<p align="center">
  <img src="https://raw.githubusercontent.com/Xumi0920/dsh-plan-completion/main/docs/screenshots/plan-panel-light.png" alt="计划面板（浅色）" width="420">
  <img src="https://raw.githubusercontent.com/Xumi0920/dsh-plan-completion/main/docs/screenshots/plan-panel-dark.png" alt="计划面板（深色）" width="420">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Xumi0920/dsh-plan-completion/main/docs/screenshots/composer-entry.png" alt="输入框上方的 Tab 建议与 ▤ 计划入口" width="640">
</p>

## 核心交互

| 操作 | 行为 |
|---|---|
| `Tab` | 将当前建议填入输入框（只写草稿，不发送） |
| `Alt+1..3` | 选择第 1~3 条候选建议填入 |
| `Esc` | 关闭计划浮层；无浮层时忽略当前建议 |
| `Ctrl+Alt+P` | 打开 / 关闭计划浮层 |
| 点击输入框上方的 `▤ vX.Y` | 打开 / 关闭计划浮层 |
| 面板内「同步给 Agent / 核对进度 / 填入草稿」 | 让 Agent 关注计划、核对进度、写入草稿 |
| 面板内「人工验收 / 撤销」 | 记录或撤销用户来源的验收（manual scope） |
| `/replan` | 请求重新规划；保留验收仍有效的完成步骤 |


## 兼容性与验收

默认 `progressProtocol: legacy` 保留 0.1.8 的状态 patch、连续两次 none 后的 /replan 提示，以及 rewrite 行为。界面明确标注“模型报告，未经执行验收”。

Settings 可显式选择 strict：模型只提出计划和验收条件；Host 按原始执行回执、验收版本及依赖关系计算完成。中文会话、英文思考和助手声明均不能冒充执行证据。/replan 会保留验收仍有效的完成步骤，新增条件不能追认旧执行。

没有机器回执的人工验收步骤可在计划面板确认或撤销，记录来源为用户。撤销或更改前置验收会使依赖步骤失效。切回 legacy 不会绕过已版本化计划的校验。

## 同一个插件，多个组件

| 组件 | 职责 | 关闭后的影响 |
|---|---|---|
| 计划补全（核心） | 会话状态、配置、持久化、恢复校验和客户端入口 | 依赖它的组件一起停止；已保存的计划保留 |
| 会话事件观察 `observer` | 监听事件、触发更新、按原始回执核验进度 | 停止自动跟踪，旧完成状态待重新核验 |
| 本地 Q8 运行服务 `embedding` | 准备模型、管理 llama.cpp 进程及运行状态，只生成文本向量 | 回收所托管的进程；检索退回关键词，计划生成仍可运行 |
| 会话上下文检索 `retrieval` | 维护内存索引、中文/英文检索、保留约束；借用向量服务 | 清空检索索引，保留计划；独立 Q8 服务仍受自身空闲策略管理 |
| 计划与补全生成 `generator` | 调用所选 DSH 生成模型提出计划和下一句建议 | 停止生成和重排，事件观察与回执核验可继续 |
| 计划界面接口 `api` | 计划面板、Tab 建议、设置、人工确认和命令的鉴权接口 | 界面和命令无法读取/操作计划，后台组件可继续运行 |

六个组件均提供 DSH 插件列表可读取的中英文名称和说明。Q8 运行服务与检索分开管理，仍属于同一个插件；它不是 DSH 的通用模型提供者，其他插件不会自动共享它。

旧单行 profile 自动挂载全部职责；旧五行 profile 未声明 `embedding` 时仍由 retrieval 的兼容入口托管 Q8。更新 bundle 后新增独立运行服务行；已存在但被禁用的 embedding 行不会被兼容逻辑重新开启。配置、计划和模型安装目录保持原路径。外部 embedding endpoint 仍可用，不依赖本地 Q8 运行组件。

需要立即释放本地 Q8 进程时，关闭「本地 Q8 运行服务」或在插件设置关闭 RAG；只关闭检索组件会清空索引，独立运行服务随后按空闲策略回收。旧五行配置中关闭 retrieval 仍会同时回收其兼容托管的 Q8。

## 本地 Q8（零配置，默认关闭）

默认关闭 RAG，也关闭向生成模型发送检索片段。首次在设置里打开开关时会弹一次确认，说明将要做什么；确认后**不需要填写任何路径**：

1. 自动下载并校验官方 llama.cpp 运行时（Windows/Linux x64；Windows 优先 Vulkan，GPU 不可用时自动回退 CPU 构建）；
2. 自动下载官方 Qwen3-Embedding-0.6B Q8 模型（约 610MB），启动前核对官方 SHA-256；
3. 在本机回环端口启动 llama-server（随机端口、一次性密钥、随机模型别名）；空闲、组件关闭或 DSH Host 退出时自动回收。

下载通过系统代理/环境代理（优先 curl）进行，模型与运行时不进入 npm 包、不随包分发。高级设置里仍可指定安装目录、固定 CPU/Vulkan 变体，或关闭“自动下载”后手动提供 `llama-server` 与官方模型路径；旧的自定义 endpoint 继续以 external 后端兼容。

llama.cpp 仍是第三方开源推理引擎，DSH 插件负责其生命周期，并不把它变成 DSH 内置模型引擎。

配置、故障恢复和数据边界见 [托管 Q8 说明](docs/managed-embedding.md)；测试范围见[托管验证记录](docs/managed-validation.md)（仓库内）。自动化无法覆盖原生桌面完整点击链，本版以真实 DSH 加载/组件启停/Q8 进程 canary 作为发布验收依据；未覆盖项如实保留在文档中。

## 环境要求与配置

| 依赖 | 要求 |
|---|---|
| Node.js | `>=20` |
| DSH | `>=0.2.1-rc.5`（`engines.dsh` 不设上限） |
| 本地 Q8（可选） | Windows / Linux x64；首次开启自动下载 llama.cpp 与 Qwen3-Embedding-0.6B Q8（约 610MB） |

常用配置来自 `cordis.patch.yml`：

| 配置 | 默认 | 说明 |
|---|---|---|
| `progressProtocol` | `legacy` | `strict` 只按原始执行回执/人工验收推进 |
| `modelCalls` | `true` | 关闭后不调用生成模型，回执核验保留 |
| `persistPlans` | `true` | 按会话持久化计划与最近建议 |
| `storageDir` | `~/.dsh/plan-completion-data` | 跟随显式 DSH_HOME；自定义目录保留原义 |
| `rag.enabled` | `false` | 本地检索；首次开启需确认并准备 Q8 |
| `rag.sendContextToGenerator` | `false` | 是否向所选生成模型发送检索片段 |
| `evidenceChars` / `maxTokensPatch` / `maxTokensRewrite` | `1500` / `800` / `1200` | 证据预算与生成 token 上限 |

## 隐私与验证

本地 embedding 不外发。若开启“发送检索片段给计划助手”，片段将经选定的 DSH 生成模型路由发送；本地检索不等于生成流程离线。计划和建议可明文持久化。默认存储跟随显式 DSH_HOME；自定义目录保留原义，旧共享目录不会自动导入隔离环境。详见[安全与隐私边界](docs/security.md)。

运行 `npm test` 与 `npm run check:package`。当前基线：**292/292 PASS**（Ubuntu/Windows × Node 20/22），打包校验 **57 files / 6 exports**。后者离线安装实际 tarball，检查六个 Host 入口及各组件中英文说明。实验数据、测试脚本、截图和模型二进制不进入 npm 包。真实硬件检查可按托管说明运行 `scripts/check-managed-runtime.mjs`。

[历史设计与实验档案](docs/experiment-archive.md)保留在仓库，作为 v0.3.0 时代的历史快照（源码历史可用对应 tag 查看）；历史近 1M/多次压缩结果不当作本轮重新测试结果。

可选原生加载器检查：`node scripts/check-components-dsh.mjs <DSH运行时目录>`。目录需包含 `node_modules/@deepseek-ai`。脚本使用临时 DSH_HOME，检查六行、旧五行、旧单行配置的加载、中英文元信息与组件启停；不调用生成模型、不下载或启动 Q8，不替代真实硬件与桌面点击验收。

## 文档导航

| 文档 | 内容 |
|---|---|
| [设计规范读取入口](docs/ui-design-contract.md) | 私密设计仓库的固定版本入口 + 本插件业务边界 |
| [托管 Q8 说明](docs/managed-embedding.md) | 零配置安装、手动路径、故障恢复与数据边界 |
| [安全与隐私边界](docs/security.md) | 鉴权、数据外发、模型/检索边界 |
| [兼容性说明](docs/compatibility.md) | 六组件、进度协议、旧 profile 兼容 |
| [发布评估记录](docs/publish-assessment.md) | 各版本 tag / CI / npm / 验证记录 |
| [托管验证记录](docs/managed-validation.md) | 0.2.0 候选阶段历史验证归档 |
| [历史设计 v1.2](docs/design-v1.2.md) | 早期产品设计（历史） |
| [一期交付说明](docs/delivery-notes.md) · [二期计划](docs/phase-2-plan.md) · [实验档案](docs/experiment-archive.md) | 历史交付、计划与实验归档 |

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
