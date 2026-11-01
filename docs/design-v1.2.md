# 会话计划补全插件 · 设计计划 v1.2

> 状态：设计确认中，**暂不实现**（本文只冻结设计，不含代码）
> 前版：v1.0 / v1.1（保留不动）
> 本版变更：① 开头加"大白话版"给人看；② 模型改为**用户自主选择**（默认经济模型）；③ 详细设计整体下移给 Agent 实现用

---

# 〇、落地状态与计划分类（2026-11-02 更新）

一期已实现并真机验收，按分类归档：

| 分类 | 内容 | 状态 |
|---|---|---|
| `[交付]` | 建议胶囊 + Tab 填入（不发送）+ 常驻 `▤ vX.Y` 入口 + 回合结束自动刷新 + 计划 Popover（全部步骤/证据/更新原因） | ✅ 已完成 |
| `[交付]` | 暗色主题适配 + 全场景视觉验收（胶囊/入口/无建议/新会话/切会话，截图为证） | ✅ 已完成 |
| `[验证]` | 两轮隔离测试（温度 0、每组 3 次、字符切片、跨模型盲评），结论：证据 800~1200 字符、输出 200~300 tokens 足够 | ✅ 已完成 |
| `[验证]` | 6 条真机 auto-job 样本与建议质量偏差记录（输出 75~113 tok、延迟 1.25~1.53s、6/6 可用） | ✅ 已完成 |
| `[冻结]` | 生产配置写入插件 `config`：`evidenceChars=1500`、`maxTokensPatch=400`、`maxTokensRewrite=1200`（Host 启动日志与模型调用日志双确认） | ✅ 已完成 |
| `[收尾]` | README / 设计文档 / 实验数据归档与交付说明 | ✅ 已完成（`dsh-plan-completion/交付说明.md`、`research/archive/2026-11-02-plan-completion/INDEX.md`） |
| `[二期]` | 计划持久化（storageDomain）、模型三选一设置页、右栏计划页、路由鉴权、按需「核对计划」按钮 | ⬜ 待办 |

实现位置：`dsh-plan-completion/`（Host + Client + 78 单测），运行说明见 `dsh-plan-completion/README.md`。

---

# 一、大白话版（给人看的）

## 这是什么

一个输入框小助手。它在后台默默记着"这个会话到底要干什么、现在做到哪一步了"，然后每次 AI 答完，在输入框下面给你一句"下一句可以这么说"，你按一下 Tab，这句话就进输入框，再按回车发出去。

## 用起来是什么感觉

1. 你开个新会话，说"给项目加个登录页"。
2. 它自己在后台列一份 3~7 步的小计划（**不显示给你**，除非你点开看）。
3. AI 干完这件活，输入框下面出现一行灰字：
   `Tab 填入 ·「登录页先跑起来看看效果，再继续接 token 拦截器」`
4. 按 Tab，这句话进输入框；想改就改，不想改直接回车发出去。
5. 输入框右下角一直有个很淡的 `▤ v2.3`。点开能看到完整计划、手动打勾/改步骤，还能一键把"我改过的计划"变成一句话发回给 AI。

## 它不会做的事（重要）

- **不会改 AI 的行为**，不会偷偷往提示词里塞东西；
- **不会往聊天记录里写任何东西**，聊天记录里看不到"计划"这两个字；
- **不会自动替你发消息**——Tab 只是填进输入框，发不发由你；
- **不会弹窗打扰你**，出错了就安静地不显示。

## 花钱吗

- 默认有一个"便宜快"的模型专门干这件事，每回合最多问它一次，只传最近的口头对话摘要，回一句话。
- 你也可以**完全关掉模型**，只用免费规则（比如"上一步报错了 → 建议修报错""计划下一步没做 → 建议去做"），一样能用。
- 可以设每天最多问多少次，超了就自动只用免费规则。

## 能用什么模型（你说了算）

- 三种方式任选：**跟随当前会话的模型** / **指定某个模型** / **自动挑最便宜的**。
- 默认是"指定一个经济模型"，装的时候让你选一次，之后随时能改。
- 如果选中的是"会思考"的模型（R1、o1 这类），它会提醒"这个慢而且贵"，并优先降到最低思考档，或干脆换回便宜的。
- 选不到可用模型时，自动退回免费规则，不会报错给你看。

## 现在到哪一步了

设计已经定稿（就是本文）。**还没写一行代码**。下一步是花十几分钟做几个只读验证——确认输入框能不能塞整段文字、计划存哪里、右栏面板能不能加——验证完再开始实现。

---

