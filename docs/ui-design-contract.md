# 计划补全插件的设计规范入口

完整通用设计规范统一维护在私密仓库 [dsh-plugin-design-system](https://github.com/Xumi0920/dsh-plugin-design-system)。本文件保留读取入口与本插件的业务边界，不再维护另一份通用规范副本。

## 固定设计基线

- 规范版本：**1.0.0**
- 固定 commit：`80ec9bc5be06d1616cfc9efaeb27c0deb289f0b5`
- [读取该版本的 README](https://github.com/Xumi0920/dsh-plugin-design-system/blob/80ec9bc5be06d1616cfc9efaeb27c0deb289f0b5/README.md)
- [Agent 执行入口](https://github.com/Xumi0920/dsh-plugin-design-system/blob/80ec9bc5be06d1616cfc9efaeb27c0deb289f0b5/AGENTS.md)
- [按任务选择章节的 MANIFEST](https://github.com/Xumi0920/dsh-plugin-design-system/blob/80ec9bc5be06d1616cfc9efaeb27c0deb289f0b5/MANIFEST.json)
- 宿主参考版本：DSH 0.2.1-rc.5。实现时仍须核对当前 DSH 的原生控件、主题和公开能力。

开发 Agent 先读取上述三个文件，再按任务路由加载相关章节。新插件按完整流程设计；本插件的界面小修只读相关章节，并验证受影响的主题、布局、状态与行为。在设计记录和 PR 中写明使用的规范版本及 commit，升级时显式更新基线。

## 私密仓库访问

通过现有授权的 GitHub 连接器或 Git 凭据读取 [固定版本](https://github.com/Xumi0920/dsh-plugin-design-system/tree/80ec9bc5be06d1616cfc9efaeb27c0deb289f0b5)。如果返回 401、403 或 404，先报告访问问题；不要要求用户把令牌发到聊天里，也不要创建公开镜像或复制完整私密规范到本仓库。

这只是开发时的规范入口，不新增插件安装或运行时依赖。没有访问权限时，可以继续不依赖完整规范的工作，但不能宣称已经按完整规范完成验收。

## 本插件必须保留的行为

- Tab 和“填入草稿”只写草稿，不自动发送；插入与替换语义保持明确。
- 计划、建议、请求和输入动作属于当前会话；旧请求不能覆盖新会话。
- 模型报告、工具验收和用户确认保持不同来源；过期结果明确标注。
- Q8 运行服务管理其托管进程，检索组件管理索引并借用向量；启停说明反映真实所有权。
- 通过宿主插槽、公开输入动作和同源鉴权接口集成，不修改宿主 DOM 或全局主题。
- 验证记录区分隔离渲染、行为测试与真实 DSH 验收。

当前行为以 [README](../README.md) 和代码为准，开发流程见 [CONTRIBUTING](../CONTRIBUTING.md)。历史产品设计不替代当前行为或固定规范。

旧版通用规范仍可能存在于历史提交和已发布版本中；本次调整建立后续维护的统一私密来源，不删除或改写历史。
