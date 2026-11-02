# 交付说明 · 会话计划补全插件（dsh-plan-completion）v0.1.0

> 历史文档：以下保留 v0.1.0 的交付/评估/计划记录。**v0.1.1 已发布**（鉴权、状态一致性、隐私边界修复），详见 [security.md](security.md) 与 [CHANGELOG](../CHANGELOG.md)；旧记录中的“无鉴权”、原始诊断字段与独立评审不代表当前实现。

> 一期交付 · 2026-11-02 · 真机验收通过
> 设计与实现说明见 `README.md`；设计规格见 `docs/design-v1.2.md`
> 实验数据归档见 `docs/experiment-archive.md`

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
| `dsh-plan-completion/test/` | 111 个单测（plan / prompt / heuristics / evidence / job / store / pipeline / Host 接线 / Client 生命周期 / 安全与隐私） |
| `dsh-plan-completion/cordis.patch.yml` | 插件装配行 + **生产配置** |
| `dsh-plan-completion/README.md` | 实现说明、触发链路、数据通道、配置、验证状态、已知限制 |
| `docs/experiment-archive.md` | 实验与验收数据摘要（仓库内）；原始数据仅本地保留（`research/archive/…`） |

## 三、安装 / 卸载

已安装在当前 profile（bundle id `dsh-plan-completion`）。重装 / 卸载：

```powershell
plugin_manager install_bundle target='<repo>'
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

## 七、已知限制（v0.1.1 现状）

1. **旧会话回填已支持**（v0.1.1）：打开插件从未观察过的会话时，Client 会 POST `/plan-completion/warm`，Host 从持久化会话日志重建计划+建议（同一会话 10 分钟内只回填一次；需要一次模型调用，可用 `warmBackfill:false` 关闭）。不触发回填时仍只有 `▤` 入口。
2. **计划不持久化**：进程内存保存，DSH 重启后计划丢失，下个回合结束重新生成（二期接 `storageDomain`）。
3. **用户编辑锁**：`editedByUser=true` 后模型不能自动 rewrite 覆盖计划，只能 patch；需要整体重构用 `/replan`。
4. **调试路由**：`experiment|autojob|steps|theme|diag|reset|debug` 仅在 `enableDebugRoutes:true` 时注册，且与其他路由一样必须通过宿主 `connection.requestRejection`（v0.1.1 起）。
5. **无「核对进度」按钮**：计划页当前只展示状态/证据；按需模型核对按钮在二期清单（见下）。
6. **模型路由**：v0.1.1 起只使用宿主当前默认 provider/model（不再自动改投其他供应商）；`modelCalls:false` 可关闭插件全部模型调用。用户三选一设置页仍在二期。

## 八、二期清单

- [ ] 计划持久化（`storageDomain` + 文件存储，重启不丢）
- [ ] 模型选择设置页（跟随会话默认 / 固定模型 / 自动挑非思考模型）
- [ ] 右栏计划页（`ctx.sidebarRightTabs.register`，替代/补充浮层）
- [x] 路由鉴权（`connection.requestRejection` / `connection.fetch`）——已在 v0.1.1 交付
- [ ] 「核对进度」按钮（按需一次调用，输出计划 vs 实际差异清单）
- [x] 挂载时回填（打开老会话时按需生成计划/建议）——已在 v0.1.1 交付
- [ ] 每日 token 预算闸（可选）

## 九、排障

- 运行日志：`<debugDir>/plan-completion-runtime.jsonl`（Host 侧 debugLog；含 `host-ready` / `routes-registered` / `model-usage` / `client-diag` / `user-edit`）。
- 状态自检：`GET /plan-completion/state?sessionId=…`、`GET /plan-completion/debug`。
- 客户端自检：`POST /plan-completion/diag` 上报 `build / hasPill / hasEntry / entryText / suggestVisible / rowHeight` 与计算样式。
- 插件「没显示」排查顺序：① Ctrl+R 刷新页面 → ② 确认 profile 里插件 enabled → ③ `/plan-completion/debug` 看 `host-ready` 服务是否齐全 → ④ 看 `client-diag` 是否有 `hasPill/hasEntry`。


