import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import { createWebServer } from "../src/http-server.ts";
import { objectValue, parseJson } from "../src/json.ts";
import type { JsonObject } from "../src/json.ts";
import { SessionService } from "../src/session-service.ts";
import { SqliteStore } from "../src/sqlite-store.ts";
import { JsonTodoStore } from "../src/todo-store.ts";
import type { Model, AssistantMessage, ToolCall } from "../src/types.ts";
import { lastConversationMessage, latestUserText, userTexts } from "./helpers/messages.ts";

/** 创建临时 SQLite 目录，清理时校验删除范围。 */
function directory(context: TestContext): string {
  const root = resolve(tmpdir());
  const result = mkdtempSync(join(root, "minimal-agent-sessions-"));
  context.after(() => { assert.ok(resolve(result).startsWith(`${root}${sep}minimal-agent-sessions-`)); rmSync(result, { recursive: true, force: true }); });
  return result;
}

/** 构造可用于结束一轮对话的助手回复。 */
function answer(content: string): AssistantMessage { return { role: "assistant", content, toolCalls: [] }; }

/** 测试模型保存窗口专属待办，再使用完整历史回答后续消息。 */
function rememberedModel(): Model {
  return {
    /** 按用户消息决定创建待办或回顾历史，期间不访问真实模型。 */
    async generate(input) {
      const users = userTexts(input);
      const latest = latestUserText(input);
      const last = lastConversationMessage(input);
      if (last?.role === "tool") return answer(`已记录：${latest}`);
      if (latest.startsWith("记住")) {
        const content = latest.slice(2).trim();
        return { role: "assistant", content: null, toolCalls: [{ id: "todo", name: "write_todos", arguments: JSON.stringify({ todos: [{ content, status: "pending" }] }) }] };
      }
      return answer(`当前窗口历史：${users.join("；")}`);
    },
  };
}

test("SQLite 两窗口的完整聊天和待办独立，新进程式重建服务后继续原窗口", async (context) => {
  const path = join(directory(context), "agent.sqlite");
  let store = new SqliteStore(path);
  let service = new SessionService(store, rememberedModel());
  const a = store.createSession("A", "天气窗口");
  const b = store.createSession("A", "周报窗口");
  const ownerA = { userId: "A", threadId: a.id }, ownerB = { userId: "A", threadId: b.id };
  const [first, second] = await Promise.all([service.startRun(ownerA, "记住 上海带伞").completion, service.startRun(ownerB, "记住 补充周报成果").completion]);
  assert.equal(first.status, "completed"); assert.equal(second.status, "completed");
  assert.equal(store.read(ownerA)[0]?.content, "上海带伞");
  assert.equal(store.read(ownerB)[0]?.content, "补充周报成果");
  assert.ok(store.history(ownerA).some((message) => message.role === "tool"));
  assert.ok(!JSON.stringify(store.history(ownerA)).includes("周报"));
  await service.shutdown(); store.close();
  store = new SqliteStore(path); service = new SessionService(store, rememberedModel());
  try {
    const continued = await service.startRun(ownerA, "之前记住了什么？").completion;
    assert.match(continued.finalAnswer ?? "", /上海带伞/);
    assert.ok(!continued.finalAnswer?.includes("周报"));
    assert.equal(store.detail(ownerA).messages.length, 5);
    assert.equal(store.detail(ownerB).messages.length, 3);
    assert.throws(() => store.detail({ userId: "B", threadId: a.id }), /会话不存在/);
    assert.throws(() => store.getRun(ownerB, first.identity?.runId ?? ""), /运行不存在/);
  } finally { await service.shutdown(); store.close(); }
});

test("完整历史保留工具关联 ID，同一会话忙时拒绝重复提交但其他窗口正常运行", async () => {
  const store = new SqliteStore(":memory:");
  const model: Model = {
    /** 延迟回复，用于观察两个窗口并行以及同窗口重复请求的拒绝。 */
    async generate() { await delay(25); return answer("完成"); },
  };
  const service = new SessionService(store, model);
  try {
    const a = store.createSession("A"), b = store.createSession("A");
    const ownerA = { userId: "A", threadId: a.id }, ownerB = { userId: "A", threadId: b.id };
    const first = service.startRun(ownerA, "窗口一");
    assert.throws(() => service.startRun(ownerA, "重复消息"), /正在执行/);
    const second = service.startRun(ownerB, "窗口二");
    await Promise.all([first.completion, second.completion]);
    assert.equal(store.history(ownerA).length, 2);
    assert.equal(store.history(ownerB).length, 2);
    const events = store.eventData(ownerA, first.runId);
    assert.ok(events.length >= 5);
    assert.ok(events.every((event) => objectValue(event, "事件").threadId === a.id));
  } finally { await service.shutdown(); store.close(); }
});

