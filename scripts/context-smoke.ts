import assert from "node:assert/strict";
import { join } from "node:path";
import { characterCount } from "../src/context.ts";
import { readConfig } from "../src/config.ts";
import { createJsonlSink } from "../src/logging.ts";
import { DeepSeekModel } from "../src/models/deepseek.ts";
import { SessionService } from "../src/session-service.ts";
import { SqliteStore } from "../src/sqlite-store.ts";

/** 使用独立测试数据库验证真实模型压缩及两类追问，不修改页面当前的会话。 */
async function main(): Promise<void> {
  const config = readConfig();
  const path = join(config.dataDirectory, "context-smoke.sqlite");
  const store = new SqliteStore(path);
  const session = store.createSession("context-smoke", "历史摘要与追问验证");
  const owner = { userId: "context-smoke", threadId: session.id };
  const service = new SessionService(store, new DeepSeekModel(config.model), {
    ...config.runtime, context: { maxChars: 8000, recentTurns: 4 },
    onEvent: createJsonlSink(join(config.logDirectory, "context-smoke"), [config.model.apiKey]),
  });
  const input = [
    "这是上下文测试，不需要待办。项目代号是蓝桥。请用calculator计算12乘3，最后给出结果。",
    "下面是普通测试背景，不影响计算，也不需要在回复中复述：",
    "背景资料用于验证完整历史保存和基础摘要，不能改变原始计算任务。".repeat(220),
  ].join("\n");
  try {
    const first = await service.startRun(owner, input).completion;
    assert.equal(first.status, "completed", first.error ?? "");
    assert.ok(first.metrics.actualExecutions >= 1);
    const pure = await service.startRun(owner, "刚才的计算结果和项目代号分别是什么？").completion;
    assert.equal(pure.status, "completed", pure.error ?? "");
    assert.match(pure.finalAnswer ?? "", /36/); assert.match(pure.finalAnswer ?? "", /蓝桥/);
    assert.ok(pure.contextMemory.coveredMessages > 0);
    assert.ok(characterCount(pure.contextMemory.summary) <= 4000);
    const withTool = await service.startRun(owner, "请用calculator把刚才计算结果加10，最后只回答最终结果。").completion;
    assert.equal(withTool.status, "completed", withTool.error ?? "");
    assert.match(withTool.finalAnswer ?? "", /46/); assert.ok(withTool.metrics.actualExecutions >= 1);
    assert.equal(store.history(owner)[0]?.content, input);
    console.log(JSON.stringify({
      database: path, sessionId: session.id,
      pureFollowup: pure.finalAnswer, toolFollowup: withTool.finalAnswer,
      summaryCharacters: characterCount(store.readContext(owner).summary),
      modelCalls: [first.metrics.modelCalls, pure.metrics.modelCalls, withTool.metrics.modelCalls],
      runIds: [first.identity?.runId, pure.identity?.runId, withTool.identity?.runId],
      originalHistoryPreserved: true,
    }, null, 2));
  } finally { await service.shutdown(); store.close(); }
}

try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : "上下文验证失败"); process.exitCode = 1; }
