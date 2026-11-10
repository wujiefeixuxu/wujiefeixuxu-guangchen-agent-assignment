import type { JsonObject, JsonValue } from "./json.ts";
import type { ToolExecutionContext, ToolResultMeta } from "./execution.ts";
import type { ToolErrorData } from "./tool-errors.ts";
import type { UserPrompt } from "./prompt.ts";

export type NodeId = "model" | "tools";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface SystemMessage {
  readonly role: "system";
  readonly content: string;
}

export interface UserMessage {
  readonly role: "user";
  readonly content: string;
  readonly prompt?: UserPrompt;
}

export type TextMessage = SystemMessage | UserMessage;

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly reasoningContent?: string;
  readonly usage?: ModelUsage;
}

export interface ModelUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens?: number;
  readonly cacheHitTokens?: number;
  readonly cacheMissTokens?: number;
}

export interface ToolMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly content: string;
}

export type Message = TextMessage | AssistantMessage | ToolMessage;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
}

export interface Tool<TArgs, TResult extends JsonValue = JsonValue> extends ToolDefinition {
  /** 校验原始 JSON 参数，并转换为该工具的具体参数类型；无效参数抛出工具异常。 */
  parse(argumentsObject: JsonObject): TArgs;
  /** 使用校验后的参数执行业务操作；身份、调用信息和取消信号由 Runtime 注入。 */
  execute(args: TArgs, context: ToolExecutionContext): Promise<TResult>;
}

export type ToolResult = (
  | { readonly ok: true; readonly result: JsonValue }
  | { readonly ok: false; readonly error: ToolErrorData }
) & { readonly meta: ToolResultMeta };

export interface ModelInput {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
  readonly maxOutputTokens?: number;
}

export interface Model {
  /** 根据消息与工具 Schema 生成一条助手回复，并响应传入的取消信号。 */
  generate(input: ModelInput, signal: AbortSignal): Promise<AssistantMessage>;
  /** 使用提供商计数接口核算输入 token；该操作不生成模型回复。 */
  countTokens?(input: ModelInput, signal: AbortSignal): Promise<number>;
}
