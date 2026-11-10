import assert from "node:assert/strict";
import { lastConversationMessage, lastToolMessage } from "./helpers/messages.ts";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { parseCli } from "../src/cli.ts";
import type { LogEntry } from "../src/execution.ts";
import { createAgentGraph } from "../src/graph.ts";
import { arrayValue, objectValue, parseJson, stringField } from "../src/json.ts";
import { createJsonlSink } from "../src/logging.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { createBuiltinTools } from "../src/tools/builtin.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { AssistantMessage, Model, Tool } from "../src/types.ts";

/** 构造工具调用回复，默认复用模型 ID 以验证本地 invocationId 的唯一性。 */
function call(name: string, args: string, id = "same-model-id"): AssistantMessage {
  return { role: "assistant", content: null, toolCalls: [{ id, name, arguments: args }] };
}

test("参数修正后继续循环，ID、序号、实际次数和时间戳完整关联", async () => {
  let round = 0;
  const model: Model = {
    /** 依次返回非法参数、修正后的参数和最终答案，验证错误反馈后的重试。 */
    async generate() {
      round++;
      if (round === 1) return call("calculator", '{"a":"12A","b":3,"operation":"*"}');
      if (round === 2) return call("calculator", '{"a":12,"b":3,"operation":"*"}');
      return { role: "assistant", content: "36", toolCalls: [] };
    },
  };
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools())).run("测试修正数字", { userId: "A", threadId: "window-1" });
  assert.equal(state.status, "completed");
  assert.deepEqual(state.metrics, { modelCalls: 3, toolRequests: 2, actualExecutions: 1, toolSucceeded: 1, toolRejected: 1, toolFailed: 0, tokenCountRequests: 0 });
  const requests = state.logs.filter((entry) => entry.event === "tool.requested");
  assert.deepEqual(requests.map((entry) => entry.toolCallNo), [1, 2]);
  assert.notEqual(requests[0]?.invocationId, requests[1]?.invocationId);
  assert.equal(requests[0]?.toolCallId, requests[1]?.toolCallId);
  assert.deepEqual(state.logs.filter((entry) => entry.event === "tool.started").map((entry) => entry.actualExecutionCount), [1]);
  for (const entry of state.logs) {
    assert.equal(entry.userId, "A");
    assert.equal(entry.threadId, "window-1");
    assert.equal(entry.runId, state.identity?.runId);
    assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
    if (entry.durationMs !== null) assert.ok(entry.durationMs >= 0);
  }
  assert.equal(state.logs.at(-1)?.event, "run.finished");
});

test("模型根据搜索链接读取 Mock 正文，再使用计算工具", async () => {
  let round = 0;
  const model: Model = {
    /** 根据上一轮真实工具结果依次选择搜索、抓取、计算和最终回答。 */
    async generate(input) {
      round++;
      if (round === 1) return call("search", '{"query":"Node.js","count":1}', "search-id");
      if (round === 2) {
        const message = lastToolMessage(input);
        assert.ok(message?.role === "tool");
        const result = objectValue(objectValue(parseJson(message.content), "工具结果").result, "搜索结果");
        const first = objectValue(arrayValue(result.results, "results")[0], "条目");
        return call("fetch", JSON.stringify({ url: stringField(first, "url") }), "fetch-id");
      }
      if (round === 3) {
        const message = lastToolMessage(input);
        assert.ok(message?.role === "tool");
        assert.match(message.content, /12 × 3/);
        return call("calculator", '{"a":12,"b":3,"operation":"*"}', "calc-id");
      }
      return { role: "assistant", content: "模拟资料中的练习：12×3=36。", toolCalls: [] };
    },
  };
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools())).run("搜索 Node.js 教程，读取正文并计算示例");
  assert.equal(state.status, "completed", state.error ?? "");
  assert.equal(state.metrics.actualExecutions, 3);
  assert.deepEqual(state.logs.filter((entry) => entry.event === "tool.started").map((entry) => entry.toolName), ["search", "fetch", "calculator"]);
});

