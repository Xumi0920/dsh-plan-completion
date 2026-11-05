# Plan Completion — 兼容性说明（v0.4.3）

同一个 DSH 插件，保留原生长上下文、回复和 Tab 草稿补全。适用于当前正式版本 **0.4.3**：根服务 + observer / embedding / retrieval / generator / api 六个组件；零配置托管 Q8 为默认关闭的 opt-in 能力。

默认 progressProtocol: legacy 保留 0.1.8 的状态 patch、连续两次 none 后 /replan 和 rewrite 语义，并明确标注模型报告未经执行验收。Settings 可显式选择 strict：仅已建立验收版本的原始执行回执或用户手动确认可推进完成；旧计划迁移为待验收。已经版本化的计划不能通过关闭 strict 绕过校验。

计划面板提供人工确认/撤销；请求绑定计划版本与验收版本。重新定义或撤销前置验收会使后续步骤失效。固定模型路由失败时停止调用，不回落其他供应商；修改设置取消旧调用。

当前包含独立 `embedding` 组件（零配置托管 Q8，默认关闭）；关闭 embedding 会回收 llama.cpp 进程，retrieval 退回关键词检索。旧 profile 覆盖配置不会重复启动或复活关闭的组件；`/` 手工路径与 external endpoint 仍兼容。

验证：npm test；npm run check:package。历史实验与截图保留在集成 PR，npm 包不带实验数据。
