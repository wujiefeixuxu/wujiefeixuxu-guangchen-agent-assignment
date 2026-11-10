import { createModelNode, createToolsNode } from "./nodes.ts";
import type { AgentNode } from "./nodes.ts";
import type { AgentState } from "./state.ts";
import type { Model, NodeId } from "./types.ts";
import type { ToolRegistry } from "./tools/registry.ts";

export const END = "end";
export type NextNode = NodeId | typeof END;
export type AgentEdge = (state: AgentState) => NextNode;

export interface AgentGraph {
  readonly entry: NodeId;
  readonly nodes: Readonly<Record<NodeId, AgentNode>>;
  readonly edges: Readonly<Record<NodeId, AgentEdge>>;
}

/** 组装 model、tools 两个节点及其路由规则，入口为 model，最终回答通向 END。 */
export function createAgentGraph(model: Model, tools: ToolRegistry): AgentGraph {
  return {
    entry: "model",
    nodes: {
      model: createModelNode(model, tools),
      tools: createToolsNode(tools),
    },
    edges: {
      /** 根据是否存在待执行工具，选择工具节点或流程出口。 */
      model: (state) => state.pendingToolCalls.length > 0 ? "tools" : END,
      /** 工具结果写回消息后，交由模型继续决策。 */
      tools: () => "model",
    },
  };
}
