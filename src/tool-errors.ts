export type ToolErrorCode =
  | "INVALID_JSON" | "MISSING_ARGUMENT" | "INVALID_ARGUMENT" | "INVALID_OPERATION"
  | "DIVISION_BY_ZERO" | "NUMERIC_OVERFLOW" | "TOOL_NOT_FOUND"
  | "TOOL_EXECUTION_FAILED" | "TOOL_TIMEOUT" | "TOOL_CANCELLED"
  | "MOCK_PAGE_NOT_FOUND" | "RUN_STOPPED" | "MULTIPLE_TODO_WRITES" | "TODO_STORAGE_ERROR"
  | "MEMORY_NOT_FOUND" | "MEMORY_ORGANIZE_NEW_ID" | "MEMORY_ORGANIZE_DELETE_ORDER";

export type ToolErrorData = {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly field: string | null;
};

export class ToolError extends Error {
  readonly details: ToolErrorData;

  /** 将稳定错误码、错误说明及可选字段名封装为可回传给模型的工具异常。 */
  constructor(code: ToolErrorCode, message: string, field: string | null = null) {
    super(message);
    this.name = "ToolError";
    this.details = { code, message, field };
  }
}
