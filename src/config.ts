import type { DeepSeekOptions, ReasoningEffort, ThinkingMode } from "./models/deepseek.ts";
import type { RuntimeOptions } from "./runtime.ts";
import { join } from "node:path";

export interface AgentConfig {
  readonly model: DeepSeekOptions;
  readonly runtime: RuntimeOptions;
  readonly logDirectory: string;
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly webPort: number;
}

/** 读取指定环境变量中的正整数；缺省使用 fallback，格式或计时范围不合法时抛错。 */
function integerSetting(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} 必须是正整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(`${name} 超出有效范围`);
  }
  return value;
}

/** 从环境变量构建模型、Runtime 和日志配置，并提前检查密钥及执行限制。 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("请在环境变量或本地 .env 中设置 DEEPSEEK_API_KEY");
  const dataDirectory = env.AGENT_DATA_DIR?.trim() || ".agent-data";
  const webPort = integerSetting(env, "PORT", 3210);
  if (webPort > 65535) throw new Error("PORT 必须在 1 到 65535 之间");
  const contextUnit = env.AGENT_CONTEXT_UNIT?.trim() || "tokens";
  if (contextUnit !== "tokens" && contextUnit !== "characters") throw new Error("AGENT_CONTEXT_UNIT 只支持 tokens 或 characters");
  const thinkingMode = env.DEEPSEEK_THINKING?.trim() || "enabled";
  const reasoningEffort = env.DEEPSEEK_REASONING_EFFORT?.trim() || "max";
  if (thinkingMode !== "enabled" && thinkingMode !== "disabled") throw new Error("DEEPSEEK_THINKING 只支持 enabled 或 disabled");
  if (reasoningEffort !== "low" && reasoningEffort !== "high" && reasoningEffort !== "max") throw new Error("DEEPSEEK_REASONING_EFFORT 只支持 low、high 或 max");
  const maxOutputTokens = integerSetting(env, "DEEPSEEK_MAX_OUTPUT_TOKENS", 131_072);
  if (maxOutputTokens > 393_216) throw new Error("DEEPSEEK_MAX_OUTPUT_TOKENS 不能超过393216");
  return {
    logDirectory: env.AGENT_LOG_DIR?.trim() || "logs",
    dataDirectory,
    databasePath: env.AGENT_DB_PATH?.trim() || join(dataDirectory, "agent.sqlite"),
    webPort,
    model: {
      apiKey,
      baseUrl: env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
      model: env.DEEPSEEK_MODEL?.trim() || "deepseek-flash",
      timeoutMs: integerSetting(env, "DEEPSEEK_TIMEOUT_MS", 120_000),
      maxOutputTokens,
      thinkingMode: thinkingMode satisfies ThinkingMode,
      reasoningEffort: reasoningEffort satisfies ReasoningEffort,
    },
    runtime: {
      maxSteps: integerSetting(env, "AGENT_MAX_STEPS", 40),
      maxModelCalls: integerSetting(env, "AGENT_MAX_MODEL_CALLS", 20),
      context: {
        ...(contextUnit === "tokens" ? { maxTokens: integerSetting(env, "AGENT_CONTEXT_MAX_TOKENS", 100_000) } : { maxChars: integerSetting(env, "AGENT_CONTEXT_MAX_CHARS", 48_000) }),
        recentTurns: integerSetting(env, "AGENT_CONTEXT_RECENT_TURNS", 4),
      },
      timeoutMs: integerSetting(env, "AGENT_TIMEOUT_MS", 300_000),
    },
  };
}
