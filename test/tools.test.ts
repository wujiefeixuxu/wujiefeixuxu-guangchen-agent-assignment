import assert from "node:assert/strict";
import test from "node:test";
import { RunContext } from "../src/execution.ts";
import { arrayValue, objectValue, stringField } from "../src/json.ts";
import type { JsonObject } from "../src/json.ts";
import { calculatorTool, createBuiltinTools } from "../src/tools/builtin.ts";

/** 为测试创建工具请求，通过真实注册入口执行，并返回包含错误与元数据的结果。 */
async function execute(name: string, args: JsonObject | string, context = new RunContext("test-user", "test-thread")) {
  const pending = context.requestTool({ id: "call-test", name, arguments: typeof args === "string" ? args : JSON.stringify(args) });
  return createBuiltinTools().execute(pending, context, new AbortController().signal);
}

test("计算工具支持四则运算", async () => {
  for (const [operation, expected] of [["+", 10], ["-", 6], ["*", 16], ["/", 4]] as const) {
    const result = await execute("calculator", { a: 8, b: 2, operation });
    assert.ok(result.ok);
    assert.equal(result.result, expected);
    assert.equal(result.meta.executed, true);
    assert.ok(result.meta.executionDurationMs !== null && result.meta.executionDurationMs >= 0);
  }
});

test("无效 JSON、参数类型、额外参数和除零均作为工具错误返回", async () => {
  const invalidArguments = [
    "not-json", "null", "[]",
    '{"a":"12A","b":2,"operation":"+"}',
    '{"a":8,"b":0,"operation":"/"}',
    '{"a":8,"b":2,"operation":"power"}',
    '{"a":8,"b":2,"operation":"+","extra":true}',
    '{"a":1e308,"b":1e308,"operation":"*"}',
    '{"a":12A,"b":2,"operation":"+"}',
  ];
  for (const argumentsText of invalidArguments) {
    const result = await execute("calculator", argumentsText);
    assert.equal(result.ok, false, argumentsText);
  }
});

test("未注册的工具不能执行，重复注册会被拒绝", async () => {
  const tools = createBuiltinTools();
  assert.throws(() => tools.register(calculatorTool), /已注册/);
  assert.deepEqual(tools.definitions().map((tool) => tool.name), ["calculator", "search", "fetch", "write_todos", "memory_read", "memory_write"]);
  const result = await execute("run_shell", "{}");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TOOL_NOT_FOUND");
  assert.equal(result.meta.executed, false);
});

test("12A 报到具体字段，校验失败不计入实际执行次数", async () => {
  const context = new RunContext("A", "window-1");
  const result = await execute("calculator", { a: "12A", b: 2, operation: "+" }, context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENT");
  assert.equal(result.error.field, "a");
  assert.match(result.error.message, /12A/);
  assert.equal(result.meta.executed, false);
  assert.equal(context.metrics.toolRequests, 1);
  assert.equal(result.meta.executionDurationMs, null);
  assert.equal(context.metrics.actualExecutions, 0);
  assert.deepEqual(context.logs.map((entry) => entry.event), ["tool.requested", "tool.rejected"]);
});

test("缺参、非法运算符、除零的错误码明确，执行失败仍计次数", async () => {
  const missing = await execute("calculator", { a: 1, b: 2 });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "MISSING_ARGUMENT");
  const operation = await execute("calculator", { a: 1, b: 2, operation: "**" });
  assert.equal(operation.ok, false);
  assert.equal(operation.error.code, "INVALID_OPERATION");
  const context = new RunContext();
  const zero = await execute("calculator", { a: 1, b: 0, operation: "/" }, context);
  assert.equal(zero.ok, false);
  assert.equal(zero.error.code, "DIVISION_BY_ZERO");
  assert.equal(zero.meta.executed, true);
  assert.equal(context.metrics.actualExecutions, 1);
  assert.equal(context.metrics.toolFailed, 1);
});

test("Mock 搜索链接可以抓取到同一份 Markdown 正文，全程不联网", async (context) => {
  const network = context.mock.method(globalThis, "fetch", async () => { throw new Error("工具不应联网"); });
  const searched = await execute("search", { query: "Node.js", count: 1 });
  assert.ok(searched.ok);
  const search = objectValue(searched.result, "搜索结果");
  assert.equal(search.mock, true);
  const results = arrayValue(search.results, "results");
  assert.equal(results.length, 1);
  const item = objectValue(results[0], "搜索条目");
  assert.equal(typeof item.url, "string");
  const fetched = await execute("fetch", { url: stringField(item, "url") });
  assert.ok(fetched.ok);
  const page = objectValue(fetched.result, "网页");
  assert.equal(page.mock, true);
  assert.equal(page.title, item.title);
  assert.match(typeof page.content === "string" ? page.content : "", /^# Node.js/);
  assert.equal(network.mock.callCount(), 0);
});

test("搜索允许空结果，拒绝无效 count、空查询及多余字段", async () => {
  const empty = await execute("search", { query: "does-not-exist-7913" });
  assert.ok(empty.ok);
  assert.deepEqual(objectValue(empty.result, "结果").results, []);
  for (const args of [
    { query: "Node.js", count: "12A" }, { query: "Node.js", count: 0 },
    { query: "Node.js", count: 51 }, { query: "Node.js", count: 1.5 },
    { query: " " }, { query: "x".repeat(129) }, { query: "Node.js", threadId: "other-window" },
  ]) {
    const result = await execute("search", args);
    assert.equal(result.ok, false);
    assert.equal(result.meta.executed, false);
  }
  const unicode = await execute("search", { query: "😀".repeat(128) });
  assert.ok(unicode.ok);
});

test("fetch 拒绝非法地址，未知合法地址返回 MOCK_PAGE_NOT_FOUND", async () => {
  for (const url of ["not-url", "file:///C:/secret", "https://user:password@example.test/", "x".repeat(8193)]) {
    const result = await execute("fetch", { url });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_ARGUMENT");
    assert.equal(result.meta.executed, false);
  }
  const missing = await execute("fetch", { url: "https://mock.example.test/missing" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "MOCK_PAGE_NOT_FOUND");
  assert.equal(missing.meta.executed, true);
});
