# 托管 Q8、兼容协议与增量拆分验证

测试日期：2026-11-04；**历史验证归档：0.2.0-canary.1 候选阶段**，原始记录保留，不代表当前发布状态。当前 0.4.1 的验证结果见 `docs/publish-assessment.md`（292/292 tests、六组件与 Q8 状态接口、视觉 canary）。生产桌面 profile 和凭据只读。

## 结果与范围

| 检查 | 结果 |
|---|---|
| progress-protocol 增量回归 | 203/203，0 跳过 |
| component-split 增量回归 | 209/209，0 跳过 |
| 完整托管 Q8 回归 | 265/265，0 跳过 |
| 三阶段实际 tarball 离线安装 | 根入口分别 1 / 4 / 5 个 Host export 全部 import 通过 |
| 两个增量的真实 DSH Loader | 单行/四行，旧配置不带 managed 标记，启停通过 |
| 隔离 Electron Host 组件/配置/鉴权 | 9/9 组通过 |
| 同一 Host 人工确认/撤销/后端设置 | 4/4 组通过 |
| 官方 Q8 真实进程与故障恢复 | 7/7 组通过 |
| 当前 DeepSeek + QQAgent/小黑盒合成流程 | 8/8 状态检查点通过 |
| 同一隔离 Host 的浏览器界面 | 实际显示一个插件、五个运行中的组件、canary 版本 |
| 原生桌面完整点击验收 | **未完成**：先遇到截图/定位超时，重试时用户按 Esc 停止 Computer Use |

不能将这个矩阵称为发布级全 PASS。原生 dsh-app 页面已启动，但新设置保存、人工确认按钮和组件切换的完整桌面点击链仍须补测。实际 API 与 Loader 通过不能替代这项验收。生产实例未替换。

## 测试环境与隔离

复用已安装 DSH 0.2.1-rc.5 桌面代码与当前 DeepSeek-V4.1-Flash。桌面 canary 位于独立目录，使用独立 DSH_HOME、userData 和应用身份；测试启动层只调整身份/路径及 development 标记，使用原生 Electron Host、HTTP 代理和前端代码。无自动更新/协议注册。测试适配器和凭据不进入 PR。

主模型 contextWindow=1,048,576，defaultMaxTokens=256,000，原生 max 推理；计划助手使用自身有界预算。没有缩短主 Agent 长上下文，也没有将 Codex 作为被测模型。此轮是生命周期/兼容性与合成短任务回归，**没有重跑接近 1M 输入及连续压缩**。历史长测只对原提交 6fca7e8 有效，见集成分支旧报告。

合成 exec 工具只接受预置命令标识，返回虚构回执，不执行系统 shell、真实 QQ 消息、抓取、部署或发布。流程依次检查英文思考意图、原始成功回执、较新的失败回执及下游失效、关闭 RAG 后仅讨论恢复意图。

两任务各六步：意图阶段全 todo；成功阶段全 done；第三步失败后为 done、done、blocked、blocked、blocked、blocked；关闭 RAG 后不因声明完成而改变结果。回归另覆盖复合步骤、验收 revision、跨步骤失效、人工来源防伪、已验证 rewrite 保留、legacy 两次 none 和状态 patch 兼容。

## 延迟与资源

| 测量 | 结果 |
|---|---|
| 官方 Q8 冷启动 + 三段中文/英文/代码 embedding | 1,509.6 ms |
| 两段中文/英文热 embedding，8 次 | 35.4–40.0 ms |
| 向量维度/归一化 | 1024，L2 约为 1 |
| DSH 内完整热检索 | 42–88 ms |
| 未取消的计划助手调用 | 1.29–2.41 s |
| 完整合成阶段 | 4.56–19.31 s |
| llama-server RSS 采样 | 1,131.9 MiB |
| llama-server PrivateMemorySize64 | 约 2,584.5 MiB；不是 GPU 显存 |
| Electron Host 峰值 RSS | 309.7 MiB；不含 renderer/supervisor/llama-server |

未独立测得 GPU 显存，不能把 RSS 当显存或声称 GPU 卸载成功。资源数字是各进程采样口径，不能相加为精确同时峰值。

首次索引采用词法回退，随后进入 hybrid。关闭 RAG 的场景用于状态安全检查，输入/历史不同，不是随机匹配的性能 A/B，不能据此声称 RAG 提速。22 次助手请求有 14 次被更新事件取消；网络层记录 8 次 transport 失败，未逐一证明其是否全由取消导致。最终状态与恢复通过，但不能宣称零失败或最优成本。

## 真实故障与安全检查

本轮使用已有 llama.cpp b12032 和 SHA-256 固定的官方 Q8。实测未授权 embedding 返回 401；杀死本次 server 后可冷却重启；空闲释放、显式关闭、再次按需启动通过；模拟 Host 被终止后，supervisor 经 IPC 断开清理自身 server。设置关闭/重启不影响其他 Ollama 或 llama.cpp 实例。伪造代理接收计数为 0。

回归覆盖无 shell、环境凭据过滤、Electron Node 模式、启动超时、不匹配模型哈希、取消共享启动等待、旧 endpoint 兼容及失效作业拒绝。人工确认绑定计划版本与验收版本，过期返回 409；撤销改变 revision；无日志首事件前也持久化用户来源。

生产 profile、根配置与凭据的前后哈希不变；合成工作区哨兵不变。索引/提示脱敏是有限规则，不能宣称业务正文全部匿名。默认 store 跟随 DSH_HOME，明确自定义路径不变。验证私有凭据精确值和本机路径不进入候选文件；完整 Git 历史及第三方二进制供应链不在此扫描保证内。

## 审查顺序

1. progress-protocol：保留 legacy 默认，strict 显式启用；路由/取消修复、人工验收、独立存储。Host 内部职责文件拆分，但只有一条 Cordis 根条目。
2. component-split：同包新增 observer / generator / api 独立条目，保留旧配置兼容与组件关闭语义；不引入向量引擎。
3. managed-q8-rag：新增 retrieval 组件和托管 llama.cpp，默认关闭，独立数据外发开关。

集成 PR #1 保留历史实验文档；增量 PR 不引入这些大体积历史数据。npm 包为 44 文件，解包约 495 KB，只保留运行时与必要说明。CI 增加实际 tarball 安装和 export smoke；本报告中的本机计数与远端 CI 状态分别核对。

归档说明：该候选已由 0.2.0+ 正式发布取代，本段原始发布门槛仅作历史记录，不再是当前发布条件。
