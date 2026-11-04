# 插件托管官方 Q8

状态：0.2.0-canary.1，未发布。DSH 保留原生长上下文；检索仅用于计划/补全助手。

## 安装与配置

自行从官方渠道准备 llama.cpp 的 llama-server（包含它需要的动态库）和官方 Qwen/Qwen3-Embedding-0.6B-GGUF 的 Q8_0 文件。插件不会自动安装或执行下载内容。本轮复用已安装的 llama.cpp b12032，不能据此保证所有后续版本兼容。

Settings 中选择“插件托管 llama.cpp”，填写两个绝对路径，再启用本地检索。默认 enabled=false、sendContextToGenerator=false；两个开关独立。程序路径指向可信、当前用户受控的文件。执行文件由用户选择，插件不验证它的发行商签名；模型固定校验 SHA-256：

    06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439

对应官方仓库 revision 370f27d7550e0def9b39c1f16d3fbaa13aa67728。支持模型固定为该官方 Q8，不接受其他量化或微调权重冒充。向量为 1024 维；中文查询和英文思考按来源分层检索。

配置示例（合并到根组件的 config；路径仅为占位示例）：

```yaml
progressProtocol: legacy
rag:
  enabled: false
  sendContextToGenerator: false
  backend: llama.cpp
  executablePath: /absolute/path/to/llama-server
  modelPath: /absolute/path/to/Qwen3-Embedding-0.6B-Q8_0.gguf
  startupTimeoutMs: 30000
  idleTimeoutMs: 120000
  retryDelayMs: 3000
  contextSize: 8192
  gpuLayers: 99
  threads: 4
```

8192 是本地 embedding 分块/批处理上限，不修改 DeepSeek 的 1M 主上下文。设置页只暴露必要路径和开关；其他参数在配置中有界取值。GPU 99 是卸载请求，不保证设备支持 GPU；以实际运行资源为准。

旧配置有显式 endpoint 且没有 backend 时保留 external；新配置默认 managed。切换托管后不再访问该旧端点。external 仍只接受字面回环地址及 /v1/embeddings，不跟随重定向、不走 HTTP 代理。

## 进程与数据边界

retrieval 组件持有唯一运行时实例。首次需要向量时，先校验模型，再以参数数组、shell=false 启动 Node supervisor。Supervisor 启动 llama-server，绑定 127.0.0.1 随机端口，使用 --embedding --pooling last 和一次性 API key。密钥通过 IPC 和私有临时文件传递，不放入命令行；健康检查验证密钥与本次随机模型别名，避免误用占用同端口的其他服务。

子进程不继承生成供应商凭据、代理变量或 LLAMA_ARG_* 覆盖项。Electron Host 的 supervisor 明确保留 Node 模式。模型内容不经过云端；仅在另行开启 sendContextToGenerator 时把选中的片段发送给 DSH 生成模型。临时密钥防止误访问，不构成对同一 OS 用户恶意进程的隔离。

并发调用共享启动；取消查询会及时结束等待，不取消其他索引批次。冷启动/超时/崩溃时检索允许词法回退，不能借失败推断 done。重试有冷却，索引后台重试有界。空闲、组件禁用、配置更换会停止自身子进程；Host 意外退出时，IPC 断开触发 supervisor 清理。不会按进程名批量终止其他 llama.cpp 或 Ollama 实例。

## 验收与兼容

legacy 默认保留已发布状态语义并显示未经执行验收；strict 为显式启用。迁移旧模型计划时变为待人工/机器验收，不宣称旧模型的 done 是证据。已版本化计划不能降级绕过检查。人工确认仅适用于 manual scope，绑定当前计划版本和 acceptance revision；机器执行步骤不能通过该接口标成通过。

默认存储在显式 DSH_HOME 下的 plan-completion-data；DSH_HOME 未设置时仍为 ~/.dsh/plan-completion-data。明确自定义 storageDir 不变。多个 profile 共用同一 DSH_HOME 时仍应给各自指定存储目录；不会自动迁移其他 profile 的私密计划。

## 可重复验证

```powershell
npm test
npm run check:package
$env:DSH_LLAMA_SERVER = 'C:\absolute\path\llama-server.exe'
$env:DSH_Q8_MODEL = 'C:\absolute\path\Qwen3-Embedding-0.6B-Q8_0.gguf'
node scripts/check-managed-runtime.mjs
```

硬件脚本只使用合成文本，会主动终止它自己创建的进程以测试崩溃恢复和 Host 退出清理。它不在普通 CI 中自动运行；没有模型时不能把硬件测试视为通过。输出 managed-runtime-result.json 默认留在工作目录，不提交。

参考：[Qwen 官方 GGUF](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF)、[llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)。
