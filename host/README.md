# `host/` 接线指南（给 index.js / review / 后续维护用）

本目录是「会话计划补全」插件的 **Host 纯逻辑层**：纯 ESM、零依赖、**不 import 任何 DSH 包**。
所有与运行时交互（LLM、存储、发布、时钟、取消）都通过 index.js 注入的**端口**完成，
因此 `node --test` 可以在没有 DSH 的环境里直接跑。

---

## 0. 文件清单

| 文件 | 职责 |
|---|---|
| `config.js` | 所有默认参数（双截止线 2500/6000/8000ms、并发 2、步骤 3~7、保留 5 版、prompt 上限等）。index.js 可用插件 Config 覆盖后传入。 |
| `text.js` | 文本清洗：单行化、去 Markdown、≤40 字、危险命令过滤、提问检测。 |
| `plan.js` | Plan 数据模型：`normalizePlan` 校验、`patchPlan`/`rewritePlan`/`applyUserEdit` 版本规则、`statusFor`、`mayRewrite`。 |
| `prompt.js` | `SYSTEM_PROMPT` + `buildPatchPrompt`/`buildRewritePrompt`/`buildRepairPrompt` + `parseModelOutput`。 |
| `heuristics.js` | 模型不可用时的 `heuristicSuggestion`（失败工具/下一步/提问决策/验收）与 `fallbackPlan`（3~5 步骨架）。 |
| `evidence.js` | `collectFromEvents`：SessionEvent[] → 证据对象（纯函数，不改输入）。 |
| `job.js` | `runJob` 完整流水线（双截止线、CAS、降级）+ `createQueue`（同会话串行/合并/幂等/全局并发闸）。**当前 index.js 走内联流水线，job.js 为后续重构备选**（见 §7）。 |
| `store.js` | `createMemoryStore()`（同步，一期默认）+ `createFileStore(dir)`（异步、原子写，预留）。 |

测试在 `../test/*.test.js`。

---

## 1. 运行测试

```powershell
# 标准方式（Lead/CI 用这个；Node 绝对路径按本机）
& 'C:\Users\Antia\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' `
  --test dsh-plan-completion/test
