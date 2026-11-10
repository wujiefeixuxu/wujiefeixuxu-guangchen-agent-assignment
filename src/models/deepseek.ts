import { arrayValue, numberField, objectValue, parseJson, stringField } from "../json.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import type { AssistantMessage, Message, Model, ModelInput, ToolCall } from "../types.ts";
import { decodeReasoning, decodeUsage } from "../model-output.ts";

export type ThinkingMode = "enabled" | "disabled";
export type ReasoningEffort = "low" | "high" | "max";

export interface DeepSeekOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly thinkingMode?: ThinkingMode;
  readonly reasoningEffort?: ReasoningEffort;
}

/** 将消息转换为兼容计数接口使用的结构，批量工具结果保持与原请求的关联。 */
export function encodeTokenCountInput(input: ModelInput, model: string, thinkingMode: ThinkingMode = "enabled", reasoningEffort: ReasoningEffort = "max"): JsonObject {
  const messages: { role: "user" | "assistant"; content: JsonValue[] }[] = [];
  const system = input.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  for (const message of input.messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const block = { type: "tool_result", tool_use_id: message.toolCallId, content: message.content };
      const last = messages.at(-1);
      if (last?.role === "user" && last.content.every((value) => value !== null && typeof value === "object" && !Array.isArray(value) && value.type === "tool_result")) last.content.push(block);
      else messages.push({ role: "user", content: [block] });
    } else if (message.role === "user") messages.push({ role: "user", content: [{ type: "text", text: message.content }] });
    else if (message.role === "assistant") {
      const content: JsonValue[] = [];
      if (input.tools.length && message.reasoningContent) content.push({ type: "thinking", thinking: message.reasoningContent });
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        // 计数只读取历史参数，不执行任何工具；无效 JSON 留给正常工具错误流程修正。
        let args: JsonValue;
        try { args = parseJson(call.arguments); } catch { args = { raw_arguments: call.arguments }; }
        content.push({ type: "tool_use", id: call.id, name: call.name, input: args });
      }
      messages.push({ role: "assistant", content });
    }
  }
  return {
    model, system, messages, thinking: { type: thinkingMode },
    ...(thinkingMode === "enabled" ? { output_config: { effort: reasoningEffort } } : {}),
    ...(input.tools.length ? { tools: input.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
  };
}

/** 将内部消息格式转换为 DeepSeek 协议字段，保留工具请求与结果的关联 ID。 */
function encodeMessage(message: Message, includeReasoning: boolean): JsonObject {
  switch (message.role) {
    case "system":
    case "user": return { role: message.role, content: message.content };
    case "tool": return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    case "assistant": return {
      role: "assistant",
      content: message.content,
      ...(includeReasoning ? { reasoning_content: message.reasoningContent ?? "" } : {}),
      ...(message.toolCalls.length === 0 ? {} : {
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      }),
    };
  }
}

/** 校验单个 function 工具调用，并提取模型调用 ID、工具名称和原始参数文本。 */
function decodeToolCall(value: JsonValue): ToolCall {
  const call = objectValue(value, "tool_call");
  if (call.type !== "function") throw new Error("不支持的工具调用类型");
  const fn = objectValue(call.function, "tool_call.function");
  return { id: stringField(call, "id"), name: stringField(fn, "name"), arguments: stringField(fn, "arguments") };
}

/** 解析模型响应，校验结束原因、内容和工具调用，拒绝截断回复与重复调用 ID。 */
export function decodeCompletion(text: string): AssistantMessage {
  const body = objectValue(parseJson(text), "DeepSeek 响应");
  const choice = objectValue(arrayValue(body.choices, "choices")[0], "choices[0]");
  const finishReason = stringField(choice, "finish_reason");
  if (finishReason !== "stop" && finishReason !== "tool_calls") {
    throw new Error(`DeepSeek 回复未正常完成：${finishReason}${finishReason === "length" ? "（思考与答案共用输出预算，请提高 DEEPSEEK_MAX_OUTPUT_TOKENS）" : ""}`);
  }
  const message = objectValue(choice.message, "message");
  if (message.role !== "assistant") throw new Error("DeepSeek 响应角色无效");
  const rawContent = message.content ?? null;
  if (rawContent !== null && typeof rawContent !== "string") {
    throw new Error("DeepSeek 响应 content 必须是字符串或 null");
  }
  const reasoningContent = decodeReasoning(message.reasoning_content);
  const toolCalls = message.tool_calls === undefined || message.tool_calls === null
    ? []
    : arrayValue(message.tool_calls, "tool_calls").map(decodeToolCall);
  if (toolCalls.length > 16 || new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length) {
    throw new Error("工具调用过多或调用 ID 重复");
  }
  if ((finishReason === "tool_calls") !== (toolCalls.length > 0)) {
    throw new Error("DeepSeek 的结束原因与工具调用不匹配");
  }
  if (toolCalls.length === 0 && !rawContent?.trim()) {
    throw new Error(reasoningContent?.trim() ? "DeepSeek 仅返回思考过程，缺少最终答案或工具调用" : "DeepSeek 返回了空回答");
  }
  return { role: "assistant", content: rawContent, toolCalls, ...(reasoningContent === undefined ? {} : { reasoningContent }), ...(body.usage === undefined ? {} : { usage: decodeUsage(body.usage) }) };
}

export class DeepSeekModel implements Model {
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #countEndpoint: string;
  readonly #maxOutputTokens: number;
  readonly #thinkingMode: ThinkingMode;
  readonly #reasoningEffort: ReasoningEffort;

  /** 保存密钥和模型选项，校验 API 地址及单次请求超时，构造聊天请求地址。 */
  constructor(options: DeepSeekOptions) {
    if (!options.apiKey.trim()) throw new Error("缺少 DEEPSEEK_API_KEY 环境变量");
    const url = new URL(options.baseUrl ?? "https://api.deepseek.com");
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("DeepSeek Base URL 格式无效");
    }
    this.#apiKey = options.apiKey;
    this.#endpoint = `${url.href.replace(/\/+$/, "")}/chat/completions`;
    this.#countEndpoint = `${url.origin}/anthropic/v1/messages/count_tokens`;
    this.#model = options.model ?? "deepseek-flash";
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#maxOutputTokens = options.maxOutputTokens ?? 131_072;
    this.#thinkingMode = options.thinkingMode ?? "enabled";
    this.#reasoningEffort = options.reasoningEffort ?? "max";
    if (!["enabled", "disabled"].includes(this.#thinkingMode)) throw new Error("thinkingMode 只支持 enabled 或 disabled");
    if (!["low", "high", "max"].includes(this.#reasoningEffort)) throw new Error("reasoningEffort 只支持 low、high 或 max");
    if (!Number.isSafeInteger(this.#maxOutputTokens) || this.#maxOutputTokens < 1 || this.#maxOutputTokens > 393_216) throw new Error("模型输出 token 上限必须在1～393216之间");
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 2_147_483_647) {
      throw new Error("DeepSeek 请求超时必须是有效的正整数计时长度");
    }
  }

  /** 调用提供商兼容计数接口；不生成文字，返回的 token 与生成接口 usage 分别记录。 */
  async countTokens(input: ModelInput, signal: AbortSignal): Promise<number> {
    const response = await fetch(this.#countEndpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify(encodeTokenCountInput(input, this.#model, this.#thinkingMode, this.#reasoningEffort)),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Token 计数失败（HTTP ${response.status}）`); }
    const result = objectValue(parseJson(await response.text()), "计数响应");
    const count = numberField(result, "input_tokens");
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("提供商返回了无效 token 数量");
    return count;
  }

  /** 发送非流式模型请求并解析回复；合并外部取消和请求超时，错误时不回显认证信息。 */
  async generate(input: ModelInput, signal: AbortSignal): Promise<AssistantMessage> {
    const requestTimeout = AbortSignal.timeout(this.#timeoutMs);
    try {
      const response = await fetch(this.#endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, requestTimeout]),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify({
          model: this.#model,
          messages: input.messages.map((message) => encodeMessage(message, input.tools.length > 0)),
          thinking: { type: this.#thinkingMode },
          ...(this.#thinkingMode === "enabled" ? { reasoning_effort: this.#reasoningEffort } : { temperature: 0 }),
          stream: false,
          max_tokens: input.maxOutputTokens ?? this.#maxOutputTokens,
          ...(input.tools.length === 0 ? {} : {
            tools: input.tools.map((tool) => ({ type: "function", function: tool })),
          }),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const hints: Readonly<Record<number, string>> = {
          401: "请检查 API Key",
          402: "请检查账户余额",
          429: "请求受限，请稍后再试",
        };
        throw new Error(`DeepSeek 请求失败（HTTP ${response.status}）：${hints[response.status] ?? "服务未能完成请求"}`);
      }
      return decodeCompletion(await response.text());
    } catch (error) {
      if (signal.aborted) throw new Error("任务已取消或执行超时");
      if (requestTimeout.aborted) throw new Error(`DeepSeek 请求超过 ${this.#timeoutMs} 毫秒`);
      throw error;
    }
  }
}
