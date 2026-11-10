import { fileURLToPath } from "node:url";
import { readConfig } from "./config.ts";
import { errorMessage } from "./errors.ts";
import { createWebServer } from "./http-server.ts";
import { createJsonlSink } from "./logging.ts";
import { DeepSeekModel } from "./models/deepseek.ts";
import { SessionService } from "./session-service.ts";
import { SqliteStore } from "./sqlite-store.ts";

/** 启动仅监听本机的 SQLite 会话工作台，退出前保存被取消运行的状态。 */
async function main(): Promise<void> {
  const config = readConfig();
  const store = new SqliteStore(config.databasePath);
  const migration = store.importLegacyTodos(config.dataDirectory);
  store.recoverAbandonedRuns();
  if (migration.imported) console.log(`已导入 ${migration.imported} 个旧待办会话，原文件保留。`);
  if (migration.skipped.length) console.log(`跳过 ${migration.skipped.length} 个无效的旧待办文件。`);
  const service = new SessionService(store, new DeepSeekModel(config.model), { ...config.runtime, onEvent: createJsonlSink(config.logDirectory, [config.model.apiKey]) });
  const server = createWebServer(service, {
    publicDirectory: fileURLToPath(new URL("../public/", import.meta.url)),
    clientFile: fileURLToPath(new URL("./web/client.js", import.meta.url)), modelName: config.model.model ?? "deepseek-flash",
    contextUnit: config.runtime.context?.maxTokens === undefined ? "characters" : "tokens",
    contextLimit: config.runtime.context?.maxTokens ?? config.runtime.context?.maxChars ?? 48000,
    maxModelCalls: config.runtime.maxModelCalls ?? 20,
    thinkingMode: config.model.thinkingMode ?? "enabled", reasoningEffort: config.model.reasoningEffort ?? "max", maxOutputTokens: config.model.maxOutputTokens ?? 131072,
  });
  let closing = false;
  /** 停止接收请求，取消执行并提交消息后关闭 SQLite。 */
  async function stop(): Promise<void> {
    if (closing) return;
    closing = true;
    server.close();
    await service.shutdown();
    server.closeAllConnections();
    store.close();
  }
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  server.once("error", (error) => { console.error(errorMessage(error)); store.close(); process.exitCode = 1; });
  server.listen(config.webPort, "127.0.0.1", () => console.log(`Local: http://127.0.0.1:${config.webPort}\nSQLite: ${config.databasePath}`));
}

try { await main(); } catch (error) { console.error(errorMessage(error)); process.exitCode = 1; }
