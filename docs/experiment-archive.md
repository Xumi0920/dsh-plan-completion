# 归档索引 · 会话计划补全插件一期（2026-11-02）

本目录归档「会话计划补全」插件一期的实验数据、验证证据与运行日志。

## 文件

| 文件 | 内容 | 用途 |
|---|---|---|
| `plan-completion-experiment.json` | 第二轮隔离测试全量数据（27 组：证据字符 800/2000/4000 × 输出 200/300/500 × 3 次重复；温度 0；跨模型盲评） | 复核 token 预算结论 |
| `autojob-samples.json` | 6 条真机 auto-job 样本（两批各 3 条）+ 输出长度/延迟/质量偏差统计 + 用户编辑记录 | 复核生产配置（1500/400）表现 |
| `runtime-log.jsonl` | Host 运行日志（`host-ready`、路由注册、turn-end 触发、模型选择/用量、client-diag、用户编辑等） | 排查行为与配置是否生效 |
| `ui-final6-row.png` | 浅色主题最终 UI（建议胶囊 + `▤ v2.0`，对齐输入框卡片） | 视觉验收 |
| `ui-dark2-row.png` | 暗色主题 UI | 主题适配验收 |
| `ui-plan-v2-row.png` | 分类整理后的计划与建议（`▤ v2.0` + 收尾下一步建议） | 计划/建议链路验收 |

## 关键结论（一句话版）

- **证据**：patch 路径 800~2000 字符足够，更多无收益；三档盲评 4.67/5（天花板效应），建议质量一致。
- **输出**：200~300 tokens 足够（实测 55~85 tok）；500 无提升。
- **生产配置（已冻结）**：`evidenceChars=1500`、`maxTokensPatch=400`、`maxTokensRewrite=1200`，写入 `cordis.patch.yml` 的插件行 config。
- **真机表现**：自动 job 输出 75~113 tok、延迟 1.25~1.53s、6/6 建议可用；计划无实质变化时不 bump 版本。
- **已知偏差**：仅 1 条「任务已完成但模型以为仍在进行」的状态误判；judge 为同 provider 不同模型（本机无可用跨厂商凭证）。

## 复现方式

```powershell
# 1) 触发一次自动 job（真实 runGeneration patch 路径）
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4116/plan-completion/autojob' `
  -ContentType 'application/json' -Body '{"sessionId":"<sessionId>"}'

# 2) 重跑隔离测试（后台异步，结果写入 research/plan-completion-experiment.json）
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4116/plan-completion/experiment' `
  -ContentType 'application/json' -Body '{"sessionId":"<sessionId>","evidenceChars":[800,2000,4000],"maxTokens":[200,300,500],"reps":3}'
```

> 注：`experiment` / `autojob` / `steps` 是为验证新增的调试路由，仅监听本机回环地址，二期会按鉴权方案收敛。
