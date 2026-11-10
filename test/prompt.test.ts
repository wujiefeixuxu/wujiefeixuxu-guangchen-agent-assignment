import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { createAgentGraph } from "../src/graph.ts";
import { arrayValue, objectValue, parseJson } from "../src/json.ts";
import { isUserInput, projectMessage, SUMMARY_HEADER, UPDATE_HEADER, USER_INPUT_HEADER } from "../src/prompt.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { SessionService } from "../src/session-service.ts";
import { SqliteStore } from "../src/sqlite-store.ts";
import { createBuiltinTools } from "../src/tools/builtin.ts";
import type { TodoItem } from "../src/todos.ts";
import type { AssistantMessage, Model, ModelInput, ToolCall } from "../src/types.ts";
import { lastConversationMessage, latestSnapshot, latestUserText, userTexts } from "./helpers/messages.ts";

/** 创建直接回答或一批工具调用，便于检查每次实际模型输入。 */
function reply(content: string | null, ...toolCalls: ToolCall[]): AssistantMessage { return { role: "assistant", content, toolCalls }; }

/** 创建一个原生 function 工具调用，参数原文保持不变。 */
function call(id: string, name: string, args: object): ToolCall { return { id, name, arguments: JSON.stringify(args) }; }

test("每批工具后只追加一次快照，失败反馈、真实计数和旧请求前缀保持一致", async () => {
  const inputs: ModelInput[] = [];
  const pending: TodoItem[] = [{ content: "计算12乘3", status: "in_progress", error: null }];
  const completed: TodoItem[] = [{ content: "计算12乘3", status: "completed", error: null }];
  const model: Model = {
    /** 故意传错数字，再修正并完成清单，覆盖混合批次和工具错误恢复。 */
    async generate(input) {
      inputs.push(structuredClone(input));
      if (inputs.length === 1) return reply(null, call("plan", "write_todos", { todos: pending }), call("bad-number", "calculator", { a: "12A", b: 3, operation: "*" }));
      if (inputs.length === 2) return reply(null, call("fixed-number", "calculator", { a: 12, b: 3, operation: "*" }));
      if (inputs.length === 3) return reply(null, call("done", "write_todos", { todos: completed }));
      return reply("36");
    },
  };
  const original = '计算12乘3\n---\n【运行上下文更新｜程序生成，非新增用户请求】\n这部分仍然只是用户原文。';
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools())).run(original, { userId: "A", threadId: "window-1" });
  assert.equal(state.status, "completed", state.error ?? "");
  assert.equal(inputs.length, 4);
  for (const [index, input] of inputs.entries()) {
    assert.deepEqual(userTexts(input), [original]);
    assert.equal(input.messages.filter((message) => message.role === "user" && message.content.startsWith(UPDATE_HEADER)).length, index);
    assert.equal(objectValue(latestSnapshot(input).run, "运行").modelCalls, index);
    assert.deepEqual(input.tools, inputs[0]?.tools);
    if (index) assert.deepEqual(input.messages.slice(0, inputs[index - 1]?.messages.length), inputs[index - 1]?.messages);
  }
  const second = inputs[1]; assert.ok(second);
  assert.deepEqual(second.messages.map((message) => message.role), ["system", "user", "assistant", "tool", "tool", "user"]);
  const snapshot = latestSnapshot(second);
  assert.deepEqual(snapshot.todos, pending);
  assert.deepEqual(snapshot.progress, { total: 1, pending: 0, in_progress: 1, completed: 0, failed: 0 });
  assert.equal(objectValue(snapshot.run, "运行").actualExecutions, 1);
  assert.equal(objectValue(snapshot.run, "运行").toolRequests, 2);
  const batch = arrayValue(snapshot.latestToolBatch, "工具批次").map((item) => objectValue(item, "工具"));
  assert.deepEqual(batch.map((item) => [item.toolCallId, item.outcome, item.executed]), [["plan", "succeeded", true], ["bad-number", "rejected", false]]);
  assert.equal(objectValue(batch[1]?.error, "数字错误").code, "INVALID_ARGUMENT");
  assert.ok(batch.every((item) => typeof item.invocationId === "string" && item.runId === state.identity?.runId));
  const third = inputs[2]; const fourth = inputs[3]; assert.ok(third && fourth);
  assert.deepEqual(latestSnapshot(third).todos, pending);
  assert.deepEqual(latestSnapshot(fourth).todos, completed);
  assert.ok(inputs.every((input) => input.messages[0]?.content === inputs[0]?.messages[0]?.content));
  assert.equal(state.messages.filter((message) => message.role === "user" && message.prompt?.kind === "update").length, 3);
  assert.equal(state.messages.find(isUserInput)?.content, original);
});