```

当前结果：**6 个测试文件 / 75 tests / 75 pass / 0 fail**（Node v24.21.0）。

> 受限 shell 备注：本会话早期沙箱下 `node --test <目录>` 会因测试 runner 子进程
> `spawn EPERM` 失败，可用 `--test-isolation=none` + 显式文件列表绕过：
>
> ```powershell
> $node = 'C:\Users\Antia\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
> $files = Get-ChildItem 'dsh-plan-completion\test\*.test.js' | ForEach-Object { $_.FullName }
> & $node --test --test-isolation=none @files
> ```
>
> 完全权限的 shell 不需要这个 workaround。文件存储测试用 `os.tmpdir()`，不写工作区。

---

## 2. index.js 接线指南

### 2.1 import（导出名已与 Lead 契约对齐）

```js
import {
  normalizePlan, statusFor, patchPlan, rewritePlan, applyUserEdit,
  createSeedPlan, mayRewrite,
} from './host/plan.js'
import { buildPatchPrompt, buildRewritePrompt, SYSTEM_PROMPT, parseModelOutput } from './host/prompt.js'
import { heuristicSuggestion, fallbackPlan } from './host/heuristics.js'
import { collectFromEvents } from './host/evidence.js'
import { createQueue, runJob } from './host/job.js'
import { createMemoryStore } from './host/store.js'
```

### 2.2 端口（index.js 注入；运行时已确认可用的能力）

```js
const ports = {
  // ctx.get('llm').stream({ provider, model, system, messages, maxTokens, temperature, signal })
  // 消费 text-delta 拼成字符串后返回「模型原文」（不要在这里解析 JSON）
  callModel: async ({ system, messages, maxTokens, temperature, signal }) => rawText,

  // store.put 返回 boolean
  commit: async (plan, { cas }) => store.put(plan, { cas }),

  // 写内存 stateBySession + 供 HTTP GET /plan-completion/state 读取
  publish: async ({ plan, suggestion, turn /*, 以及下面 §2.6 的附加字段 */ }) => { /* ... */ },

  now: () => Date.now(),

  signal: abortController.signal, // 可选；/replan 超时/会话归档时 abort
}
```

`callModel` 的返回**只接受模型原始文本**（string）。若你的适配器返回 `{text}` 对象，
`job.js` 的 `extractModelText` 也能兼容，但请优先返回 string。

### 2.3 事件订阅（probe-verify 实测契约）

```js
ctx.on('session/event', (session, event) => {   // 注意是双参：session 在前，event 在后
  if (event.type !== 'turn/end') return

  const sessionId = session.id
  const events = session.snapshotEvents()      // readonly SessionEvent[]（或 session.ownEvents()）
  const plan = store.get(sessionId)            // 计划存储 key=sessionId

  const evidence = collectFromEvents({
    events,
    plan,
    turn: event.data.turn,                     // turn/end.data = { turn, reason: { kind } }
    sessionId,
  })
  // evidence.interrupted === true 表示 reason.kind 是 aborted/interrupted/error
  // 设计 §3.6「非错误/中断结束」才显示建议；计划是否更新由你决定（建议过滤掉发布即可）

  // ↓ 进入内联流水线（与 job.runJob 等价），见 §2.4
})
```

SessionEvent 字段（实测）：`{ type, seq, time, data }`，**`seq` 在顶层**；
`turn/end.data.reason.kind ∈ completed|aborted|blocked|error|max-tokens|interrupted|forked`。

### 2.4 内联流水线（index.js 现状；runJob 内部步骤相同）

```js
async function runTurnJob({ sessionId, turn, plan, evidence }) {
  const t0 = ports.now()
  const commitDeadlineMs = 6000
  const suggestionDeadlineMs = 2500
  const watermark = evidence.watermark           // {turn, seq}，seq 来自事件顶层 seq

  // 1) 构造提示：有 plan → patch；冷启动/强制 → rewrite
  const prompt = plan
    ? buildPatchPrompt(evidence)
    : buildRewritePrompt(evidence)

  // 2) 调模型（失败/JSON 非法 → 修复重发 1 次；超 6000ms 放弃）
  const raw = await ports.callModel({ system: prompt.system, messages: prompt.messages,
    maxTokens: prompt.maxTokens, temperature: prompt.temperature, signal: ports.signal })
  if (ports.now() - t0 > commitDeadlineMs) return { committed: false, published: false, reason: 'plan-deadline' }
  let parsed = parseModelOutput(raw)
  if (!parsed.ok) {
    const repair = buildRepairPrompt(prompt, raw, parsed.error)
    const raw2 = await ports.callModel({ system: repair.system, messages: repair.messages,
      maxTokens: repair.maxTokens, temperature: repair.temperature, signal: ports.signal })
    parsed = parseModelOutput(raw2)
  }

  // 3) 校验 + 版本 bump + CAS 落盘
  let nextPlan = null, committed = false, baseReason = 'ok'
  if (parsed.ok) {
    const out = parsed.output                     // {op,reason,changes,steps,intent,suggestion,alternates}
    let applied
    if (out.op === 'rewrite' || !plan) {
      applied = rewritePlan(plan ?? null, out, { reason: out.reason, watermark, now: ports.now(), force: /* /replan */ false, sessionId })
    } else if (out.op === 'patch') {
      applied = patchPlan(plan, out.changes, { reason: out.reason, watermark, now: ports.now() })
    } else {
      applied = { ok: true, plan: null, changed: false }   // op=none
    }
    if (applied.ok && applied.plan && applied.changed !== false) {
      committed = await ports.commit(applied.plan, { cas: plan ? plan.version : null })
      if (!committed) baseReason = 'cas-conflict'
      else nextPlan = applied.plan
    }
  } else {
    baseReason = 'model-invalid'
  }

  // 4) 建议：模型建议 → 没有就用启发式；双截止线 + 与上一条去重
  let suggestion = parsed.ok ? parsed.output.suggestion : ''
  if (!suggestion) {
    const heur = heuristicSuggestion({ ...evidence, plan: nextPlan ?? plan })
    suggestion = heur.ok ? heur.text : ''
  }
  const published = Boolean(suggestion) &&
    ports.now() - t0 <= suggestionDeadlineMs &&
    suggestion !== lastSuggestion
  if (published) await ports.publish({ plan: nextPlan ?? plan, suggestion, turn, sessionId, version: (nextPlan ?? plan)?.version ?? null, watermark, alternates: parsed.ok ? parsed.output.alternates : [], op: parsed.ok ? parsed.output.op : 'none', fallback: !parsed.ok })

  return { committed, published, reason: baseReason === 'ok' && committed && published ? 'ok' : baseReason, plan: nextPlan }
}
```

如果不想自己维护这段，可以直接用 `runJob`（见 §7），它的返回是
`{ok, committed, published, reason, plan, suggestion, op, version, fallback, attempts, durationMs, error, publishSkip?}`。

### 2.5 冷启动（计划不存在时）

- 第一次 `turn/end` 且 `store.get(sessionId) === null` 时用 `buildRewritePrompt`；
- 模型失败/输出非法时，用 `fallbackPlan(evidence.intent)`（3~5 步骨架）+
  `createSeedPlan({ sessionId, intent, steps, watermark, reason: 'seed-fallback' })` 落版本 `0.0`；
- `runJob` 已内置这条降级链，内联实现可照抄 §2.4 的 else 分支。

### 2.6 HTTP 路由（GET /plan-completion/state?sessionId=…）

`publish` 的 payload 建议整份存入 `stateBySession.set(sessionId, payload)`，GET 路由直接返回；
结构（`publish` 会传的超集，按需取用）：

```jsonc
{
  "plan": { /* §3.4 完整 Plan；commit 失败时为 last-good */ },
  "suggestion": "≤40 字单行建议",       // 空字符串表示本回合无建议
  "turn": 9,
  "sessionId": "s_7f3a",
  "version": { "gen": 2, "rev": 3 },
  "watermark": { "turn": 9, "seq": 902 },
  "alternates": ["备选1", "备选2"],
  "op": "patch",                        // 本次模型 op：none|patch|rewrite
  "fallback": false,                    // true = 建议来自启发式
  "kind": "turn",                       // turn | force-rewrite
  "at": 1762000000000
}
```

客户端展示条件（非 running/草稿空/无 pendingInteraction/非错误结束/当前会话/未 dismissed/未重复）
由 client-ui 用这份 payload + 自身状态判断；`evidence.interrupted` 可在 Host 侧先过滤发布。

### 2.7 用户操作

| 操作 | 推荐用法 |
|---|---|
| 手动编辑计划 | `applyUserEdit(plan, {steps, intent?}, {reason:'user edit'})` → `commit(next, {cas: plan.version})`；之后 `mayRewrite(plan) === false`，模型自动 rewrite 会被拒，只能 patch。 |
| `/replan [说明]` | 用 `buildRewritePrompt(evidence, {force:true})`；`rewritePlan(plan, out, {..., force:true})` 覆盖用户版并**重置 `editedByUser=false`**。 |
| `/roadmap` | 直接返回 `store.get(sessionId)`。 |
| `/roadmap clear` | `store.clear(sessionId)`。 |
| 历史版本 | `store.history(sessionId)`（旧→新）；`store.prune(5)` 保留最近 5 版。 |

---

## 3. 数据契约

### 3.1 Plan（与设计文档 §3.4 一致）

```jsonc
{
  "sessionId": "s_7f3a",
  "version": { "gen": 2, "rev": 3 },
  "status": "active",                    // active | completed | archived
  "intent": "给 Vue 项目加登录页，接入现有鉴权",
  "steps": [
    { "id": "s1", "title": "摸清现有路由与鉴权结构", "status": "done",
      "source": "model", "evidence": ["read:src/router.ts"] },
    { "id": "s2", "title": "新增 Login.vue 与路由", "status": "doing", "source": "model" },
    { "id": "s3", "title": "接入 token 存储与请求拦截器", "status": "todo", "source": "user" }
  ],
  "updatedAt": 1762000000000,
  "reason": "第2步完成（已创建 Login.vue）",
  "revisionOf": { "gen": 2, "rev": 2 },
  "watermark": { "turn": 7, "seq": 214 },
  "editedByUser": false,
  "stats": { "calls": 12, "tokensIn": 18321, "tokensOut": 2014 }  // 可选
}
```

约束：`steps` 3~7；`status ∈ {todo,doing,done,dropped}`；`source ∈ {model,user}`；
版本规则 `rewrite → gen+1, rev=0`、`patch → gen.rev+1`、首版 `0.0`；每次 bump 必带 `reason`。
`normalizePlan` 会丢弃未知字段、补默认值，非法输入返回 `{ok:false, code, error}`（永不 throw）。

### 3.2 evidence（`collectFromEvents` 输出）

```jsonc
{
  "ok": true,
  "sessionId": "s_7f3a",
  "turn": 9,
  "seq": 902, "watermark": { "turn": 9, "seq": 902 },
  "intent": "…",                        // plan.intent，没有则首条用户消息
  "plan": { /* 传入的 plan 副本，未传为 null */ },
  "lastAssistantText": "…",             // 最后一条 assistant 正文（只取 text block，截断 1500 字）
  "toolCalls": [{ "name": "write", "ok": true, "callId": "c2", "path": "src/views/Login.vue" }],
  "failedTools": [{ "name": "bash", "ok": false, "callId": "c3", "error": "EACCES: permission denied" }],
  "lastUserMessages": ["…", "…"],       // 最近 2 条（跨回合），各截断 500 字
  "firstUserMessage": "…",
  "recentMessages": [{ "role": "user", "text": "…" }],
  "todoSteps": [{ "id": "s3", "title": "…", "status": "todo" }],
  "files": ["src/views/Login.vue"],
  "hasQuestion": false,
  "turnEnded": true, "turnEndReason": "completed", "turnEndError": "", "interrupted": false,
  "counts": { "events": 108, "toolCalls": 3, "failedTools": 1, "messages": 6, "userMessages": 9 }
}
```

事件按实测契约解析：`turn/start|turn/end|user/message|assistant/message|tool/call|tool/result`；
正文只取 `{type:'text'}` content block（reasoning/tool-call 块不进入证据）；
工具失败以 `tool/result.message.isError === true` 为准，工具名按 `callId` 回填到 `tool/call`。
`events` 直接用 `session.snapshotEvents()` 或 `session.ownEvents()` 的返回值。

### 3.3 模型输出 JSON（prompt 要求的 schema）

```jsonc
// patch
{ "op": "patch", "reason": "第2步完成",
  "changes": [ { "id": "s2", "status": "done", "evidence": ["write:src/views/Login.vue"] } ],
  "suggestion": "…≤40字…", "alternates": ["…"] }
