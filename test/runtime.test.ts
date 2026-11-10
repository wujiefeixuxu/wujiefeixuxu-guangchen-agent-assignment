import assert from "node:assert/strict";
import test from "node:test";
import { objectValue, parseJson } from "../src/json.ts";
import type { JsonObject } from "../src/json.ts";
import { createAgentGraph, END } from "../src/graph.ts";
import { AgentRuntime } from "../src/runtime.ts";
import type { Status } from "../src/state.ts";
import { createBuiltinTools } from "../src/tools/builtin.ts";
import type { AssistantMessage, Model, ModelInput, ToolMessage } from "../src/types.ts";
import { latestUserText } from "./helpers/messages.ts";

/** 创建不含工具调用的助手回复，用于验证直接回答和最终结束路径。 */
function answer(content: string): AssistantMessage {
  return { role: "assistant", content, toolCalls: [] };
}

/** 构造携带指定调用 ID 的计算器请求，供多轮工具循环测试使用。 */
function calculate(id: string, a: number, b: number, operation: string): AssistantMessage {
  return { role: "assistant", content: null, toolCalls: [{ id, name: "calculator", arguments: JSON.stringify({ a, b, operation }) }] };
}

class ScriptedModel implements Model {
  readonly inputs: ModelInput[] = [];
  readonly #replies: readonly AssistantMessage[];
  #index = 0;

  /** 保存预设回复序列，每次模型调用依次消费一条。 */
  constructor(replies: readonly AssistantMessage[]) {
    this.#replies = replies;
  }

  /** 保存本轮输入快照并返回下一条预设回复，序列耗尽时抛错。 */
  async generate(input: ModelInput, _signal: AbortSignal): Promise<AssistantMessage> {
    this.inputs.push(structuredClone(input));
    const reply = this.#replies[this.#index++];
    if (reply === undefined) throw new Error("没有更多测试回复");
    return reply;
  }
}

/** 从模型输入中提取工具消息，便于检查结果顺序和调用 ID 的关联。 */
function toolMessages(input: ModelInput): readonly ToolMessage[] {
  return input.messages.filter((message): message is ToolMessage => message.role === "tool");
}

/** 确认工具消息存在，并将其 JSON 正文解析为可断言的对象。 */
function toolPayload(message: ToolMessage | undefined): JsonObject {
  assert.ok(message);
  return objectValue(parseJson(message.content), "工具结果");
}

test("模型可直接回答，生命周期只包含约定的四种状态", async () => {
  const model = new ScriptedModel([answer("你好")]);
  const statuses: Status[] = [];
  const runtime = new AgentRuntime(createAgentGraph(model, createBuiltinTools()), {
    /** 仅收集运行状态事件，用来断言任务生命周期。 */
    onEvent(event) { if (event.event === "run.status" && event.status !== null) statuses.push(event.status); },
  });
  const state = await runtime.run("打个招呼");
  assert.equal(state.status, "completed");
  assert.equal(state.finalAnswer, "你好");
  assert.deepEqual(state.trace, ["model"]);
  assert.deepEqual(statuses, ["pending", "running", "completed"]);
});

test("多轮工具结果按调用 ID 回传，后续模型调用看到真实执行结果", async () => {
  const model = new ScriptedModel([
    calculate("multiply", 2, 3, "*"),
    calculate("add", 6, 4, "+"),
    answer("10"),
  ]);
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools())).run("计算 2×3+4");
  assert.equal(state.status, "completed");
  assert.equal(state.finalAnswer, "10");
  assert.equal(state.steps, 5);
  assert.deepEqual(state.trace, ["model", "tools", "model", "tools", "model"]);
  const secondInput = model.inputs[1];
  const thirdInput = model.inputs[2];
  assert.ok(secondInput && thirdInput);
  assert.deepEqual(toolMessages(secondInput).map((message) => [message.toolCallId, toolPayload(message).result]), [["multiply", 6]]);
  assert.deepEqual(toolMessages(thirdInput).map((message) => toolPayload(message).result), [6, 10]);
  assert.equal(state.metrics.toolRequests, 2);
  assert.equal(state.metrics.actualExecutions, 2);
  assert.deepEqual(state.pendingToolCalls, []);
});

