# 会话计划补全插件 · 二期计划

> 版本：v2.0 计划草案 · 2026-11-02
> 依据：一期交付（见 `dsh-plan-completion/交付说明.md`）+ 本次真机反馈（常驻、计划页视觉、GitHub 发布评估）
> 目标：把「能用」的一期做成「稳、好看、可发布」的二期

---

## 一、二期范围与优先级

### P0（必须，决定可用性与发布）

| # | 事项 | 现状问题 | 方案 | 验收标准 | 预估 |
|---|---|---|---|---|---|
| P0-1 | **挂载时回填（旧会话也能有建议）** | 插件只处理「激活后观察到 turn/end」的会话；老会话打开只有裸入口 | client 挂载时若 `state.stale && !plan`，POST `/plan-completion/warm {sessionId}`；host 用 `session.snapshotEvents` 回填一次计划+建议（可在会话无新回合时工作） | 打开任意历史会话 ≤5s 出现建议；同一会话只回填一次（按 session+seq 去重） | 0.5d |
| P0-2 | **真·常驻（hero / 新会话也有入口）** | `conversation.input.dock` 在无 Session 的 hero 页不渲染；删除全部消息后栏位消失 | 在 `shell.overlay` 增加一个随 composer 定位的轻量 `▤ 计划` 入口（hero 时显示；已有 dock 时隐藏避免重复）；无计划时保留虚线提示胶囊（一期已做） | 新会话 hero、删除全部消息、旧会话、正常会话四种状态都有入口且不重叠 | 0.5d |
| P0-3 | **计划持久化** | 进程内存，DSH 重启丢失 | `storageDomain` 持久化 plan（按 sessionId 分 key）+ 启动时恢复 + 版本号 `gen.rev` 保留 | 重启 DSH 后同一会话仍显示原计划与版本；schema 变更可迁移 | 1d |
| P0-4 | **路由鉴权** | `/plan-completion/*` 调试路由无鉴权（本机回环） | 使用 `connection.requestRejection` 校验来源、或改用 `connection.fetch` 同源校验；调试路由默认仅本机、可配置关闭 | 非本机/非 DSH 页面的请求被拒；客户端不受影响 | 0.5d |
| P0-5 | **「核对进度」按钮** | 计划页只能看状态，无法对照实际进度 | 计划页底部加「核对进度」→ POST `/plan-completion/verify` → 一次模型调用生成「计划 vs 实际差异 + 建议修正」→ 展示在计划页（可折叠、可采纳） | 点击后 ≤5s 返回差异清单；采纳后生成 patch；失败有降级文案 | 1d |
| P0-6 | **发布工程化** | 无 git 仓库 / LICENSE / CI / 包元数据、README 含本地绝对路径 | 见 `发布评估-GitHub.md` 的 P0 清单 | 全部 P0 项 PASS，`node --test` 绿，仓库可公开 | 1d |

### P1（体验增强）

| # | 事项 | 方案 | 验收 |
|---|---|---|---|
| P1-1 | 模型三选一设置页 | 跟随会话默认 / 固定模型 / 自动挑非思考模型；落插件 config + 设置页 | UI 可切换并即时生效，日志记录实际路由 |
| P1-2 | 右栏计划页 | `ctx.sidebarRightTabs.register` 提供常驻计划 tab，浮层保留为快捷入口 | 右栏可打开、与浮层状态一致 |
| P1-3 | 建议「依据」展示 | 保持一行；hover tooltip 显示 `plan.reason`；`suggestionLines: 1\|2` 作为配置项（默认 1） | 默认视觉不变，hover 可看依据 |
| P1-4 | 计划页编辑能力 | 状态点击切换（走 `/steps`）、步骤增删、`/replan` 入口按钮；`editedByUser` 语义保持 | 用户编辑后 gen+1、模型只 patch |
| P1-5 | 每日 token 预算闸 | 配置 `dailyTokenBudget`，超限降级启发式并提示 | 超预算时无模型调用、UI 有提示 |
| P1-6 | 单元测试补强 | client 纯逻辑（normalize/format/fill 决策）抽到可测模块；新增 shared-host 生命周期测试 | 测试 ≥120 且 CI 绿 |

### P2（打磨）

- 计划导出 Markdown / 复制为 checklist；
- 建议历史（最近 5 条，可回填）；
- 多语言补全（en 全文案）；
- 图标与空态插画；
- 性能：轮询降频策略、页面隐藏时暂停；
- 失败重试策略统一（模型超时/空输出/非法 JSON 的退避）。

---

## 二、本轮已顺带修复的技术债（记录）

1. **重复 handler 泄漏**：插件 toggle/hot reload 后旧模块的 HTTP 路由仍存活，导致同一路径出现新旧两个处理实例（`/state` 读旧、`/reset` 写新）。已改为 `globalThis` 共享状态 + 注册前 dispose 旧 disposers。
2. **客户端不清空计划**：服务端返回 `plan:null` 时客户端仍保留旧计划，导致「计划/建议不消失」。已加 `handlePlanFetch → clearPlanResult`。
3. **常驻兜底**：无计划时显示虚线提示胶囊 + `▤ 计划` 入口（已验证 `entryText=▤计划`、`suggestVisible=false`）。
4. **计划页视觉 v2**：卡片式面板（16px 圆角、双层阴影、分区 header/body/footer、状态胶囊、建议高亮卡、底部操作栏），截图验证通过。
5. **调试日志路径可配置**：`config.debugDir` / `DSH_PLAN_COMPLETION_DEBUG_DIR`，为空不写文件（为发布清路径做准备）。

---

## 三、里程碑

| 里程碑 | 内容 | 出口标准 |
|---|---|---|
| M2.0 | P0-1/2/3（回填、常驻、持久化） | 四类会话状态都有入口；重启不丢计划 |
| M2.1 | P0-4/5（鉴权、核对按钮） | 安全审计 + 核对可用 |
| M2.2 | P0-6 + P1-1/2（发布工程化、设置页、右栏） | GitHub 公开、CI 绿、文档齐 |
| M2.3 | P1-3/4/5/6（依据、编辑、预算、测试） | 体验与稳定性达标 |

## 四、风险

- **回填成本**：打开旧会话触发一次模型调用；用「每个会话一次 + 预算闸」控制。
- **跨版本兼容**：持久化 schema 需版本字段与迁移器。
- **鉴权改动**：可能影响现有同源 fetch 契约（一期已验证的通道），需回归。
- **用户编辑锁**：编辑后模型不能 rewrite，需在 UI 明确「/replan 可整体重写」。

