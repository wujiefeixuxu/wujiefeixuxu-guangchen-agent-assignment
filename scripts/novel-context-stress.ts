import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { characterCount } from "../src/context.ts";
import { readConfig } from "../src/config.ts";
import { objectValue, parseJson } from "../src/json.ts";
import type { JsonValue } from "../src/json.ts";
import { createJsonlSink } from "../src/logging.ts";
import { DeepSeekModel } from "../src/models/deepseek.ts";
import { SessionService } from "../src/session-service.ts";
import { SqliteStore } from "../src/sqlite-store.ts";
import { createState, transitionState } from "../src/state.ts";
import type { AgentState } from "../src/state.ts";
import { buildModelInput, createRuntimeSnapshot, isUserInput, withInputSnapshot } from "../src/prompt.ts";
import type { TodoItem } from "../src/todos.ts";
import { createBuiltinTools } from "../src/tools/builtin.ts";
import type { Message, ModelInput } from "../src/types.ts";
import { createNovelFixture } from "./fixtures/novel.ts";
import type { NovelFixture } from "./fixtures/novel.ts";

/** 读取本脚本的数值选项，避免把字符数误当作 token 规模。 */
function flag(name: string, fallback: number): number {
  const index = process.argv.indexOf(name); if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
  return value;
}

/** 构造带有明确导入标识的历史，不把夹具回执伪装成实际模型调用。 */
function historyFor(fixture: NovelFixture): Message[] {
  return [{ role: "user", content: "【本地压力测试资料导入】以下为合成小说材料，后续写作以已确认设定为准。" }, ...fixture.messages,
    { role: "assistant", content: "【本地导入回执，非模型生成】资料已完整保存，等待实际写作请求。", toolCalls: [] }];
}

/** 按正式消息协议校准输入规模；占位身份只用于预估，生成响应仍以真实 usage 验收。 */
function calibrationInput(prompt: string, fixture: NovelFixture, todos: readonly TodoItem[], maxModelCalls: number): ModelInput {
  const state = createState(prompt, undefined, historyFor(fixture));
  const user = state.messages.at(-1); assert.ok(user && isUserInput(user));
  const snapshot = createRuntimeSnapshot({ userId: "user-A", threadId: "calibration", runId: "calibration" }, "running", state.metrics, maxModelCalls, todos, state.messages);
  const messages = [...state.messages.slice(0, -1), withInputSnapshot(user, snapshot)];
  return buildModelInput(messages.filter((message) => message.role === "system"), messages.filter((message) => message.role !== "system"), createBuiltinTools().definitions());
}

/** 只在新建的测试会话中导入资料，生成调用次数保持为零。 */
function importFixture(store: SqliteStore, owner: { userId: string; threadId: string }, fixture: NovelFixture): void {
  const history = historyFor(fixture); const first = history[0]; assert.ok(first?.role === "user");
  const runId = randomUUID(); store.beginRun(owner, first.content, runId);
  let state = transitionState(createState(first.content), "running");
  const system = state.messages[0]; assert.ok(system);
  state = { ...state, messages: [system, ...history], finalAnswer: "本地合成资料导入完成", identity: { ...owner, runId } };
  store.finishRun(owner, runId, transitionState(state, "completed"));
}

/** 从真正的模型生成响应提取输入 token，用于验证兼容计数与实际 usage。 */
function usages(state: AgentState): number[] {
  return state.logs.filter((entry) => entry.event === "model.succeeded").map((entry) => {
    const data = objectValue(entry.data, "模型结果"); const usage = objectValue(data.usage, "真实 usage");
    const count = usage.promptTokens; if (typeof count !== "number") throw new Error("模型没有返回真实输入 token 用量");
    return count;
  });
}

/** 归一化自动回忆检查的标点；不代替人工文学审读。 */
function normalize(value: JsonValue | undefined): string {
  return String(value ?? "").replace(/[\p{P}\s]/gu, "").toLowerCase();
}

