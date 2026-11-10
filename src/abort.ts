/** 执行异步操作；取消时立即拒绝等待，并在结束后移除取消监听器。 */
export async function withAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("任务已取消或执行超时");
  let onAbort = (): void => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("任务已取消或执行超时"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), interrupted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
