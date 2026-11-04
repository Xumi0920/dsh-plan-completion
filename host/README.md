# Host 组件与生产接线

当前插件只有一个宿主入口 `index.js::apply`。DSH 服务、事件观察、模型路由、作业取消、CAS 存储与 HTTP 路由在这个入口装配；客户端通过同一个插件的 HTTP 接口读取状态。

`host/` 不依赖 DSH 包，便于 Node 回归，但不是所有文件都无副作用：`store.js` 读写文件，`rag.js` 使用本机 HTTP 与文件 API；其余领域逻辑与运行时适配需要保持明确边界。

## 实际职责

| 模块 | 当前职责 |
|---|---|
| acceptance.js / plan.js | 验收条件规范化、计划模型、版本、手动编辑 |
| progress-schema.js | v1 信封、验收定义和 proof 的数据规范；不计算执行状态 |
| progress-protocol.js / progress.js | 验收修订、依赖失效、原始回执校验及旧计划兼容 |
| event-source.js / rag-evidence.js / evidence.js | 事件来源、原始调用/回执、脱敏及有界提示证据 |
| constraint-memory.js | 与向量 FIFO 分离的有界用户约束账本 |
| rag.js / retrieval-policy.js | 本机嵌入、会话索引、冷却恢复、语义/词法检索与目标回执覆盖 |
| prompt.js / text.js / heuristics.js | 计划助手提示和解析、显示文本处理及无模型降级 |
| store.js / security.js | 版本化存储、CAS、请求鉴权与输入边界 |
| config.js | 默认值；实际配置解析仍在 index.js |
| experiment.js | 调试实验逻辑，不能替代生产验收 |
| job.js | 历史未接线的 runJob/createRunner，以及独立队列工具；不是当前生产流水线 |

## 生产路径与信任边界

`index.js::runGeneration` 的顺序是：

1. 按会话和当前作业身份读取原始事件及已持久化计划。
2. 从原始回执重建生命周期与版本依赖；不依赖模型声明完成。
3. 同步有界索引，按配置检索；另构造宿主 progressProtocol 快照。
4. 通过当前选定的 DSH 模型调用计划助手；非法 JSON 允许一次有界修复。
5. 校验模型提案，再使用当前作业检查和 CAS 提交；晚到结果不能覆盖新状态。
6. 发布计划与建议。主 Agent 回复、主请求上下文和会话历史不被重写。

默认不启用嵌入，也不向生成模型发送 RAG 片段；两项开关独立。开启外部生成模型时，脱敏不等同完全匿名化。接口必须经过宿主 connection 鉴权，内部模块拆分不能绕开该边界。

## 历史 job.js 不能直接接替

旧文档曾把内联流水线与 `runJob` 称为等价；新协议接入后这一说法不成立。旧 runJob 没有原始日志、验收版本和跨步骤依赖校验。回归已复现其可能接受模型对版本化步骤的 done 提案。

当前增加了显式保护：传入带 acceptance 的计划，runJob/createRunner 返回 `unsupported-versioned-plan`，不调用模型、不提交、不发布。未版本化的旧调用保留原行为。独立 `createQueue` 只负责排队，仍可与一个经过验证的执行器组合。

后续重构应从实际生产 `runGeneration` 提取生成服务，并保留现有 Host 集成测试；不能通过替换成旧 runJob 来缩短入口文件。源文件的导出与对应测试比历史文档中的旧接线示例更可靠。

## 组件化与验证

建议保留一个 npm 包、一个插件 ID、一个 Host/Client 注册入口，在内部拆分配置与模型适配、观察调度、生成编排、HTTP 控制、进度领域和检索服务。客户端模块源码可拆分，但应构建为当前 DSH 加载器所需的单一浏览器产物。具体边界、迁移顺序与风险见 [组件审查](../docs/component-audit.md)。

回归运行 `node --test`。重点检查 Host 真实接线、过时作业/CAS、恢复与压缩后的原始回执、验收版本、来源隔离、鉴权、隐私以及 Client 请求竞态。离线回归不等于真实 DeepSeek 长上下文测试；实际模型结果单独记录。