> 下面从第二节开始是给 Agent 实现用的详细规格，人不用细读。

---

# 二、模型选择（D12，本轮新增）

## 2.1 三种模式

| 模式 | 行为 | 默认 |
|---|---|---|
| `follow` 跟随会话 | 取本会话最后一条 assistant 消息的 provider/model | — |
| `fixed` 指定模型 | 用户从"已配置的 provider/model 列表"里选一个 | **默认** |
| `auto` 自动经济 | 从可用列表里挑最便宜/最快的路由（规则可配） | — |

首次安装：引导用户选一次模型（默认高亮最便宜的可用路由）；不选就用 `auto` 兜底。

## 2.2 可选项从哪来

- Host 半：`llm.listProviders()` → 已注册的 provider 路由；`llm.listModels(provider)` → 该路由下的模型。
- 这些列表通过插件自己的 Remote 端点暴露给设置页下拉框。
- 不可用/未授权的路由照样可以显示但标注"不可用"；被选中时调用失败 → 熔断 5 分钟并退回启发式，不打扰用户。

## 2.3 思考模型处理

- 调用前 `llm.resolveModelInfo(provider, model)`：
  - 声明了 `reasoning` → 设最低 `reasoningEffort`；不支持设置则提示一次并建议换模型；
  - 未声明 → 直接调用。
- `follow` 模式下如果会话模型是思考模型，同样走上面逻辑（这也是为什么默认不选 `follow`）。

## 2.4 覆盖粒度

- v1：**全局一个模型设置**，所有会话共用。
- 不提供按会话覆盖（后续如需要再加，见 §8 N1）。

---

# 三、详细设计（Agent 实现用）

## 3.1 变更记录

| 版本 | 变更 |
|---|---|
| v1.0 | 初稿：计划台账 + 建议条 + Tab 填入 + 常驻入口 |
| v1.1 | 双截止线；固定经济模型；全局并发闸；watermark 校验；锚定 Popover；同步给 Agent；TTL GC；注入防护 |
| **v1.2** | 开头加大白话版；模型改为**用户三选一**（默认经济模型，D12）；细节补充模型选择实现 |

## 3.2 已确认的决策

| # | 决策 | 结论 |
|---|---|---|
| D1 | 计划给不给主模型看 | **不给**（纯观察者，不注入 system prompt、不加工具、不改 agent 行为） |
| D2 | 计划写不写会话日志 | **不写**（插件私有存储，避免污染 log / fork / 回放） |
| D3 | 建议出现时机 | **回合结束后立即出现**（目标 1~2s 内出条） |
| D4 | 计划条目粒度 | **3~7 个里程碑**，每条挂证据，不到 todo 级 |
| D5 | 版本方案 | 双段 `gen.rev`：rewrite → `gen+1.0`；patch → `gen.rev+1`；保留 5 版 |
| D6 | 重写触发 | **证据驱动**（阶段边界）+ 用户 `/replan` 强制；不是定时器 |
| D7 | 入口位置 | 不进工具行（权限模式是 single 槽、`+` 无扩展点）；放 dock 区 |
| D8 | 入口可见性 | **常驻**（无建议时也在，做淡） |
| D9 | 模型只能"提议" | Host 校验后"提交"；非法输出不落地，保留 last-good |
| D10 | 默认模型 | **指定经济模型**（用户可选，见 D12） |
| D11 | 计划页形态 | **v1 锚定 Popover，v2 右栏面板** |
| **D12** | **模型是否用户可选** | **是，三选一：跟随会话 / 指定模型 / 自动经济；默认指定经济模型** |

## 3.3 系统分层

```
┌─ Host 半（每会话计划作业队列 + 全局并发闸）─────────────────┐
│  session/event(turn/end) ─┐                               │
│  agent/turn-stopping(预热) ┤                               │
│  /replan 命令 ────────────┴─► PlanJob（串行、可取消、幂等）│
│      → 只读收集证据（最近消息/工具结果/文件变更/todo/goal）│
│      → 1 次 ctx.llm.stream()（独立于 agent loop，模型见 §2）│
│      → 输出 { op, reason, steps, suggestion }              │
│      → 校验（schema/diff/版本单调/防抖/注入过滤）           │
│      → 原子写计划存储（key=sessionId）                      │
│      → wire view 发布 { 计划摘要, suggestion }              │
└───────────────────────────┬────────────────────────────────┘
                            │ projection（只读）
┌─ Client 半 ───────────────┴────────────────────────────────┐
│  conversation.composer.dock：建议条 + 常驻入口 ▤ v2.3       │
│  Tab → inputActions.captureInsertion() + insertText()      │
│  入口点开 → 计划 PAGE（shell.overlay 锚定 Popover）          │
└────────────────────────────────────────────────────────────┘
```

