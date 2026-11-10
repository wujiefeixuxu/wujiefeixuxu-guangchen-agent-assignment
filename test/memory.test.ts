import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { RunContext } from "../src/execution.ts";
import type { ToolExecutionContext } from "../src/execution.ts";
import { createAgentGraph } from "../src/graph.ts";
import { createWebServer } from "../src/http-server.ts";
import { objectValue, parseJson } from "../src/json.ts";
import { createMemorySnapshot, relativeMemoryTime, renderMemorySnapshot } from "../src/memory.ts";
import type { MemoryDraft } from "../src/memory.ts";
import { InMemoryMemoryStore } from "../src/memory-store.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { SessionService } from "../src/session-service.ts";
import { SqliteStore } from "../src/sqlite-store.ts";
import { createBuiltinTools } from "../src/tools/builtin.ts";
import type { AssistantMessage, Model, ModelInput, Tool } from "../src/types.ts";
import { latestUserText } from "./helpers/messages.ts";

const asOf = new Date("2026-11-10T00:01:00+08:00");
const old = "2026-11-08T08:00:00.000Z";

/** 创建一条内容明确的测试记忆。 */
function draft(id: string, content = "已确认使用Node.js和TypeScript"): MemoryDraft { return { id, name: id === "preferences" ? "偏好" : "Agent项目", summary: "已确认约束", content }; }

/** 创建最终回答，不把思考文本当成答案。 */
function answer(content = "完成"): AssistantMessage { return { role: "assistant", content, toolCalls: [] }; }

/** 构造与真实工具一致的调用参数和调用 ID。 */
function memoryCall(args: object, name = "memory_write"): AssistantMessage { return { role: "assistant", content: null, toolCalls: [{ id: "memory-call", name, arguments: JSON.stringify(args) }] }; }

test("相对时间按北京时间自然日计算，跨午夜两分钟仍是昨天", () => {
  const cases = [
    ["2026-11-10T00:00:00+08:00", "今天"], ["2026-11-09T23:59:00+08:00", "昨天"],
    ["2026-11-08T23:59:00+08:00", "前天"], ["2026-11-07T12:00:00+08:00", "三天前"],
    ["2026-11-03T12:00:00+08:00", "约一周前"], ["2026-10-26T12:00:00+08:00", "约半个月前"],
    ["2026-10-10T12:00:00+08:00", "约一个月前"], ["2026-08-10T12:00:00+08:00", "约三个月前"],
    ["2025-11-10T12:00:00+08:00", "约一年前"],
  ];
  for (const [time, expected] of cases) { assert.ok(time); assert.equal(relativeMemoryTime(time, asOf), expected); }
  assert.throws(() => relativeMemoryTime("not-a-date", asOf), /时间无效/);
});

test("索引字段固定排序且不暴露准确日期、正文或其他用户，偏好正文单独提供", () => {
  const store = new InMemoryMemoryStore();
  store.upsertMemory("A", draft("z-last", "不能出现在索引里的完整正文"), old);
  store.upsertMemory("A", draft("preferences", "- 使用中文回答"), old);
  store.upsertMemory("A", draft("a-first"), old);
  store.upsertMemory("B", draft("private", "B的私有内容"), old);
  const snapshot = createMemorySnapshot(store.listMemories("A"), asOf);
  assert.deepEqual(snapshot.index.map((item) => item.id), ["a-first", "z-last"]);
  assert.deepEqual(Object.keys(snapshot.index[0] ?? {}), ["id", "name", "summary", "timeLabel"]);
  assert.equal(snapshot.preferences?.content, "- 使用中文回答");
  assert.ok(snapshot.index.every((item) => item.timeLabel === "前天"));
  const text = renderMemorySnapshot(snapshot);
  assert.equal(text.includes(old), false); assert.equal(text.includes("2026-"), false);
  assert.equal(text.includes("B的私有内容"), false); assert.equal(text.includes("不能出现在索引里的完整正文"), false);
  assert.ok(text.includes("- 使用中文回答"));
});

