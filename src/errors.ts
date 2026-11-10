// 仅异常捕获边界接受不确定类型，业务数据均使用具体类型。
/** 将捕获到的异常归一化为可展示的说明，兼容 Error、字符串和其他抛出值。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  return "发生无法识别的执行错误";
}