test("工具超时有结束日志，迟到结果不重复计数或追加日志", async () => {
  const slow: Tool<null, number> = {
    name: "slow", description: "超时测试", parameters: { type: "object", properties: {}, additionalProperties: false },
    /** 测试工具不需要业务参数，直接返回固定的空参数值。 */
    parse() { return null; },
    /** 故意晚于任务超时返回，验证迟到结果不会重复写日志或计数。 */
    async execute() { await delay(70); return 1; },
  };
  const model: Model = {
    /** 请求慢工具，为任务超时测试创建实际工具执行。 */
    async generate() { return call("slow", "{}"); }
  };
  const emitted: LogEntry[] = [];
  const runtime = new AgentRuntime(createAgentGraph(model, new ToolRegistry().register(slow)), {
    timeoutMs: 30,
    /** 保存所有发出的事件，以检查超时结束后是否出现重复日志。 */
    onEvent(entry) { emitted.push(entry); },
  });
  const state = await runtime.run("等待超时");
  assert.equal(state.status, "failed");
  assert.equal(state.metrics.actualExecutions, 1);
  assert.equal(state.metrics.toolFailed, 1);
  const count = emitted.length;
  await delay(90);
  assert.equal(emitted.length, count);
  const terminals = emitted.filter((entry) => entry.event === "tool.failed");
  assert.equal(terminals.length, 1);
  const error = objectValue(objectValue(terminals[0]?.data, "data").error, "error");
  assert.equal(error.code, "TOOL_TIMEOUT");
  assert.equal(emitted.at(-1)?.event, "run.finished");
});

test("忽略取消的模型也有唯一失败结束事件", async () => {
  const model: Model = {
    /** 模拟始终挂起且忽略取消的模型，验证失败结束事件仍会记录。 */
    generate() { return new Promise<AssistantMessage>(() => {}); }
  };
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools()), { timeoutMs: 20 }).run("模型超时");
  assert.equal(state.logs.filter((entry) => entry.event === "model.started").length, 1);
  assert.equal(state.logs.filter((entry) => entry.event === "model.failed").length, 1);
  assert.equal(state.logs.at(-1)?.event, "run.finished");
});

test("执行函数抛出异常时返回结构化错误和元数据", async () => {
  const broken: Tool<null> = {
    name: "broken", description: "异常测试", parameters: { type: "object" },
    /** 让测试参数通过校验，以便把异常定位到实际执行阶段。 */
    parse() { return null; },
    /** 模拟工具内部异常，验证错误归一化和实际执行次数统计。 */
    async execute() { throw new Error("执行失败示例"); },
  };
  let receivedError = false;
  const model: Model = {
    /** 首轮请求异常工具，后续检查收到的结构化错误并返回最终回复。 */
    async generate(input) {
      const message = lastConversationMessage(input);
      if (message?.role !== "tool") return call("broken", "{}");
      const result = objectValue(parseJson(message.content), "结果");
      assert.equal(objectValue(result.error, "error").code, "TOOL_EXECUTION_FAILED");
      assert.equal(result.meta, undefined);
      receivedError = true;
      return { role: "assistant", content: "工具执行失败。", toolCalls: [] };
    },
  };
  const state = await new AgentRuntime(createAgentGraph(model, new ToolRegistry().register(broken))).run("异常测试");
  assert.ok(receivedError);
  assert.equal(state.metrics.toolFailed, 1);
});

test("JSONL 按 runId 分文件，同线程新任务重置统计，并脱敏密钥", async (context) => {
  const tempRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(tempRoot, "minimal-agent-logs-"));
  context.after(() => {
    const target = resolve(directory);
    assert.ok(target.startsWith(`${tempRoot}${sep}minimal-agent-logs-`));
    rmSync(target, { recursive: true, force: true });
  });
  const model: Model = {
    /** 返回包含测试密钥的回复，用来验证日志写入时的脱敏处理。 */
    async generate() { return { role: "assistant", content: "test-api-secret", toolCalls: [] }; }
  };
  const runtime = new AgentRuntime(createAgentGraph(model, createBuiltinTools()), { onEvent: createJsonlSink(directory, ["test-api-secret"]) });
  const first = await runtime.run("A", { userId: "user-A", threadId: "same-window" });
  const second = await runtime.run("B", { userId: "user-A", threadId: "same-window" });
  assert.notEqual(first.identity?.runId, second.identity?.runId);
  assert.equal(first.metrics.modelCalls, 1);
  assert.equal(second.metrics.modelCalls, 1);
  const files = readdirSync(directory);
  assert.equal(files.length, 2);
  for (const file of files) {
    const text = readFileSync(join(directory, file), "utf8");
    assert.equal(text.includes("test-api-secret"), false);
    assert.ok(text.includes("[REDACTED]"));
    const lines = text.trim().split("\n").map((line) => objectValue(parseJson(line), "日志"));
    assert.equal(lines.at(-1)?.event, "run.finished");
    assert.ok(lines.every((line) => line.threadId === "same-window"));
  }
});

test("CLI 可以指定用户和 thread，拒绝缺失标识参数", () => {
  const result = parseCli(["--user-id", "A", "--thread-id", "window-1", "搜索", "Node.js"]);
  assert.equal(result.userId, "A");
  assert.equal(result.threadId, "window-1");
  assert.equal(result.task, "搜索 Node.js");
  assert.throws(() => parseCli(["--thread-id"]), /缺少有效值/);
  assert.throws(() => parseCli(["--unsupported"]), /不支持/);
});