test("SQLite记忆跨重开保留六字段和准确时间，只改索引不刷新时间", (context) => {
  const root = resolve(tmpdir()); const directory = mkdtempSync(join(root, "minimal-agent-memory-"));
  context.after(() => { assert.ok(resolve(directory).startsWith(`${root}${sep}minimal-agent-memory-`)); rmSync(directory, { recursive: true, force: true }); });
  const path = join(directory, "agent.sqlite");
  let store = new SqliteStore(path);
  const original = store.upsertMemory("A", draft("same"), old);
  store.upsertMemory("B", draft("same", "B的内容"), old);
  assert.deepEqual(Object.keys(original).sort(), ["content", "id", "name", "recordedAt", "summary", "userId"]);
  store.upsertMemory("A", { ...draft("same"), name: "改名", summary: "改简介" }, asOf.toISOString());
  assert.equal(store.getMemory("A", "same")?.recordedAt, old);
  store.close(); store = new SqliteStore(path);
  try {
    assert.equal(store.getMemory("A", "same")?.recordedAt, old);
    assert.equal(store.getMemory("A", "same")?.name, "改名");
    assert.equal(store.getMemory("B", "same")?.content, "B的内容");
    store.deleteMemory("A", "same"); assert.equal(store.getMemory("A", "same"), null);
    assert.equal(store.getMemory("B", "same")?.content, "B的内容");
    assert.throws(() => store.deleteMemory("A", "same"), /没有这条记忆/);
  } finally { store.close(); }
});

test("写入和跨天不会重建本轮system，下条用户输入才加载新偏好和新时间标签", async () => {
  const store = new InMemoryMemoryStore(); store.upsertMemory("A", draft("preferences", "旧偏好"), old);
  let date = asOf; const inputs: ModelInput[] = [];
  const model: Model = {
    /** 首轮写入新偏好并跨午夜，后续请求检查冻结前缀和工具最新结果。 */
    async generate(input) {
      inputs.push(structuredClone(input));
      if (inputs.length === 1) { date = new Date("2026-11-11T01:00:00+08:00"); return memoryCall({ operation: "upsert", ...draft("preferences", "新偏好") }); }
      if (inputs.length === 3) return memoryCall({ id: "preferences" }, "memory_read");
      return answer();
    },
  };
  const runtime = new AgentRuntime(createAgentGraph(model, createBuiltinTools()), { memoryStore: store, now: () => date });
  const first = await runtime.run("记住新偏好", { userId: "A", threadId: "one" });
  assert.equal(first.status, "completed", first.error ?? "");
  assert.equal(inputs[0]?.messages[0]?.content, inputs[1]?.messages[0]?.content);
  assert.ok(inputs[1]?.messages[0]?.content?.includes("旧偏好"));
  assert.ok(inputs[1]?.messages.some((message) => message.role === "tool" && message.content.includes("新偏好")));
  assert.deepEqual(inputs[1]?.messages.slice(0, inputs[0]?.messages.length), inputs[0]?.messages);
  const second = await runtime.run("查询偏好", { userId: "A", threadId: "one", history: first.messages.filter((message) => message.role !== "system") });
  assert.equal(second.status, "completed", second.error ?? "");
  assert.ok(inputs[2]?.messages[0]?.content?.includes("新偏好"));
  assert.ok(inputs[2]?.messages[0]?.content?.includes("昨天"));
  const currentRead = inputs[3]?.messages.findLast((message) => message.role === "tool" && message.name === "memory_read");
  assert.ok(currentRead?.content);
  assert.equal(objectValue(objectValue(objectValue(parseJson(currentRead.content), "工具结果").result, "读取结果").memory, "偏好").timeLabel, "昨天");
  assert.equal(first.memorySnapshot.preferences?.content, "旧偏好");
});

