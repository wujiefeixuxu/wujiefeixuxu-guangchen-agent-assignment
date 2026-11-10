import type { RunMetrics } from "../execution.ts";
import type { JsonValue } from "../json.ts";
import type { Status } from "../state.ts";
import type { TodoItem } from "../todos.ts";
import type { ModelUsage, ToolCall } from "../types.ts";
import type { ReasoningEffort, ThinkingMode } from "../models/deepseek.ts";
import type { MemoryIndexEntry, MemoryView } from "../memory.ts";

export interface RunSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly status: Status;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly metrics: RunMetrics;
}

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly preview: string;
  readonly activeRun: RunSummary | null;
}

export interface ChatMessage {
  readonly id: number;
  readonly runId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: string;
  readonly reasoningContent?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly usage?: ModelUsage;
}

export interface SessionDetail {
  readonly session: SessionSummary;
  readonly messages: readonly ChatMessage[];
  readonly todos: readonly TodoItem[];
  readonly runs: readonly RunSummary[];
}

export type ApiResponse =
  | { readonly kind: "sessions"; readonly sessions: readonly SessionSummary[] }
  | { readonly kind: "session"; readonly detail: SessionDetail }
  | { readonly kind: "started"; readonly run: RunSummary }
  | { readonly kind: "events"; readonly run: RunSummary; readonly events: readonly JsonValue[] }
  | { readonly kind: "cancelled" }
  | { readonly kind: "memories"; readonly items: readonly MemoryIndexEntry[] }
  | { readonly kind: "memory"; readonly memory: MemoryView }
  | { readonly kind: "memory_deleted"; readonly id: string }
  | { readonly kind: "config"; readonly model: string; readonly storage: "SQLite"; readonly contextUnit: "tokens" | "characters"; readonly contextLimit: number; readonly maxModelCalls: number; readonly thinkingMode: ThinkingMode; readonly reasoningEffort: ReasoningEffort; readonly maxOutputTokens: number }
  | { readonly kind: "error"; readonly message: string };
