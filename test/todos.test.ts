import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { RunContext } from "../src/execution.ts";
import type { ToolExecutionContext } from "../src/execution.ts";
import { createAgentGraph } from "../src/graph.ts";
import { objectValue, parseJson } from "../src/json.ts";
import type { JsonObject } from "../src/json.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { JsonTodoStore, MemoryTodoStore } from "../src/todo-store.ts";
import type { TodoStore } from "../src/todo-store.ts";
import { ToolError } from "../src/tool-errors.ts";
import { cloneTodos, parseTodos } from "../src/todos.ts";
import type { TodoItem } from "../src/todos.ts";
import { createBuiltinTools } from "../src/tools/builtin.ts";
import type { AssistantMessage, Model, ModelInput, Tool, ToolCall } from "../src/types.ts";
import { lastConversationMessage, lastToolMessage, latestSnapshot, latestUserText } from "./helpers/messages.ts";

/** 为测试构造整表写入请求，保留指定的模型调用 ID。 */
function todoCall(todos: readonly TodoItem[], id = "todo-call"): ToolCall {
  return { id, name: "write_todos", arguments: JSON.stringify({ todos }) };
}

/** 构造一轮包含工具请求的模型回复。 */
function calls(...toolCalls: ToolCall[]): AssistantMessage {
  return { role: "assistant", content: null, toolCalls };
}

/** 构造不含工具调用的最终回复。 */
function answer(content: string): AssistantMessage {
  return { role: "assistant", content, toolCalls: [] };
}

/** 验证最新 user 快照包含完整清单，系统规则不再包含动态 Todo。 */
function assertSnapshot(input: ModelInput, expected: readonly TodoItem[]): void {
  const system = input.messages.find((message) => message.role === "system");
  assert.ok(system?.content);
  assert.deepEqual(latestSnapshot(input).todos, expected);
  assert.equal(system.content.includes("当前 thread 的最新待办快照"), false);
}

/** 解析最近一次工具结果，便于检查整表回传和结构化错误。 */
function lastResult(input: ModelInput): JsonObject {
  const message = lastToolMessage(input);
  assert.ok(message?.role === "tool");
  return objectValue(parseJson(message.content), "工具结果");
}

/** 创建受限于系统临时目录的测试数据目录，并注册范围校验后的清理操作。 */
function temporaryDirectory(context: TestContext): string {
  const root = resolve(tmpdir());
  const directory = mkdtempSync(join(root, "minimal-agent-todos-"));
  context.after(() => {
    const target = resolve(directory);
    assert.ok(target.startsWith(`${root}${sep}minimal-agent-todos-`));
    rmSync(target, { recursive: true, force: true });
  });
  return directory;
}

test("write_todos 整表回传，普通工具不自动修改进度，全完成后仍需最终回答", async () => {
  const initial: TodoItem[] = [
    { content: "计算 12×3", status: "in_progress", error: null },
    { content: "整理结果", status: "pending", error: null },
  ];
  const completed: TodoItem[] = initial.map((item) => ({ ...item, status: "completed", error: null }));
  let round = 0;
  const model: Model = {
    /** 依次建计划、计算、完成计划、输出答案，并检查每轮收到的最新清单。 */
    async generate(input) {
      round++;
      if (round === 1) { assertSnapshot(input, []); return calls(todoCall(initial)); }
      if (round === 2) {
        assertSnapshot(input, initial);
        assert.deepEqual(parseTodos(objectValue(lastResult(input).result, "结果").todos), initial);
        return calls({ id: "calc", name: "calculator", arguments: '{"a":12,"b":3,"operation":"*"}' });
      }
      if (round === 3) {
        assertSnapshot(input, initial);
        assert.equal(lastResult(input).result, 36);
        return calls(todoCall(completed, "finish-plan"));
      }
      assertSnapshot(input, completed);
      return answer("12×3=36");
    },
  };
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools())).run("完成计算并记录计划");
  assert.equal(round, 4);
  assert.equal(state.status, "completed");
  assert.equal(state.finalAnswer, "12×3=36");
  assert.deepEqual(state.todos, completed);
  assert.equal(state.metrics.actualExecutions, 3);
  assert.equal(state.logs.filter((entry) => entry.event === "todos.updated").length, 2);
  assert.ok(state.logs.filter((entry) => entry.event === "todos.updated").every((entry) => entry.toolName === "write_todos" && entry.invocationId !== null));
  assert.equal(state.messages[0]?.content?.includes("当前 thread 的最新待办快照"), false);
});

