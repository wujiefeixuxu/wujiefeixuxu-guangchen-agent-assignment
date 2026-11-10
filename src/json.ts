import { ToolError } from "./tool-errors.ts";

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** 解析外部 JSON 文本；仅建立 JSON 类型边界，具体字段由后续校验函数检查。 */
export function parseJson(text: string): JsonValue {
  try {
    // JSON.parse 的结果仅在这个边界转换为 JSON 类型，字段仍须逐项校验。
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new ToolError("INVALID_JSON", "内容不是有效的 JSON，请修正 JSON 格式后重新调用");
  }
}

/** 确保值是 JSON 对象，拒绝 null、数组和缺失值；label 用于错误说明。 */
export function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolError("INVALID_ARGUMENT", `${label} 必须是对象`);
  }
  return value;
}

/** 确保值是 JSON 数组；类型不匹配时使用 label 指明出错位置。 */
export function arrayValue(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须是数组`);
  }
  return value;
}

/** 读取必填的非空字符串字段，区分缺少参数与参数类型错误。 */
export function stringField(object: JsonObject, key: string): string {
  const value = object[key];
  if (value === undefined) throw new ToolError("MISSING_ARGUMENT", `缺少必填参数 ${key}`, key);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolError("INVALID_ARGUMENT", `参数 ${key} 必须是非空字符串`, key);
  }
  return value;
}

/** 读取必填的有限数字字段；拒绝 "12A" 等字符串，并返回包含字段名的错误。 */
export function numberField(object: JsonObject, key: string): number {
  const value = object[key];
  if (value === undefined) throw new ToolError("MISSING_ARGUMENT", `缺少必填参数 ${key}`, key);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    const received = typeof value === "string" ? `字符串 ${JSON.stringify(value.slice(0, 80))}` : String(value);
    throw new ToolError("INVALID_ARGUMENT", `参数 ${key} 必须是有效的有限数字，收到${received}，请修正后重新调用`, key);
  }
  return value;
}

/** 检查参数对象只包含允许的字段，防止模型传入 Schema 之外的参数。 */
export function assertKeys(object: JsonObject, allowed: readonly string[]): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new ToolError("INVALID_ARGUMENT", `不支持参数：${key}`, key);
    }
  }
}
