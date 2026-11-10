import { randomUUID } from "node:crypto";

export interface CliInput {
  readonly help: boolean;
  readonly userId: string;
  readonly threadId: string;
  readonly task: string;
}

/** 解析任务文本、用户和 thread 标识；标识未提供时使用默认值，非法选项直接报错。 */
export function parseCli(args: readonly string[]): CliInput {
  let userId = "local-user";
  let threadId: string = randomUUID();
  const task: string[] = [];
  let help = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) break;
    if (arg === "--help") { help = true; continue; }
    if (arg === "--user-id" || arg === "--thread-id") {
      const value = args[++index];
      if (value === undefined || !value.trim() || value.startsWith("--")) throw new Error(`${arg} 缺少有效值`);
      if (arg === "--user-id") userId = value;
      else threadId = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`不支持命令行选项：${arg}`);
    } else {
      task.push(arg);
    }
  }
  return { help, userId, threadId, task: task.join(" ") };
}
