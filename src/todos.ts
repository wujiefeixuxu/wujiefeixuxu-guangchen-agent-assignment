import { assertKeys, objectValue, stringField } from "./json.ts";
import type { JsonValue } from "./json.ts";
import { ToolError } from "./tool-errors.ts";

export const todoStatuses = ["pending", "in_progress", "completed", "failed"] as const;
export type TodoStatus = (typeof todoStatuses)[number];
export type TodoItem =
  | { readonly content: string; readonly status: Exclude<TodoStatus, "failed">; readonly error: null }
  | { readonly content: string; readonly status: "failed"; readonly error: string };
export type WriteTodosArgs = { readonly todos: TodoItem[] };
export type WriteTodosResult = { readonly todos: TodoItem[] };

/** 判断待办状态是否为允许的四种枚举值。 */
function isTodoStatus(value: string): value is TodoStatus {
  return todoStatuses.some((status) => status === value);
}

/** 校验完整待办列表，失败项必须带非空原因，其他状态的错误原因统一为 null。 */
export function parseTodos(value: JsonValue | undefined): TodoItem[] {
  if (value === undefined) throw new ToolError("MISSING_ARGUMENT", "缺少必填参数 todos", "todos");
  if (!Array.isArray(value)) throw new ToolError("INVALID_ARGUMENT", "todos 必须是数组", "todos");
  return value.map((item, index): TodoItem => {
    const path = `todos[${index}]`;
    try {
      const row = objectValue(item, path);
      assertKeys(row, ["content", "status", "error"]);
      const content = stringField(row, "content");
      const status = stringField(row, "status");
      if (!isTodoStatus(status)) throw new ToolError("INVALID_ARGUMENT", "status 只支持 pending、in_progress、completed、failed", "status");
      if (status === "failed") return { content, status, error: stringField(row, "error") };
      if (row.error !== undefined && row.error !== null) {
        throw new ToolError("INVALID_ARGUMENT", "非失败待办的 error 必须省略或设为 null", "error");
      }
      return { content, status, error: null };
    } catch (error) {
      if (error instanceof ToolError) {
        throw new ToolError(error.details.code, `${path}：${error.message}`, error.details.field === null ? path : `${path}.${error.details.field}`);
      }
      throw error;
    }
  });
}

/** 复制每个待办对象，避免调用方通过返回值修改内部清单。 */
export function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({ ...todo }));
}
