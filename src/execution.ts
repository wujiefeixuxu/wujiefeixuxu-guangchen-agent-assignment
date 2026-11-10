import { randomUUID } from "node:crypto";
import { withAbort } from "./abort.ts";
import { ContextManager } from "./context.ts";
import type { ContextMemory, ContextOptions, PreparedContext } from "./context.ts";
import { errorMessage } from "./errors.ts";
import { parseJson } from "./json.ts";
import type { JsonValue } from "./json.ts";
import type { Status } from "./state.ts";
import type { ToolErrorData } from "./tool-errors.ts";
import { ToolError } from "./tool-errors.ts";
import { MemoryTodoStore } from "./todo-store.ts";
import type { TodoStore } from "./todo-store.ts";
import { cloneTodos } from "./todos.ts";
import type { TodoItem } from "./todos.ts";
import { createRuntimeSnapshot, createRuntimeUpdate } from "./prompt.ts";
import type { RuntimeSnapshot, ToolObservation, UpdateReason } from "./prompt.ts";
import { createMemorySnapshot, memoryIndex, memoryTimestamp, memoryView, PREFERENCES_ID } from "./memory.ts";
import type { MemoryMode, MemoryReadResult, MemorySnapshot, MemoryWriteArgs, MemoryWriteResult } from "./memory.ts";
import { InMemoryMemoryStore } from "./memory-store.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { AssistantMessage, Message, Model, ModelInput, NodeId, ToolCall, ToolDefinition, ToolResult } from "./types.ts";

export interface ContextSettings {
  readonly maxModelCalls?: number;
  readonly context?: ContextOptions;
  readonly memory?: ContextMemory;
  readonly saveMemory?: (memory: ContextMemory) => void;
  readonly recentTools?: readonly ToolObservation[];
  readonly memoryStore?: MemoryStore;
  readonly memoryMode?: MemoryMode;
  readonly memoryRecordedAt?: string;
  readonly now?: () => Date;
}

export interface RunIdentity {
  readonly userId: string;
  readonly threadId: string;
  readonly runId: string;
}

export interface RunMetrics {
  readonly modelCalls: number;
  readonly toolRequests: number;
  readonly actualExecutions: number;
  readonly toolSucceeded: number;
  readonly toolRejected: number;
  readonly toolFailed: number;
  readonly tokenCountRequests: number;
}

/** 创建全为零的调用统计，供新任务初始化时使用。 */
export function emptyMetrics(): RunMetrics {
  return { modelCalls: 0, toolRequests: 0, actualExecutions: 0, toolSucceeded: 0, toolRejected: 0, toolFailed: 0, tokenCountRequests: 0 };
}

export interface PendingToolCall {
  readonly call: ToolCall;
  readonly invocationId: string;
  readonly toolCallNo: number;
  readonly modelCallNo: number;
  readonly requestedAt: string;
}

export interface ToolResultMeta extends RunIdentity {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly invocationId: string;
  readonly toolCallNo: number;
  readonly modelCallNo: number;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly executionDurationMs: number | null;
  readonly executed: boolean;
}

export interface ToolExecutionContext extends RunIdentity {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly invocationId: string;
  readonly toolCallNo: number;
  readonly modelCallNo: number;
  readonly actualExecutionCount: number;
  readonly signal: AbortSignal;
  /** 在当前调用所属的 thread 中替换完整待办清单，保存后返回副本。 */
  writeTodos(todos: readonly TodoItem[]): TodoItem[];
  /** 查询当前用户的最新记忆，不重建本轮已经冻结的 system 快照。 */
  readMemory(id?: string): MemoryReadResult;
  /** 单条创建、更新或删除记忆，用户身份与时间始终由 Runtime 注入。 */
  writeMemory(args: MemoryWriteArgs): MemoryWriteResult;
}