test("一轮可以处理多个工具调用，保留结果顺序及关联 ID", async () => {
  const first = calculate("first", 1, 2, "+");
  const second = calculate("second", 3, 4, "*");
  const model = new ScriptedModel([{ ...first, toolCalls: [...first.toolCalls, ...second.toolCalls] }, answer("3 和 12")]);
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools())).run("分别计算");
  assert.equal(state.status, "completed");
  const input = model.inputs[1];
  assert.ok(input);
  assert.deepEqual(toolMessages(input).map((message) => [message.toolCallId, toolPayload(message).result]), [
    ["first", 3], ["second", 12],
  ]);
});

test("工具错误回传给模型，修正参数后可以完成任务", async () => {
  const model = new ScriptedModel([calculate("bad", 10, 0, "/"), calculate("fixed", 10, 2, "/"), answer("5")]);
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools())).run("测试修正");
  assert.equal(state.status, "completed");
  const input = model.inputs[2];
  assert.ok(input);
  assert.match(toolMessages(input)[0]?.content ?? "", /除数不能为零/);
  assert.equal(toolPayload(toolMessages(input)[1]).result, 5);
});

test("循环达到步数上限时失败，不继续执行工具", async () => {
  const model: Model = {
    /** 持续请求计算工具，验证 Runtime 达到步数上限后会停止。 */
    async generate() { return calculate("loop", 1, 2, "+"); }
  };
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools()), { maxSteps: 3 }).run("持续调用");
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /最大执行步数 3/);
  assert.equal(state.steps, 3);
  assert.equal(state.messages.filter((message) => message.role === "tool").length, 1);
  assert.equal(state.metrics.toolRequests, 2);
  assert.equal(state.metrics.actualExecutions, 1);
  assert.equal(state.metrics.toolRejected, 1);
});

test("模型异常和空回复使任务进入失败状态", async () => {
  const models: Model[] = [
    {
      /** 模拟模型调用直接失败，验证异常转为任务失败状态。 */
      async generate() { throw new Error("模型不可用"); }
    },
    new ScriptedModel([answer("")]),
  ];
  for (const model of models) {
    const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools())).run("测试失败");
    assert.equal(state.status, "failed");
    assert.ok(state.error);
    assert.equal(state.finalAnswer, null);
  }
});

test("即使节点忽略取消信号，Runtime 也会在超时后返回失败", async () => {
  const model: Model = {
    /** 返回始终不结束的调用，验证 Runtime 能独立中止等待。 */
    generate() { return new Promise<AssistantMessage>(() => {}); }
  };
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools()), { timeoutMs: 30 }).run("超时测试");
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /超时/);
});

test("外部取消能中断正在执行的节点", async () => {
  const controller = new AbortController();
  const model: Model = {
    /** 在调用开始时触发外部取消，并保持挂起以验证取消处理。 */
    generate() {
      controller.abort();
      return new Promise<AssistantMessage>(() => {});
    },
  };
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools())).run("取消测试", { signal: controller.signal });
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /取消/);
});

test("同一个 Runtime 并发执行任务，状态和消息互不串扰", async () => {
  const model: Model = {
    /** 回显当前任务的用户输入，用于检查并发任务的消息隔离。 */
    async generate(input) {
      return answer(latestUserText(input));
    },
  };
  const runtime = new AgentRuntime(createAgentGraph(model, createBuiltinTools()));
  const [a, b] = await Promise.all([
    runtime.run("A", { userId: "user-A", threadId: "window-1" }),
    runtime.run("B", { userId: "user-A", threadId: "window-2" }),
  ]);
  assert.equal(a.finalAnswer, "A");
  assert.equal(b.finalAnswer, "B");
  assert.notEqual(a.messages, b.messages);
  assert.equal(a.messages.length, 3);
  assert.equal(b.messages.length, 3);
  assert.notEqual(a.identity?.runId, b.identity?.runId);
  assert.ok(a.logs.every((entry) => entry.threadId === "window-1" && entry.runId === a.identity?.runId));
  assert.ok(b.logs.every((entry) => entry.threadId === "window-2" && entry.runId === b.identity?.runId));
});

test("错误的结束边不能把未完成任务标为完成", async () => {
  const graph = createAgentGraph(new ScriptedModel([calculate("pending", 1, 2, "+")]), createBuiltinTools());
  const state = await new AgentRuntime({ ...graph, edges: { ...graph.edges, model: () => END } }).run("错误边测试");
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /没有最终回答/);
});

test("拒绝无效的执行限制", () => {
  const graph = createAgentGraph(new ScriptedModel([]), createBuiltinTools());
  assert.throws(() => new AgentRuntime(graph, { maxSteps: 0 }), /maxSteps/);
  assert.throws(() => new AgentRuntime(graph, { timeoutMs: -1 }), /timeoutMs/);
});