边界：Host 不碰 agent，只订阅事件、读状态、调 `llm.stream`、写自己的存储。
`/replan` 会留下 `command/run` / `command/done` 两条日志事件（用户主动触发，可接受）。

## 3.4 数据模型：Plan

```jsonc
{
  "sessionId": "s_7f3a",
  "version": { "gen": 2, "rev": 3 },
  "status": "active",                         // active | completed | archived
  "intent": "给 Vue 项目加登录页，接入现有鉴权",
  "steps": [
    { "id": "s1", "title": "摸清现有路由与鉴权结构", "status": "done",
      "evidence": ["read:src/router.ts"], "source": "model" },
    { "id": "s2", "title": "新增 Login.vue 与路由", "status": "doing",
      "evidence": ["write:src/views/Login.vue"], "source": "model" },
    { "id": "s3", "title": "接入 token 存储与请求拦截器", "status": "todo", "source": "user" },
    { "id": "s4", "title": "补测试并跑通", "status": "todo" }
  ],
  "updatedAt": 1762000000000,
  "reason": "第2步完成（已创建 Login.vue）",
  "revisionOf": { "gen": 2, "rev": 2 },
  "watermark": { "turn": 7, "seq": 214 },
  "editedByUser": false,
  "stats": { "calls": 12, "tokensIn": 18321, "tokensOut": 2014 }
}
```

约束：`steps` 3~7 条；`status ∈ {todo,doing,done,dropped}`；`source ∈ {model,user}`；每次 bump 必带 `reason`；只保留最近 5 版；存储用 Host 私有存储域（key=sessionId，具体 API 待 P0 探针）。

## 3.5 重写执行模型

### 3.5.1 流水线

```ts
onTurnStopping(session) { evidence.prewarm(session) }         // 可选：只采集
onTurnEnd(session, ev) { enqueue({ sessionId, kind: 'turn', watermark: ev.seq }) }
onCommandReplan(session, instruction) {
  enqueue({ sessionId, kind: 'force-rewrite', instruction })
  return { kind: 'success', text: '计划重写已开始…' }          // 不阻塞命令
}

async function run(job) {
  if (queue.superseded(job)) return
  await globalGate.acquire()                                  // in-flight ≤ 2
  try {
    const ctx = await collectEvidence(job)
    const out = await callModel(ctx, { deadlineMs: 6000 })    // 计划落盘截止线
    if (!valid(out)) return keepLastGood(job)
    const next = job.kind === 'force-rewrite' || out.op === 'rewrite'
      ? rewritePlan(ctx.plan, out) : patchPlan(ctx.plan, out)
    if (!commit(next, { cas: ctx.plan.version })) return
    if (job.suggestionDeadlineMet(2500) && job.suggestionStillValid()) {
      publish(ctx.plan, out.suggestion)                       // 建议展示截止线
    }
  } finally { globalGate.release() }
}
```

### 3.5.2 幂等、合并与一致性

- 幂等键 `(sessionId, turn)`，`turn/end.seq` 作 watermark；重连/重放不重复跑。
- 同会话串行；期间新事件只标脏，跑完后按最新状态再跑一次。
- **全局并发闸**：跨会话共享信号量 `in-flight ≤ 2`（可配）。
- **一致性校验**：提交前确认当前日志仍含 `plan.watermark`；失配 → 标 `stale`，**不自动回退历史版本**，下一次 `turn/end` 重建式 rewrite。
- 事实：DSH 会话日志 append-only，**无 rewind**；回退仅以 `sessions.fork({ atSeq })` 派生新会话形式存在。fork 子会话 seq 语义待 P0 探针。

### 3.5.3 取消与失效

| 时机 | 计划更新 | 建议发布 |
|---|---|---|
| 新一轮开始 | 允许继续提交 | **丢弃** |
| 会话切换 / 入口关闭 | 继续 | 可发布，客户端按当前会话过滤 |
| 插件卸载 / 会话归档 | 取消 | 取消 |
| 用户 Esc 关闭建议条 | 不受影响 | dismissed，本回合不弹 |

### 3.5.4 超时、失败与熔断

| 阶段 | 截止线 | 超时行为 |
|---|---|---|
| 建议展示 | 2.5s | 不弹建议；计划仍继续落盘 |
| 计划落盘 | 6s | 放弃，保留 last-good，静默 |
| 强制重写 | 8s | 返回"重写失败，已保留原计划"（用户主动触发，可见） |
| 模型不可用 | — | 熔断 5 分钟 + 退回启发式，不打扰 |
| JSON 非法 | — | 修复重发 1 次；仍失败静默 |
| 连续 3 次失败 | — | 熔断 5 分钟；入口小黄点 |