test("失败待办可由模型改回进行中再完成，不会自动把整个运行标为失败", async () => {
  const plans: TodoItem[][] = [
    [{ content: "读取资料", status: "failed", error: "暂未找到对应网页" }],
    [{ content: "读取资料", status: "in_progress", error: null }],
    [{ content: "读取资料", status: "completed", error: null }],
  ];
  let round = 0;
  const model: Model = {
    /** 按失败、重试、完成顺序整表更新，最终在下一轮正常回复。 */
    async generate(input) {
      assertSnapshot(input, round === 0 ? [] : plans[round - 1] ?? []);
      const plan = plans[round++];
      return plan === undefined ? answer("资料处理完成") : calls(todoCall(plan));
    },
  };
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools())).run("测试失败重试");
  assert.equal(state.status, "completed");
  assert.deepEqual(state.todos, plans[2]);
  assert.equal(state.logs.filter((entry) => entry.event === "run.status" && entry.status === "failed").length, 0);
});

test("非法清单、缺少失败原因、错误状态和伪造 thread 参数均被拒绝且不执行", async () => {
  const invalid = [
    {}, { todos: null }, { todos: "not-array" },
    { todos: [{ content: "", status: "pending" }] },
    { todos: [{ content: "事项", status: "waiting" }] },
    { todos: [{ content: "事项", status: "failed" }] },
    { todos: [{ content: "事项", status: "failed", error: " " }] },
    { todos: [{ content: "事项", status: "completed", error: "旧错误" }] },
    { todos: [{ content: "事项", status: "pending", extra: true }] },
    { todos: [], threadId: "other-window" },
  ];
  for (const args of invalid) {
    const context = new RunContext("A", "window-1");
    context.loadTodos();
    const pending = context.requestTool({ id: "invalid", name: "write_todos", arguments: JSON.stringify(args) });
    const result = await createBuiltinTools().execute(pending, context, new AbortController().signal);
    assert.equal(result.ok, false);
    assert.equal(result.meta.executed, false);
    assert.equal(context.metrics.actualExecutions, 0);
    assert.deepEqual(context.todos, []);
  }
  const context = new RunContext();
  const pending = context.requestTool({ id: "missing-error", name: "write_todos", arguments: '{"todos":[{"content":"事项","status":"failed"}]}' });
  const result = await createBuiltinTools().execute(pending, context, new AbortController().signal);
  assert.equal(result.ok, false);
  assert.equal(result.error.field, "todos[0].error");
});

test("一轮多次 write_todos 全部拒绝，其他工具仍执行，模型可合并后重试", async () => {
  const store = new MemoryTodoStore();
  const owner = { userId: "A", threadId: "one-window" };
  const original: TodoItem[] = [{ content: "原有清单", status: "pending", error: null }];
  const updated: TodoItem[] = [{ content: "计算 2+2", status: "completed", error: null }];
  store.write(owner, original);
  let round = 0;
  const model: Model = {
    /** 首轮发出冲突更新，收到两条错误后合并为一次整表写入。 */
    async generate(input) {
      round++;
      if (round === 1) return calls(todoCall([], "write-1"), todoCall(updated, "write-2"), { id: "calc", name: "calculator", arguments: '{"a":2,"b":2,"operation":"+"}' });
      if (round === 2) {
        assertSnapshot(input, original);
        assert.deepEqual(store.read(owner), original);
        const errors = input.messages.filter((message) => message.role === "tool" && message.name === "write_todos");
        assert.equal(errors.length, 2);
        for (const message of errors) {
          const payload = objectValue(parseJson(message.content ?? ""), "结果");
          assert.equal(objectValue(payload.error, "错误").code, "MULTIPLE_TODO_WRITES");
          assert.equal(payload.meta, undefined);
        }
        return calls(todoCall(updated, "merged-write"));
      }
      return answer("4");
    },
  };
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools()), { todoStore: store }).run("合并更新", owner);
  assert.equal(state.status, "completed");
  assert.deepEqual(state.todos, updated);
  assert.equal(state.metrics.toolRequests, 4);
  assert.equal(state.metrics.actualExecutions, 2);
  assert.equal(state.metrics.toolRejected, 2);
  assert.equal(state.logs.filter((entry) => entry.event === "todos.updated").length, 1);
});

