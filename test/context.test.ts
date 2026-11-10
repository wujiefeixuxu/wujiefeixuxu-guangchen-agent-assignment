import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { ContextManager, characterCount, emptyContextMemory } from "../src/context.ts";
import type { ContextEvent, ContextMemory } from "../src/context.ts";
import { createAgentGraph } from "../src/graph.ts";
import { emptyMetrics } from "../src/execution.ts";
import { objectValue, parseJson } from "../src/json.ts";
import type { JsonValue } from "../src/json.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { SessionService } from "../src/session-service.ts";
import { SqliteStore } from "../src/sqlite-store.ts";
import { createBuiltinTools } from "../src/tools/builtin.ts";
import { createRuntimeSnapshot, createRuntimeUpdate, SUMMARY_HEADER, UPDATE_HEADER, withInputSnapshot } from "../src/prompt.ts";
import type { TodoItem } from "../src/todos.ts";
import type { AssistantMessage, Message, Model, ModelInput } from "../src/types.ts";
import { lastConversationMessage, lastToolMessage, latestSnapshot, latestUserText } from "./helpers/messages.ts";

/** 创建无需工具的模型回复。 */
function answer(content: string): AssistantMessage { return { role: "assistant", content, toolCalls: [] }; }

/** 创建一个计算请求，便于验证追问和调用上限。 */
function calculate(a: number, b: number, operation: string, id = "calc"): AssistantMessage {
  return { role: "assistant", content: null, toolCalls: [{ id, name: "calculator", arguments: JSON.stringify({ a, b, operation }) }] };
}

/** 创建受限于系统临时目录的数据库路径，结束时校验清理范围。 */
function databasePath(context: TestContext): string {
  const root = resolve(tmpdir()); const directory = mkdtempSync(join(root, "minimal-agent-context-"));
  context.after(() => { assert.ok(resolve(directory).startsWith(`${root}${sep}minimal-agent-context-`)); rmSync(directory, { recursive: true, force: true }); });
  return join(directory, "agent.sqlite");
}

/** 取得最近一次工具结果的业务数据，不依赖仅保存在日志里的 meta。 */
function toolResult(input: ModelInput): JsonValue {
  const message = lastToolMessage(input); assert.ok(message?.role === "tool");
  return objectValue(parseJson(message.content), "结果").result ?? null;
}

test("单次任务默认最多实际调用模型20次，新任务计数重新开始", async () => {
  let calls = 0;
  const model: Model = {
    /** 持续发出计算请求，另一个新任务则直接回答。 */
    async generate(input) {
      calls++;
      return latestUserText(input) === "hello" ? answer("你好") : calculate(1, 2, "+", `call-${calls}`);
    },
  };
  const runtime = new AgentRuntime(createAgentGraph(model, createBuiltinTools()));
  const state = await runtime.run("持续调用");
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /最大模型调用次数 20/);
  assert.equal(calls, 20);
  assert.equal(state.metrics.modelCalls, 20);
  assert.equal(state.metrics.actualExecutions, 20);
  const next = await runtime.run("hello");
  assert.equal(next.status, "completed"); assert.equal(next.metrics.modelCalls, 1);
});

test("工具日志meta从模型副本移除，网页正文和调用关联保持完整", async () => {
  const content = `BEGIN\n${"网页正文😀".repeat(3000)}\nEND`;
  const original: Message[] = [
    { role: "system", content: "系统规则" }, { role: "user", content: "读取网页" },
    { role: "assistant", content: null, toolCalls: [{ id: "fetch-id", name: "fetch", arguments: '{"url":"https://example.test"}' }] },
    { role: "tool", name: "fetch", toolCallId: "fetch-id", content: JSON.stringify({ ok: true, result: { content, meta: { source: "业务元数据" } }, meta: { runId: "local-log" } }) },
  ];
  const before = JSON.stringify(original);
  const events: { event: ContextEvent; data: JsonValue }[] = [];
  const manager = new ContextManager({ maxChars: 1000 });
  const todos: TodoItem[] = [{ content: "保留完整待办", status: "pending", error: null }];
  const snapshot = createRuntimeSnapshot({ userId: "A", threadId: "one", runId: "run" }, "running", emptyMetrics(), 20, todos, original);
  const { input: prepared } = await manager.prepare(original, [], () => createRuntimeUpdate(snapshot, ["tools_completed"]), async () => { assert.fail("当前轮次不能被压缩"); }, (event, data) => events.push({ event, data }));
  const message = prepared.messages.find((item) => item.role === "tool"); assert.ok(message?.role === "tool");
  const payload = objectValue(parseJson(message.content), "结果");
  assert.equal(payload.meta, undefined);
  const result = objectValue(payload.result, "业务结果");
  assert.equal(result.content, content);
  assert.deepEqual(result.meta, { source: "业务元数据" });
  assert.equal(message.toolCallId, "fetch-id");
  assert.equal(prepared.messages[0]?.content, "系统规则");
  assert.deepEqual(latestSnapshot(prepared).todos, todos);
  assert.equal(JSON.stringify(original), before);
  const report = objectValue(events.at(-1)?.data, "整理报告");
  assert.equal(report.overBudget, true); assert.equal(report.webContentTruncated, false);
});

