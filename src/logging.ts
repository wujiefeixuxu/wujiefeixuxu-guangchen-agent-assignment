import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LogSink } from "./execution.ts";

/** 创建 JSONL 日志接收函数，按 runId 分文件，并在写入前替换指定的敏感字符串。 */
export function createJsonlSink(directory: string, secrets: readonly string[] = []): LogSink {
  mkdirSync(directory, { recursive: true });
  /** 校验事件的文件标识，将脱敏后的单条事件追加为一行 JSON。 */
  return (entry) => {
    if (!/^[a-f0-9-]{36}$/i.test(entry.runId)) throw new Error("日志 runId 格式无效");
    let line = JSON.stringify(entry);
    for (const secret of secrets) {
      if (secret.length > 0) line = line.replaceAll(secret, "[REDACTED]");
    }
    appendFileSync(join(directory, `${entry.runId}.jsonl`), `${line}\n`, "utf8");
  };
}