test("完成全部待办或清空清单本身都不会自动结束 Agent 运行", async () => {
  const completed: TodoItem[] = [{ content: "事项", status: "completed", error: null }];
  for (const todos of [completed, []]) {
    const model: Model = {
      /** 只写入清单，不提供最终回答，用来验证完成工具调用后仍需继续模型节点。 */
      async generate() { return calls(todoCall(todos)); },
    };
    const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools()), { maxSteps: 2 }).run("只更新清单");
    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /最大执行步数/);
    assert.equal(state.finalAnswer, null);
    assert.deepEqual(state.todos, todos);
    assert.equal(state.metrics.actualExecutions, 1);
  }
});

test("JSON 待办存储整表覆盖并隔离用户与窗口，重建存储后仍可加载", (context) => {
  const directory = temporaryDirectory(context);
  const store = new JsonTodoStore(directory);
  const owners = [
    { userId: "A", threadId: "window-1" }, { userId: "A", threadId: "window-2" },
    { userId: "B", threadId: "window-1" }, { userId: "../A", threadId: "../../window" },
  ];
  for (const owner of owners) {
    store.write(owner, [{ content: `${owner.userId}:${owner.threadId}`, status: "pending", error: null }]);
  }
  const reopened = new JsonTodoStore(directory);
  for (const owner of owners) assert.equal(reopened.read(owner)[0]?.content, `${owner.userId}:${owner.threadId}`);
  const first = owners[0];
  assert.ok(first);
  reopened.write(first, [{ content: "完成事项", status: "completed", error: null }]);
  assert.deepEqual(store.read(first), [{ content: "完成事项", status: "completed", error: null }]);
  const copy = reopened.read(first);
  assert.ok(copy[0]);
  Object.assign(copy[0], { content: "外部篡改" });
  assert.equal(reopened.read(first)[0]?.content, "完成事项");
  reopened.write(first, []);
  assert.deepEqual(new JsonTodoStore(directory).read(first), []);
  const files = readdirSync(directory);
  assert.equal(files.length, 4);
  assert.ok(files.every((file) => /^[a-f0-9]{64}\.todos\.json$/.test(file)));
});

test("新 Runtime 在同一 thread 看到持久化清单，其他窗口保持空列表", async (context) => {
  const directory = temporaryDirectory(context);
  const completed: TodoItem[] = [{ content: "已完成工作", status: "completed", error: null }];
  const owner = { userId: "A", threadId: "window-1" };
  new JsonTodoStore(directory).write(owner, completed);
  const model: Model = {
    /** 只根据本次请求中的待办快照回答，不调用工具修改已完成清单。 */
    async generate(input) { assertSnapshot(input, completed); return answer("事项已完成"); },
  };
  const restored = await new AgentRuntime(createAgentGraph(model, createBuiltinTools()), { todoStore: new JsonTodoStore(directory) }).run("查询待办", owner);
  assert.deepEqual(restored.todos, completed);
  assert.equal(restored.metrics.toolRequests, 0);
  const other: Model = {
    /** 另一个窗口必须收到空列表，不能看到窗口一的待办。 */
    async generate(input) { assertSnapshot(input, []); return answer("没有待办"); },
  };
  const isolated = await new AgentRuntime(createAgentGraph(other, createBuiltinTools()), { todoStore: new JsonTodoStore(directory) }).run("查询待办", { userId: "A", threadId: "window-2" });
  assert.deepEqual(isolated.todos, []);
});