test("按完整轮次压缩旧工具请求与结果，不删除原始消息或留下孤立结果", async () => {
  const history: Message[] = [
    { role: "system", content: "规则" }, { role: "user", content: "计算12乘3" },
    calculate(12, 3, "*", "old-id"),
    { role: "tool", name: "calculator", toolCallId: "old-id", content: JSON.stringify({ ok: true, result: { value: 36, notes: "x".repeat(8000) }, meta: { runId: "trace" } }) },
    answer("结果36"), { role: "user", content: "把刚才结果加10" },
  ];
  const original = JSON.stringify(history); let summaryCalls = 0;
  const manager = new ContextManager({ maxChars: 3000 });
  const { input: prepared } = await manager.prepare(history, [], () => null, async (input) => {
    summaryCalls++;
    assert.deepEqual(input.tools, []);
    assert.ok(input.messages[1]?.content?.includes("x".repeat(8000)));
    return answer("用户要求计算12乘3，工具返回36，已经告知结果。后续计算以36为参考。");
  }, () => {});
  assert.equal(summaryCalls, 1);
  assert.equal(manager.memory.coveredMessages, 4);
  assert.equal(prepared.messages.length, 3);
  assert.equal(prepared.messages[0]?.content, "规则");
  assert.equal(prepared.messages[2]?.content, "把刚才结果加10");
  assert.ok(prepared.messages[1]?.content?.startsWith(SUMMARY_HEADER));
  assert.ok(prepared.messages[1]?.content?.includes("工具返回36"));
  assert.equal(prepared.messages.filter((message) => message.role === "tool").length, 0);
  assert.equal(JSON.stringify(history), original);
});

test("摘要来源移除程序快照和状态通知，保留用户手写标签与配对工具事实，覆盖边界不变", async () => {
  const rawUser = `${UPDATE_HEADER}这是用户手写的标签，属于原文。请计算12乘3。${"旧资料".repeat(3000)}`;
  const snapshot = createRuntimeSnapshot({ userId: "A", threadId: "one", runId: "runtime-only-run" }, "running", emptyMetrics(), 20, [{ content: "snapshot-only-todo", status: "pending", error: null }], []);
  const messages: Message[] = [
    { role: "system", content: "固定规则" },
    withInputSnapshot({ role: "user", content: rawUser }, snapshot),
    { ...calculate(12, 3, "*", "business-calc"), reasoningContent: "private-old-reasoning", usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } },
    { role: "tool", name: "calculator", toolCallId: "business-calc", content: JSON.stringify({ ok: true, result: { value: 36, source: "business-evidence" }, meta: { runId: "runtime-only-run", durationMs: 9 } }) },
    createRuntimeUpdate(snapshot, ["tools_completed"]), answer("结果36，计算已完成"), { role: "user", content: "继续追问结果" },
  ];
  const before = JSON.stringify(messages);
  const summary = "【已确认事实】\n- 计算12乘3，工具实际返回36。\n【变更与最终结论】\n- 计算已完成，结果36。\n【未确认或未提供】\n无\n【未完成事项】\n无";
  const manager = new ContextManager({ maxChars: 3000 });
  let calls = 0;
  const prepared = await manager.prepare(messages, [], () => null, async (input) => {
    calls++;
    assert.deepEqual(input.tools, []);
    const payload = objectValue(parseJson(input.messages[1]?.content ?? ""), "摘要输入");
    const source = payload.messages;
    assert.ok(Array.isArray(source)); assert.equal(source.length, 4);
    assert.equal(objectValue(source[0], "用户原文").content, rawUser);
    assert.equal(objectValue(source[0], "用户原文").prompt, undefined);
    const serialized = JSON.stringify(source);
    for (const excluded of ["runtime-only-run", "snapshot-only-todo", "private-old-reasoning", "promptTokens", "durationMs"]) assert.equal(serialized.includes(excluded), false, excluded);
    const tool = objectValue(source[2], "工具结果");
    assert.equal(tool.toolCallId, "business-calc");
    assert.deepEqual(parseJson(String(tool.content)), { ok: true, result: { value: 36, source: "business-evidence" } });
    const instructions = input.messages[0]?.content ?? "";
    assert.ok(instructions.includes("过期的一次性回复要求"));
    assert.ok(instructions.includes("旧摘要也要按以下规则重新整理"));
    return answer(summary);
  }, () => {});
  assert.equal(calls, 1);
  assert.deepEqual(manager.memory, { summary, coveredMessages: 5 });
  assert.equal(prepared.input.messages.at(-1)?.content, "继续追问结果");
  assert.equal(JSON.stringify(messages), before);
});

