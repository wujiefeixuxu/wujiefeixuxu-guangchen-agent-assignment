import { errorMessage } from "./errors.ts";
import { randomUUID } from "node:crypto";
import { withAbort } from "./abort.ts";
import { RunContext } from "./execution.ts";
import type { LogEntry } from "./execution.ts";
import { END } from "./graph.ts";
import type { AgentGraph, NextNode } from "./graph.ts";
import { AgentStatus, createState, transitionState } from "./state.ts";
import type { AgentState } from "./state.ts";
import type { Message, NodeId } from "./types.ts";
import { MemoryTodoStore } from "./todo-store.ts";
import type { TodoStore } from "./todo-store.ts";
import type { ContextMemory, ContextOptions } from "./context.ts";
import { isUserInput, withInputSnapshot } from "./prompt.ts";
import type { ToolObservation } from "./prompt.ts";
import { renderMemorySnapshot } from "./memory.ts";
import type { MemoryMode } from "./memory.ts";
import { InMemoryMemoryStore } from "./memory-store.ts";
import type { MemoryStore } from "./memory-store.ts";

export type RuntimeEvent = LogEntry;

export interface RunOptions {
  readonly userId?: string;
  readonly threadId?: string;
  readonly signal?: AbortSignal;
  readonly runId?: string;
  readonly history?: readonly Message[];
  readonly contextMemory?: ContextMemory;
  readonly onContextUpdate?: (memory: ContextMemory) => void;
  readonly recentTools?: readonly ToolObservation[];
  readonly memoryMode?: MemoryMode;
  readonly memoryRecordedAt?: string;
}

export interface RuntimeOptions {
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
  readonly systemPrompt?: string;
  readonly onEvent?: (event: RuntimeEvent) => void;
  readonly todoStore?: TodoStore;
  readonly maxModelCalls?: number;
  readonly context?: ContextOptions;
  readonly memoryStore?: MemoryStore;
  readonly now?: () => Date;
}

export class AgentRuntime {
  readonly #graph: AgentGraph;
  readonly #maxSteps: number;
  readonly #timeoutMs: number;
  readonly #systemPrompt: string | undefined;
  readonly #onEvent: ((event: RuntimeEvent) => void) | undefined;
  readonly #todoStore: TodoStore;
  readonly #maxModelCalls: number;
  readonly #contextOptions: ContextOptions;
  readonly #memoryStore: MemoryStore;
  readonly #now: (() => Date) | undefined;
  readonly #threadQueue = new Map<string, Promise<void>>();

