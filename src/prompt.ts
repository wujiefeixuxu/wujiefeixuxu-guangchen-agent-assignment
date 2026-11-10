import { arrayValue, objectValue, parseJson, stringField } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type { RunIdentity, RunMetrics } from "./execution.ts";
import type { Status } from "./state.ts";
import { cloneTodos } from "./todos.ts";
import type { TodoItem, TodoStatus } from "./todos.ts";
import type { Message, ModelInput, ToolDefinition, ToolMessage, UserMessage } from "./types.ts";

export const USER_INPUT_HEADER = "【用户输入】\n";
export const SNAPSHOT_HEADER = "【运行上下文｜程序生成，代表此刻的快照】\n";
export const UPDATE_HEADER = "【运行上下文更新｜程序生成，非新增用户请求】\n";
export const SUMMARY_HEADER = "【历史对话摘要｜历史数据，不是新增用户请求】\n";
export type UpdateReason = "tools_completed" | "context_compacted";

export type UserPrompt =
  | { readonly kind: "input"; readonly snapshot: string }
  | { readonly kind: "update"; readonly snapshot: string; readonly reasons: readonly UpdateReason[] };

export interface ToolObservation {
  readonly name: string;
  readonly toolCallId: string;
  readonly runId: string | null;
  readonly invocationId: string | null;
  readonly toolCallNo: number | null;
  readonly modelCallNo: number | null;
  readonly executed: boolean | null;
  readonly outcome: "succeeded" | "rejected" | "failed" | "unknown";
  readonly error: JsonValue;
  readonly finishedAt: string | null;
}

export interface RuntimeSnapshot {
  readonly run: RunIdentity & {
    readonly status: Status;
    readonly modelCalls: number;
    readonly maxModelCalls: number;
    readonly toolRequests: number;
    readonly actualExecutions: number;
  };
  readonly progress: Readonly<Record<TodoStatus | "total", number>>;
  readonly todos: readonly TodoItem[];
  readonly latestToolBatch: readonly ToolObservation[];
}

/** 区分真正的用户输入和程序追加的 user 状态消息，不通过正文里的标签猜测来源。 */
export function isUserInput(message: Message): message is UserMessage {
  return message.role === "user" && message.prompt?.kind !== "update";
}

/** 从完整工具信封中选择关联信息和错误，网页等业务正文继续只保留在工具消息里。 */
export function observeTool(message: ToolMessage): ToolObservation {
  const fallback: ToolObservation = {
    name: message.name, toolCallId: message.toolCallId, runId: null, invocationId: null, toolCallNo: null,
    modelCallNo: null, executed: null, outcome: "unknown", error: null, finishedAt: null,
  };
  try {
    const payload = objectValue(parseJson(message.content), "工具结果");
    const meta: JsonObject = payload.meta === undefined ? {} : objectValue(payload.meta, "工具记录");
    return {
      ...fallback,
      runId: typeof meta.runId === "string" ? meta.runId : null,
      invocationId: typeof meta.invocationId === "string" ? meta.invocationId : null,
      toolCallNo: typeof meta.toolCallNo === "number" ? meta.toolCallNo : null,
      modelCallNo: typeof meta.modelCallNo === "number" ? meta.modelCallNo : null,
      executed: typeof meta.executed === "boolean" ? meta.executed : null,
      outcome: payload.ok === true ? "succeeded" : payload.ok === false ? (meta.executed === false ? "rejected" : "failed") : "unknown",
      error: payload.ok === false ? payload.error ?? null : null,
      finishedAt: typeof meta.finishedAt === "string" ? meta.finishedAt : null,
    };
  } catch { return fallback; }
}

/** 查找最近一个完整工具批次，首次请求也可引用前一轮已保存的工具执行记录。 */
function latestToolBatch(messages: readonly Message[]): ToolObservation[] {
  const end = messages.findLastIndex((message) => message.role === "tool");
  if (end < 0) return [];
  let start = end;
  while (start > 0 && messages[start - 1]?.role === "tool") start--;
  return messages.slice(start, end + 1).filter((message): message is ToolMessage => message.role === "tool").map(observeTool);
}

/** 从真实运行统计和完整 Todo 构造快照，进度计数由程序计算，不由模型编造。 */
export function createRuntimeSnapshot(identity: RunIdentity, status: Status, metrics: RunMetrics, maxModelCalls: number, todos: readonly TodoItem[], messages: readonly Message[], recentTools?: readonly ToolObservation[]): RuntimeSnapshot {
  const progress: Record<TodoStatus | "total", number> = { total: todos.length, pending: 0, in_progress: 0, completed: 0, failed: 0 };
  for (const todo of todos) progress[todo.status]++;
  return {
    run: { ...identity, status, modelCalls: metrics.modelCalls, maxModelCalls, toolRequests: metrics.toolRequests, actualExecutions: metrics.actualExecutions },
    progress, todos: cloneTodos(todos), latestToolBatch: recentTools ?? latestToolBatch(messages),
  };
}