test("旧文本摘要兼容读取，新批次合并变更后持久化四节摘要并直接复用", async () => {
  const legacy: ContextMemory = { summary: "旧版自由文本：勘查预算8000元，资料接收已完成。旧快照为running，模型调用0。", coveredMessages: 2 };
  const saves: ContextMemory[] = [];
  const manager = new ContextManager({ maxChars: 3000 }, legacy, (memory) => saves.push({ ...memory }));
  const prior: Message[] = [{ role: "user", content: "初始预算8000元" }, answer("已收到")];
  await manager.prepare([...prior, { role: "user", content: "普通追问" }], [], () => null, async () => { assert.fail("未超阈值不能为重排版额外调用模型"); }, () => {});
  assert.deepEqual(manager.memory, legacy); assert.equal(saves.length, 0);
  const messages: Message[] = [...prior, { role: "user", content: `正式预算改为5000元，替代8000元；取消此前的巡检任务。${"新增资料".repeat(2000)}` }, answer("已更正预算并取消巡检"), { role: "user", content: "现在的预算是多少" }];
  const before = JSON.stringify(messages);
  const summary = "【已确认事实】\n- 资料接收已完成。\n【变更与最终结论】\n- 预算最终为5000元，替代8000元；巡检任务已取消。\n【未确认或未提供】\n无\n【未完成事项】\n无";
  await manager.prepare(messages, [], () => null, async (input) => {
    const payload = objectValue(parseJson(input.messages[1]?.content ?? ""), "摘要输入");
    assert.equal(payload.previousSummary, legacy.summary);
    assert.ok(Array.isArray(payload.messages)); assert.equal(payload.messages.length, 2);
    assert.ok(JSON.stringify(payload.messages).includes("正式预算改为5000元"));
    return answer(summary);
  }, () => {});
  assert.deepEqual(saves, [{ summary, coveredMessages: 4 }]);
  const continued = await manager.prepare([...messages, answer("5000元"), { role: "user", content: "继续沿用这个预算" }], [], () => null, async () => { assert.fail("有效摘要应直接复用"); }, () => {});
  const summaryMessage = continued.input.messages.find((message) => message.role === "user" && message.content.startsWith(SUMMARY_HEADER));
  assert.ok(summaryMessage?.content?.includes("5000元"));
  assert.equal(JSON.stringify(continued.input).includes("旧快照为running"), false);
  assert.equal(saves.length, 1);
  assert.equal(JSON.stringify(messages), before);
});

test("摘要按Unicode硬限4000字符，过长时重新生成而不是裁剪正文", async () => {
  const manager = new ContextManager({ maxChars: 1000 });
  let attempts = 0;
  const messages: Message[] = [{ role: "system", content: "规则" }, { role: "user", content: "旧记录".repeat(2000) }, answer("已记录"), { role: "user", content: "继续" }];
  await manager.prepare(messages, [], () => null, async (input) => {
    assert.ok(input.messages[1]?.content?.includes("旧记录".repeat(2000)));
    return answer("😀".repeat(++attempts === 1 ? 4001 : 4000));
  }, () => {});
  assert.equal(attempts, 2);
  assert.equal(characterCount(manager.memory.summary), 4000);
  assert.equal(manager.memory.coveredMessages, 2);
});

test("两次摘要都超过上限时保留原记忆和原历史", async () => {
  let saves = 0;
  const manager = new ContextManager({ maxChars: 1000 }, emptyContextMemory(), () => saves++);
  const messages: Message[] = [{ role: "user", content: "旧内容".repeat(2000) }, answer("旧回复"), { role: "user", content: "继续" }];
  const before = JSON.stringify(messages);
  await assert.rejects(manager.prepare(messages, [], () => null, async () => answer("文".repeat(4001)), () => {}), /4000/);
  assert.equal(saves, 0); assert.deepEqual(manager.memory, emptyContextMemory());
  assert.equal(JSON.stringify(messages), before);
});