test("取消失败后保存可继续的消息历史，不带悬空工具请求污染下一轮", async () => {
  const store = new SqliteStore(":memory:");
  let calls = 0;
  const model: Model = {
    /** 首轮持续调用工具触发步数失败，下一轮正常回顾已保存的用户历史。 */
    async generate(input) {
      calls++;
      if (calls === 1) {
        const tool: ToolCall = { id: "unfinished", name: "calculator", arguments: '{"a":1,"b":2,"operation":"+"}' };
        return { role: "assistant", content: null, toolCalls: [tool] };
      }
      assert.ok(!input.messages.some((message) => message.role === "assistant" && message.toolCalls.length > 0));
      return answer("可以继续");
    },
  };
  const service = new SessionService(store, model, { maxSteps: 1 });
  try {
    const session = store.createSession("A"); const owner = { userId: "A", threadId: session.id };
    const failed = await service.startRun(owner, "第一次任务").completion;
    assert.equal(failed.status, "failed");
    assert.equal(store.history(owner).length, 2);
    const next = await service.startRun(owner, "继续").completion;
    assert.equal(next.status, "completed");
    assert.equal(next.finalAnswer, "可以继续");
  } finally { await service.shutdown(); store.close(); }
});

test("SQL 参数绑定隔离带引号的用户 ID，旧 JSON 迁移幂等且保留原文件", (context) => {
  const root = directory(context); const store = new SqliteStore(join(root, "agent.sqlite"));
  try {
    const owner = { userId: "A' OR 1=1 --", threadId: "window-1" };
    const legacy = new JsonTodoStore(root);
    legacy.write(owner, [{ content: "旧待办", status: "completed", error: null }]);
    const original = readdirSync(root).find((file) => file.endsWith(".todos.json")); assert.ok(original);
    const before = readFileSync(join(root, original), "utf8");
    assert.equal(store.importLegacyTodos(root).imported, 1);
    store.write(owner, []);
    assert.equal(store.importLegacyTodos(root).imported, 0);
    assert.deepEqual(store.read(owner), []);
    assert.equal(store.listSessions("A").length, 0);
    assert.equal(store.listSessions(owner.userId).length, 1);
    assert.equal(readFileSync(join(root, original), "utf8"), before);
  } finally { store.close(); }
});

test("SQLite 待办四状态和整表替换仍适用，每个窗口独立", async () => {
  const store = new SqliteStore(":memory:");
  const service = new SessionService(store, rememberedModel());
  try {
    const first = store.createSession("A"), second = store.createSession("A");
    const owner = { userId: "A", threadId: first.id };
    await service.startRun(owner, "记住 工作事项").completion;
    store.write(owner, [{ content: "工作事项", status: "failed", error: "等待资料" }]);
    assert.equal(store.read(owner)[0]?.status, "failed");
    assert.deepEqual(store.read({ userId: "A", threadId: second.id }), []);
    store.write(owner, [{ content: "工作事项", status: "completed", error: null }]);
    assert.equal(store.read(owner)[0]?.status, "completed");
  } finally { await service.shutdown(); store.close(); }
});

