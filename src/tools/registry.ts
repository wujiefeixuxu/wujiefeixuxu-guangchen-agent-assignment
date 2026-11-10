import { errorMessage } from "../errors.ts";
import { withAbort } from "../abort.ts";
import type { PendingToolCall, RunContext } from "../execution.ts";
import { objectValue, parseJson } from "../json.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import { ToolError } from "../tool-errors.ts";
import type { Tool, ToolDefinition, ToolResult } from "../types.ts";

interface RegisteredTool extends ToolDefinition {
  /** 以通用 JSON 参数进入工具专属校验与执行流程，并保留调用上下文。 */
  invoke(args: JsonObject, pending: PendingToolCall, context: RunContext, signal: AbortSignal): Promise<JsonValue>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  /** 校验并注册唯一工具名称，用泛型封装该工具具体的参数校验和执行函数。 */
  register<TArgs, TResult extends JsonValue>(tool: Tool<TArgs, TResult>): this {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(tool.name)) {
      throw new Error("工具名称格式无效");
    }
    if (this.#tools.has(tool.name)) {
      throw new Error(`工具已注册：${tool.name}`);
    }
    this.#tools.set(tool.name, {
      name: tool.name, description: tool.description, parameters: tool.parameters,
      /** 先校验具体参数，再在真正进入执行函数时记数，并响应任务取消。 */
      async invoke(args, pending, context, signal) {
        const parsed = tool.parse(args);
        if (signal.aborted) throw new ToolError(context.interruption.code, context.interruption.message);
        return withAbort(() => {
          context.startTool(pending);
          return tool.execute(parsed, context.toolContext(pending, signal));
        }, signal);
      },
    });
    return this;
  }

  /** 提取供模型决策使用的名称、描述和 Schema，不暴露本地执行函数。 */
  definitions(): readonly ToolDefinition[] {
    return [...this.#tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  /** 查找工具、解析参数并执行，将成功结果或结构化错误与调用元数据一起返回。 */
  async execute(pending: PendingToolCall, context: RunContext, signal: AbortSignal): Promise<ToolResult> {
    const call = pending.call;
    try {
      if (signal.aborted) throw new ToolError(context.interruption.code, context.interruption.message);
      const tool = this.#tools.get(call.name);
      if (tool === undefined) throw new ToolError("TOOL_NOT_FOUND", `未注册的工具：${call.name}`);
      const argumentsObject = objectValue(parseJson(call.arguments), "工具参数");
      const result = await tool.invoke(argumentsObject, pending, context, signal);
      if (signal.aborted) throw new ToolError(context.interruption.code, context.interruption.message);
      return context.finishTool(pending, { ok: true, result });
    } catch (error) {
      // 可修正的工具错误写回对话，由模型决定下一步。
      const details = signal.aborted ? context.interruption : error instanceof ToolError
        ? error.details : { code: "TOOL_EXECUTION_FAILED" as const, message: errorMessage(error), field: null };
      return context.finishTool(pending, { ok: false, error: details });
    }
  }
}