  /** 保存节点图与执行选项，并检查最大步数、总超时是否有效。 */
  constructor(graph: AgentGraph, options: RuntimeOptions = {}) {
    this.#graph = graph;
    this.#maxSteps = options.maxSteps ?? 40;
    this.#timeoutMs = options.timeoutMs ?? 300_000;
    this.#systemPrompt = options.systemPrompt;
    this.#onEvent = options.onEvent;
    this.#todoStore = options.todoStore ?? new MemoryTodoStore();
    this.#maxModelCalls = options.maxModelCalls ?? 20;
    this.#contextOptions = options.context ?? {};
    this.#memoryStore = options.memoryStore ?? new InMemoryMemoryStore();
    this.#now = options.now;
    if (!Number.isSafeInteger(this.#maxModelCalls) || this.#maxModelCalls < 1) throw new Error("maxModelCalls 必须是正整数");
    if (!Number.isSafeInteger(this.#maxSteps) || this.#maxSteps < 1) {
      throw new Error("maxSteps 必须是正整数");
    }
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 2_147_483_647) {
      throw new Error("timeoutMs 必须是有效的正整数计时长度");
    }
  }

  /**
   * 为一次用户输入创建独立运行，沿边调度节点直到完成、失败或取消。
   * options 注入用户、thread 标识及外部取消信号；返回最终状态、统计和完整日志。
   * 同一用户、同一 thread 的请求串行执行，不同 thread 独立调度。
   */
  async run(input: string, options: RunOptions = {}): Promise<AgentState> {
    const ownedOptions = { ...options, userId: options.userId ?? "local-user", threadId: options.threadId ?? randomUUID() };
    const key = JSON.stringify([ownedOptions.userId, ownedOptions.threadId]);
    const previous = this.#threadQueue.get(key) ?? Promise.resolve();
    const task = previous.then(() => this.#execute(input, ownedOptions));
    const completed = task.then(() => {}, () => {});
    this.#threadQueue.set(key, completed);
    try {
      return await task;
    } finally {
      if (this.#threadQueue.get(key) === completed) this.#threadQueue.delete(key);
    }
  }

  /** 执行已按 thread 排队的单次任务，加载待办并在每个节点后保存最新运行快照。 */
  async #execute(input: string, options: RunOptions): Promise<AgentState> {
    let state = createState(input, this.#systemPrompt, options.history);
    const context = new RunContext(options.userId, options.threadId, this.#onEvent, this.#todoStore, options.runId, {
      maxModelCalls: this.#maxModelCalls, context: this.#contextOptions,
      ...(options.contextMemory === undefined ? {} : { memory: options.contextMemory }),
      ...(options.onContextUpdate === undefined ? {} : { saveMemory: options.onContextUpdate }),
      ...(options.recentTools === undefined ? {} : { recentTools: options.recentTools }),
      memoryStore: this.#memoryStore,
      ...(options.memoryMode === undefined ? {} : { memoryMode: options.memoryMode }),
      ...(options.memoryRecordedAt === undefined ? {} : { memoryRecordedAt: options.memoryRecordedAt }),
      ...(this.#now === undefined ? {} : { now: this.#now }),
    });
    state = { ...state, identity: context.identity };
    context.emit("run.status", { status: state.status });
    state = transitionState(state, AgentStatus.RUNNING);
    context.emit("run.status", { status: state.status });

    const controller = new AbortController();
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.signal]);
    const timer = setTimeout(() => {
      context.interruption = { code: "TOOL_TIMEOUT", message: "任务执行超时", field: null };
      controller.abort();
    }, this.#timeoutMs);

    try {
      context.loadTodos();
      context.loadMemories();
      const memorySnapshot = context.memorySnapshot;
      state = {
        ...state, memorySnapshot,
        messages: state.messages.map((message, index) => index === 0 && message.role === "system" ? { ...message, content: `${message.content}\n\n${renderMemorySnapshot(memorySnapshot)}` } : message),
      };
      const currentInput = state.messages.at(-1);
      if (!currentInput || !isUserInput(currentInput)) throw new Error("运行缺少当前用户输入");
      state = {
        ...state, todos: context.todos,
        messages: [...state.messages.slice(0, -1), withInputSnapshot(currentInput, context.snapshot(state.messages, state.status))],
      };
      let nextNode: NextNode = this.#graph.entry;
      while (nextNode !== END) {
        if (signal.aborted) throw new Error("任务已取消或执行超时");
        if (nextNode === "model") context.assertModelBudget();
        if (state.steps >= this.#maxSteps) {
          throw new Error(`达到最大执行步数 ${this.#maxSteps}，任务未完成`);
        }
        const node: NodeId = nextNode;
        state = { ...state, steps: state.steps + 1, trace: [...state.trace, node] };
        context.startNode(node, state.steps);
        const nodeState = state;
        const update = await withAbort(() => this.#graph.nodes[node](nodeState, signal, context), signal);
        // Runtime 保留 status、steps、trace 的控制权，节点只更新执行数据。
        state = {
          ...state,
          messages: update.messages,
          pendingToolCalls: update.pendingToolCalls,
          finalAnswer: update.finalAnswer,
          todos: context.todos,
          contextMemory: context.contextMemory,
        };
        nextNode = this.#graph.edges[node](state);
      }
      if (!state.finalAnswer?.trim() || state.pendingToolCalls.length !== 0) {
        throw new Error("流程结束时没有最终回答，或仍有工具调用未执行");
      }
      state = transitionState(state, AgentStatus.COMPLETED);
    } catch (error) {
      state = transitionState(state, AgentStatus.FAILED, errorMessage(error));
      if (!signal.aborted) context.interruption = { code: "RUN_STOPPED", message: state.error ?? "任务已停止", field: null };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    context.finish(state.status, state.error);
    return { ...state, todos: context.todos, contextMemory: context.contextMemory, metrics: context.metrics, logs: context.logs };
  }
}