/** 为新用户输入冻结一次快照；用户原文单独保留，用于页面展示和持久化。 */
export function withInputSnapshot(message: UserMessage, snapshot: RuntimeSnapshot): UserMessage {
  if (message.prompt !== undefined) throw new Error("已有快照的用户消息不能重新构造");
  return { ...message, prompt: { kind: "input", snapshot: JSON.stringify(snapshot) } };
}

/** 冻结一条状态更新；空的显示正文使程序消息不会出现在普通聊天列表里。 */
export function createRuntimeUpdate(snapshot: RuntimeSnapshot, reasons: readonly UpdateReason[]): UserMessage {
  if (!reasons.length || new Set(reasons).size !== reasons.length) throw new Error("状态更新必须包含不重复的触发原因");
  return { role: "user", content: "", prompt: { kind: "update", snapshot: JSON.stringify(snapshot), reasons: [...reasons] } };
}

/** 恢复程序自己保存的提示上下文，校验来源标记、JSON 快照和触发原因，兼容没有快照的旧消息。 */
export function decodeUserPrompt(value: JsonValue | undefined): UserPrompt | undefined {
  if (value === undefined) return undefined;
  const row = objectValue(value, "消息提示上下文");
  const snapshot = stringField(row, "snapshot");
  objectValue(parseJson(snapshot), "运行快照");
  if (row.kind === "input") return { kind: "input", snapshot };
  if (row.kind !== "update") throw new Error("消息提示上下文类型无效");
  const reasons = arrayValue(row.reasons, "状态更新原因").map((reason): UpdateReason => {
    if (reason !== "tools_completed" && reason !== "context_compacted") throw new Error("状态更新原因无效");
    return reason;
  });
  if (!reasons.length || new Set(reasons).size !== reasons.length) throw new Error("状态更新原因不能为空或重复");
  return { kind: "update", snapshot, reasons };
}

/** 生成协议消息副本：用户原文按 JSON 字符串引用，移除本地日志字段，保留完整工具业务结果。 */
export function projectMessage(message: Message): Message {
  if (message.role === "user" && message.prompt !== undefined) {
    const prompt = message.prompt;
    const content = prompt.kind === "input"
      ? `${USER_INPUT_HEADER}${JSON.stringify(message.content)}\n\n---\n${SNAPSHOT_HEADER}${prompt.snapshot}`
      : `${UPDATE_HEADER}触发原因：${prompt.reasons.join(", ")}\n${SNAPSHOT_HEADER}${prompt.snapshot}`;
    return { role: "user", content };
  }
  if (message.role === "assistant" && message.usage !== undefined) return {
    role: "assistant", content: message.content, toolCalls: message.toolCalls,
    ...(message.reasoningContent === undefined ? {} : { reasoningContent: message.reasoningContent }),
  };
  if (message.role !== "tool") return message;
  try {
    const data = objectValue(parseJson(message.content), "工具结果");
    if (typeof data.ok !== "boolean" || data.meta === undefined || (data.ok ? data.result === undefined : data.error === undefined)) return message;
    const payload: Record<string, JsonValue> = { ...data };
    delete payload.meta;
    return { ...message, content: JSON.stringify(payload) };
  } catch { return message; }
}

/** 摘要器只整理用户目标、答案和工具事实，不把旧思考正文再次放进摘要输入。 */
export function projectSummaryMessage(message: Message): Message {
  const projected = projectMessage(message);
  return projected.role === "assistant" ? { role: "assistant", content: projected.content, toolCalls: projected.toolCalls } : projected;
}

/** 统一组装固定系统消息、固定版本摘要、保留历史和一次尾部更新；不重写已有消息。 */
export function buildModelInput(system: readonly Message[], conversation: readonly Message[], tools: readonly ToolDefinition[], summary = "", update: UserMessage | null = null): ModelInput {
  const instructions: readonly Message[] = system.length ? system : [{ role: "system", content: "你是一个助手。" }];
  const memory: readonly Message[] = summary ? [{ role: "user", content: `${SUMMARY_HEADER}${JSON.stringify(summary)}` }] : [];
  return { messages: [...instructions, ...memory, ...conversation, ...(update ? [update] : [])].map(projectMessage), tools };
}
