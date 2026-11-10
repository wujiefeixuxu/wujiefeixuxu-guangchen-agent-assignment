import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { errorMessage } from "../src/errors.ts";
import { createAgentGraph } from "../src/graph.ts";
import { arrayValue, objectValue, parseJson, stringField } from "../src/json.ts";
import type { JsonObject } from "../src/json.ts";
import { DeepSeekModel, decodeCompletion, encodeTokenCountInput } from "../src/models/deepseek.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { createBuiltinTools } from "../src/tools/builtin.ts";
import { decodeStoredMessage } from "../src/sessions.ts";

/** 生成 DeepSeek 响应夹具，允许测试指定消息内容和结束原因。 */
function completion(message: JsonObject, finishReason = "stop"): string {
  return JSON.stringify({ choices: [{ finish_reason: finishReason, message: { role: "assistant", ...message } }] });
}

/** 以 UTF-8 汇总测试 HTTP 请求正文，读取失败时拒绝 Promise。 */
async function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

/** 在本机随机端口启动测试服务，返回地址及关闭方法；处理器异常时响应 500。 */
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        await handler(request, response);
      } catch {
        response.writeHead(500).end();
      }
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("测试服务器未启动");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    /** 关闭测试连接并等待服务器释放端口。 */
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

test("通过真实 HTTP 客户端完成工具循环，正确编码请求和 tool_call_id", async (context) => {
  const requests: { body: JsonObject; authorization: string | undefined; path: string | undefined }[] = [];
  const server = await serve(async (request, response) => {
    requests.push({ body: objectValue(parseJson(await readBody(request)), "请求"), authorization: request.headers.authorization, path: request.url });
    response.setHeader("Content-Type", "application/json");
    response.end(requests.length === 1
      ? completion({ content: null, reasoning_content: "fixture: calculator decision", tool_calls: [{ id: "http-call", type: "function", function: { name: "calculator", arguments: '{"a":123,"b":456,"operation":"*"}' } }] }, "tool_calls")
      : completion({ content: "56088", reasoning_content: "fixture: verified result" }));
  });
  context.after(() => server.close());
  const model = new DeepSeekModel({ apiKey: "test-token", baseUrl: server.baseUrl });
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools())).run("计算 123×456");
  assert.equal(state.status, "completed", state.error ?? "");
  assert.equal(state.finalAnswer, "56088");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.authorization, "Bearer test-token");
  assert.equal(requests[0]?.path, "/chat/completions");
  assert.equal(requests[0]?.body.model, "deepseek-flash");
  assert.deepEqual(requests[0]?.body.thinking, { type: "enabled" });
  assert.equal(requests[0]?.body.reasoning_effort, "max");
  assert.equal(requests[0]?.body.temperature, undefined);
  assert.equal(requests[0]?.body.max_tokens, 131072);
  assert.equal(arrayValue(requests[0]?.body.tools, "tools").length, 6);
  const messages = arrayValue(requests[1]?.body.messages, "messages");
  const tool = objectValue(messages[3], "工具消息");
  assert.equal(objectValue(messages[2], "助手消息").reasoning_content, "fixture: calculator decision");
  assert.equal(tool.role, "tool");
  assert.equal(tool.tool_call_id, "http-call");
  assert.equal(typeof tool.content, "string");
  const payload = objectValue(parseJson(stringField(tool, "content")), "工具结果");
  assert.equal(payload.result, 56088);
  assert.equal(payload.meta, undefined);
  const original = state.messages.find((message) => message.role === "tool");
  assert.ok(original?.role === "tool");
  assert.equal(objectValue(objectValue(parseJson(original.content), "原始结果").meta, "原始 meta").toolCallId, "http-call");
  assert.equal(JSON.stringify(requests[1]?.body).includes("test-token"), false);
  assert.equal(state.messages.at(-1)?.role === "assistant" ? state.messages.at(-1)?.content : null, "56088");
  assert.ok(state.messages.some((message) => message.role === "assistant" && message.reasoningContent === "fixture: verified result"));
});

