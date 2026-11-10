import { numberField, objectValue } from "./json.ts";
import type { JsonValue } from "./json.ts";
import type { ModelUsage } from "./types.ts";

/** 校验可选思考正文，兼容旧消息与非思考模式的 null，不将它混入最终回答。 */
export function decodeReasoning(value: JsonValue | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("reasoning_content 必须是字符串或 null");
  return value;
}

/** 统一校验非负整数 token 用量，供提供商响应和 SQLite 恢复共同使用。 */
export function validateUsage(usage: ModelUsage): ModelUsage {
  const counts = [usage.promptTokens, usage.completionTokens, usage.totalTokens, usage.reasoningTokens, usage.cacheHitTokens, usage.cacheMissTokens];
  if (counts.some((count) => count !== undefined && (!Number.isSafeInteger(count) || count < 0))) throw new Error("模型 token 用量无效");
  return usage;
}

/** 解析提供商返回的输入、输出、思考及缓存 token 数，始终以真实 API 数据为准。 */
export function decodeUsage(value: JsonValue): ModelUsage {
  const usage = objectValue(value, "usage");
  const details = usage.completion_tokens_details === undefined || usage.completion_tokens_details === null ? null : objectValue(usage.completion_tokens_details, "completion_tokens_details");
  return validateUsage({
    promptTokens: numberField(usage, "prompt_tokens"), completionTokens: numberField(usage, "completion_tokens"), totalTokens: numberField(usage, "total_tokens"),
    ...(details?.reasoning_tokens === undefined ? {} : { reasoningTokens: numberField(details, "reasoning_tokens") }),
    ...(usage.prompt_cache_hit_tokens === undefined ? {} : { cacheHitTokens: numberField(usage, "prompt_cache_hit_tokens") }),
    ...(usage.prompt_cache_miss_tokens === undefined ? {} : { cacheMissTokens: numberField(usage, "prompt_cache_miss_tokens") }),
  });
}

/** 从本地持久化消息恢复内部命名的用量字段，兼容没有统计的旧历史。 */
export function decodeStoredUsage(value: JsonValue | undefined): ModelUsage | undefined {
  if (value === undefined) return undefined;
  const usage = objectValue(value, "已保存的模型用量");
  return validateUsage({
    promptTokens: numberField(usage, "promptTokens"), completionTokens: numberField(usage, "completionTokens"), totalTokens: numberField(usage, "totalTokens"),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: numberField(usage, "reasoningTokens") }),
    ...(usage.cacheHitTokens === undefined ? {} : { cacheHitTokens: numberField(usage, "cacheHitTokens") }),
    ...(usage.cacheMissTokens === undefined ? {} : { cacheMissTokens: numberField(usage, "cacheMissTokens") }),
  });
}
