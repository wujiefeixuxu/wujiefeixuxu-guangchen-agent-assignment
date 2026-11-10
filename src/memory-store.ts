import { memoryTimestamp, validateMemoryDraft, validateMemoryId, validateMemoryUser } from "./memory.ts";
import type { MemoryDraft, MemoryRecord } from "./memory.ts";
import { ToolError } from "./tool-errors.ts";

export interface MemoryStore {
  /** 列出当前用户的长期记忆，返回副本，不混入其他用户记录。 */
  listMemories(userId: string): MemoryRecord[];
  /** 按用户和 ID 读取单条完整记录；不存在时返回 null。 */
  getMemory(userId: string, id: string): MemoryRecord | null;
  /** 创建或更新单条记录；只改名称或简介时保留原信息时间。 */
  upsertMemory(userId: string, draft: MemoryDraft, recordedAt: string): MemoryRecord;
  /** 删除当前用户的一条记忆，不存在时明确报错。 */
  deleteMemory(userId: string, id: string): void;
}

export class InMemoryMemoryStore implements MemoryStore {
  readonly #records = new Map<string, MemoryRecord>();

  /** 返回当前用户的记录副本；这个后端供独立 Runtime 和测试使用。 */
  listMemories(userId: string): MemoryRecord[] {
    validateMemoryUser(userId);
    return [...this.#records.values()].filter((record) => record.userId === userId).map((record) => ({ ...record }));
  }

  /** 通过无歧义的用户、ID组合查询，拒绝通过 ID 读取其他用户记忆。 */
  getMemory(userId: string, id: string): MemoryRecord | null {
    validateMemoryUser(userId); validateMemoryId(id);
    const record = this.#records.get(JSON.stringify([userId, id]));
    return record ? { ...record } : null;
  }

  /** 校验后保存内容，读取和纯索引编辑不会把旧记忆刷成今天。 */
  upsertMemory(userId: string, draft: MemoryDraft, recordedAt: string): MemoryRecord {
    validateMemoryUser(userId); const valid = validateMemoryDraft(draft); const timestamp = memoryTimestamp(recordedAt);
    const previous = this.getMemory(userId, valid.id);
    const record = { ...valid, userId, recordedAt: previous?.content === valid.content ? previous.recordedAt : timestamp };
    this.#records.set(JSON.stringify([userId, valid.id]), record);
    return { ...record };
  }

  /** 删除当前用户记录，不改变其他用户的同名记忆。 */
  deleteMemory(userId: string, id: string): void {
    if (!this.getMemory(userId, id)) throw new ToolError("MEMORY_NOT_FOUND", "当前用户没有这条记忆", "id");
    this.#records.delete(JSON.stringify([userId, id]));
  }
}
