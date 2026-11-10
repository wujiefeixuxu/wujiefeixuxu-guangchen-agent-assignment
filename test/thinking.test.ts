import assert from "node:assert/strict";
import test from "node:test";
import { ContextManager } from "../src/context.ts";
import { objectValue, parseJson } from "../src/json.ts";
import { SessionService } from "../src/session-service.ts";
import { SqliteStore } from "../src/sqlite-store.ts";
import type { AssistantMessage, Message, Model, ModelInput } from "../src/types.ts";
import { lastConversationMessage } from "./helpers/messages.ts";

/** 构造同时包含思考、答案和真实格式用量的测试助手消息。 */
function answer(content: string, reasoningContent: string): AssistantMessage {
  return { role: "assistant", content, reasoningContent, toolCalls: [], usage: { promptTokens: 100, completionTokens: 50, reasoningTokens: 40, totalTokens: 150 } };
}

test("工具循环和SQLite恢复保留全部思考，页面同时取得工具步骤与最终答案", async () => {
  const store = new SqliteStore(":memory:");
  const inputs: ModelInput[] = [];
  const toolThinking = "fixture: complete tool reasoning 😀".repeat(300);
  const finalThinking = "fixture: final reasoning";
  const model: Model = {
    /** 工具决策包含长思考，工具后和恢复后的请求都必须完整保留原文。 */
    async generate(input) {
      inputs.push(structuredClone(input));
      if (inputs.length === 1) return { ...answer("", toolThinking), content: null, toolCalls: [{ id: "thinking-calc", name: "calculator", arguments: '{"a":12,"b":3,"operation":"*"}' }] };
      assert.equal(input.messages.find((message) => message.role === "assistant" && message.toolCalls.length)?.role === "assistant", true);
      const prior = input.messages.find((message) => message.role === "assistant" && message.toolCalls.length);
      assert.ok(prior?.role === "assistant"); assert.equal(prior.reasoningContent, toolThinking); assert.equal(prior.usage, undefined);
      return answer(lastConversationMessage(input)?.role === "tool" ? "36" : "之前是36", finalThinking);
    },
  };
  let service = new SessionService(store, model);
  const session = store.createSession("A"); const owner = { userId: "A", threadId: session.id };
  try {
    const first = await service.startRun(owner, "计算12乘3").completion;
    assert.equal(first.status, "completed", first.error ?? "");
    const history = store.history(owner);
    assert.ok(history.some((message) => message.role === "assistant" && message.reasoningContent === toolThinking));
    const page = store.detail(owner).messages.filter((message) => message.role === "assistant");
    assert.equal(page.length, 2); assert.equal(page[0]?.toolCalls?.[0]?.id, "thinking-calc");
    assert.equal(page[0]?.reasoningContent, toolThinking); assert.equal(page[1]?.reasoningContent, finalThinking);
    assert.equal(page[1]?.content, "36"); assert.equal(page[1]?.usage?.reasoningTokens, 40);
    await service.shutdown(); service = new SessionService(store, model);
    const second = await service.startRun(owner, "刚才结果是什么").completion;
    assert.equal(second.status, "completed", second.error ?? "");
    const restored = inputs[2]; assert.ok(restored);
    assert.ok(restored.messages.some((message) => message.role === "assistant" && message.reasoningContent === finalThinking));
    assert.equal(JSON.stringify(store.history(owner).slice(0, history.length)), JSON.stringify(history));
  } finally { await service.shutdown(); store.close(); }
});

test("压缩不向摘要器灌入旧思考，当前轮工具调用的思考仍然完整发送", async () => {
  const oldThought = "old reasoning that is not a business fact".repeat(300);
  const currentThought = "current complete reasoning".repeat(150);
  const messages: Message[] = [
    { role: "system", content: "固定系统规则" }, { role: "user", content: "旧资料".repeat(4000) },
    { ...answer("", oldThought), content: null, toolCalls: [{ id: "old", name: "calculator", arguments: '{"a":12,"b":3,"operation":"*"}' }] },
    { role: "tool", name: "calculator", toolCallId: "old", content: '{"ok":true,"result":36}' },
    answer("结果36", oldThought), { role: "user", content: "加10" },
    { ...answer("", currentThought), content: null, toolCalls: [{ id: "current", name: "calculator", arguments: '{"a":36,"b":10,"operation":"+"}' }] },
    { role: "tool", name: "calculator", toolCallId: "current", content: '{"ok":true,"result":46}' },
  ];
  const before = JSON.stringify(messages);
  let calls = 0;
  const manager = new ContextManager({ maxChars: 3000 });
  const prepared = await manager.prepare(messages, [], () => null,
    /** 仅归纳旧用户轮次中的事实，当前工具对及其思考不属于压缩来源。 */
    async (input) => {
      calls++; const data = objectValue(parseJson(input.messages[1]?.content ?? ""), "摘要输入");
      assert.equal(JSON.stringify(data).includes(oldThought), false); assert.equal(JSON.stringify(data).includes(currentThought), false);
      assert.ok(JSON.stringify(data).includes("36")); return answer("历史计算结果36，后续可以引用。", "summary fixture");
    }, () => {});
  assert.equal(calls, 1); assert.equal(manager.memory.coveredMessages, 4);
  const active = prepared.input.messages.find((message) => message.role === "assistant" && message.toolCalls.some((call) => call.id === "current"));
  assert.ok(active?.role === "assistant"); assert.equal(active.reasoningContent, currentThought);
  assert.equal(prepared.input.messages[0]?.content, "固定系统规则");
  assert.equal(JSON.stringify(messages), before);
});