test("摘要请求也占模型预算，耗尽后不额外调用决策模型", async () => {
  let actual = 0;
  const model: Model = {
    /** 仅允许这次调用用于无工具摘要。 */
    async generate(input) { actual++; assert.deepEqual(input.tools, []); return answer("旧记录摘要"); },
  };
  const history: Message[] = [{ role: "user", content: "旧内容".repeat(5000) }, answer("旧答复")];
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools()), { maxModelCalls: 1, context: { maxChars: 6000 } }).run("继续", { history });
  assert.equal(state.status, "failed"); assert.match(state.error ?? "", /最大模型调用次数 1/);
  assert.equal(actual, 1); assert.equal(state.metrics.modelCalls, 1);
  assert.equal(state.contextMemory.coveredMessages, 2);
  const started = state.logs.find((entry) => entry.event === "model.started");
  assert.equal(objectValue(started?.data, "模型输入").purpose, "summary");
  assert.equal(state.messages.length, 4);
});

test("摘要只覆盖旧轮次，近期对话和当前用户输入仍保留原文", async () => {
  const messages: Message[] = [{ role: "system", content: "规则" }];
  for (let index = 0; index < 7; index++) messages.push({ role: "user", content: `问题${index}：${index === 0 ? "很长的旧记录".repeat(2000) : "短问题"}` }, answer(`回答${index}`));
  messages.push({ role: "user", content: "当前追问原文" });
  const manager = new ContextManager({ maxChars: 2000, recentTurns: 4 });
  const { input: prepared } = await manager.prepare(messages, [], () => null, async () => answer("旧问题0已处理。"), () => {});
  const users = prepared.messages.filter((message) => message.role === "user");
  assert.equal(users.at(-1)?.content, "当前追问原文");
  assert.ok(users.some((message) => message.content?.startsWith("问题6：")));
  assert.ok(users.some((message) => message.content?.startsWith("问题3：")));
  assert.equal(manager.memory.coveredMessages, 2);
});

test("SQLite 摘要持久保存，压缩后纯对话与工具追问都能使用旧结果", async (context) => {
  const path = databasePath(context);
  let store = new SqliteStore(path);
  const session = store.createSession("A"); const owner = { userId: "A", threadId: session.id };
  const original = `原始计算12乘3，记住参考结果。${"背景资料".repeat(3000)}`;
  store.write(owner, [{ content: "后续待办", status: "pending", error: null }]);
  const model: Model = {
    /** 模拟摘要、原始计算、纯追问和带计算工具的追问。 */
    async generate(input) {
      if (input.tools.length === 0) return answer("用户要求计算12乘3，calculator返回36，已告知结果36。未来计算可使用36。网址https://example.test/fact保留。");
      assert.ok(JSON.stringify(latestSnapshot(input).todos).includes("后续待办"));
      const user = latestUserText(input);
      if (user.startsWith("原始计算")) return lastConversationMessage(input)?.role === "tool" ? answer("36") : calculate(12, 3, "*");
      assert.ok(input.messages.some((message) => message.role === "user" && message.content.startsWith(SUMMARY_HEADER) && message.content.includes("calculator返回36")));
      if (user === "刚才的结果是多少") return answer("36");
      return lastConversationMessage(input)?.role === "tool" ? answer(String(toolResult(input))) : calculate(36, 10, "+");
    },
  };
  let service = new SessionService(store, model, { context: { maxChars: 10_000 } });
  await service.startRun(owner, original).completion;
  const pure = await service.startRun(owner, "刚才的结果是多少").completion;
  assert.equal(pure.status, "completed", pure.error ?? ""); assert.equal(pure.finalAnswer, "36");
  assert.equal(pure.metrics.modelCalls, 2);
  const memory = store.readContext(owner);
  assert.equal(memory.coveredMessages, 5); assert.ok(characterCount(memory.summary) <= 4000);
  assert.equal(store.history(owner)[0]?.content, original);
  assert.equal(store.history(owner).length, 8);
  const other = store.createSession("A"); assert.deepEqual(store.readContext({ userId: "A", threadId: other.id }), emptyContextMemory());
  assert.throws(() => store.readContext({ userId: "B", threadId: session.id }), /会话不存在/);
  await service.shutdown(); store.close();
  store = new SqliteStore(path); service = new SessionService(store, model, { context: { maxChars: 10_000 } });
  try {
    assert.deepEqual(store.readContext(owner), memory);
    const followup = await service.startRun(owner, "在刚才结果上加10").completion;
    assert.equal(followup.status, "completed", followup.error ?? ""); assert.equal(followup.finalAnswer, "46");
    assert.equal(followup.metrics.actualExecutions, 1); assert.equal(followup.metrics.modelCalls, 2);
    assert.equal(store.history(owner).length, 13);
    assert.equal(store.history(owner)[0]?.content, original);
    assert.deepEqual(store.readContext(owner), memory);
    assert.equal(store.detail(owner).messages.length, 8);
  } finally { await service.shutdown(); store.close(); }
});