test("HTTP 错误不回显服务端正文或密钥", async (context) => {
  const server = await serve(async (_request, response) => {
    response.writeHead(401).end('{"error":"secret-in-error-body"}');
  });
  context.after(() => server.close());
  const model = new DeepSeekModel({ apiKey: "test-token", baseUrl: server.baseUrl });
  await assert.rejects(model.generate({ messages: [{ role: "user", content: "你好" }], tools: [] }, new AbortController().signal), (error) => {
    const message = errorMessage(error);
    assert.match(message, /HTTP 401/);
    assert.equal(message.includes("secret-in-error-body"), false);
    assert.equal(message.includes("test-token"), false);
    return true;
  });
});

test("请求超时会终止 HTTP 请求", async (context) => {
  const server = await serve(async () => {});
  context.after(() => server.close());
  const model = new DeepSeekModel({ apiKey: "test-token", baseUrl: server.baseUrl, timeoutMs: 50 });
  await assert.rejects(model.generate({ messages: [{ role: "user", content: "你好" }], tools: [] }, new AbortController().signal), /超过 50 毫秒/);
});

test("校验外部响应，拒绝截断、空回复、缺失字段、错误类型和重复 ID", () => {
  const call = { id: "duplicate", type: "function", function: { name: "calculate", arguments: "{}" } };
  const invalid = [
    "not-json", "null", '{"choices":[]}',
    completion({ content: 123 }),
    completion({ content: "" }),
    completion({ content: "未完成" }, "length"),
    completion({ content: null }, "tool_calls"),
    completion({ content: null, tool_calls: [call, call] }, "tool_calls"),
    completion({ content: null, tool_calls: [{ type: "function", function: { name: "calculate", arguments: "{}" } }] }, "tool_calls"),
    completion({ content: null, tool_calls: [{ ...call, function: { name: "calculate", arguments: {} } }] }, "tool_calls"),
  ];
  for (const body of invalid) assert.throws(() => decodeCompletion(body), Error);
  assert.deepEqual(decodeCompletion(completion({ content: "正常回答" })), { role: "assistant", content: "正常回答", toolCalls: [] });
});

test("保存 API 的真实usage，不使用字符比例推算", () => {
  const decoded = decodeCompletion(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "完成" } }], usage: { prompt_tokens: 250123, completion_tokens: 42, total_tokens: 250165, prompt_cache_hit_tokens: 100000, prompt_cache_miss_tokens: 150123 } }));
  assert.deepEqual(decoded.usage, { promptTokens: 250123, completionTokens: 42, totalTokens: 250165, cacheHitTokens: 100000, cacheMissTokens: 150123 });
});

test("计数请求正确编码工具结果批次并保留完整正文", () => {
  const encoded = encodeTokenCountInput({ messages: [
    { role: "system", content: "规则" }, { role: "user", content: "测试" },
    { role: "assistant", content: null, toolCalls: [{ id: "one", name: "calculator", arguments: '{"a":1}' }, { id: "two", name: "fetch", arguments: '{"url":"https://example.test"}' }] },
    { role: "tool", toolCallId: "one", name: "calculator", content: "结果一" },
    { role: "tool", toolCallId: "two", name: "fetch", content: "完整网页正文" },
  ], tools: [] }, "deepseek-flash");
  assert.equal(encoded.system, "规则");
  const messages = arrayValue(encoded.messages, "消息");
  assert.equal(messages.length, 3);
  const results = arrayValue(objectValue(messages[2], "工具结果").content, "结果批次");
  assert.equal(results.length, 2); assert.equal(objectValue(results[1], "结果").content, "完整网页正文");
});

test("通过本地HTTP验证token计数接口及返回值", async (context) => {
  const server = await serve(async (request, response) => {
    assert.equal(request.url, "/anthropic/v1/messages/count_tokens");
    const input = objectValue(parseJson(await readBody(request)), "请求");
    assert.equal(input.model, "deepseek-flash"); assert.deepEqual(input.thinking, { type: "enabled" });
    assert.deepEqual(input.output_config, { effort: "max" });
    response.setHeader("Content-Type", "application/json"); response.end('{"input_tokens":250123}');
  });
  context.after(() => server.close());
  const model = new DeepSeekModel({ apiKey: "test-token", baseUrl: server.baseUrl });
  assert.equal(await model.countTokens({ messages: [{ role: "user", content: "测试" }], tools: [] }, new AbortController().signal), 250123);
});

