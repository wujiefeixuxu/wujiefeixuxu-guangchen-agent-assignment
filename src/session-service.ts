import { randomUUID } from "node:crypto";
import { errorMessage } from "./errors.ts";
import { createAgentGraph } from "./graph.ts";
import { AgentRuntime } from "./runtime.ts";
import type { RuntimeOptions } from "./runtime.ts";
import { AppError } from "./sessions.ts";
import { SqliteStore } from "./sqlite-store.ts";
import type { AgentState } from "./state.ts";
import type { TodoOwner } from "./todo-store.ts";
import { createBuiltinTools } from "./tools/builtin.ts";
import type { Message, Model } from "./types.ts";
import type { MemoryMode } from "./memory.ts";

export const ORGANIZE_MEMORY_INPUT = "请整理我已经保存的长期记忆：先用memory_read列出当前索引，再读取需要整理的正文。只依据库内已有信息去重、合并和修正简介，不从旧聊天重新增加或恢复已删除的事实。保持原有记录时间，保留偏好ID preferences。删除重复项前，必须先对保留ID执行一次upsert并确认成功，即使保留项正文无需变化也要先保存；再删除确定已经合并的重复ID。不能创建新ID，不要删除不确定的独立事实，不操作Todo。无需修改时直接说明。最后简短列出实际改动。";

export class SessionService {
  readonly store: SqliteStore;
  readonly #runtime: AgentRuntime;
  readonly #active = new Map<string, { controller: AbortController; completion: Promise<AgentState> }>();
  #closed = false;

  /** 将 SQLite 历史、待办和日志接入现有 Runtime，不改变模型与工具的自主决策。 */
  constructor(store: SqliteStore, model: Model, options: RuntimeOptions = {}) {
    this.store = store;
    this.#runtime = new AgentRuntime(createAgentGraph(model, createBuiltinTools()), {
      ...options, todoStore: store, memoryStore: store,
      /** 同一事件先入数据库，再交给调用方保存 JSONL 或显示。 */
      onEvent(entry) { store.recordEvent(entry); options.onEvent?.(entry); },
    });
  }

  /** 原子接受一条消息，返回运行标识和可等待的结果，浏览器可立即开始轮询。 */
  startRun(owner: TodoOwner, input: string, externalSignal?: AbortSignal, memoryMode: MemoryMode = "normal"): { runId: string; completion: Promise<AgentState> } {
    if (this.#closed) throw new AppError(503, "服务正在关闭");
    const runId = randomUUID();
    const history = this.store.beginRun(owner, input, runId);
    const controller = new AbortController();
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    const completion = Promise.resolve().then(() => this.#execute(owner, input, runId, history, signal, memoryMode));
    this.#active.set(runId, { controller, completion });
    void completion.catch(() => {});
    return { runId, completion };
  }

  /** 用户手动触发整理，复用现有受限 Agent 循环，不启动常驻后台模型。 */
  startMemoryOrganization(owner: TodoOwner): { runId: string; completion: Promise<AgentState> } {
    this.store.getSession(owner);
    if (!this.store.listMemories(owner.userId).length) throw new AppError(400, "还没有已保存的记忆可以整理");
    return this.startRun(owner, ORGANIZE_MEMORY_INPUT, undefined, "organize");
  }

  /** 执行并提交本轮新增消息，外层异常也保存为可继续对话的失败回复。 */
  async #execute(owner: TodoOwner, input: string, runId: string, history: readonly Message[], signal: AbortSignal, memoryMode: MemoryMode): Promise<AgentState> {
    try {
      const state = await this.#runtime.run(input, {
        ...owner, runId, history, signal, contextMemory: this.store.readContext(owner), recentTools: this.store.recentToolBatch(owner),
        memoryMode, memoryRecordedAt: this.store.inputRecordedAt(owner, runId),
        /** 摘要只保存覆盖范围和文本，SQLite 原始聊天记录始终保留。 */
        onContextUpdate: (memory) => this.store.saveContext(owner, memory),
      });
      this.store.finishRun(owner, runId, state);
      return state;
    } catch (error) {
      this.store.failRun(owner, runId, errorMessage(error));
      throw error;
    } finally { this.#active.delete(runId); }
  }

  /** 校验用户、会话和运行归属后取消当前服务持有的执行。 */
  cancel(owner: TodoOwner, runId: string): void {
    const run = this.store.getRun(owner, runId);
    if (run.status === "completed" || run.status === "failed") return;
    const active = this.#active.get(runId);
    if (!active) throw new AppError(409, "该运行由另一个本地进程持有，请在原进程停止");
    active.controller.abort();
  }

  /** 关闭前取消并等待本服务的运行，确保消息和失败状态提交后再关闭数据库。 */
  async shutdown(): Promise<void> {
    this.#closed = true;
    const active = [...this.#active.values()];
    active.forEach((run) => run.controller.abort());
    await Promise.allSettled(active.map((run) => run.completion));
  }
}
