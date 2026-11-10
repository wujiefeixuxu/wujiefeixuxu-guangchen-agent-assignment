import { arrayValue, objectValue, parseJson, stringField } from "./json.ts";
import type { JsonValue } from "./json.ts";
import type { Message, ToolCall } from "./types.ts";
import { decodeUserPrompt } from "./prompt.ts";
import { decodeReasoning, decodeStoredUsage } from "./model-output.ts";

export const MAX_MESSAGE_CHARS = 1_000_000;
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export class AppError extends Error {
  readonly statusCode: number;
  /** 保存可返回给本地页面的 HTTP 状态和错误说明。 */
  constructor(statusCode: number, message: string) { super(message); this.statusCode = statusCode; }
}

/** 从数据库 JSON 中恢复消息，逐字段校验角色和工具调用关联信息。 */
export function decodeStoredMessage(text: string): Message {
  const row = objectValue(parseJson(text), "消息");
  if (row.role === "system") return { role: "system", content: stringField(row, "content") };
  if (row.role === "user") {
    const prompt = decodeUserPrompt(row.prompt);
    if (typeof row.content !== "string" || (!row.content.trim() && prompt?.kind !== "update")) throw new Error("用户消息正文无效");
    if (prompt?.kind === "update" && row.content !== "") throw new Error("程序状态消息不能包含用户输入");
    return { role: "user", content: row.content, ...(prompt === undefined ? {} : { prompt }) };
  }
  if (row.role === "tool") return { role: "tool", content: stringField(row, "content"), name: stringField(row, "name"), toolCallId: stringField(row, "toolCallId") };
  if (row.role !== "assistant") throw new Error("数据库消息角色无效");
  const content = row.content;
  if (content !== null && typeof content !== "string") throw new Error("助手消息内容无效");
  const toolCalls: ToolCall[] = arrayValue(row.toolCalls, "toolCalls").map((value: JsonValue) => {
    const call = objectValue(value, "工具调用");
    return { id: stringField(call, "id"), name: stringField(call, "name"), arguments: stringField(call, "arguments") };
  });
  const reasoningContent = decodeReasoning(row.reasoningContent);
  const usage = decodeStoredUsage(row.usage);
  return { role: "assistant", content, toolCalls, ...(reasoningContent === undefined ? {} : { reasoningContent }), ...(usage === undefined ? {} : { usage }) };
}