test("记忆工具严格校验用户、时间和字段，失败不会被当成执行成功", async () => {
  const library = new InMemoryMemoryStore(); library.upsertMemory("B", draft("secret"), old);
  const context = new RunContext("A", "one", undefined, undefined, undefined, { memoryStore: library, now: () => asOf });
  const tools = createBuiltinTools(); const signal = new AbortController().signal;
  for (const args of [
    { operation: "upsert", ...draft("one"), userId: "B" },
    { operation: "upsert", ...draft("one"), recordedAt: old },
    { operation: "upsert", id: "one", name: "缺字段" },
    { operation: "upsert", ...draft("../outside") },
    { operation: "delete", id: "one", content: "多余字段" },
    { operation: "upsert", ...draft("preferences", "x".repeat(4001)) },
  ]) {
    const request = context.requestTool({ id: "bad", name: "memory_write", arguments: JSON.stringify(args) });
    const result = await tools.execute(request, context, signal);
    assert.equal(result.ok, false); assert.equal(result.meta.executed, false);
  }
  const missing = await tools.execute(context.requestTool({ id: "read", name: "memory_read", arguments: '{"id":"secret"}' }), context, signal);
  assert.equal(missing.ok, false); assert.equal(missing.error.code, "MEMORY_NOT_FOUND");
  assert.equal(context.metrics.actualExecutions, 1); assert.deepEqual(library.listMemories("A"), []);
});

test("已结束的工具上下文不能迟到修改记忆", async () => {
  const captured: { write?: ToolExecutionContext["writeMemory"] } = {};
  const capture: Tool<null, number> = {
    name: "capture_memory", description: "测试生命周期", parameters: { type: "object" },
    /** 没有业务参数。 */ parse() { return null; },
    /** 保存写入入口，供调用结束后尝试使用。 */ async execute(_args, context) { captured.write = context.writeMemory; return 1; },
  };
  let round = 0;
  const model: Model = {
    /** 工具返回后，运行尚未结束也必须拒绝旧调用继续写入。 */
    async generate() {
      if (++round === 1) return memoryCall({}, "capture_memory");
      assert.ok(captured.write); assert.throws(() => captured.write?.({ operation: "upsert", ...draft("late") }), /已结束/);
      return answer();
    },
  };
  const library = new InMemoryMemoryStore();
  const state = await new AgentRuntime(createAgentGraph(model, createBuiltinTools().register(capture)), { memoryStore: library }).run("生命周期测试");
  assert.equal(state.status, "completed", state.error ?? ""); assert.deepEqual(library.listMemories("local-user"), []);
});

test("手动整理先保存保留项再删重复项，时间不被刷成今天", async () => {
  const store = new SqliteStore(":memory:");
  store.upsertMemory("A", draft("keep"), old); store.upsertMemory("A", draft("duplicate"), old);
  let round = 0;
  const model: Model = {
    /** 整理合并只修改已有记录，随后删除确定重复的条目。 */
    async generate() {
      round++;
      if (round === 1) return memoryCall({ operation: "upsert", ...draft("keep", "合并后仍是已确认的Node.js和TypeScript约束") });
      if (round === 2) return memoryCall({ operation: "delete", id: "duplicate" });
      return answer();
    },
  };
  const service = new SessionService(store, model, { now: () => asOf });
  try {
    const session = store.createSession("A"); const state = await service.startMemoryOrganization({ userId: "A", threadId: session.id }).completion;
    assert.equal(state.status, "completed", state.error ?? "");
    assert.equal(store.listMemories("A").length, 1); assert.equal(store.getMemory("A", "keep")?.recordedAt, old);
    assert.equal(state.metrics.actualExecutions, 2); assert.equal(state.logs.filter((entry) => entry.event === "memory.updated").length, 2);
  } finally { await service.shutdown(); store.close(); }
});

