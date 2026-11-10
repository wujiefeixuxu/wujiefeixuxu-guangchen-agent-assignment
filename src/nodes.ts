import type { AgentState } from "./state.ts";
import type { PendingToolCall, RunContext } from "./execution.ts";
import type { Message, Model } from "./types.ts";
import type { ToolRegistry } from "./tools/registry.ts";

export interface NodeUpdate {
  readonly messages: readonly Message[];
  readonly pendingToolCalls: readonly PendingToolCall[];
  readonly finalAnswer: string | null;
}

export type AgentNode = (state: AgentState, signal: AbortSignal, context: RunContext) => Promise<NodeUpdate>;

/** 创建模型节点，将对话和工具 Schema 交给模型，并把回复转为待执行调用或最终回答。 */
export function createModelNode(model: Model, tools: ToolRegistry): AgentNode {
  /** 执行一轮模型决策，同时记录输入、结果、错误和本轮工具请求。 */
  return async (state, signal, context) => {
    const prepared = await context.prepareInput(model, state.messages, tools.definitions(), signal);
    const reply = await context.invokeModel(model, prepared.input, signal);
    return {
      messages: [...prepared.messages, reply],
      pendingToolCalls: reply.toolCalls.map((call) => context.requestTool(call)),
      finalAnswer: reply.toolCalls.length === 0 ? reply.content : null,
    };
  };
}

/** 创建工具节点，按模型提供的顺序执行调用，并将各工具结果写回对话。 */
export function createToolsNode(tools: ToolRegistry): AgentNode {
  /** 消费当前待执行列表，保留模型原始调用 ID，完成后清空待执行列表。 */
  return async (state, signal, context) => {
    if (state.pendingToolCalls.length === 0) {
      throw new Error("工具节点没有待执行的工具调用");
    }
    const messages: Message[] = [...state.messages];
    const multipleTodoWrites = state.pendingToolCalls.filter((pending) => pending.call.name === "write_todos").length > 1;
    for (const pending of state.pendingToolCalls) {
      if (signal.aborted) throw new Error("任务已取消或执行超时");
      const call = pending.call;
      const result = multipleTodoWrites && call.name === "write_todos"
        ? context.finishTool(pending, { ok: false, error: {
          code: "MULTIPLE_TODO_WRITES", message: "同一轮最多调用一次 write_todos，请合并为一份完整清单后重试", field: "todos",
        } })
        : await tools.execute(pending, context, signal);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(result),
      });
    }
    return { messages, pendingToolCalls: [], finalAnswer: null };
  };
}