export type LogEventName =
  | "run.status" | "run.finished" | "node.started"
  | "model.started" | "model.succeeded" | "model.failed"
  | "tool.requested" | "tool.started" | "tool.succeeded" | "tool.rejected" | "tool.failed" | "todos.updated"
  | "context.compacting" | "context.compacted" | "context.prepared" | "tokens.started" | "tokens.succeeded" | "tokens.failed"
  | "memory.loaded" | "memory.updated";

export interface LogEntry extends RunIdentity {
  readonly event: LogEventName;
  readonly timestamp: string;
  readonly step: number;
  readonly modelCallNo: number;
  readonly toolCallNo: number;
  readonly actualExecutionCount: number;
  readonly status: Status | null;
  readonly node: NodeId | null;
  readonly toolName: string | null;
  readonly toolCallId: string | null;
  readonly invocationId: string | null;
  readonly durationMs: number | null;
  readonly data: JsonValue;
}

export type LogSink = (entry: LogEntry) => void;

interface LogFields {
  readonly status?: Status;
  readonly node?: NodeId;
  readonly tool?: PendingToolCall;
  readonly durationMs?: number;
  readonly data?: JsonValue;
}

interface InvocationRecord {
  readonly pending: PendingToolCall;
  readonly requestedTick: number;
  startedAt: string | null;
  startedTick: number | null;
  result: ToolResult | null;
}

export class RunContext {
  readonly identity: RunIdentity;
  readonly #sink: LogSink | undefined;
  readonly #logs: LogEntry[] = [];
  readonly #invocations = new Map<string, InvocationRecord>();
  readonly #startedTick = performance.now();
  readonly #todoStore: TodoStore;
  readonly #contextManager: ContextManager;
  readonly #maxModelCalls: number;
  readonly #recentTools: readonly ToolObservation[] | undefined;
  readonly #memoryStore: MemoryStore;
  readonly #memoryMode: MemoryMode;
  readonly #memoryAsOf: Date;
  readonly #memoryRecordedAt: string;
  readonly #initialMemoryIds = new Set<string>();
  readonly #organizedSavedIds = new Set<string>();
  #memorySnapshot: MemorySnapshot = { preferences: null, index: [] };
  #memoryLoaded = false;
  #todos: TodoItem[] = [];
  #metrics = emptyMetrics();
  #step = 0;
  #closed = false;
  #modelStartedTick: number | null = null;
  interruption: ToolErrorData = { code: "TOOL_CANCELLED", message: "任务已取消", field: null };

