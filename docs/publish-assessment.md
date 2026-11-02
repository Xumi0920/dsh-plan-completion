# GitHub 发布评估 · 会话计划补全插件（2026-11-02）

> 历史文档：以下保留 v0.1.0 的交付/评估/计划记录。**当前最新为 v0.1.7**（计划停更检测 + 建议文本保真 + 核对进度 + 本地计划持久化 + 鉴权/状态一致性/隐私边界修复），详见 [security.md](security.md) 与 [CHANGELOG](../CHANGELOG.md)；旧记录中的“无鉴权”、原始诊断字段与独立评审不代表当前实现。
>
> v0.1.7 发布记录（2026-11-02）：设置页 DSH 视觉对齐 + 第三方 provider 模型列表修复。tag `v0.1.7`；npm `dsh-plan-completion@0.1.7`；138/138 tests。
>
> v0.1.6 发布记录（2026-11-02）：模型设置页（settings.plugins.tab）+ settings 持久化；Tab 建议日志仅本地不发布。tag `v0.1.6`；npm `dsh-plan-completion@0.1.6`；138/138 tests；CI run 41393937067。
>
> v0.1.5 发布记录（2026-11-02）：计划停更检测——连续 2 次 op=none 后建议变为 `/replan …` 并标记 stale。tag `v0.1.5` + [Release](https://github.com/Xumi0920/dsh-plan-completion/releases/tag/v0.1.5)；Actions [run 41391402601](https://github.com/Xumi0920/dsh-plan-completion/actions/runs/41391402601)（四 job 全绿，133/133 tests）；npm `dsh-plan-completion@0.1.5`（shasum `c53c6d7ef79d8634913054db79fa9e5b1e86b182`）。
>
> v0.1.4 发布记录（2026-11-02）：建议文本保真修复（标识符/路径/命令保留 + 语义化截断）。tag `v0.1.4` + [Release](https://github.com/Xumi0920/dsh-plan-completion/releases/tag/v0.1.4)；GitHub Actions [run 41389845733](https://github.com/Xumi0920/dsh-plan-completion/actions/runs/41389845733)（四 job 全绿，132/132 tests）；npm `dsh-plan-completion@0.1.4`（31 files，shasum `a6f8953445e330081243f9f9d6b429fd4402b341`）。
>
> v0.1.3 发布记录（2026-11-02）：tag `v0.1.3` + [Release](https://github.com/Xumi0920/dsh-plan-completion/releases/tag/v0.1.3)；GitHub Actions [run 41368609382](https://github.com/Xumi0920/dsh-plan-completion/actions/runs/41368609382)（Ubuntu/Windows × Node20/22 四 job 全绿，126/126 tests）；npm `dsh-plan-completion@0.1.3`（31 files，shasum `11adee0fe9acff199a180be511ca8bc600afdf6f`）；canary 验证 `/plan-completion/verify` 未认证 401、客户端鉴权请求正常。
>
> v0.1.1 发布记录（2026-11-02）：tag `v0.1.1` + [Release](https://github.com/Xumi0920/dsh-plan-completion/releases/tag/v0.1.1)；GitHub Actions [run 41366651557](https://github.com/Xumi0920/dsh-plan-completion/actions/runs/41366651557)（Ubuntu/Windows × Node20/22 四 job 全绿）；npm `dsh-plan-completion@0.1.1`（31 files，shasum `18989b0f50b72d5c8c332f3fdee7f43ccb5fd91a`）。
>
> v0.1.2 发布记录（2026-11-02）：tag `v0.1.2` + [Release](https://github.com/Xumi0920/dsh-plan-completion/releases/tag/v0.1.2)；GitHub Actions [run 41367719292](https://github.com/Xumi0920/dsh-plan-completion/actions/runs/41367719292)（Ubuntu/Windows × Node20/22 四 job 全绿，120/120 tests）；npm `dsh-plan-completion@0.1.2`（31 files，shasum `e9d5d61ae2cb35f043e2eb7d05a38786d2699626`）；真机持久化 canary 通过（6 个会话计划落盘、会话文件 `gen5.rev0` 可读回、subagent 真实回合自动写入）。

> **2026-11-02 晚更新：P0 清单已全部完成，状态从「不满足全 PASS」→「可按 GitHub 源码仓库发布」。**
>
> | 项 | 状态 |
> |---|---|
> | B1 git 仓库 | ✅ 已 `git init` + 提交（见 git log） |
> | B2 LICENSE | ✅ MIT（`LICENSE`） |
> | B3 包元数据 | ✅ `name=dsh-plan-completion`、license/repository/keywords/engines/scripts/author；`private:false`；profile 已完成改名并验证运行 |
> | B4 本地绝对路径 | ✅ README/config 已无绝对路径；发布版 patch 不含 `debugDir` |
> | B5 调试路由鉴权/收敛 | ✅ 默认关闭（`enableDebugRoutes:false`），生产路由仅 state/debug/diag/replan/warm |
> | B6 运行时数据不入库 | ✅ `.gitignore` 排除 research/*.jsonl 等；仓库仅含源码+文档+脱敏截图 |
> | B7 CI | ✅ `.github/workflows/test.yml` 已启用（GitHub Actions，Node 20/22 矩阵，push/PR 触发；README 带 badge） |
> | B8 CHANGELOG/CONTRIBUTING | ✅ 已补 |
>
> 发布状态：GitHub 仓库 public、`main` 已推送、tag `v0.1.0` + Release 已创建；GitHub Actions 已启用并 **CI 全绿**（Node 20/22 双 job success）；**npm 已发布 `dsh-plan-completion@0.1.0`**（https://www.npmjs.com/package/dsh-plan-completion，shasum `274044abe5906d0551802033b4dfe16ac05e45`，integrity `sha512-Q3bf67…Ka7D9w==`，与发布输出一致）。
> 包名改名已完成并在本机 profile 验证（`remove @local/...` + `install <repo>`，运行状态与计划在重装后保持）。

结论先说：**代码与文档质量达到"可以开源"，但当前状态"不满足全 PASS"**。
按下面的 P0 清单做完（约 1 天工作量），即可公开；P1 是加分项。

评估范围：`<repo>`（插件源码，含 78 个单测）+ 两份设计/交付文档 + 实验归档。
结论依据：代码走查、`node --test` 实测、目录/元数据检查、敏感信息扫描。

---

## 一、总览评分

| 维度 | 状态 | 说明 |
|---|---|---|
| 代码质量 | ✅ PASS | Host/Client 分层清晰，纯函数模块（plan/prompt/evidence/heuristics/config/store/job）可单测 |
| 测试 | ✅ PASS | `node --test`：**78 tests / 78 pass / 0 fail**（含 pipeline 集成测试） |
| 文档 | 🟡 部分 | README/交付说明/设计文档齐全，但 README 有 6 处本地绝对路径、缺 CHANGELOG/CONTRIBUTING |
| 安全 | 🟡 部分 | 源码无密钥/密码（已扫描）；但 6 个调试路由无鉴权、默认写本地日志目录 |
| 隐私/数据 | 🟡 部分 | 运行日志与实验档包含 sessionId、UA、对话摘要片段；不应进公开仓库 |
| 包元数据 | ❌ FAIL | `private:true`、`name=@local/...`、无 license/repository/keywords/engines/author |
| 仓库工程 | ❌ FAIL | 工作区**不是 git 仓库**；无 LICENSE、.gitignore、CI workflow、CHANGELOG |
| 可移植性 | 🟡 部分 | 默认 `debugDir` 可配置（已改），但 patch 示例仍带本地路径；README 路径需泛化 |
| 视觉/演示资产 | 🟡 部分 | 有真机截图（归档目录），但仓库内无 screenshots/demo 目录 |
| 许可证合规 | ❌ FAIL | 无 LICENSE 文件，无法合法声明开源许可 |

**当前结论：6 项 PASS / 4 项部分 / 4 项 FAIL → 不满足"全 PASS"。**

---

## 二、P0 阻塞项（发布前必须修）

| # | 阻塞项 | 现状 | 修复动作 |
|---|---|---|---|
| B1 | 无 git 仓库 | 工作区不是 repo | 只把插件目录+文档纳入仓库：`git init` → `.gitignore` → 首次提交（建议独立 repo，不要把 research/、其他项目带进去） |
| B2 | 无 LICENSE | 缺失 | 选 MIT（或 Apache-2.0）→ `LICENSE` + package.json `license` 字段 |
| B3 | package.json 元数据不全 | `private:true`、`@local/` 前缀、无 license/repository/author/keywords/engines | 改名 `dsh-plan-completion`（或保留 scoped），补全字段；若只做 GitHub 源码分发可保留 private=false 但不发 npm |
| B4 | 本地绝对路径 | README 与文档中存在本地绝对路径；`cordis.patch.yml` 有本地 `debugDir` | README/文档改成相对路径/占位符；发布版 patch 去掉 `debugDir`（代码已支持 env 覆盖） |
| B5 | 调试路由无鉴权 | `/plan-completion/experiment|autojob|steps|reset|diag|theme` | 发布版：默认关闭调试路由（config `enableDebugRoutes:false`），或加来源校验（`connection.requestRejection`） |
| B6 | 运行时数据/实验档不应入库 | `research/plan-completion-runtime.jsonl`（含 sessionId/UA/对话片段）、`research/archive` | `.gitignore` 排除 `research/`、`*.jsonl`、实验/样本 JSON；如需展示数据，脱敏后放 `docs/` |
| B7 | 无 CI | — | `.github/workflows/test.yml`：Node 20/22 矩阵跑 `node --test test/*.test.js`；可选 markdown lint |
| B8 | 缺 CHANGELOG / CONTRIBUTING | — | 加 `CHANGELOG.md`（0.1.0 初始）+ `CONTRIBUTING.md`（本地安装/调试命令） |

## 三、P1 建议（发布后 1~2 周）

1. 仓库结构建议：
   ```
   dsh-plan-completion/        # 根即插件包（保持现在结构）
   ├── index.js client.js host/ locale/ test/
   ├── cordis.patch.yml  package.json  icon.svg
   ├── README.md  LICENSE  CHANGELOG.md  CONTRIBUTING.md  .gitignore
   ├── docs/             # 设计计划 v1.2、二期计划、交付说明
   ├── docs/screenshots/ # 建议新增 3 张（浅色/暗色/计划页）
   └── .github/workflows/test.yml
   ```
2. 安全：调试路由默认 off + 请求来源校验；README 增加「隐私说明：插件会把会话摘要发送给模型」。
3. 质量：把 client 纯逻辑抽出来补测试（目标 ≥120 用例）；host 生命周期（重载不重复注册）加回归测试。
4. 发布：打 tag `v0.1.0` + GitHub Release notes（引用交付说明）；可选 npm publish（需 dsh 生态约定）。
5. 版本要求：package.json 增加 `engines.dsh` 或 README 明确最低 DSH 版本（本插件依赖 `dsh.client/slots/webServer/llm/commands` 契约）。

## 四、已具备的发布优势

- **契约经过探测验证**：槽位、InputActions、同源 HTTP、斜杠命令均在真机日志中有证据（`research/p0-contract.md`）。
- **可量化验收**：两轮隔离测试 + 6 条真机样本 + 78 单测 + 配置生效日志，README/交付说明可复现。
- **成本与预算有结论**：稳态 ~1.2k tokens/回合、patch 输出 75~113 tokens，有明确默认值与依据。
- **无第三方运行时依赖**：只用 Node 标准库 + React（宿主提供），发布门槛低。
- **面向失败的设计**：模型失败走启发式 fallback、CAS 版本冲突、用户编辑优先、超时降级。

## 五、发布命令草稿（确认后执行）

```powershell
cd <repo>
git init
# 先补 LICENSE / .gitignore / CI / CHANGELOG / 元数据 / 移除本地路径与调试路由默认值
git add .
git commit -m "feat: initial release v0.1.0"
git remote add origin https://github.com/<you>/dsh-plan-completion.git
git push -u origin main
git tag v0.1.0 && git push --tags
```

> 建议：**先把 P0 B1~B8 全部打勾，再公开仓库**；否则许可证与数据问题会成为不可逆的历史提交。