test("同一 Runtime 中同一 thread 的并发请求按顺序加载最新清单", async () => {
  const first: TodoItem[] = [{ content: "第一项", status: "pending", error: null }];
  const both: TodoItem[] = [...first, { content: "第二项", status: "pending", error: null }];
  const model: Model = {
    /** 首个请求故意延迟，第二个请求应在它保存后才能加载并扩展清单。 */
    async generate(input) {
      if (lastConversationMessage(input)?.role === "tool") return answer("已保存");
      if (latestUserText(input) === "first") {
        assertSnapshot(input, []);
        await delay(20);
        return calls(todoCall(first));
      }
      assertSnapshot(input, first);
      return calls(todoCall(both));
    },
  };
  const runtime = new AgentRuntime(createAgentGraph(model, createBuiltinTools()));
  const owner = { userId: "A", threadId: "same-window" };
  const [a, b] = await Promise.all([runtime.run("first", owner), runtime.run("second", owner)]);
  assert.deepEqual(a.todos, first);
  assert.deepEqual(b.todos, both);
  assert.notEqual(a.identity?.runId, b.identity?.runId);
});

test("存储失败返回具体错误并保持旧清单，模型可以报告问题", async () => {
  const original: TodoItem[] = [{ content: "原清单", status: "pending", error: null }];
  const store: TodoStore = {
    /** 模拟可读取的旧清单。 */
    read() { return cloneTodos(original); },
    /** 模拟写入失败，验证旧状态不会被新清单覆盖。 */
    write() { throw new ToolError("TODO_STORAGE_ERROR", "模拟磁盘写入失败"); },
  };
  const model: Model = {
    /** 保存失败后确认仍收到原清单，并告知用户错误。 */
    async generate(input) {
      if (lastConversationMessage(input)?.role !== "tool") return calls(todoCall([]));
      assertSnapshot(input, original);
      assert.equal(objectValue(lastResult(input).error, "错误").code, "TODO_STORAGE_ERROR");
      return answer("待办保存失败，原清单保留。");
    },
  };
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools()), { todoStore: store }).run("测试保存失败");
  assert.deepEqual(state.todos, original);
  assert.equal(state.metrics.toolFailed, 1);
});

test("损坏的待办文件使运行失败且不会调用模型或覆盖文件", async (context) => {
  const directory = temporaryDirectory(context);
  const owner = { userId: "A", threadId: "window-1" };
  const store = new JsonTodoStore(directory);
  store.write(owner, []);
  const file = readdirSync(directory)[0];
  assert.ok(file);
  const path = join(directory, file);
  writeFileSync(path, "broken-json", "utf8");
  const model: Model = {
    /** 数据加载失败时不应发起任何模型请求。 */
    async generate() { assert.fail("不应调用模型"); },
  };
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools()), { todoStore: store }).run("读取损坏状态", owner);
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /待办数据/);
  assert.equal(state.metrics.modelCalls, 0);
  assert.equal(readFileSync(path, "utf8"), "broken-json");
});

test("已结束的工具调用不能在模型继续运行时迟到修改待办", async () => {
  const captured: { write?: ToolExecutionContext["writeTodos"] } = {};
  const capture: Tool<null, number> = {
    name: "capture", description: "保存上下文以测试调用生命周期", parameters: { type: "object" },
    /** 测试工具没有业务参数。 */
    parse() { return null; },
    /** 保存当前调用的写入入口，但在执行结束后由测试尝试调用。 */
    async execute(_args, context) { captured.write = context.writeTodos; return 1; },
  };
  const tools = createBuiltinTools().register(capture);
  const model: Model = {
    /** 工具已返回后尝试写入，确认即使任务未结束也会拒绝迟到修改。 */
    async generate(input) {
      if (lastConversationMessage(input)?.role !== "tool") return calls({ id: "capture", name: "capture", arguments: "{}" });
      const write = captured.write;
      assert.ok(write);
      assert.throws(() => write([{ content: "迟到修改", status: "completed", error: null }]), /调用已结束/);
      return answer("已拒绝迟到修改");
    },
  };
  const state = await new AgentRuntime(createAgentGraph(model, tools)).run("测试迟到修改");
  assert.equal(state.status, "completed");
  assert.deepEqual(state.todos, []);
  assert.equal(state.logs.filter((entry) => entry.event === "todos.updated").length, 0);
});
