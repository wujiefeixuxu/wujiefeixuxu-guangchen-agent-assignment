# 问题解决记录

本记录描述本地实现与已执行的验证，不包含 API Key 或完整开发聊天。运行结果以对应测试和本地验证报告为准。

| 问题 | 处理方式 | 验证位置 |
| --- | --- | --- |
| 主流程不能依赖 Agent 框架 | 手写 model/tools 节点、路由和执行循环，运行状态为待运行、运行中、完成、失败 | `test/runtime.test.ts`、`test/state.test.ts` |
| 模型把 `12A` 当数字传入 | 严格验证 JSON 数字类型，不使用 `parseFloat` 或动态执行表达式；错误回传模型修正 | `test/tools.test.ts`、`test/logging.test.ts` |
| 同一轮多次整表修改 Todo 有歧义 | 拒绝同批多个 `write_todos`，保留旧清单，允许模型合并重试 | `test/todos.test.ts` |
| 两个窗口的聊天和待办互相干扰 | SQLite 按用户和 session 隔离；浏览器按标签页保存选择，同 session 活跃任务防重入 | `test/sessions.test.ts` |
| 状态没有提供给模型 | 用户输入附冻结的运行状态，工具批次结束后追加一条状态更新 | `test/prompt.test.ts` |
| 动态内容破坏前缀稳定性 | 运行状态和摘要不反复拼进开头；长期偏好和索引按用户要求在一轮开始时进入 system 并冻结 | `test/prompt.test.ts`、`test/memory.test.ts` |
| 长历史超出应用阈值 | 按提供商实际 token 计数压缩完整旧用户轮次；摘要最多4000字符，原始SQLite历史保留，当前网页正文不截断 | `test/context.test.ts`、`scripts/context-smoke.ts` |
| 摘要混入过期指令和旧运行状态 | 摘要输入排除程序快照、状态通知与旧思考；提示词约定四节事实摘要，区分最终变更、不确定性与未完成事项。兼容旧文本，下次压缩时合并，不额外调用模型迁移 | `test/context.test.ts`、`test/prompt.test.ts`；用户反馈新版摘要手工测试结果良好 |
| 思考模式工具循环丢字段 | 分别解析思考、工具调用与答案；保留历史思考并完整回传，SQLite恢复后仍保留 | `test/thinking.test.ts`、`test/deepseek.test.ts` |
| 把模型思考误当最终回答 | 只有思考没有答案或工具调用时明确失败；输出截断也不能记为完成 | `test/deepseek.test.ts` |
| 真实输入 token 与字符数混淆 | 计数接口与生成接口 usage 分开记录，计数请求不消耗20次生成预算 | `test/context.test.ts`、`scripts/memory-smoke.ts` |
| 最近工具记录因失败轮次隐藏而丢失 | 从所属会话的工具事件恢复最近批次，普通聊天不保留悬空工具调用 | `test/prompt.test.ts` |
| 记忆信息放在哪里 | SQLite存六字段；偏好为Markdown全文，索引为JSON；工具按需读取正文，写入结果追加 | `src/memory.ts`、`test/memory.test.ts` |
| 相对时间跨午夜计算错误 | 用北京时间自然日计算昨天、前天，周月年注明近似；数据库仍保存UTC ISO | `test/memory.test.ts` |
| 整理使旧资料全部变成今天 | 整理模式保留原时间，只改名称和简介也不刷新信息时间 | `test/memory.test.ts` |
| 整理重建已删除记录或先删后写 | 只允许处理本轮开始时已有且当前仍存在的ID；保留偏好，先成功保存保留项再删重复项 | `test/memory.test.ts` |
| 异步工具迟到写入状态 | 读写入口校验取消信号和调用生命周期；结束后不能继续改Todo或记忆 | `test/todos.test.ts`、`test/memory.test.ts` |
| 页面日志难读 | 将思考、工具参数/结果、最终回答分开显示，原始JSON仍可展开 | `src/web/client.ts`、本地浏览器验证 |

## 验证方式

测试方向、预期结果与尚待验证的场景见 [测试方案与验收用例](TEST-PLAN.md)。当前优先准备可评审材料；常规10万token压缩触发线保持不变，不新增100万或200万token压测，也不因编写方案而调用真实模型。

- `npm run check`：类型检查、自动化用例和构建；不使用真实模型。
- `npm run smoke:context`：真实模型验证压缩、纯追问和带工具追问。
- `npm run smoke:memory`：独立测试库验证偏好写入、新会话召回、手动整理及时间保留，生成JSON报告与请求示例。
- `npm run stress:novel`：保留的历史20～30万token合成资料测试，当前不要求执行；材料由程序生成，不把夹具回执当真实模型生成。

真实测试会使用本地环境变量中的DeepSeek Key。报告、SQLite和运行日志位于忽略的数据目录；不把密钥写进源码或文档。