  /** 绑定用户和 thread，生成 runId，并设置日志接收函数和待办存储。 */
  constructor(userId = "local-user", threadId: string = randomUUID(), sink?: LogSink, todoStore: TodoStore = new MemoryTodoStore(), runId: string = randomUUID(), settings: ContextSettings = {}) {
    if (!userId.trim() || !threadId.trim()) throw new Error("userId 和 threadId 不能为空");
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runId)) throw new Error("runId 必须是 UUID");
    this.identity = { userId, threadId, runId };
    this.#sink = sink;
    this.#todoStore = todoStore;
    this.#maxModelCalls = settings.maxModelCalls ?? 20;
    this.#recentTools = settings.recentTools;
    this.#memoryStore = settings.memoryStore ?? new InMemoryMemoryStore();
    this.#memoryMode = settings.memoryMode ?? "normal";
    this.#memoryAsOf = new Date(memoryTimestamp(settings.now?.() ?? new Date()));
    this.#memoryRecordedAt = memoryTimestamp(settings.memoryRecordedAt ?? this.#memoryAsOf);
    if (!Number.isSafeInteger(this.#maxModelCalls) || this.#maxModelCalls < 1) throw new Error("最大模型调用次数必须是正整数");
    this.#contextManager = new ContextManager(settings.context, settings.memory, settings.saveMemory);
  }

  /** 返回当前统计的浅拷贝，避免调用方直接改写内部计数。 */
  get metrics(): RunMetrics { return { ...this.#metrics }; }
  /** 按事件发生顺序返回日志数组的浅拷贝。 */
  get logs(): readonly LogEntry[] { return [...this.#logs]; }

  /** 返回当前 thread 待办的副本，供模型快照和最终运行状态使用。 */
  get todos(): readonly TodoItem[] { return cloneTodos(this.#todos); }

  /** 返回本轮更新后的摘要与消息覆盖边界，便于下一轮或持久化层复用。 */
  get contextMemory(): ContextMemory { return this.#contextManager.memory; }

  /** 返回本轮开始时的偏好与索引副本；工具写入不会修改这个快照。 */
  get memorySnapshot(): MemorySnapshot {
    return { preferences: this.#memorySnapshot.preferences ? { ...this.#memorySnapshot.preferences } : null, index: this.#memorySnapshot.index.map((item) => ({ ...item })) };
  }

  /** 每轮只加载一次，时间标签也固定在本轮开始时，跨午夜不会重写 system。 */
  loadMemories(): void {
    if (this.#memoryLoaded) return;
    const records = this.#memoryStore.listMemories(this.identity.userId);
    for (const record of records) this.#initialMemoryIds.add(record.id);
    this.#memorySnapshot = createMemorySnapshot(records, this.#memoryAsOf);
    this.#memoryLoaded = true;
    this.emit("memory.loaded", { data: { snapshot: this.memorySnapshot } });
  }

  /** 在真正请求模型之前检查单次任务预算，摘要调用也占用同一个计数。 */
  assertModelBudget(): void {
    if (this.#metrics.modelCalls >= this.#maxModelCalls) throw new Error(`达到单次任务最大模型调用次数 ${this.#maxModelCalls}`);
  }

  /** 选择真实执行状态，构造可冻结到用户消息或状态通知中的完整运行快照。 */
  snapshot(messages: readonly Message[], status: Status = "running"): RuntimeSnapshot {
    return createRuntimeSnapshot(this.identity, status, this.metrics, this.#maxModelCalls, this.todos, messages, this.#metrics.toolRequests === 0 ? this.#recentTools : undefined);
  }

  /** 在工具批次完成或历史压缩后生成一次尾部更新，并按最终实际发送内容计数。 */
  async prepareInput(model: Model, messages: readonly Message[], tools: readonly ToolDefinition[], signal: AbortSignal): Promise<PreparedContext> {
    return this.#contextManager.prepare(messages, tools,
      /** 多次摘要只刷新尚未发送的候选快照，工具和压缩同时发生时合并为一条更新。 */
      (compacted) => {
        const reasons: UpdateReason[] = [];
        if (messages.at(-1)?.role === "tool") reasons.push("tools_completed");
        if (compacted) reasons.push("context_compacted");
        return reasons.length ? createRuntimeUpdate(this.snapshot(messages), reasons) : null;
      },
      (input) => this.invokeModel(model, input, signal, "summary"),
      (event, data) => this.emit(event, { data }),
      (input) => this.#countTokens(model, input, signal));
  }

  /** 单独记录计数接口请求，它不生成回复，也不占用20次模型生成轮次。 */
  async #countTokens(model: Model, input: ModelInput, signal: AbortSignal): Promise<number> {
    const countTokens = model.countTokens;
    if (!countTokens) throw new Error("当前模型没有提供 token 计数接口");
    if (signal.aborted) throw new Error("任务已取消或执行超时");
    this.#metrics = { ...this.#metrics, tokenCountRequests: this.#metrics.tokenCountRequests + 1 };
    const started = performance.now();
    this.emit("tokens.started", { data: { inputCharacters: JSON.stringify(input).length } });
    try {
      const result = await withAbort(() => countTokens.call(model, input, signal), signal);
      this.emit("tokens.succeeded", { durationMs: performance.now() - started, data: { inputTokens: result } });
      return result;
    } catch (error) {
      this.emit("tokens.failed", { durationMs: performance.now() - started, data: { error: errorMessage(error) } });
      throw error;
    }
  }

  /** 统一记录和计数真实模型调用，区分 Agent 决策与无工具的历史摘要。 */
  async invokeModel(model: Model, input: ModelInput, signal: AbortSignal, purpose: "agent" | "summary" = "agent"): Promise<AssistantMessage> {
    if (signal.aborted) throw new Error("任务已取消或执行超时");
    this.assertModelBudget();
    this.startModel(parseJson(JSON.stringify({ ...input, purpose })));
    try {
      const reply = await withAbort(() => model.generate(input, signal), signal);
      if (signal.aborted) throw new Error("任务已取消或执行超时");
      if (reply.toolCalls.length > 16) throw new Error("单次模型回复最多允许 16 个工具调用");
      if (reply.toolCalls.length === 0 && !reply.content?.trim()) throw new Error("模型没有返回有效回答或工具调用");
      this.finishModel("model.succeeded", parseJson(JSON.stringify({ ...reply, purpose })));
      return reply;
    } catch (error) {
      this.finishModel("model.failed", { error: errorMessage(error), purpose });
      throw error;
    }
  }

  /** 在运行开始时加载当前用户和 thread 的清单，保留之前已完成或失败的状态。 */
  loadTodos(): void {
    this.#todos = this.#todoStore.read(this.identity);
  }

  /** 为事件补齐身份、时间戳和当前计数，再保存并发送；任务关闭后忽略新事件。 */
  emit(event: LogEventName, fields: LogFields = {}): void {
    if (this.#closed) return;
    const entry: LogEntry = {
      ...this.identity, event, timestamp: new Date().toISOString(), step: this.#step,
      modelCallNo: fields.tool?.modelCallNo ?? this.#metrics.modelCalls,
      toolCallNo: fields.tool?.toolCallNo ?? this.#metrics.toolRequests,
      actualExecutionCount: this.#metrics.actualExecutions,
      status: fields.status ?? null, node: fields.node ?? null,
      toolName: fields.tool?.call.name ?? null, toolCallId: fields.tool?.call.id ?? null,
      invocationId: fields.tool?.invocationId ?? null, durationMs: fields.durationMs ?? null,
      data: fields.data ?? null,
    };
    this.#logs.push(entry);
    this.#sink?.(entry);
  }

  /** 更新当前节点步数并记录节点开始事件。 */
  startNode(node: NodeId, step: number): void {
    this.#step = step;
    this.emit("node.started", { node });
  }

  /** 增加模型调用次数、启动单调时钟计时，并记录模型输入。 */
  startModel(data: JsonValue): void {
    if (this.#closed) throw new Error("本次任务已经结束");
    this.assertModelBudget();
    this.#metrics = { ...this.#metrics, modelCalls: this.#metrics.modelCalls + 1 };
    this.#modelStartedTick = performance.now();
    this.emit("model.started", { data });
  }

  /** 记录当前模型调用的结果和耗时；同一轮调用只记录一次结束事件。 */
  finishModel(event: "model.succeeded" | "model.failed", data: JsonValue): void {
    if (this.#modelStartedTick === null) return;
    const durationMs = Math.round((performance.now() - this.#modelStartedTick) * 1000) / 1000;
    this.#modelStartedTick = null;
    this.emit(event, { durationMs, data });
  }

  /** 为模型工具请求分配本地唯一 ID 和序号，此时尚未增加实际执行次数。 */
  requestTool(call: ToolCall): PendingToolCall {
    if (this.#closed) throw new Error("本次任务已经结束");
    this.#metrics = { ...this.#metrics, toolRequests: this.#metrics.toolRequests + 1 };
    const pending: PendingToolCall = {
      call, invocationId: randomUUID(), toolCallNo: this.#metrics.toolRequests,
      modelCallNo: this.#metrics.modelCalls, requestedAt: new Date().toISOString(),
    };
    this.#invocations.set(pending.invocationId, { pending, requestedTick: performance.now(), startedAt: null, startedTick: null, result: null });
    this.emit("tool.requested", { tool: pending, data: { arguments: call.arguments } });
    return pending;
  }

  /** 在执行函数开始前记录时间并增加实际执行次数，拒绝重复执行或已结束的调用。 */
  startTool(pending: PendingToolCall): void {
    const record = this.#record(pending);
    if (this.#closed || record.result !== null || record.startedAt !== null) throw new Error("工具调用已经执行或任务已结束");
    record.startedAt = new Date().toISOString();
    record.startedTick = performance.now();
    this.#metrics = { ...this.#metrics, actualExecutions: this.#metrics.actualExecutions + 1 };
    this.emit("tool.started", { tool: pending });
  }

  /** 构造工具执行上下文，注入当前身份、调用标识、序号和取消信号。 */
  toolContext(pending: PendingToolCall, signal: AbortSignal): ToolExecutionContext {
    return {
      ...this.identity, toolName: pending.call.name, toolCallId: pending.call.id, invocationId: pending.invocationId,
      toolCallNo: pending.toolCallNo, modelCallNo: pending.modelCallNo,
      actualExecutionCount: this.#metrics.actualExecutions, signal,
      /** 在保存前检查取消信号，身份和调用关联信息始终来自当前 Runtime。 */
      writeTodos: (todos) => {
        if (signal.aborted) throw new ToolError(this.interruption.code, this.interruption.message);
        return this.#writeTodos(pending, todos);
      },
      /** 使用当前工具的生命周期和用户归属读取最新存储内容。 */
      readMemory: (id) => {
        this.#assertMemoryToolOpen(pending, signal);
        if (id === undefined) return { kind: "index", index: this.#memoryStore.listMemories(this.identity.userId).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((record) => memoryIndex(record, this.#memoryAsOf)) };
        const record = this.#memoryStore.getMemory(this.identity.userId, id);
        if (!record) throw new ToolError("MEMORY_NOT_FOUND", "当前用户没有这条记忆，请先读取索引", "id");
        return { kind: "memory", memory: memoryView(record, this.#memoryAsOf) };
      },
      /** 只修改存储，保留已发送的 system 快照，结果通过原生工具消息追加。 */
      writeMemory: (args) => {
        this.#assertMemoryToolOpen(pending, signal);
        const existing = this.#memoryStore.getMemory(this.identity.userId, args.id);
        if (this.#memoryMode === "organize" && (!this.#initialMemoryIds.has(args.id) || !existing)) throw new ToolError("MEMORY_ORGANIZE_NEW_ID", "整理只能修改开始时已有的记忆，不能创建或恢复已删除的ID", "id");
        let result: MemoryWriteResult;
        if (args.operation === "delete") {
          if (this.#memoryMode === "organize" && (args.id === PREFERENCES_ID || ![...this.#organizedSavedIds].some((id) => id !== args.id && this.#memoryStore.getMemory(this.identity.userId, id)))) throw new ToolError("MEMORY_ORGANIZE_DELETE_ORDER", "整理时保留偏好，删除重复项前必须先成功保存另一个保留ID", "id");
          this.#memoryStore.deleteMemory(this.identity.userId, args.id); result = { operation: "delete", id: args.id, deleted: true };
        }
        else {
          const record = this.#memoryStore.upsertMemory(this.identity.userId, args, this.#memoryMode === "organize" && existing ? existing.recordedAt : this.#memoryRecordedAt);
          result = { operation: "upsert", memory: memoryView(record, this.#memoryAsOf) };
          if (this.#memoryMode === "organize") this.#organizedSavedIds.add(record.id);
        }
        this.emit("memory.updated", { tool: pending, data: { ...result } });
        return result;
      },
    };
  }

  /** 防止取消、超时或已完成的工具上下文迟到读取、修改用户记忆。 */
  #assertMemoryToolOpen(pending: PendingToolCall, signal: AbortSignal): void {
    if (signal.aborted) throw new ToolError(this.interruption.code, this.interruption.message);
    const record = this.#record(pending);
    if (this.#closed || record.startedAt === null || record.result !== null) throw new ToolError("RUN_STOPPED", "任务或工具调用已结束，不能继续访问记忆");
  }

  /** 先持久保存再替换内存快照，记录关联到本次工具调用的完整待办更新事件。 */
  #writeTodos(pending: PendingToolCall, todos: readonly TodoItem[]): TodoItem[] {
    const record = this.#record(pending);
    if (this.#closed || record.startedAt === null || record.result !== null) {
      throw new ToolError("RUN_STOPPED", "任务或工具调用已结束，不能继续修改待办");
    }
    const next = cloneTodos(todos);
    this.#todoStore.write(this.identity, next);
    this.#todos = next;
    this.emit("todos.updated", { tool: pending, data: { todos: cloneTodos(next) } });
    return cloneTodos(next);
  }

  /**
   * 封装工具结果、关联标识及两类耗时，并按成功、拒绝或执行失败分别统计。
   * 已结束的调用直接返回原结果，避免超时后的迟到结果重复计数。
   */
  finishTool(
    pending: PendingToolCall,
    outcome: { readonly ok: true; readonly result: JsonValue } | { readonly ok: false; readonly error: ToolErrorData },
  ): ToolResult {
    const record = this.#record(pending);
    // 超时关闭后，迟到的工具结果不能追加第二个结束事件或篡改统计。
    if (record.result !== null) return record.result;
    const finishedTick = performance.now();
    const durationMs = Math.round((finishedTick - record.requestedTick) * 1000) / 1000;
    const executionDurationMs = record.startedTick === null ? null : Math.round((finishedTick - record.startedTick) * 1000) / 1000;
    const meta: ToolResultMeta = {
      ...this.identity, toolName: pending.call.name, toolCallId: pending.call.id,
      invocationId: pending.invocationId, toolCallNo: pending.toolCallNo, modelCallNo: pending.modelCallNo,
      requestedAt: pending.requestedAt, startedAt: record.startedAt,
      finishedAt: new Date().toISOString(), durationMs, executionDurationMs, executed: record.startedAt !== null,
    };
    const result: ToolResult = { ...outcome, meta };
    record.result = result;
    if (outcome.ok) this.#metrics = { ...this.#metrics, toolSucceeded: this.#metrics.toolSucceeded + 1 };
    else if (meta.executed) this.#metrics = { ...this.#metrics, toolFailed: this.#metrics.toolFailed + 1 };
    else this.#metrics = { ...this.#metrics, toolRejected: this.#metrics.toolRejected + 1 };
    this.emit(outcome.ok ? "tool.succeeded" : meta.executed ? "tool.failed" : "tool.rejected", {
      tool: pending, durationMs, data: { ...outcome, meta: { ...meta } },
    });
    return result;
  }

  /** 关闭尚未结束的模型和工具调用，记录任务终态与汇总，再停止接收新日志。 */
  finish(status: Status, error: string | null): void {
    if (this.#modelStartedTick !== null) this.finishModel("model.failed", { error });
    for (const record of this.#invocations.values()) {
      if (record.result === null) this.finishTool(record.pending, {
        ok: false,
        error: { ...this.interruption, message: error ?? this.interruption.message },
      });
    }
    this.emit("run.status", { status });
    this.emit("run.finished", {
      status, durationMs: Math.round((performance.now() - this.#startedTick) * 1000) / 1000,
      data: { ...this.#metrics, error },
    });
    this.#closed = true;
  }

  /** 获取当前任务拥有的工具调用记录，拒绝不存在或来自其他任务的调用对象。 */
  #record(pending: PendingToolCall): InvocationRecord {
    const record = this.#invocations.get(pending.invocationId);
    if (record === undefined || record.pending !== pending) throw new Error("工具调用不属于当前任务");
    return record;
  }
}