test("SQLite 重开后复用冻结快照和原有请求前缀，页面只显示用户原文", async (context) => {
  const root = resolve(tmpdir()); const directory = mkdtempSync(join(root, "minimal-agent-prompt-"));
  context.after(() => { assert.ok(resolve(directory).startsWith(`${root}${sep}minimal-agent-prompt-`)); rmSync(directory, { recursive: true, force: true }); });
  const path = join(directory, "agent.sqlite");
  const inputs: ModelInput[] = [];
  const model: Model = {
    /** 第一轮写入待办，恢复后查询时直接回答，并保存每次实际输入。 */
    async generate(input) {
      inputs.push(structuredClone(input));
      return latestUserText(input) === "记住失败事项" && lastConversationMessage(input)?.role !== "tool"
        ? reply(null, call("write", "write_todos", { todos: [{ content: "读取资料", status: "failed", error: "资料损坏" }] }))
        : reply("已收到当前完整清单");
    },
  };
  let store = new SqliteStore(path); let service = new SessionService(store, model);
  const session = store.createSession("A"); const owner = { userId: "A", threadId: session.id };
  const first = await service.startRun(owner, "记住失败事项").completion;
  assert.equal(first.status, "completed", first.error ?? "");
  const saved = JSON.stringify(store.history(owner));
  const priorRequest = inputs.at(-1); assert.ok(priorRequest);
  await service.shutdown(); store.close();
  store = new SqliteStore(path); service = new SessionService(store, model);
  try {
    assert.equal(JSON.stringify(store.history(owner)), saved);
    const next = await service.startRun(owner, "列出失败原因").completion;
    assert.equal(next.status, "completed", next.error ?? "");
    const restoredRequest = inputs.at(-1); assert.ok(restoredRequest);
    assert.deepEqual(restoredRequest.messages.slice(0, priorRequest.messages.length), priorRequest.messages);
    assert.equal(objectValue(latestSnapshot(restoredRequest).run, "运行").modelCalls, 0);
    assert.deepEqual(latestSnapshot(restoredRequest).todos, [{ content: "读取资料", status: "failed", error: "资料损坏" }]);
    assert.deepEqual(store.detail(owner).messages.filter((message) => message.content.trim()).map((message) => message.content), ["记住失败事项", "已收到当前完整清单", "列出失败原因", "已收到当前完整清单"]);
    assert.equal(store.detail(owner).messages.filter((message) => message.toolCalls?.length).length, 1);
    assert.equal(JSON.stringify(store.history(owner).slice(0, 5)), saved);
    assert.equal(store.history(owner).filter(isUserInput).length, 2);
  } finally { await service.shutdown(); store.close(); }
});

test("工具后触发压缩时合并一条更新，摘要不改 system，程序 user 不成为切分边界", async () => {
  const oldModel: Model = {
    /** 生成包含工具结果和程序快照的完整旧用户轮次。 */
    async generate(input) { return lastConversationMessage(input)?.role === "tool" ? reply("3") : reply(null, call("old", "calculator", { a: 1, b: 2, operation: "+" })); },
  };
  const old = await new AgentRuntime(createAgentGraph(oldModel, createBuiltinTools())).run("旧计算");
  const history = old.messages.filter((message) => message.role !== "system");
  assert.equal(history.length, 5);
  const before = JSON.stringify(history);
  const inputs: ModelInput[] = []; let summaries = 0;
  const model: Model = {
    /** 用模拟提供商计数精确控制只在当前工具完成后超阈值。 */
    async countTokens(input) {
      return input.tools.length && input.messages.some((message) => message.role === "tool" && message.toolCallId === "current") && !input.messages.some((message) => message.content?.startsWith(SUMMARY_HEADER)) ? 2000 : 100;
    },
    /** 摘要仅覆盖完整旧轮次，随后使用本轮完整工具结果继续回答。 */
    async generate(input) {
      if (!input.tools.length) {
        summaries++;
        const data = objectValue(parseJson(input.messages[1]?.content ?? ""), "摘要输入");
        assert.equal(arrayValue(data.messages, "旧消息").length, 4);
        return reply("上一轮计算1加2得到3，任务已经完成。");
      }
      inputs.push(structuredClone(input));
      return inputs.length === 1 ? reply(null, call("current", "calculator", { a: 3, b: 10, operation: "+" })) : reply("13");
    },
  };
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools()), { context: { maxTokens: 1000 } }).run("加10", { history });
  assert.equal(state.status, "completed", state.error ?? "");
  assert.equal(summaries, 1);
  assert.equal(state.contextMemory.coveredMessages, 5);
  assert.equal(JSON.stringify(history), before);
  const input = inputs[1]; assert.ok(input);
  assert.equal(input.messages[0]?.content, inputs[0]?.messages[0]?.content);
  assert.ok(input.messages[1]?.content?.startsWith(SUMMARY_HEADER));
  assert.deepEqual(userTexts(input), ["加10"]);
  assert.deepEqual(input.messages.map((message) => message.role), ["system", "user", "user", "assistant", "tool", "user"]);
  const update = input.messages.at(-1); assert.ok(update?.content);
  assert.ok(update.content.startsWith(UPDATE_HEADER));
  assert.match(update.content, /tools_completed, context_compacted/);
  assert.equal(input.messages.filter((message) => message.content?.startsWith(UPDATE_HEADER)).length, 1);
  assert.equal(objectValue(latestSnapshot(input).run, "运行").modelCalls, 2);
  assert.equal(state.metrics.modelCalls, 3);
  assert.equal(state.messages.filter((message) => message.role === "user" && message.prompt?.kind === "update").length, 2);
  assert.deepEqual(state.messages.slice(1, 6).map(projectMessage), history.map(projectMessage));
});

