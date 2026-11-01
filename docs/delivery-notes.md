# 交付说明 · 会话计划补全插件（dsh-plan-completion）v0.1.0

> 一期交付 · 2026-11-02 · 真机验收通过
> 设计与实现说明见 `README.md`；设计规格见 `G:\DSH\吃吃喝喝\会话计划补全-设计计划-v1.2.md`
> 实验数据归档见 `G:\DSH\吃吃喝喝\research\archive\2026-11-02-plan-completion\INDEX.md`

## 一、它是什么

在 DSH 输入框上方常驻的「计划补全」助手：

- 每次 AI 回合结束，自动在输入框上方生成一句**可直接发送的下一句建议**；按 `Tab` 填入输入框（只填入、不发送）。
- 左侧常驻 `▤ vX.Y` 入口，点开可看**隐式计划**：步骤列表、每步状态、证据与最近更新原因。
- 计划与建议都是后台由独立模型调用生成，**不进入主对话、不改变 Agent 的提示词/工具/行为**。

## 二、交付物

| 路径 | 说明 |
|---|---|
| `dsh-plan-completion/index.js` | Host 半：事件监听、计划/建议生成、HTTP 路由、slash 命令、用户编辑通道 |
| `dsh-plan-completion/client.js` | Client 半：建议条 + 常驻入口 + 计划 Popover + Tab/快捷键 + 主题适配 |
| `dsh-plan-completion/host/*.js` | 纯函数模块：plan / prompt / evidence / heuristics / config / store / job / experiment |
| `dsh-plan-completion/test/` | 78 个单测（plan / prompt / heuristics / evidence / job / store / pipeline） |
| `dsh-plan-completion/cordis.patch.yml` | 插件装配行 + **生产配置** |
| `dsh-plan-completion/README.md` | 实现说明、触发链路、数据通道、配置、验证状态、已知限制 |
| `research/archive/2026-11-02-plan-completion/` | 实验数据、真机样本、运行日志、验收截图、归档索引 |

## 三、安装 / 卸载

已安装在当前 profile（bundle id `dsh-plan-completion`）。重装 / 卸载：

```powershell
plugin_manager install_bundle target='G:\DSH\吃吃喝喝\dsh-plan-completion'
plugin_manager remove_bundle target='dsh-plan-completion'
```

- **Host 代码变更**：需要一次 profile 重组（`plugin_manager set_plugin` 开关一次，或重装）后生效。
- **Client 代码变更**：需要刷新页面（Ctrl+R）后生效；链接的本地 bundle 不会自动热更。

## 四、使用

| 操作 | 效果 |
|---|---|
| `Tab`（输入框聚焦） | 把当前建议填入输入框（不发送） |
| `Alt+1..3` | 填入第 1~3 条备选建议 |
| `Esc` | 关闭当前建议（只留 `▤` 入口） |
| 点击 `▤ vX.Y` | 打开计划页（步骤 / 状态 / 证据 / 更新原因） |
| `Ctrl+Alt+P` | 快速打开/关闭计划页 |
| `/roadmap` | 在会话里查看当前计划（只读） |
| `/replan <方向>` | 带方向强制重写计划（用户编辑过计划后，这是唯一能整体重写的入口） |

## 五、生产配置（已冻结）

`cordis.patch.yml`：

```yaml
- insert:
    - id: plan-completion
      name: 'dsh-plan-completion'
      config:
        evidenceChars: 1500      # patch 路径证据字符预算
        maxTokensPatch: 400      # patch 输出上限（实测只需 65~120）
        maxTokensRewrite: 1200   # rewrite/冷启动输出上限（输出完整步骤表）
```

改配置 → 重组插件 → 看 Host 启动日志 `host-ready.settings` 确认生效。

## 六、验证证据链

1. **单测**：78 tests / 78 pass / 0 fail。
2. **两轮隔离测试**（固定快照 + 固定计划；温度 0；每组 3 次；字符切片；跨模型盲评）：
   - 证据 800/2000/4000 字符 → 盲评 4.67/5 持平；输出 200/300/500 → 4.63/4.67/4.70；27/27 解析成功、可用率 100%。
   - 结论：证据 800~1200 字符、输出 200~300 tokens 足够；增加上下文无收益。
3. **6 条真机 auto-job 样本**：输出 75~113 tok（均值 88）、延迟 1.25~1.53s、建议 21~36 字、6/6 可用；计划无实质变化时不 bump。
4. **配置生效**：`host-ready.config` 回显 1500/400/1200；force 调用 `maxTokens:1200`、patch 调用 `maxTokens:400`。
5. **UI 验收**：浅色 / 暗色主题截图、建议胶囊与会话卡片左缘对齐、无建议时只剩 `▤`、新会话/切会话行为符合预期。
6. **用户编辑通道**：标记 s4 done → `gen+1 / editedByUser=true / reason 记录`，之后模型只能 patch；整计划整理（分类）→ 7 步 `[交付]/[验证]/[冻结]/[收尾]/[二期]`。

## 七、已知限制（一期）

1. **不覆盖历史会话**：插件只处理「激活后观察到 turn/end」的会话；老会话在产生下一次回合结束前，只有 `▤` 入口、没有建议（当前行为，二期可加「挂载时回填」）。
2. **计划不持久化**：进程内存保存，DSH 重启后计划丢失，下个回合结束重新生成（二期接 `storageDomain`）。
3. **用户编辑锁**：`editedByUser=true` 后模型不能自动 rewrite 覆盖计划，只能 patch；需要整体重构用 `/replan`。
4. **调试路由**：`/plan-completion/experiment|autojob|steps|theme|diag` 仅监听本机回环，无鉴权（二期按 `connection.requestRejection`/`fetch` 收敛）。
5. **无「核对进度」按钮**：计划页当前只展示状态/证据；按需模型核对按钮在二期清单（见下）。
6. **模型选择固定策略**：默认优先非思考模型；用户三选一（跟随默认/固定/自动）设置页在二期。

## 八、二期清单

- [ ] 计划持久化（`storageDomain` + 文件存储，重启不丢）
- [ ] 模型选择设置页（跟随会话默认 / 固定模型 / 自动挑非思考模型）
- [ ] 右栏计划页（`ctx.sidebarRightTabs.register`，替代/补充浮层）
- [ ] 路由鉴权（`connection.requestRejection` / `connection.fetch`）
- [ ] 「核对进度」按钮（按需一次调用，输出计划 vs 实际差异清单）
- [ ] 挂载时回填（打开老会话时按需生成计划/建议）
- [ ] 每日 token 预算闸（可选）

## 九、排障

- 运行日志：`G:\DSH\吃吃喝喝\research\plan-completion-runtime.jsonl`（Host 侧 debugLog；含 `host-ready` / `routes-registered` / `model-usage` / `client-diag` / `user-edit`）。
- 状态自检：`GET /plan-completion/state?sessionId=…`、`GET /plan-completion/debug`。
- 客户端自检：`POST /plan-completion/diag` 上报 `build / hasPill / hasEntry / entryText / suggestVisible / rowHeight` 与计算样式。
- 插件「没显示」排查顺序：① Ctrl+R 刷新页面 → ② 确认 profile 里插件 enabled → ③ `/plan-completion/debug` 看 `host-ready` 服务是否齐全 → ④ 看 `client-diag` 是否有 `hasPill/hasEntry`。