test("SQLite 摘要拒绝越过消息范围或截断工具配对，4000个Unicode字符可保存", async () => {
  const store = new SqliteStore(":memory:");
  const model: Model = {
    /** 生成一个完整的计算轮次供摘要边界测试使用。 */
    async generate(input) { return lastConversationMessage(input)?.role === "tool" ? answer("3") : calculate(1, 2, "+"); },
  };
  const service = new SessionService(store, model);
  try {
    const session = store.createSession("A"); const owner = { userId: "A", threadId: session.id };
    await service.startRun(owner, "计算").completion;
    for (const coveredMessages of [1, 2, 3, 4, 100]) assert.throws(() => store.saveContext(owner, { summary: "摘要", coveredMessages }));
    assert.throws(() => store.saveContext(owner, { summary: "文".repeat(4001), coveredMessages: 5 }), /4000/);
    const memory: ContextMemory = { summary: "😀".repeat(4000), coveredMessages: 5 };
    store.saveContext(owner, memory); assert.deepEqual(store.readContext(owner), memory);
    assert.equal(store.history(owner).length, 5);
  } finally { await service.shutdown(); store.close(); }
});

test("摘要超时或请求工具时不保存伪摘要，也不执行任何工具", async () => {
  const history: Message[] = [{ role: "user", content: "旧资料".repeat(5000) }, answer("旧回复")];
  const models: Model[] = [
    { /** 模拟摘要调用忽略取消并一直挂起。 */ generate() { return new Promise<AssistantMessage>(() => {}); } },
    { /** 模拟摘要模型错误地产生工具请求。 */ async generate() { return calculate(1, 2, "+"); } },
  ];
  for (const model of models) {
    const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools()), { timeoutMs: 30, context: { maxChars: 6000 } }).run("继续", { history });
    assert.equal(state.status, "failed"); assert.deepEqual(state.contextMemory, emptyContextMemory());
    assert.equal(state.metrics.modelCalls, 1); assert.equal(state.metrics.actualExecutions, 0);
    assert.equal(state.metrics.toolRequests, 0);
  }
});

test("token模式按提供商计数触发，而不是用字符长度换名", async () => {
  const messages: Message[] = [{ role: "system", content: "规则" }, { role: "user", content: "旧短历史" }, answer("已记录"), { role: "user", content: "继续" }];
  const manager = new ContextManager({ maxTokens: 100000 });
  let summaries = 0; const reports: JsonValue[] = [];
  const { input: result } = await manager.prepare(messages, [], () => null, async () => { summaries++; return answer("旧历史已记录"); }, (event, data) => { if (event === "context.prepared") reports.push(data); }, async (input) => input.messages.some((message) => message.role === "user" && message.content === "旧短历史") ? 250000 : 5000);
  assert.equal(summaries, 1);
  assert.equal(result.messages.at(-1)?.content, "继续");
  const report = objectValue(reports[0], "报告");
  assert.equal(report.budgetUnit, "tokens"); assert.equal(report.preparedTokens, 5000); assert.equal(report.thresholdTokens, 100000);
});

test("token计数请求独立记录，不占用模型生成次数", async () => {
  const model: Model = {
    /** 返回模拟提供商输入 token 数，与字符数无关。 */
    async countTokens() { return 1234; },
    /** 生成一次正常回复，并携带服务端 token 用量。 */
    async generate() { return { ...answer("完成"), usage: { promptTokens: 1238, completionTokens: 2, totalTokens: 1240 } }; },
  };
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools()), { maxModelCalls: 1, context: { maxTokens: 100000 } }).run("测试");
  assert.equal(state.status, "completed"); assert.equal(state.metrics.modelCalls, 1); assert.equal(state.metrics.tokenCountRequests, 1);
  assert.equal(state.logs.filter((entry) => entry.event === "tokens.succeeded").length, 1);
  const response = state.logs.find((entry) => entry.event === "model.succeeded");
  assert.equal(objectValue(objectValue(response?.data, "回复").usage, "usage").promptTokens, 1238);
});