铁律：任何失败都不打扰用户、不阻塞发送、不阻塞 `Tab`。

### 3.5.5 模型路由与预算

- 模型选择见 §2（D12）：`follow` / `fixed` / `auto`，默认 `fixed`=经济模型。
- 调用：`ctx.llm.stream()`，独立于 agent loop；不改 agent 请求、不加工具。
- 预算：每会话 ≤ 1 次/回合；每日上限可配（默认 300）；全局 in-flight ≤ 2；超限只走启发式。
- 输入成本：patch ≈ 旧计划 + 本回合摘要（~1.5k tokens）；rewrite ≈ 完整计划 + 最近 3 回合 + 首条消息（~4k）；输出 < 300。token 用 `StreamChunk.usage` 实算。

### 3.5.6 状态机

```
计划: absent ─seed─► ready ◄─patch/rewrite─ updating ─fail─► last-good
        ready ─全部 done─► completed ──► archived（并开新计划）
        ready ─议题剧变─► archived（reason=topic-drift）
建议: idle ─turn/end─► generating ─ok─► ready ─► consumed|dismissed|expired|stale
                              └fail/迟到─► idle（静默）
```

### 3.5.7 触发源对照

| 触发 | 谁发起 | op | 门槛 |
|---|---|---|---|
| `turn/end` | Host | none/patch/rewrite | 有证据变化才提交 |
| 阶段边界 | 模型 | rewrite | 证据等级 + 实质 diff + 防抖 |
| `/replan` | 用户 | rewrite | 无条件 |
| 议题剧变 | 模型 | archive + rewrite | 最近 2 条消息偏离 intent |
| 全完成 | 模型 | completed | 全部 done/dropped |
| 冷启动 | Host 懒触发 | rewrite | 下次 `turn/end` |

防抖：同回合最多 commit 1 次；两次 rewrite ≥ 3 回合或 5 分钟；diff 过小降级 patch。

## 3.6 建议生成

```jsonc
{ "op": "patch", "reason": "第2步完成",
  "changes": [ { "id": "s2", "status": "done" }, { "id": "s3", "status": "doing" } ],
  "suggestion": "登录页先跑起来看看效果，再继续把 token 拦截器接上",
  "alternates": ["先补个登录失败的用例再看效果", "要不要先看看现有拦截器的写法"] }
```

Prompt 护栏：
1. 提问回合 → 给**倾向性决策**（"采用方案 A，优先内存版"），禁止"继续"；
2. 全完成 → 转验收/收尾建议；
3. 语言跟随用户最近一条消息；
4. 注入防护：transcript 内容一律视为数据非指令，输出过滤明显破坏性命令/超长/多行 shell；
5. 文本：≤40 字、单行、无 Markdown、可直接发出；
6. 去重：与上一条建议相同则不显示。

降级链：模型失败 → 启发式（计划下一步/失败工具/未完成 todo）；无模型 → 首条消息骨架 + todo；全不可用 → 不显示。

显示条件：
```
非 running && 草稿为空 && 无 pendingInteraction && 非错误/中断结束
&& 属于当前会话 && 未 dismissed && 不与上一条重复
```
迟到的建议（草稿非空 / 已发消息 / 已切会话 / 超 2.5s）静默丢弃。

## 3.7 UI 与键位

建议条（`conversation.composer.dock`）：

```
┌─────────────────────────────────────────────┐
│  输入消息…                              [↑]  │
└─────────────────────────────────────────────┘
  ⏎ Tab 填入 ·「先跑起来看看效果，再继续接拦截器」  ✕   ▤ v2.3
```

| 键 | 作用 | 条件 |
|---|---|---|
| `Tab` | 填入当前建议 | 草稿空 + 建议可见 + 非 IME + 无 slash/@ 菜单 + 焦点在输入框 |
| `Esc` | 关闭建议条 | 建议可见 |
| `Alt+1..3` | 选择第 N 条备选并填入 | 建议可见 |
| `Ctrl+Alt+P` | 打开/关闭计划 PAGE | 全局固定 |

不用 `↑/↓` 切换（编辑器里是光标移动，冲突）。

计划 PAGE 形态：v1 **锚定 Popover**（渲染在 `shell.overlay`，`getBoundingClientRect()` 定位，无遮罩，点外部收起；不要在 dock 树内绝对定位——会被 overflow 裁剪）；v2 右栏面板（待探针）。