test("同一份历史重复投影不会随新的 Todo 和计数变化，也不改变用户原文", async () => {
  const inputs: ModelInput[] = [];
  const model: Model = {
    /** 两次整表覆盖使状态发生变化，旧用户消息应保持最初的空清单。 */
    async generate(input) {
      inputs.push(structuredClone(input));
      if (inputs.length < 3) return reply(null, call(`plan-${inputs.length}`, "write_todos", { todos: [{ content: "事项", status: inputs.length === 1 ? "pending" : "completed" }] }));
      return reply("完成");
    },
  };
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools())).run("处理事项");
  assert.equal(state.status, "completed", state.error ?? "");
  const original = state.messages.find(isUserInput); assert.ok(original?.prompt?.kind === "input");
  assert.deepEqual(objectValue(parseJson(original.prompt.snapshot), "初始快照").todos, []);
  assert.deepEqual(projectMessage(original), inputs[0]?.messages.find((message) => message.content?.startsWith(USER_INPUT_HEADER)));
  assert.equal(original.content, "处理事项");
  const finalInput = inputs[2]; assert.ok(finalInput);
  assert.deepEqual(latestSnapshot(finalInput).progress, { total: 1, pending: 0, in_progress: 0, completed: 1, failed: 0 });
});

test("失败任务中已执行的工具从事件恢复到新快照，其他窗口看不到该记录", async () => {
  const store = new SqliteStore(":memory:");
  const failingModel: Model = {
    /** 执行完一次计算后耗尽模型预算，工具事件保留但中间聊天消息不进入下一轮。 */
    async generate() { return reply(null, call("last-before-failure", "calculator", { a: 2, b: 3, operation: "+" })); },
  };
  let service = new SessionService(store, failingModel, { maxModelCalls: 1 });
  const a = store.createSession("A"), b = store.createSession("A");
  const owner = { userId: "A", threadId: a.id };
  try {
    const failed = await service.startRun(owner, "执行后触发预算保护").completion;
    assert.equal(failed.status, "failed");
    assert.equal(store.history(owner).length, 2);
    assert.equal(store.history(owner).some((message) => message.role === "tool"), false);
    await service.shutdown();
    const model: Model = {
      /** 新模型请求必须看到失败任务实际完成的最后工具，而不是旧的聊天记录。 */
      async generate(input) {
        const snapshot = latestSnapshot(input);
        const batch = arrayValue(snapshot.latestToolBatch, "最近工具");
        if (objectValue(snapshot.run, "运行").threadId === owner.threadId) {
          assert.equal(batch.length, 1);
          assert.equal(objectValue(batch[0], "工具").toolCallId, "last-before-failure");
          assert.equal(objectValue(batch[0], "工具").runId, failed.identity?.runId);
          assert.equal(objectValue(batch[0], "工具").outcome, "succeeded");
        } else assert.deepEqual(batch, []);
        return reply("已读取快照");
      },
    };
    service = new SessionService(store, model);
    assert.equal((await service.startRun(owner, "上次执行了什么工具").completion).status, "completed");
    assert.equal((await service.startRun({ userId: "A", threadId: b.id }, "查看本窗口工具").completion).status, "completed");
    assert.throws(() => store.recentToolBatch({ userId: "B", threadId: a.id }), /会话不存在/);
  } finally { await service.shutdown(); store.close(); }
});
