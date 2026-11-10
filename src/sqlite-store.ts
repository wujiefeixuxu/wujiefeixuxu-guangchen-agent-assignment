import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emptyMetrics } from "./execution.ts";
import { emptyContextMemory, validateContextMemory } from "./context.ts";
import type { ContextMemory } from "./context.ts";
import type { LogEntry, RunMetrics } from "./execution.ts";
import { objectValue, parseJson, numberField, stringField } from "./json.ts";
import type { JsonValue } from "./json.ts";
import { AppError, decodeStoredMessage, MAX_MESSAGE_CHARS } from "./sessions.ts";
import type { AgentState, Status } from "./state.ts";
import type { TodoOwner, TodoStore } from "./todo-store.ts";
import { parseTodos } from "./todos.ts";
import type { TodoItem } from "./todos.ts";
import type { Message } from "./types.ts";
import { isUserInput, observeTool } from "./prompt.ts";
import type { ToolObservation } from "./prompt.ts";
import { memoryTimestamp, validateMemoryDraft, validateMemoryId, validateMemoryUser } from "./memory.ts";
import type { MemoryDraft, MemoryRecord } from "./memory.ts";
import type { MemoryStore } from "./memory-store.ts";
import { ToolError } from "./tool-errors.ts";
import type { ChatMessage, RunSummary, SessionDetail, SessionSummary } from "./web/contracts.ts";

type Row = Record<string, SQLOutputValue>;

/** 从 SQL 查询结果中读取文本，拒绝损坏或错误类型的数据。 */
function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`数据库字段 ${key} 无效`);
  return value;
}

/** 从 SQL 查询结果中读取整数。 */
function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`数据库字段 ${key} 无效`);
  return value;
}

/** 将数据库运行状态收窄为已约定的四状态。 */
function status(value: string): Status {
  if (value === "pending" || value === "running" || value === "completed" || value === "failed") return value;
  throw new Error("数据库运行状态无效");
}

/** 解析持久化的执行次数统计。 */
function metrics(value: JsonValue): RunMetrics {
  const row = objectValue(value, "统计");
  return {
    modelCalls: numberField(row, "modelCalls"), toolRequests: numberField(row, "toolRequests"),
    actualExecutions: numberField(row, "actualExecutions"), toolSucceeded: numberField(row, "toolSucceeded"),
    toolRejected: numberField(row, "toolRejected"), toolFailed: numberField(row, "toolFailed"),
    tokenCountRequests: row.tokenCountRequests === undefined ? 0 : numberField(row, "tokenCountRequests"),
  };
}

/** 检查产生运行的本地进程是否仍存在；没有权限检查时保守地视为存在。 */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error instanceof Error && "code" in error && error.code === "EPERM"; }
}

export class SqliteStore implements TodoStore, MemoryStore {
  readonly #db: DatabaseSync;