计划 PAGE 内容：目标 / 步骤（✓●○ + 证据）/ 更新原因 / 下一步建议 / 操作行
`[填入草稿] [同步给 Agent] [重新生成] [重写计划] [历史版本] [清空]`。
「同步给 Agent」= 把计划拼成一句指令 `insertText` 填入草稿（不发送）。

## 3.8 用户可自定义

| 设置 | 默认 | 说明 |
|---|---|---|
| 总开关 | 开 | 关掉不生成不显示 |
| 建议来源 | 启发式+模型 | 可只保留启发式 |
| **模型模式** | **指定模型（经济）** | `follow` / `fixed` / `auto`，见 §2 |
| **模型选择** | 首次引导 | 下拉选 provider/model；标注不可用 |
| Tab 行为 | 填入草稿 | 另一档直接发送 |
| 重写档位 | 平衡 | 保守/平衡/激进 |
| 建议条位置 | composer.dock | 另一档 input.overlay |
| 入口常驻样式 | `▤ v2.3` | 另一档仅图标 |
| fork 继承计划 | 是 | 待探针确认语义 |
| 版本保留数 | 5 | 1~20 |
| 每日调用上限 | 300 | 超出走启发式 |
| 全局并发 | 2 | in-flight 上限 |
| 预热 | 开 | P2 |
| 建议语言 | 跟随用户 | 跟随/中文/英文 |
| 危险建议过滤 | 开 | 拦截破坏性形态 |
| 数据保留 | 90 天 | TTL GC |
| 快捷键 | Ctrl+Alt+P | 可改 |

计划可编辑：手动改状态/标题/增删 → `gen+1`、`reason="user edit"`、`source="user"`、`editedByUser=true`；用户版**高优先级**，模型只能 patch 不能自动 rewrite 覆盖。

命令：`/roadmap`（只读展示）、`/replan [说明]`（强制重写）、`/roadmap clear`（清空）。

## 3.9 待拍板 / 待探测

| # | 问题 | 状态 |
|---|---|---|
| Q1–Q8 | 前版遗留 | 全部关闭（Q2 在 v1.2 细化为 D12） |
| D12 | 模型是否用户可选 | **已定：三选一，默认指定经济模型** |
| N1 | 是否按会话覆盖模型 | v1 不做，全局一个设置 |
| N2 | fork 子会话 seq 语义 | **待 P0 探针** |
| N3 | `InputActions` 能否整段替换草稿 | **待 P0 探针** |
| N4 | `rightbar` tab 注册对插件是否开放 | **待 P0 探针** |
| N5 | 危险建议过滤严格度 | 待定，默认只拦明显破坏性命令 |

## 3.10 落地阶段

| 阶段 | 内容 |
|---|---|
| **P0 探针** | `InputActions` 全量方法；`storageDomain` 用法；`rightbar` tab 注册；fork seq 语义 |
| **P1 最小可用** | 计划生成（patch/rewrite）+ 存储 + 建议条 + Tab 填入 + 常驻入口 Popover（启发式先跑通） |
| **P2 模型化** | `llm.stream` 接入 + 模型三选一设置页 + 双截止线 + 全局并发 + 预算熔断 + 思考模型兜底 + 预热 + 注入过滤 |
| **P3 计划 PAGE** | 完整交互、步骤编辑、同步给 Agent、历史回滚 |
| **P4 增强按钮（B 功能）** | 复用 LLM 管道做草稿增强 |

## 3.11 风险清单

| 风险 | 缓解 |
|---|---|
| Tab 抢键 / IME | 三条件收紧 + 可改键 + 组合期放行 |
| 每回合调用成本 | 证据跳过 + 缓存 + 预算闸 + 全局并发 + 启发式兜底 |
| 思考模型慢/贵 | 默认经济模型 + reasoning 探测兜底 + 用户可换 |
| 计划漂移 | 版本 + reason + 回滚 + 用户编辑优先 |
| 模型输出非法 | 校验提交 + last-good + 修复重发 |
| 迟到建议 | 会话过滤 + 丢弃不补弹 |
| 间接提示注入 | 只填不发 + 标记 AI 建议 + 数据非指令 + 危险形态过滤 |
| 并发打爆限流 | 全局 in-flight ≤ 2 |
| 存储泄漏 | TTL GC；不得用 `session/disposed` 当删除信号 |
| 升级稳定性 | 只用公开 slot / standard props / Service；`inputActions` 是唯一需盯接口 |
| 隐私 | 只发最近摘要；模型选择与开关可见 |

