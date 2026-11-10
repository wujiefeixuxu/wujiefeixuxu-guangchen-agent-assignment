import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "./errors.ts";
import { objectValue, parseJson, stringField } from "./json.ts";
import { assertKeys } from "./json.ts";
import type { JsonObject } from "./json.ts";
import { AppError, MAX_REQUEST_BYTES } from "./sessions.ts";
import { ToolError } from "./tool-errors.ts";
import type { SessionService } from "./session-service.ts";
import type { ApiResponse } from "./web/contracts.ts";
import type { ReasoningEffort, ThinkingMode } from "./models/deepseek.ts";
import { memoryIndex, memoryView, parseMemoryWrite } from "./memory.ts";

export interface WebServerOptions {
  readonly publicDirectory: string;
  readonly clientFile: string;
  readonly modelName: string;
  readonly contextUnit?: "tokens" | "characters";
  readonly contextLimit?: number;
  readonly maxModelCalls?: number;
  readonly thinkingMode?: ThinkingMode;
  readonly reasoningEffort?: ReasoningEffort;
  readonly maxOutputTokens?: number;
}

/** 返回不包含凭据的 JSON API 响应。 */
function json(response: ServerResponse, status: number, value: ApiResponse): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

/** 从本地演示的用户标识头读取身份；每个窗口独立发送，避免共享 Cookie 切换身份。 */
function userId(request: IncomingMessage): string {
  const value = request.headers["x-user-id"];
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new AppError(400, "缺少有效的本地用户标识");
  return value;
}

/** 限制 JSON 请求体大小和类型，避免无界缓存用户输入。 */
async function body(request: IncomingMessage): Promise<JsonObject> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new AppError(415, "请使用 JSON 请求体");
  request.setEncoding("utf8");
  const content = await new Promise<string>((resolve, reject) => {
    let text = "";
    let size = 0;
    request.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_REQUEST_BYTES) { reject(new AppError(413, "消息过长")); return; }
      text += chunk;
    });
    request.on("end", () => resolve(text));
    request.on("error", reject);
  });
  try { return objectValue(parseJson(content), "请求体"); }
  catch { throw new AppError(400, "请求体必须是有效 JSON 对象"); }
}

/** 提供本地页面及会话 API，所有会话、运行和待办查询都校验当前用户归属。 */
export function createWebServer(service: SessionService, options: WebServerOptions): Server {
  return createServer((request, response) => {
    void route(request, response);
  });

  /** 分发固定静态资源与参数化 API，异常统一转换为页面可理解的错误。 */
  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      const method = request.method ?? "GET";
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
      if (!["GET", "HEAD"].includes(method) && request.headers.origin && request.headers.origin !== url.origin) throw new AppError(403, "不接受跨站写入请求");
      if (url.pathname === "/api/config" && method === "GET") return json(response, 200, {
        kind: "config", model: options.modelName, storage: "SQLite", contextUnit: options.contextUnit ?? "tokens", contextLimit: options.contextLimit ?? 100000, maxModelCalls: options.maxModelCalls ?? 20,
        thinkingMode: options.thinkingMode ?? "enabled", reasoningEffort: options.reasoningEffort ?? "max", maxOutputTokens: options.maxOutputTokens ?? 131072,
      });
      const assets: Readonly<Record<string, { path: string; type: string }>> = {
        "/": { path: join(options.publicDirectory, "index.html"), type: "text/html; charset=utf-8" },
        "/styles.css": { path: join(options.publicDirectory, "styles.css"), type: "text/css; charset=utf-8" },
        "/app.js": { path: options.clientFile, type: "text/javascript; charset=utf-8" },
        "/favicon.svg": { path: join(options.publicDirectory, "favicon.svg"), type: "image/svg+xml" },
      };
      const asset = assets[url.pathname];
      if (asset && (method === "GET" || method === "HEAD")) {
        const content = await readFile(asset.path);
        response.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-store" });
        response.end(method === "HEAD" ? undefined : content);
        return;
      }
      const user = userId(request);
      if (url.pathname === "/api/memories") {
        if (method === "GET") {
          const now = new Date();
          return json(response, 200, { kind: "memories", items: service.store.listMemories(user).map((record) => memoryIndex(record, now)) });
        }
        if (method === "POST") {
          const args = parseMemoryWrite(await body(request));
          if (args.operation === "delete") { service.store.deleteMemory(user, args.id); return json(response, 200, { kind: "memory_deleted", id: args.id }); }
          const now = new Date();
          const record = service.store.upsertMemory(user, args, now.toISOString());
          return json(response, 200, { kind: "memory", memory: memoryView(record, now) });
        }
      }
      const memoryMatch = /^\/api\/memories\/([^/]+)$/.exec(url.pathname);
      if (memoryMatch?.[1] && method === "GET") {
        const record = service.store.getMemory(user, decodeURIComponent(memoryMatch[1]));
        if (!record) throw new AppError(404, "当前用户没有这条记忆");
        return json(response, 200, { kind: "memory", memory: memoryView(record, new Date()) });
      }
      if (url.pathname === "/api/sessions") {
        if (method === "GET") return json(response, 200, { kind: "sessions", sessions: service.store.listSessions(user) });
        if (method === "POST") {
          const value = await body(request);
          const title = value.title === undefined ? "新会话" : stringField(value, "title");
          const session = service.store.createSession(user, title);
          return json(response, 201, { kind: "session", detail: service.store.detail({ userId: user, threadId: session.id }) });
        }
      }
      const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|runs|memory-organize)(?:\/([^/]+)(?:\/(events|cancel))?)?)?$/.exec(url.pathname);
      if (!match?.[1]) throw new AppError(404, "接口不存在");
      const owner = { userId: user, threadId: decodeURIComponent(match[1]) };
      if (match[2] === "memory-organize" && method === "POST" && !match[3]) {
        assertKeys(await body(request), []);
        const started = service.startMemoryOrganization(owner);
        return json(response, 202, { kind: "started", run: service.store.getRun(owner, started.runId) });
      }
      if (!match[2]) {
        if (method === "GET") return json(response, 200, { kind: "session", detail: service.store.detail(owner) });
        if (method === "PATCH") {
          service.store.renameSession(owner, stringField(await body(request), "title"));
          return json(response, 200, { kind: "session", detail: service.store.detail(owner) });
        }
      }
      if (match[2] === "messages" && method === "POST") {
        const input = stringField(await body(request), "content");
        const started = service.startRun(owner, input);
        return json(response, 202, { kind: "started", run: service.store.getRun(owner, started.runId) });
      }
      const runId = match[3] ? decodeURIComponent(match[3]) : null;
      if (match[2] === "runs" && runId) {
        if (method === "GET" && match[4] === "events") {
          return json(response, 200, { kind: "events", run: service.store.getRun(owner, runId), events: service.store.eventData(owner, runId) });
        }
        if (method === "POST" && match[4] === "cancel") {
          service.cancel(owner, runId);
          return json(response, 202, { kind: "cancelled" });
        }
      }
      throw new AppError(404, "接口不存在");
    } catch (error) {
      const status = error instanceof AppError ? error.statusCode : error instanceof ToolError && error.details.code === "MEMORY_NOT_FOUND" ? 404 : error instanceof URIError || error instanceof ToolError ? 400 : 500;
      json(response, status, { kind: "error", message: status === 500 ? "本地服务暂时无法完成请求，请检查服务日志" : errorMessage(error) });
      if (status === 500) console.error("本地服务错误：", errorMessage(error));
    }
  }
}
