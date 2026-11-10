import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../src/config.ts";
import { createJsonlSink } from "../src/logging.ts";
import { memoryView } from "../src/memory.ts";
import { DeepSeekModel } from "../src/models/deepseek.ts";
import { objectValue } from "../src/json.ts";
import type { JsonValue } from "../src/json.ts";
import { SessionService } from "../src/session-service.ts";
import { SqliteStore } from "../src/sqlite-store.ts";
import type { AgentState } from "../src/state.ts";

/** 从运行日志提取模型实际看到的请求，摘要调用与任务决策分开。 */
function requests(state: AgentState) {
  return state.logs.filter((entry) => entry.event === "model.started" && objectValue(entry.data, "请求").purpose === "agent").map((entry) => objectValue(entry.data, "请求"));
}

/** 在独立测试库验证真实模型的写入、跨会话召回、冻结快照和手动整理。 */
async function main(): Promise<void> {
  const config = readConfig();
  const folder = join(config.dataDirectory, "memory-smoke", randomUUID()); mkdirSync(folder, { recursive: true });
  const database = join(folder, "agent.sqlite");
  const oldTime = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const body = "## 已确认的测试项目约束\n- 使用Node.js和TypeScript。\n- 自己实现Agent Runtime，不使用Agent框架。";
  let store = new SqliteStore(database);
  store.upsertMemory("user-A", { id: "agent-project", name: "Agent项目", summary: "项目技术约束，受控测试资料", content: body }, oldTime);
  store.upsertMemory("user-A", { id: "agent-project-copy", name: "Agent项目重复副本", summary: "与agent-project完全重复的测试副本", content: body }, oldTime);
  const options = { ...config.runtime, onEvent: createJsonlSink(join(folder, "logs"), [config.model.apiKey]) };
  let service = new SessionService(store, new DeepSeekModel(config.model), options);
  const session = store.createSession("user-A", "记忆写入与冻结验证");
  const owner = { userId: "user-A", threadId: session.id };
  try {
    console.log("[1/3] 真实模型写入偏好，验证本轮system不随写入变化…");
    const first = await service.startRun(owner, "请调用memory_write保存一条偏好：id为preferences，名称回答偏好，简介中文和条目风格，正文为‘使用中文回复，简短列点，最多三点’。只保存这条记忆，不操作Todo。保存成功后简短回复。").completion;
    assert.equal(first.status, "completed", first.error ?? "");
    assert.ok(store.getMemory("user-A", "preferences")?.content.includes("中文"));
    const firstInputs = requests(first); assert.ok(firstInputs.length >= 2);
    const originalMessages = firstInputs[0]?.messages; assert.ok(Array.isArray(originalMessages));
    for (const input of firstInputs) { assert.ok(Array.isArray(input.messages)); assert.deepEqual(input.messages[0], originalMessages[0]); }
    assert.equal(first.memorySnapshot.preferences, null);
    assert.equal(store.getMemory("user-A", "preferences")?.recordedAt, store.inputRecordedAt(owner, first.identity?.runId ?? ""));
    await service.shutdown(); store.close();
    store = new SqliteStore(database); service = new SessionService(store, new DeepSeekModel(config.model), options);
    const recalledSession = store.createSession("user-A", "长期记忆 · 召回与整理");
    const recalledOwner = { userId: "user-A", threadId: recalledSession.id };
    console.log("[2/3] 新会话按索引读取旧项目正文，不带入旧会话聊天…");
    const recalled = await service.startRun(recalledOwner, "请先调用memory_read读取agent-project的完整正文，再告诉我这个项目的技术约束。不要修改记忆，不操作Todo。").completion;
    assert.equal(recalled.status, "completed", recalled.error ?? "");
    assert.ok(recalled.logs.some((entry) => entry.event === "tool.succeeded" && entry.toolName === "memory_read"));
    assert.match(recalled.finalAnswer ?? "", /Node|node/); assert.match(recalled.finalAnswer ?? "", /TypeScript|TS/);
    assert.ok(recalled.memorySnapshot.preferences?.content.includes("中文"));
    assert.ok(recalled.memorySnapshot.index.every((item) => item.timeLabel === "前天"));
    console.log("[3/3] 由现有Agent手动整理重复记忆，保留偏好和旧记录时间…");
    const organized = await service.startMemoryOrganization(recalledOwner).completion;
    assert.equal(organized.status, "completed", organized.error ?? "");
    const remaining = store.listMemories("user-A");
    assert.equal(remaining.filter((record) => record.id !== "preferences").length, 1);
    assert.ok(remaining.some((record) => record.id === "preferences"));
    assert.equal(remaining.find((record) => record.id !== "preferences")?.recordedAt, oldTime);
    const states = [first, recalled, organized];
    const usage: JsonValue[] = [];
    for (const state of states) {
      const counted = state.logs.filter((entry) => entry.event === "context.prepared").map((entry) => objectValue(entry.data, "计数").preparedTokens);
      const actual = state.logs.filter((entry) => entry.event === "model.succeeded" && objectValue(entry.data, "回复").purpose === "agent").map((entry) => {
        const value = objectValue(objectValue(entry.data, "回复").usage, "用量"); usage.push({ ...value }); return value.promptTokens;
      });
      assert.deepEqual(counted, actual);
    }
    const report = {
      database, fixtureSource: "项目记忆由程序预置，重复副本仅用于测试；偏好写入、召回和整理由真实模型执行", sessionId: recalledSession.id,
      thinkingMode: config.model.thinkingMode ?? "enabled", reasoningEffort: config.model.reasoningEffort ?? "max",
      statuses: states.map((state) => state.status), modelCalls: states.map((state) => state.metrics.modelCalls),
      runIds: states.map((state) => state.identity?.runId ?? ""),
      actualExecutions: states.map((state) => state.metrics.actualExecutions),
      tools: states.map((state) => state.logs.filter((entry) => entry.event === "tool.started").map((entry) => entry.toolName)),
      snapshotFrozen: true, crossSessionRecall: true, originalTimePreserved: true, exactTokenCounts: true,
      memories: remaining.map((record) => memoryView(record, new Date())), replies: states.map((state) => state.finalAnswer), usage,
    };
    writeFileSync(join(folder, "report.json"), JSON.stringify(report, null, 2), "utf8");
    writeFileSync(join(folder, "request-example.json"), JSON.stringify(requests(recalled)[0], null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally { await service.shutdown(); store.close(); }
}

try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : "长期记忆验证失败"); process.exitCode = 1; }
