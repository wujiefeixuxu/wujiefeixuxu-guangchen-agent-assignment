import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { parseCli } from "./cli.ts";
import { readConfig } from "./config.ts";
import { errorMessage } from "./errors.ts";
import { DeepSeekModel } from "./models/deepseek.ts";
import { createJsonlSink } from "./logging.ts";
import type { RuntimeEvent } from "./runtime.ts";
import { AgentStatus } from "./state.ts";
import type { Status } from "./state.ts";
import { SessionService } from "./session-service.ts";
import { SqliteStore } from "./sqlite-store.ts";

const labels: Readonly<Record<Status, string>> = {
  pending: "待运行", running: "运行中", completed: "完成", failed: "失败",
};

/** 将完整运行事件转换为终端简报，显示状态、节点、调用标识和工具结果。 */
function printEvent(event: RuntimeEvent): void {
  if (event.event === "run.status" && event.status !== null) {
    if (event.status === "pending") console.log(`[任务] threadId=${event.threadId} runId=${event.runId}`);
    console.log(`[状态] ${labels[event.status]}`);
  } else if (event.event === "node.started") {
    console.log(`[节点 ${event.step}] ${event.node}`);
  } else if (event.event === "tool.requested") {
    console.log(`[工具请求 ${event.toolCallNo}] ${event.toolName} callId=${event.toolCallId} invocationId=${event.invocationId}`);
  } else if (["tool.succeeded", "tool.rejected", "tool.failed"].includes(event.event)) {
    console.log(`[${event.event}] ${JSON.stringify(event.data)}`);
  } else if (event.event === "todos.updated") {
    console.log(`[待办更新] ${JSON.stringify(event.data)}`);
  }
}

/** 解析命令行并读取任务，组装模型与 Runtime，执行后输出统计、日志路径和结果。 */
async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    console.log('用法：npm start -- [--user-id 用户] [--thread-id 会话] "你的任务"\n不传任务时会提示输入。\n复用 user-id 和 thread-id 会恢复 SQLite 中的消息和待办。\n页面：npm run web\n需要 DEEPSEEK_API_KEY；可在本地 .env 中设置。');
    return;
  }
  const config = readConfig();
  let input = options.task;
  if (!input.trim()) {
    const readline = createInterface({ input: stdin, output: stdout });
    try {
      input = await readline.question("请输入任务：");
    } finally {
      readline.close();
    }
  }
  const store = new SqliteStore(config.databasePath);
  store.importLegacyTodos(config.dataDirectory);
  store.recoverAbandonedRuns();
  const owner = { userId: options.userId, threadId: options.threadId };
  store.ensureSession(owner);
  const writeLog = createJsonlSink(config.logDirectory, [config.model.apiKey]);
  const service = new SessionService(store, new DeepSeekModel(config.model), {
    ...config.runtime,
    /** 将同一个运行事件写入完整 JSONL 日志，并同步显示终端简报。 */
    onEvent(event) { writeLog(event); printEvent(event); },
  });
  const controller = new AbortController();
  /** 将终端 Ctrl+C 转换为当前任务的取消信号。 */
  const onInterrupt = (): void => controller.abort();
  process.once("SIGINT", onInterrupt);
  try {
    const state = await service.startRun(owner, input, controller.signal).completion;
    console.log(`[统计] 模型调用=${state.metrics.modelCalls} 工具请求=${state.metrics.toolRequests} 实际执行=${state.metrics.actualExecutions} 校验/调度拒绝=${state.metrics.toolRejected} 执行失败=${state.metrics.toolFailed}`);
    if (state.identity !== null) console.log(`[日志] ${resolve(config.logDirectory, `${state.identity.runId}.jsonl`)}`);
    if (state.status === AgentStatus.COMPLETED) {
      console.log(`\n${state.finalAnswer}`);
    } else {
      console.error(`执行失败：${state.error}`);
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    await service.shutdown();
    store.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
