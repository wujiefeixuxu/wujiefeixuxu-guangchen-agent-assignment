import assert from "node:assert/strict";
import { objectValue, parseJson } from "../../src/json.ts";
import type { JsonObject } from "../../src/json.ts";
import { SNAPSHOT_HEADER, SUMMARY_HEADER, UPDATE_HEADER, USER_INPUT_HEADER } from "../../src/prompt.ts";
import type { Message, ModelInput, ToolMessage } from "../../src/types.ts";

/** 从真实模型输入中还原用户原文，跳过程序更新和历史摘要。 */
export function userTexts(input: ModelInput): string[] {
  return input.messages.filter((message) => message.role === "user").flatMap((message) => {
    const content = message.content ?? "";
    if (content.startsWith(UPDATE_HEADER) || content.startsWith(SUMMARY_HEADER)) return [];
    if (!content.startsWith(USER_INPUT_HEADER)) return [content];
    const end = content.indexOf(`\n\n---\n${SNAPSHOT_HEADER}`);
    assert.ok(end >= USER_INPUT_HEADER.length);
    const original = parseJson(content.slice(USER_INPUT_HEADER.length, end));
    assert.equal(typeof original, "string");
    return [String(original)];
  });
}

/** 取得最新用户原文，不把工具后的状态通知当成新的用户需求。 */
export function latestUserText(input: ModelInput): string { return userTexts(input).at(-1) ?? ""; }

/** 跳过纯程序通知，取得最近一条用户、助手或工具协议消息。 */
export function lastConversationMessage(input: ModelInput): Message | undefined {
  return input.messages.findLast((message) => message.role !== "user" || (!message.content.startsWith(UPDATE_HEADER) && !message.content.startsWith(SUMMARY_HEADER)));
}

/** 取得最近一次真实工具返回，不要求它恰好位于消息尾部。 */
export function lastToolMessage(input: ModelInput): ToolMessage | undefined {
  return input.messages.findLast((message): message is ToolMessage => message.role === "tool");
}

/** 解析模型实际看到的最新快照，用来核对进度、预算和当前完整 Todo。 */
export function latestSnapshot(input: ModelInput): JsonObject {
  const message = input.messages.findLast((item) => item.role === "user" && (item.content.startsWith(USER_INPUT_HEADER) || item.content.startsWith(UPDATE_HEADER)));
  assert.ok(message?.content);
  const position = message.content.indexOf(SNAPSHOT_HEADER);
  assert.ok(position >= 0);
  return objectValue(parseJson(message.content.slice(position + SNAPSHOT_HEADER.length)), "运行快照");
}