  /** 打开本地 SQLite，启用 WAL、外键和参数化查询所需的数据表。 */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path, { timeout: 5000 });
    this.#db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sessions (
        user_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id,id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
        error TEXT, started_at TEXT NOT NULL, finished_at TEXT,
        metrics_json TEXT NOT NULL, history_count INTEGER NOT NULL, owner_pid INTEGER NOT NULL,
        FOREIGN KEY(user_id,session_id) REFERENCES sessions(user_id,id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(user_id,session_id) WHERE status IN ('pending','running');
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id), role TEXT NOT NULL,
        content TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(user_id,session_id) REFERENCES sessions(user_id,id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS message_history ON messages(user_id,session_id,id);
      CREATE TABLE IF NOT EXISTS todo_items (
        user_id TEXT NOT NULL, session_id TEXT NOT NULL, position INTEGER NOT NULL,
        content TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed','failed')),
        error TEXT, PRIMARY KEY(user_id,session_id,position),
        CHECK((status='failed' AND error IS NOT NULL AND length(trim(error))>0) OR (status!='failed' AND error IS NULL)),
        FOREIGN KEY(user_id,session_id) REFERENCES sessions(user_id,id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
        event TEXT NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS event_history ON run_events(run_id,id);
      CREATE TABLE IF NOT EXISTS session_context (
        user_id TEXT NOT NULL, session_id TEXT NOT NULL,
        summary TEXT NOT NULL CHECK(length(summary)<=4000),
        covered_messages INTEGER NOT NULL CHECK(covered_messages>=0), updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id,session_id),
        FOREIGN KEY(user_id,session_id) REFERENCES sessions(user_id,id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL,
        summary TEXT NOT NULL, content TEXT NOT NULL, recorded_at TEXT NOT NULL,
        PRIMARY KEY(user_id,id)
      ) STRICT;
    `);
  }

  /** 关闭数据库连接，供服务退出与测试清理使用。 */
  close(): void { this.#db.close(); }

  /** 将六列记录恢复成长期记忆，准确时间仍保存在数据库中。 */
  #memoryRecord(row: Row): MemoryRecord {
    return { id: text(row, "id"), userId: text(row, "user_id"), name: text(row, "name"), summary: text(row, "summary"), content: text(row, "content"), recordedAt: memoryTimestamp(text(row, "recorded_at")) };
  }

  /** 按当前用户列出全部记忆，固定 ID 排序使索引序列化结果稳定。 */
  listMemories(userId: string): MemoryRecord[] {
    validateMemoryUser(userId);
    return this.#db.prepare("SELECT * FROM memories WHERE user_id=? ORDER BY id").all(userId).map((row) => this.#memoryRecord(row));
  }

  /** 读取当前用户的一条记忆，其他用户的同名 ID 不可见。 */
  getMemory(userId: string, id: string): MemoryRecord | null {
    validateMemoryUser(userId); validateMemoryId(id);
    const row = this.#db.prepare("SELECT * FROM memories WHERE user_id=? AND id=?").get(userId, id);
    return row ? this.#memoryRecord(row) : null;
  }

  /** 原子保存单条 Markdown 记忆；只改名称、简介或重复写入时保留信息原时间。 */
  upsertMemory(userId: string, draft: MemoryDraft, recordedAt: string): MemoryRecord {
    validateMemoryUser(userId); const valid = validateMemoryDraft(draft); const timestamp = memoryTimestamp(recordedAt);
    return this.#transaction(() => {
      const previous = this.getMemory(userId, valid.id);
      const time = previous?.content === valid.content ? previous.recordedAt : timestamp;
      this.#db.prepare(`INSERT INTO memories(id,user_id,name,summary,content,recorded_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,summary=excluded.summary,content=excluded.content,recorded_at=excluded.recorded_at`)
        .run(valid.id, userId, valid.name, valid.summary, valid.content, time);
      return { ...valid, userId, recordedAt: time };
    });
  }

  /** 删除当前用户的一条记录，不对其他用户相同 ID 做任何修改。 */
  deleteMemory(userId: string, id: string): void {
    validateMemoryUser(userId); validateMemoryId(id);
    const result = this.#db.prepare("DELETE FROM memories WHERE user_id=? AND id=?").run(userId, id);
    if (!result.changes) throw new ToolError("MEMORY_NOT_FOUND", "当前用户没有这条记忆", "id");
  }

  /** 使用本轮真实用户消息的入库时间记录新记忆，而不是模型生成结束的时间。 */
  inputRecordedAt(owner: TodoOwner, runId: string): string {
    this.getRun(owner, runId);
    const row = this.#db.prepare("SELECT created_at FROM messages WHERE user_id=? AND session_id=? AND run_id=? AND role='user' ORDER BY id LIMIT 1").get(owner.userId, owner.threadId, runId);
    if (!row) throw new AppError(404, "运行缺少用户消息");
    return memoryTimestamp(text(row, "created_at"));
  }

  /** 以事务运行同步数据库操作，任一步失败都会回滚。 */
  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  /** 创建指定用户的独立会话；默认生成新的 session ID。 */
  createSession(userId: string, title = "新会话", id: string = randomUUID()): SessionSummary {
    const now = new Date().toISOString();
    this.#db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)").run(userId, id, title.trim().slice(0, 80) || "新会话", now, now);
    return this.getSession({ userId, threadId: id });
  }

  /** 供 CLI 和旧数据迁移确保 thread 存在，不改写已存在的会话标题。 */
  ensureSession(owner: TodoOwner, title = "新会话"): void {
    const now = new Date().toISOString();
    this.#db.prepare("INSERT OR IGNORE INTO sessions VALUES (?,?,?,?,?)").run(owner.userId, owner.threadId, title, now, now);
  }

  /** 验证会话归属，其他用户访问同一个 ID 时同样返回不存在。 */
  #requireSession(owner: TodoOwner): Row {
    const row = this.#db.prepare("SELECT * FROM sessions WHERE user_id=? AND id=?").get(owner.userId, owner.threadId);
    if (!row) throw new AppError(404, "会话不存在");
    return row;
  }

  /** 返回侧栏需要的会话信息、最近消息摘要和正在执行的运行。 */
  getSession(owner: TodoOwner): SessionSummary {
    const row = this.#requireSession(owner);
    const preview = this.#db.prepare("SELECT content FROM messages WHERE user_id=? AND session_id=? AND content!='' AND role IN ('user','assistant') ORDER BY id DESC LIMIT 1").get(owner.userId, owner.threadId);
    const active = this.#db.prepare("SELECT * FROM runs WHERE user_id=? AND session_id=? AND status IN ('pending','running') LIMIT 1").get(owner.userId, owner.threadId);
    return {
      id: text(row, "id"), title: text(row, "title"), createdAt: text(row, "created_at"), updatedAt: text(row, "updated_at"),
      preview: preview ? text(preview, "content").slice(0, 80) : "还没有开始对话", activeRun: active ? this.#runSummary(active) : null,
    };
  }

  /** 只列出指定用户的会话，按最近活动排序。 */
  listSessions(userId: string): SessionSummary[] {
    return this.#db.prepare("SELECT id FROM sessions WHERE user_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 200").all(userId)
      .map((row) => this.getSession({ userId, threadId: text(row, "id") }));
  }

  /** 修改当前用户拥有的会话标题。 */
  renameSession(owner: TodoOwner, title: string): void {
    this.#requireSession(owner);
    if (!title.trim()) throw new AppError(400, "会话名称不能为空");
    this.#db.prepare("UPDATE sessions SET title=?,updated_at=? WHERE user_id=? AND id=?").run(title.trim().slice(0, 80), new Date().toISOString(), owner.userId, owner.threadId);
  }

  /** 读取完整模型历史，包含已配对的助手工具请求及工具结果。 */
  history(owner: TodoOwner): Message[] {
    this.#requireSession(owner);
    return this.#db.prepare("SELECT data FROM messages WHERE user_id=? AND session_id=? ORDER BY id").all(owner.userId, owner.threadId)
      .map((row) => decodeStoredMessage(text(row, "data")));
  }

  /** 从已结束工具事件恢复最近批次，失败运行未进入聊天历史的工具记录也能被下一轮看到。 */
  recentToolBatch(owner: TodoOwner): ToolObservation[] {
    this.#requireSession(owner);
    const latest = this.#db.prepare(`SELECT e.data FROM run_events e JOIN runs r ON r.id=e.run_id
      WHERE r.user_id=? AND r.session_id=? AND e.event IN ('tool.succeeded','tool.rejected','tool.failed')
      ORDER BY e.id DESC LIMIT 1`).get(owner.userId, owner.threadId);
    if (!latest) return [];
    const entry = objectValue(parseJson(text(latest, "data")), "最近工具事件");
    const rows = this.#db.prepare(`SELECT data FROM run_events WHERE run_id=?
      AND event IN ('tool.succeeded','tool.rejected','tool.failed') AND json_extract(data,'$.modelCallNo')=? ORDER BY id`)
      .all(stringField(entry, "runId"), numberField(entry, "modelCallNo"));
    return rows.map((row) => {
      const event = objectValue(parseJson(text(row, "data")), "工具事件");
      return observeTool({ role: "tool", name: stringField(event, "toolName"), toolCallId: stringField(event, "toolCallId"), content: JSON.stringify(event.data) });
    });
  }

  /** 读取当前会话的历史摘要和覆盖边界，其他用户不能通过 session ID 读取。 */
  readContext(owner: TodoOwner): ContextMemory {
    this.#requireSession(owner);
    const row = this.#db.prepare("SELECT summary,covered_messages FROM session_context WHERE user_id=? AND session_id=?").get(owner.userId, owner.threadId);
    if (!row) return emptyContextMemory();
    const memory = { summary: text(row, "summary"), coveredMessages: integer(row, "covered_messages") };
    validateContextMemory(memory);
    return memory;
  }

  /** 原子保存不超过 4000 字符的摘要，覆盖位置必须位于完整用户轮次边界。 */
  saveContext(owner: TodoOwner, memory: ContextMemory): void {
    validateContextMemory(memory);
    this.#transaction(() => {
      this.#requireSession(owner);
      const previous = this.readContext(owner);
      if (memory.coveredMessages < previous.coveredMessages) throw new Error("历史摘要覆盖位置不能倒退");
      const count = this.#db.prepare("SELECT count(*) AS count FROM messages WHERE user_id=? AND session_id=?").get(owner.userId, owner.threadId);
      if (!count || memory.coveredMessages > integer(count, "count")) throw new Error("历史摘要超过已保存的消息范围");
      const next = this.#db.prepare("SELECT data FROM messages WHERE user_id=? AND session_id=? ORDER BY id LIMIT 1 OFFSET ?").get(owner.userId, owner.threadId, memory.coveredMessages);
      if (next && !isUserInput(decodeStoredMessage(text(next, "data")))) throw new Error("历史摘要不能截断工具调用或用户轮次");
      this.#db.prepare(`INSERT INTO session_context VALUES (?,?,?,?,?)
        ON CONFLICT(user_id,session_id) DO UPDATE SET summary=excluded.summary,covered_messages=excluded.covered_messages,updated_at=excluded.updated_at`)
        .run(owner.userId, owner.threadId, memory.summary, memory.coveredMessages, new Date().toISOString());
    });
  }

  /** 原子创建运行并保存用户输入，返回本轮之前的历史，拒绝同会话重复提交。 */
  beginRun(owner: TodoOwner, input: string, runId: string): Message[] {
    if (!input.trim() || [...input].length > MAX_MESSAGE_CHARS) throw new AppError(400, `消息不能为空且不能超过 ${MAX_MESSAGE_CHARS} 个字符`);
    return this.#transaction(() => {
      const session = this.#requireSession(owner);
      const active = this.#db.prepare("SELECT id FROM runs WHERE user_id=? AND session_id=? AND status IN ('pending','running')").get(owner.userId, owner.threadId);
      if (active) throw new AppError(409, "这个会话正在执行，请等待完成或先停止当前运行");
      const history = this.history(owner);
      const now = new Date().toISOString();
      this.#db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)").run(runId, owner.userId, owner.threadId, "pending", null, now, null, JSON.stringify(emptyMetrics()), history.length, process.pid);
      this.#appendMessage(owner, runId, { role: "user", content: input });
      const title = text(session, "title") === "新会话" ? [...input.trim()].slice(0, 26).join("") : text(session, "title");
      this.#db.prepare("UPDATE sessions SET title=?,updated_at=? WHERE user_id=? AND id=?").run(title, now, owner.userId, owner.threadId);
      return history;
    });
  }

  /** 将一条内部消息和显示文本一起保存，不存入系统提示或 API Key。 */
  #appendMessage(owner: TodoOwner, runId: string, message: Message): void {
    if (message.role === "system") return;
    this.#db.prepare("INSERT INTO messages(user_id,session_id,run_id,role,content,data,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(owner.userId, owner.threadId, runId, message.role, message.content ?? "", JSON.stringify(message), new Date().toISOString());
  }

  /** 持久化完整运行事件并更新实时计数；终态留到消息事务提交时再写入。 */
  recordEvent(entry: LogEntry): void {
    const run = this.getRun({ userId: entry.userId, threadId: entry.threadId }, entry.runId);
    this.#db.prepare("INSERT INTO run_events(run_id,event,timestamp,data) VALUES (?,?,?,?)").run(entry.runId, entry.event, entry.timestamp, JSON.stringify(entry));
    const next: RunMetrics = entry.event === "run.finished" ? metrics(entry.data) : {
      modelCalls: Math.max(run.metrics.modelCalls, entry.modelCallNo), toolRequests: Math.max(run.metrics.toolRequests, entry.toolCallNo), actualExecutions: Math.max(run.metrics.actualExecutions, entry.actualExecutionCount),
      toolSucceeded: run.metrics.toolSucceeded + Number(entry.event === "tool.succeeded"),
      toolRejected: run.metrics.toolRejected + Number(entry.event === "tool.rejected"),
      toolFailed: run.metrics.toolFailed + Number(entry.event === "tool.failed"),
      tokenCountRequests: run.metrics.tokenCountRequests + Number(entry.event === "tokens.started"),
    };
    this.#db.prepare("UPDATE runs SET metrics_json=? WHERE id=?").run(JSON.stringify(next), entry.runId);
    if (entry.status === "pending" || entry.status === "running") this.#db.prepare("UPDATE runs SET status=? WHERE id=?").run(entry.status, entry.runId);
  }

  /** 在同一事务中保存本轮新消息和终态，失败时保存可继续对话的错误说明。 */
  finishRun(owner: TodoOwner, runId: string, state: AgentState): void {
    this.#transaction(() => {
      const row = this.#db.prepare("SELECT * FROM runs WHERE id=? AND user_id=? AND session_id=?").get(runId, owner.userId, owner.threadId);
      if (!row) throw new AppError(404, "运行不存在");
      if (text(row, "status") === "completed" || text(row, "status") === "failed") return;
      const conversation = state.messages.filter((message) => message.role !== "system");
      const currentInput = conversation[integer(row, "history_count")];
      if (currentInput && isUserInput(currentInput)) {
        this.#db.prepare("UPDATE messages SET data=? WHERE id=(SELECT id FROM messages WHERE run_id=? AND user_id=? AND session_id=? ORDER BY id LIMIT 1)")
          .run(JSON.stringify(currentInput), runId, owner.userId, owner.threadId);
      }
      if (state.status === "completed") {
        const newMessages = conversation.slice(integer(row, "history_count") + 1);
        for (const message of newMessages) this.#appendMessage(owner, runId, message);
      } else {
        this.#appendMessage(owner, runId, { role: "assistant", content: state.finalAnswer ?? `本轮执行未完成：${state.error ?? "执行中断"}。已保存的待办仍保留，可以继续。`, toolCalls: [] });
      }
      this.#db.prepare("UPDATE runs SET status=?,error=?,finished_at=?,metrics_json=? WHERE id=?").run(state.status, state.error, new Date().toISOString(), JSON.stringify(state.metrics), runId);
      this.#db.prepare("UPDATE sessions SET updated_at=? WHERE user_id=? AND id=?").run(new Date().toISOString(), owner.userId, owner.threadId);
    });
  }

  /** 处理 Runtime 外层异常，保存失败状态及一条可见说明。 */
  failRun(owner: TodoOwner, runId: string, error: string): void {
    this.#transaction(() => {
      const run = this.getRun(owner, runId);
      if (run.status === "completed" || run.status === "failed") return;
      this.#appendMessage(owner, runId, { role: "assistant", content: `本轮执行未完成：${error}`, toolCalls: [] });
      this.#db.prepare("UPDATE runs SET status='failed',error=?,finished_at=? WHERE id=?").run(error, new Date().toISOString(), runId);
    });
  }

  /** 返回指定用户、会话下的一次运行，不能通过 runId 跨会话读取。 */
  getRun(owner: TodoOwner, id: string): RunSummary {
    const row = this.#db.prepare("SELECT * FROM runs WHERE id=? AND user_id=? AND session_id=?").get(id, owner.userId, owner.threadId);
    if (!row) throw new AppError(404, "运行不存在");
    return this.#runSummary(row);
  }

  /** 转换经过数据库约束的数据行，生成页面使用的运行摘要。 */
  #runSummary(row: Row): RunSummary {
    return {
      id: text(row, "id"), sessionId: text(row, "session_id"), status: status(text(row, "status")),
      error: row.error === null ? null : text(row, "error"), startedAt: text(row, "started_at"),
      finishedAt: row.finished_at === null ? null : text(row, "finished_at"), metrics: metrics(parseJson(text(row, "metrics_json"))),
    };
  }

  /** 返回用户可见聊天、当前待办和历次执行，供刷新与窗口切换恢复。 */
  detail(owner: TodoOwner): SessionDetail {
    const session = this.getSession(owner);
    const messages: ChatMessage[] = this.#db.prepare("SELECT * FROM messages WHERE user_id=? AND session_id=? AND role IN ('user','assistant') ORDER BY id").all(owner.userId, owner.threadId).flatMap((row): ChatMessage[] => {
      const message = decodeStoredMessage(text(row, "data"));
      if (message.role !== "user" && message.role !== "assistant") throw new Error("聊天角色无效");
      if (message.role === "user" && (!message.content.trim() || message.prompt?.kind === "update")) return [];
      if (message.role === "assistant" && !message.content?.trim() && !message.reasoningContent?.trim() && !message.toolCalls.length) return [];
      return [{
        id: integer(row, "id"), runId: text(row, "run_id"), role: message.role, content: message.content ?? "", createdAt: text(row, "created_at"),
        ...(message.role === "assistant" && message.reasoningContent !== undefined ? { reasoningContent: message.reasoningContent } : {}),
        ...(message.role === "assistant" && message.toolCalls.length ? { toolCalls: message.toolCalls } : {}),
        ...(message.role === "assistant" && message.usage !== undefined ? { usage: message.usage } : {}),
      }];
    });
    const runs = this.#db.prepare("SELECT * FROM runs WHERE user_id=? AND session_id=? ORDER BY rowid DESC LIMIT 100").all(owner.userId, owner.threadId).map((row) => this.#runSummary(row));
    return { session, messages, todos: this.read(owner), runs };
  }

  /** 读取某次运行的完整事件 JSON；所有权已通过 getRun 验证。 */
  eventData(owner: TodoOwner, runId: string): JsonValue[] {
    this.getRun(owner, runId);
    return this.#db.prepare("SELECT data FROM run_events WHERE run_id=? ORDER BY id").all(runId).map((row) => parseJson(text(row, "data")));
  }

  /** 按用户与 session 读取待办，SQL 层始终携带两个归属条件。 */
  read(owner: TodoOwner): TodoItem[] {
    this.#requireSession(owner);
    const rows = this.#db.prepare("SELECT content,status,error FROM todo_items WHERE user_id=? AND session_id=? ORDER BY position").all(owner.userId, owner.threadId);
    return parseTodos(rows.map((row) => ({ content: text(row, "content"), status: text(row, "status"), error: row.error === null ? null : text(row, "error") })));
  }

  /** 在事务中整表替换当前 session 的待办，其他窗口的数据保持独立。 */
  write(owner: TodoOwner, todos: readonly TodoItem[]): void {
    const next = parseTodos(todos.map((todo) => ({ ...todo })));
    this.#transaction(() => {
      this.#requireSession(owner);
      this.#db.prepare("DELETE FROM todo_items WHERE user_id=? AND session_id=?").run(owner.userId, owner.threadId);
      const insert = this.#db.prepare("INSERT INTO todo_items VALUES (?,?,?,?,?,?)");
      next.forEach((todo, position) => insert.run(owner.userId, owner.threadId, position, todo.content, todo.status, todo.error));
      this.#db.prepare("UPDATE sessions SET updated_at=? WHERE user_id=? AND id=?").run(new Date().toISOString(), owner.userId, owner.threadId);
    });
  }

  /** 导入原 JSON 待办，只创建尚不存在的会话，不覆盖已有 SQLite 数据或删除原文件。 */
  importLegacyTodos(directory: string): { imported: number; skipped: string[] } {
    const result = { imported: 0, skipped: [] as string[] };
    if (!existsSync(directory)) return result;
    for (const name of readdirSync(directory).filter((file) => /^[a-f0-9]{64}\.todos\.json$/.test(file))) {
      try {
        const data = objectValue(parseJson(readFileSync(join(directory, name), "utf8")), "旧待办");
        const owner = { userId: stringField(data, "userId"), threadId: stringField(data, "threadId") };
        const todos = parseTodos(data.todos);
        if (this.#db.prepare("SELECT 1 FROM sessions WHERE user_id=? AND id=?").get(owner.userId, owner.threadId)) continue;
        this.#transaction(() => {
          this.ensureSession(owner, todos[0]?.content.slice(0, 26) || "导入的待办");
          const insert = this.#db.prepare("INSERT INTO todo_items VALUES (?,?,?,?,?,?)");
          todos.forEach((todo, index) => insert.run(owner.userId, owner.threadId, index, todo.content, todo.status, todo.error));
        });
        result.imported++;
      } catch { result.skipped.push(name); }
    }
    return result;
  }

  /** 将已退出进程遗留的运行标记为失败，保留用户输入和待办以便继续会话。 */
  recoverAbandonedRuns(): number {
    const rows = this.#db.prepare("SELECT * FROM runs WHERE status IN ('pending','running')").all();
    let count = 0;
    for (const row of rows) if (!processAlive(integer(row, "owner_pid"))) {
      this.failRun({ userId: text(row, "user_id"), threadId: text(row, "session_id") }, text(row, "id"), "上次服务已中断，本轮没有自动重试；可以继续当前会话");
      count++;
    }
    return count;
  }
}