test("思考正文、最终答案和工具调用分别解析，只有思考不能当作最终回答", () => {
  const output = decodeCompletion(completion({ content: "结果是36", reasoning_content: "fixture: reasoning field" }));
  assert.equal(output.reasoningContent, "fixture: reasoning field"); assert.equal(output.content, "结果是36");
  assert.equal(decodeCompletion(completion({ content: "答案", reasoning_content: null })).reasoningContent, undefined);
  assert.equal(decodeCompletion(completion({ content: "答案", reasoning_content: "" })).reasoningContent, "");
  assert.throws(() => decodeCompletion(completion({ content: "答案", reasoning_content: 123 })), /reasoning_content/);
  assert.throws(() => decodeCompletion(completion({ content: null, reasoning_content: "仅有思考" })), /缺少最终答案或工具调用/);
  assert.throws(() => decodeCompletion(completion({ content: null, reasoning_content: "未完成的思考" }, "length")), /DEEPSEEK_MAX_OUTPUT_TOKENS/);
});

test("思考用量按真实字段解析，SQLite恢复不丢失思考和用量", () => {
  const body = JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "完成", reasoning_content: "fixture: retained reasoning" } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, completion_tokens_details: { reasoning_tokens: 40 }, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 } });
  const message = decodeCompletion(body);
  assert.equal(message.usage?.reasoningTokens, 40);
  assert.deepEqual(decodeStoredMessage(JSON.stringify(message)), message);
  assert.throws(() => decodeStoredMessage(JSON.stringify({ ...message, reasoningContent: 42 })), /reasoning_content/);
  assert.throws(() => decodeCompletion(body.replace('"reasoning_tokens":40', '"reasoning_tokens":-1')), /token/);
});

test("计数编码包含带工具历史的完整思考，普通无工具请求不拼入历史思考", () => {
  const messages = [{ role: "assistant" as const, content: "已准备", reasoningContent: "fixture: complete reasoning", toolCalls: [] }];
  const withTools = encodeTokenCountInput({ messages, tools: createBuiltinTools().definitions() }, "deepseek-flash");
  const content = arrayValue(objectValue(arrayValue(withTools.messages, "消息")[0], "助手").content, "内容");
  assert.deepEqual(content[0], { type: "thinking", thinking: "fixture: complete reasoning" });
  const plain = encodeTokenCountInput({ messages, tools: [] }, "deepseek-flash");
  const plainContent = arrayValue(objectValue(arrayValue(plain.messages, "消息")[0], "助手").content, "内容");
  assert.deepEqual(plainContent, [{ type: "text", text: "已准备" }]);
});

test("可关闭思考，旧的无思考历史在开启工具模式时使用空字段兼容", async (context) => {
  const requests: JsonObject[] = [];
  const server = await serve(async (request, response) => {
    requests.push(objectValue(parseJson(await readBody(request)), "请求"));
    response.setHeader("Content-Type", "application/json"); response.end(completion({ content: "继续完成" }));
  });
  context.after(() => server.close());
  const messages = [{ role: "assistant" as const, content: "旧的非思考回复", toolCalls: [] }];
  const signal = new AbortController().signal;
  await new DeepSeekModel({ apiKey: "test-token", baseUrl: server.baseUrl }).generate({ messages, tools: createBuiltinTools().definitions() }, signal);
  assert.equal(objectValue(arrayValue(requests[0]?.messages, "消息")[0], "旧助手").reasoning_content, "");
  await new DeepSeekModel({ apiKey: "test-token", baseUrl: server.baseUrl, thinkingMode: "disabled" }).generate({ messages, tools: [] }, signal);
  assert.deepEqual(requests[1]?.thinking, { type: "disabled" });
  assert.equal(requests[1]?.reasoning_effort, undefined); assert.equal(requests[1]?.temperature, 0);
});