// rewrite
{ "op": "rewrite", "reason": "阶段边界", "intent": "…",
  "steps": [ { "id": "s1", "title": "里程碑", "status": "todo" } ],
  "suggestion": "…", "alternates": ["…"] }
// 没有实质变化
{ "op": "none", "reason": "本回合无实质变化", "suggestion": "…" }
```

`parseModelOutput(text)` 返回：

```js
{ ok: true,
  output: { op:'none'|'patch'|'rewrite', reason, changes, steps, intent, suggestion, alternates },
  flags:  { op, suggestionFiltered, suggestionTruncated, alternatesFiltered, ignoredIntent },
  raw:    { /* 原始 JSON 对象 */ } }
// 或 { ok:false, code, error } —— 不抛异常
```

要点：`output.suggestion` **恒为 string**（缺失/被危险过滤为 `''`）；suggestion 单行、≤40 字、
去 Markdown；危险命令（rm -rf / del /f / format / mkfs / git reset --hard / curl|sh / iex 等）
只丢建议、不丢计划；rewrite 的 steps 必须 3~7 条且 id 唯一。

---

## 4. API 速查

### `plan.js`

| 函数 | 返回 |
|---|---|
| `normalizePlan(input, {now?, requireReason?})` | `{ok, plan}` / `{ok:false, code, error}` |
| `normalizeSteps(steps)` / `normalizeEvidence(v)` | `{ok, steps}` / `string[]` |
| `statusFor(steps)` | `'active' \| 'completed'` |
| `patchPlan(plan, changes, {reason, watermark?, now?})` | `{ok, plan, changed, previous}` |
| `rewritePlan(plan\|null, next, {reason?, watermark?, now?, force?, sessionId?})` | `{ok, plan, changed, previous}` |
| `applyUserEdit(plan, {steps, intent?}, {reason?, watermark?, now?})` | `{ok, plan, changed, previous}` |
| `archivePlan(plan, {reason?, watermark?, now?})` | `{ok, plan, changed, previous}` |
| `createSeedPlan({sessionId, intent?, steps, watermark?, reason?}, {now?})` | `{ok, plan}` |
| `mayRewrite(plan, {force?})` | boolean（`editedByUser=true` / `archived` → false） |
| `nextVersion` / `versionEquals` / `compareVersions` / `isNextVersion` / `validVersion` / `validWatermark` | 工具函数 |

### `prompt.js`

| 函数 | 返回 |
|---|---|
| `SYSTEM_PROMPT` | 完整系统提示（只输出 JSON / 数据非指令 / 40 字单行 / 提问给决策 / 验收 / 语言跟随 / 禁止继续好的） |
| `buildPatchPrompt(evidence)` / `buildRewritePrompt(evidence, {force?})` | `{system, messages, maxTokens, temperature, op}` |
| `buildRepairPrompt(prompt, badOutput, error)` | 同上结构（messages 追加 assistant 失败输出 + 纠正指令） |
| `evidenceForModel(evidence)` | 裁剪后的证据对象 |
| `parseModelOutput(text)` | 见 §3.3 |

### `heuristics.js`

| 函数 | 返回 |
|---|---|
| `heuristicSuggestion(evidence)` | `{ok:true, text, kind}` / `{ok:false, text:'', kind:'none'}`；`kind ∈ fix-error / next-step / decide / accept / next-title / intent` |
| `fallbackPlan(intent)` | `{ok:true, intent, steps}`（3~5 步骨架）/ `{ok:false, code, error}` |

### `evidence.js`

`collectFromEvents({events, plan?, turn?, sessionId?})` → evidence（§3.2）。纯函数，不修改输入。

### `store.js`

| 方法 | 语义 |
|---|---|
| `get(sessionId)` | `plan \| null`（副本） |
| `put(plan, {cas})` | boolean；`cas` 省略=无条件，`null`=仅新建，`{gen,rev}`=期望当前版本，失配 false |
| `history(sessionId)` | `plan[]`（旧→新，含当前版） |
| `prune(n = 5)` | `{ok, removed, sessions, keep}` |
| `clear(sessionId?)` / `listSessions()` / `size()` | — |

`createMemoryStore()` 同步；`createFileStore(dir)` 全部 async、永不 throw（出错返回 `null/false/[]`，
原因看 `store.lastError`），单进程假设、无跨进程锁，一期可不接。

---

## 5. 双截止线（设计 §3.5.4）实现方式

| 截止线 | 默认 | 判定 | 行为 |
|---|---|---|---|
| 建议展示 | 2500ms | 模型返回后 `now() - t0` | 超过 → 不发布建议，计划照常提交（`reason: 'suggestion-deadline'`） |
| 计划落盘 | 6000ms | 模型返回后 `now() - t0` | 超过 → 放弃、保留 last-good（`reason: 'plan-deadline'`） |
| 强制重写 | 8000ms | 同上（`forceRewrite`/`kind:'force-rewrite'`） | 超时返回 `userMessage: '重写失败，已保留原计划'` |

`runJob` 用注入的 `now()` 做**确定性判定**（测试用假时钟，不需要真的等 6 秒）；
同时内部用 `setTimeout` 兜底「模型调用真正挂起」的情况并 `abort` 注入的 signal。
`commitDeadlineMs` / `suggestionDeadlineMs` 可由 `runJob({..., commitDeadlineMs, suggestionDeadlineMs})`
或 job 字段覆盖（默认 6000/2500，强制重写 8000）。

---

## 6. 与设计文档的差异 / 实现取舍（review 重点）

1. **`/replan` 强制重写后重置 `editedByUser=false`**：设计未写明。理由：`/replan` 是用户主动要求
   覆盖，若不重置会让「用户版锁」永久生效；普通模型自动 rewrite 仍被 `mayRewrite` 拒绝。
2. **rewrite 防抖取「且」**：设计写「两次 rewrite ≥ 3 回合或 5 分钟」（有歧义），实现为
   **≥3 回合且 ≥5 分钟** 才允许自动 rewrite（`rewriteAllowed`）；范围内的小 diff 由 `runJob`
   降级成 `patchPlan`（`diffToChanges` 可 patch 时）。
3. **patch 无实质变化仍 bump rev**：符合验收「patch → rev+1」，但返回 `changed:false`；
   调用方（或 `runJob`）据此**跳过 commit**。内联流水线请检查 `applied.changed !== false`。
4. **`op:'none'` 也要求 `reason` 非空**：输出 schema 统一；`none` 不变更版本。
5. **suggestion 超 40 字是截断而不是整条丢弃**；危险形态只丢建议、计划照常提交（`flags.suggestionFiltered`）。
6. **`maxTokens` 取 patch 800 / rewrite 1200**：设计预算「输出 <300 tokens」是理想值，真机实测 3~7 步 JSON
   （尤其长 reason + 多 changes）在 400/700 会被截断成非法 JSON；index.js 侧同样把下限调到 800/1200，
   并配合「parse 失败 → `buildRepairPrompt` 重发 1 次」。`test/job.test.js` 覆盖了「首轮截断 → 修复轮成功提交」
   与「超长 reason + 7 条 changes」用例。
7. **证据的消息取全量最近 2 条（跨回合）**，工具调用/失败只取本回合（与「本回合工具调用名与失败项 +
   最近 2 条用户消息」一致）。
8. **`runJob` 返回的 `reason`** 是结构化枚举（`ok / suggestion-deadline / plan-deadline / model-invalid /
   model-error / cas-conflict / commit-error / no-op / rewrite-locked / rewrite-debounced / superseded / aborted /
   internal`…），`committed`/`published` 才是主判据；`plan` 仅在提交成功时为新版，否则 `null`。
9. **`createQueue` 幂等键**：`sessionId:turn`；强制重写追加 `:replan` 后缀，避免与同回合 turn/end 撞键。
10. **`fallbackPlan` 返回 `{ok, intent, steps}` 而非 Plan**：Plan 由 `createSeedPlan` 生成并统一校验。
11. **file store 为预留接口**（异步、单进程、无锁）；一期 index.js 用插件内存 Map + 可选 JSON 文件即可。
12. **`job.js` 当前未接线**：Lead 的 index.js 自己实现了内联流水线（与 webServer 路由/事件订阅耦合），
    `runJob`/`createQueue`/`createRunner` 保留为后续重构备选，接口与内联流水线同构。

---

## 7. job.js 队列（后续重构备选）

当前 index.js 走内联流水线。若之后改成队列化，直接用：

```js
const { queue, submit } = createRunner({ ports, limit: 2 })  // limit = 全局并发闸（默认 2）
const res = await submit({
  sessionId, turn: event.data.turn,
  kind: 'turn',                              // 或 'force-rewrite' / forceRewrite: true
  watermark: evidence.watermark,
  plan: store.get(sessionId),
  evidence,
  lastSuggestion,                            // 去重
  rewriteGate: { lastRewriteTurn, lastRewriteAt },  // 防抖（可选）
})
// res: {ok, committed, published, reason, plan, suggestion, op, version, fallback, attempts, durationMs, error}
```

`createQueue` 保证：同会话串行；运行中到来的作业合并成一条 pending（`mergeJobs`，取最新
watermark/evidence，强制重写优先）；完成后只再跑一次最新作业；幂等键去重（默认 10 分钟窗口）；
跨会话 `globalGate(limit)` 并发闸（in-flight ≤2）；`close()` 取消未开始的合并作业；
`idle()` 等全部空闲。执行器签名 `execute(job, runtime)`，`runtime.isSuperseded()` 表示运行期间
是否已有更新作业在排队（据此丢弃迟到建议）。

> 也可以只用 `createQueue`（自定义 execute），或只用 `runJob`（自管队列）。

---

## 8. 防御性约定

- 所有公共函数**永不 throw**：非法输入返回 `{ok:false, code, error}`；解析模型输出/证据采集
  均包 try/catch。
- 纯函数不修改输入：`normalizePlan`/`patchPlan`/`rewritePlan`/`collectFromEvents`/`evidenceForModel`
  都返回新对象，测试里有输入快照断言。
- store 的 `get`/`history` 返回副本，改返回值不会污染存储。
- 任何失败都不阻断用户发送 / Tab 填入（Host 只负责建议与计划，不碰 agent loop）。