test("整理不能恢复旧ID、删除偏好或先删后写", async () => {
  const store = new InMemoryMemoryStore(); store.upsertMemory("A", draft("preferences"), old); store.upsertMemory("A", draft("keep"), old);
  const context = new RunContext("A", "one", undefined, undefined, undefined, { memoryStore: store, memoryMode: "organize", now: () => asOf });
  context.loadMemories();
  for (const args of [{ operation: "upsert", ...draft("new") }, { operation: "delete", id: "preferences" }, { operation: "delete", id: "keep" }]) {
    const result = await createBuiltinTools().execute(context.requestTool({ id: "organize", name: "memory_write", arguments: JSON.stringify(args) }), context, new AbortController().signal);
    assert.equal(result.ok, false);
  }
  assert.equal(store.listMemories("A").length, 2);
});

test("用户级记忆跨窗口和服务恢复可读，聊天与Todo仍独立", async () => {
  const store = new SqliteStore(":memory:"); const seen: ModelInput[] = [];
  const model: Model = {
    /** 窗口一保存明确记忆，其他窗口只从各自系统快照看到所属用户的长期信息。 */
    async generate(input) {
      seen.push(input);
      if (latestUserText(input) === "记住项目" && !input.messages.some((message) => message.role === "tool")) return memoryCall({ operation: "upsert", ...draft("project") });
      return answer();
    },
  };
  let service = new SessionService(store, model);
  try {
    const a = store.createSession("A"), b = store.createSession("A"), c = store.createSession("B");
    const first = await service.startRun({ userId: "A", threadId: a.id }, "记住项目").completion; assert.equal(first.status, "completed");
    await service.shutdown(); service = new SessionService(store, model);
    await service.startRun({ userId: "A", threadId: b.id }, "查询项目").completion;
    const same = seen.at(-1); assert.ok(same?.messages[0]?.content?.includes('"id": "project"'));
    assert.equal(same?.messages.some((message) => message.role === "user" && message.content.includes("记住项目")), false);
    await service.startRun({ userId: "B", threadId: c.id }, "查询项目").completion;
    assert.equal(seen.at(-1)?.messages[0]?.content?.includes('"id": "project"'), false);
    assert.deepEqual(store.read({ userId: "A", threadId: b.id }), []);
  } finally { await service.shutdown(); store.close(); }
});

test("记忆页面API只返回相对时间，并拒绝伪造用户、日期和跨用户读取", async (context) => {
  const store = new SqliteStore(":memory:");
  const model: Model = { /** 手工读写不需要调用模型。 */ async generate() { assert.fail("不应调用模型"); } };
  const service = new SessionService(store, model);
  const server = createWebServer(service, { publicDirectory: join(process.cwd(), "public"), clientFile: join(process.cwd(), "dist/web/client.js"), modelName: "test" });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  context.after(async () => { await service.shutdown(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  /** 使用演示身份访问API，不依赖页面共享Cookie。 */
  async function api(path: string, user = "A", body?: object) {
    const response = await fetch(base + path, { method: body ? "POST" : "GET", headers: { "X-User-Id": user, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: objectValue(parseJson(await response.text()), "响应") };
  }
  assert.equal((await api("/api/memories", "A", { operation: "upsert", ...draft("manual") })).status, 200);
  const index = await api("/api/memories"); assert.equal(index.status, 200); assert.equal(JSON.stringify(index.body).includes("recordedAt"), false);
  assert.ok(JSON.stringify(index.body).includes("今天")); assert.equal((await api("/api/memories/manual", "B")).status, 404);
  assert.equal((await api("/api/memories", "A", { operation: "upsert", ...draft("bad"), recordedAt: old })).status, 400);
  assert.equal((await api("/api/memories", "A", { operation: "upsert", ...draft("bad"), userId: "B" })).status, 400);
  assert.equal((await api("/api/memories", "B", { operation: "delete", id: "manual" })).status, 404);
  assert.equal((await api("/api/memories", "A", { operation: "delete", id: "manual" })).status, 200);
  assert.deepEqual(store.listMemories("A"), []);
});