test("本地页面 API 支持创建、续聊、日志与跨用户隔离，并拒绝跨站写入", async (context) => {
  const store = new SqliteStore(":memory:"); const service = new SessionService(store, rememberedModel());
  const server = createWebServer(service, { publicDirectory: join(process.cwd(), "public"), clientFile: join(process.cwd(), "public", "styles.css"), modelName: "test-model" });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  context.after(async () => { await service.shutdown(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  /** 请求测试 API，返回 HTTP 状态和经过解析的 JSON 对象。 */
  async function api(path: string, user = "A", data?: JsonObject) {
    const response = await fetch(base + path, { method: data ? "POST" : "GET", headers: { "X-User-Id": user, ...(data ? { "Content-Type": "application/json" } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: objectValue(parseJson(await response.text()), "响应") };
  }
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /Agent 工作台/);
  assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  const created = await api("/api/sessions", "A", {}); assert.equal(created.status, 201);
  const id = objectValue(objectValue(created.data.detail, "详情").session, "会话").id; assert.equal(typeof id, "string");
  const path = `/api/sessions/${String(id)}`;
  assert.equal((await api(path, "B")).status, 404);
  assert.equal((await api(path + "/messages", "B", { content: "越权" })).status, 404);
  assert.equal((await api(path + "/messages", "A", { content: 12 })).status, 400);
  const cross = await fetch(base + "/api/sessions", { method: "POST", headers: { "X-User-Id": "A", "Content-Type": "application/json", Origin: "https://other.example" }, body: "{}" });
  assert.equal(cross.status, 403);
  const started = await api(path + "/messages", "A", { content: "记住 上海带伞" }); assert.equal(started.status, 202);
  const runId = objectValue(started.data.run, "运行").id;
  let result = await api(path);
  for (let attempt = 0; attempt < 40; attempt++) {
    const session = objectValue(objectValue(result.data.detail, "详情").session, "会话");
    if (session.activeRun === null) break;
    await delay(10); result = await api(path);
  }
  const details = objectValue(result.data.detail, "详情");
  assert.equal(objectValue(details.session, "会话").activeRun, null);
  assert.ok(JSON.stringify(details.todos).includes("上海带伞"));
  const log = await api(`${path}/runs/${String(runId)}/events`); assert.equal(log.status, 200);
  assert.equal((await api(`${path}/runs/${String(runId)}/events`, "B")).status, 404);
  assert.equal((await api("/api/config")).data.model, "test-model");
  const longSession = await api("/api/sessions", "A", {});
  const longId = objectValue(objectValue(longSession.data.detail, "详情").session, "会话").id;
  const longInput = "长篇小说资料。".repeat(15000);
  assert.ok(Buffer.byteLength(longInput) > 262144);
  assert.equal((await api(`/api/sessions/${String(longId)}/messages`, "A", { content: longInput })).status, 202);
});

test("停止一轮执行只影响所属窗口，下一轮仍能继续", async () => {
  const store = new SqliteStore(":memory:");
  const model: Model = {
    /** 让指定消息持续等待，另一窗口直接回答。 */
    generate(input) {
      return latestUserText(input) === "等待" ? new Promise<AssistantMessage>(() => {}) : Promise.resolve(answer("正常回答"));
    },
  };
  const service = new SessionService(store, model);
  try {
    const a = store.createSession("A"), b = store.createSession("A");
    const ownerA = { userId: "A", threadId: a.id }, ownerB = { userId: "A", threadId: b.id };
    const pending = service.startRun(ownerA, "等待");
    assert.throws(() => service.cancel(ownerB, pending.runId), /运行不存在/);
    service.cancel(ownerA, pending.runId);
    const state = await pending.completion;
    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /取消/);
    const next = await service.startRun(ownerA, "继续").completion;
    const other = await service.startRun(ownerB, "另一个窗口").completion;
    assert.equal(next.status, "completed"); assert.equal(other.status, "completed");
  } finally { await service.shutdown(); store.close(); }
});

test("只恢复已退出进程的遗留运行，不中断仍存活的其他本地进程", async (context) => {
  const path = join(directory(context), "agent.sqlite");
  const store = new SqliteStore(path);
  try {
    const session = store.createSession("A"); const owner = { userId: "A", threadId: session.id };
    const id = "abandoned-run";
    store.beginRun(owner, "中断前的消息", id);
    assert.equal(store.recoverAbandonedRuns(), 0);
    const editor = new DatabaseSync(path);
    try { editor.prepare("UPDATE runs SET owner_pid=? WHERE id=?").run(2147483647, id); } finally { editor.close(); }
    assert.equal(store.recoverAbandonedRuns(), 1);
    assert.equal(store.getRun(owner, id).status, "failed");
    assert.equal(store.history(owner).length, 2);
    assert.equal(store.recoverAbandonedRuns(), 0);
    const service = new SessionService(store, rememberedModel());
    try { assert.equal((await service.startRun(owner, "继续聊").completion).status, "completed"); }
    finally { await service.shutdown(); }
  } finally { store.close(); }
});