/** 执行真实 token 长上下文、小说续写、压缩、事实回忆及 Todo 连续性测试。 */
async function main(): Promise<void> {
  const targetTokens = flag("--target-tokens", 250_000), limitTokens = flag("--limit-tokens", 100_000);
  if (targetTokens < 200_000 || targetTokens > 300_000 || limitTokens >= targetTokens) throw new Error("测试语料目标需为20万～30万token，压缩触发线应低于测试规模");
  const config = readConfig();
  const model = new DeepSeekModel({ ...config.model, timeoutMs: 120_000 });
  const baselinePrompt = "请按导入资料，以第60章末尾的场景为基础写一段600～800字的环境与人物心理描写，作为第61章开头。暂不推进剧情，不改变已确认人物、物品或时间状态。本轮不要调用工具或修改待办，只给正文。";
  const todos: TodoItem[] = [
    { content: "完成前60章资料导入", status: "completed", error: null },
    { content: "续写第61章：旧灯塔的门", status: "pending", error: null },
    { content: "核对人物伤势和会面暗号", status: "pending", error: null },
    { content: "读取北码头失效的值班登记", status: "failed", error: "原记录已被雨水浸坏，需要寻找副本" },
  ];
  let chars = 400_000; let fixture = createNovelFixture(chars); let countedTokens = 0;
  const calibrations: { characters: number; countedTokens: number }[] = [];
  console.log("[1/6] 用提供商接口校准20～30万token的合成小说资料…");
  for (let attempt = 0; attempt < 3; attempt++) {
    const input = calibrationInput(baselinePrompt, fixture, todos, config.runtime.maxModelCalls ?? 20);
    countedTokens = await model.countTokens(input, AbortSignal.timeout(120_000));
    calibrations.push({ characters: fixture.characters, countedTokens });
    console.log(`计数：${fixture.characters}字符，${countedTokens} input_tokens`);
    if (countedTokens >= 200_000 && countedTokens <= 300_000) break;
    chars = Math.min(800_000, Math.max(200_000, Math.round(chars * targetTokens / countedTokens)));
    fixture = createNovelFixture(chars);
  }
  assert.ok(countedTokens >= 200_000 && countedTokens <= 300_000, "未能校准到20～30万真实token范围");
  const store = new SqliteStore(config.databasePath);
  const session = store.createSession("user-A", `小说长上下文测试 · ${Math.round(countedTokens / 1000)}K token`);
  const owner = { userId: "user-A", threadId: session.id };
  const folder = join(config.dataDirectory, "novel-stress", session.id); mkdirSync(folder, { recursive: true });
  const reportPath = join(folder, "report.json");
  const report: Record<string, JsonValue> = { sessionId: session.id, database: config.databasePath, contextUnit: "tokens", targetTokens, limitTokens, calibrations, fixtureSource: "本地程序合成，历史回执非模型生成", url: `http://127.0.0.1:${config.webPort}/?user=user-A&session=${session.id}` };
  /** 每完成一个阶段就保存报告，失败也能查看已经取得的真实结果。 */
  const save = (): void => writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  const sink = createJsonlSink(join(config.logDirectory, "novel-stress"), [config.model.apiKey]);
  let service = new SessionService(store, model, { ...config.runtime, timeoutMs: 300_000, context: { maxTokens: 1_000_000, recentTurns: 4 }, onEvent: sink });
  try {
    console.log("[2/6] 导入新测试会话，保存完整材料和四状态待办…");
    importFixture(store, owner, fixture); store.write(owner, todos);
    writeFileSync(join(folder, "material.txt"), fixture.corpus, "utf8"); save();
    if (process.argv.includes("--prepare-only")) { console.log(JSON.stringify({ ...report, reportPath }, null, 2)); return; }
    console.log("[3/6] 用完整长上下文实际写作，记录生成响应的 usage.prompt_tokens…");
    const baseline = await service.startRun(owner, baselinePrompt).completion;
    assert.equal(baseline.status, "completed", baseline.error ?? "");
    const baselineTokens = usages(baseline);
    assert.ok(baselineTokens.some((count) => count >= 200_000 && count <= 300_000), "生成响应未确认20～30万输入token");
    assert.equal(baseline.contextMemory.coveredMessages, 0);
    report.baseline = { runId: baseline.identity?.runId ?? "", actualPromptTokens: baselineTokens, modelCalls: baseline.metrics.modelCalls, tokenCountRequests: baseline.metrics.tokenCountRequests };
    writeFileSync(join(folder, "before-compression.md"), baseline.finalAnswer ?? "", "utf8"); save();
    await service.shutdown();
    service = new SessionService(store, model, { ...config.runtime, timeoutMs: 300_000, context: { maxTokens: limitTokens, recentTurns: 4 }, onEvent: sink });
    console.log("[4/6] 触发压缩，再核对小说早、中、晚段的10个事实锚点…");
    const probePrompt = "以导入资料第60章末尾的已确认设定为准，不要把角色猜测当事实。不要调用工具或修改待办。请只返回JSON对象，每个值用字符串，不确定时用null，不要猜：age=林舟年龄；hearing=听力限制；password=交接暗号；duheng=杜衡生死状态；boxContent=铁盒真实内容；meetingTime=最终会面时间；location=第60章结束时位置；boxHolder=铁盒持有人；injury=手部伤势；gaoqi=高启是否已确认为反派。";
    const probe = await service.startRun(owner, probePrompt).completion;
    assert.equal(probe.status, "completed", probe.error ?? "");
    assert.ok(probe.contextMemory.coveredMessages > 0, "没有触发实际摘要");
    assert.ok(characterCount(probe.contextMemory.summary) <= 4000);
    const probeText = (probe.finalAnswer ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const recalled = objectValue(parseJson(probeText), "回忆结果");
    const checks = fixture.rules.map((rule) => {
      const actual = recalled[rule.key] ?? null; const normalized = normalize(actual);
      const passed = rule.all.every((part) => normalized.includes(normalize(part))) && (!rule.any || rule.any.some((part) => normalized.includes(normalize(part))));
      return { fact: rule.label, position: rule.position, expected: rule.expected, actual, passed };
    });
    const prepared = probe.logs.filter((entry) => entry.event === "context.prepared").map((entry) => entry.data);
    const actualAfter = probe.logs.filter((entry) => entry.event === "model.succeeded" && objectValue(entry.data, "模型结果").purpose === "agent").map((entry) => {
      const count = objectValue(objectValue(entry.data, "模型结果").usage, "usage").promptTokens;
      if (typeof count !== "number") throw new Error("缺少压缩后的真实输入 token 用量");
      return count;
    });
    assert.ok(actualAfter.length > 0 && actualAfter.every((count) => count <= limitTokens), "压缩后实际生成输入仍超过设定token线");
    report.compression = { runId: probe.identity?.runId ?? "", summaryCharacters: characterCount(probe.contextMemory.summary), coveredMessages: probe.contextMemory.coveredMessages, modelCalls: probe.metrics.modelCalls, tokenCountRequests: probe.metrics.tokenCountRequests, prepared, actualAllPromptTokens: usages(probe), agentPromptTokens: actualAfter, checks, recallPassed: checks.filter((item) => item.passed).length, recallTotal: checks.length };
    writeFileSync(join(folder, "summary.txt"), probe.contextMemory.summary, "utf8"); save();
    console.log("[5/6] 在压缩后上下文中继续小说，并由模型更新待办…");
    const continued = await service.startRun(owner, "继续上一段，完成第61章的一段600～800字正文，可以推进情节但不能违反已确认设定。请用write_todos把‘核对人物伤势和会面暗号’标完成、‘续写第61章：旧灯塔的门’先标进行中再标完成。原来已完成的资料导入项和失败的值班登记项及其原因必须保留。不要搜索或抓网页；最后给出正文。").completion;
    assert.equal(continued.status, "completed", continued.error ?? "");
    const savedTodos = store.read(owner);
    const todoChecks = todos.map((item) => {
      const actual = savedTodos.find((todo) => todo.content === item.content);
      const expected = item.status === "pending" ? "completed" : item.status;
      return { content: item.content, expected, actual: actual?.status ?? null, passed: actual?.status === expected && actual.error === item.error };
    });
    report.continuation = { runId: continued.identity?.runId ?? "", modelCalls: continued.metrics.modelCalls, tokenCountRequests: continued.metrics.tokenCountRequests, todos: savedTodos, todoChecks };
    writeFileSync(join(folder, "after-compression.md"), continued.finalAnswer ?? "", "utf8");
    console.log("[6/6] 核对原始材料和模型调用次数，保存报告…");
    const saved = store.history(owner);
    const corpusPreserved = fixture.messages.filter((message) => message.role === "user").every((message) => saved.some((stored) => stored.role === "user" && stored.content === message.content));
    assert.ok(corpusPreserved);
    report.originalHistoryPreserved = corpusPreserved;
    report.reportPath = reportPath; save();
    console.log(JSON.stringify({ url: report.url, reportPath, baselinePromptTokens: baselineTokens, summaryCharacters: characterCount(probe.contextMemory.summary), recalledFacts: `${checks.filter((item) => item.passed).length}/${checks.length}`, todosPassed: `${todoChecks.filter((item) => item.passed).length}/${todoChecks.length}`, originalHistoryPreserved: corpusPreserved }, null, 2));
  } catch (error) { report.failure = error instanceof Error ? error.message : "长上下文测试失败"; save(); throw error; }
  finally { await service.shutdown(); store.close(); }
}

try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : "小说上下文测试失败"); process.exitCode = 1; }
