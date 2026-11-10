import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { objectValue, parseJson } from "./json.ts";
import { ToolError } from "./tool-errors.ts";
import { cloneTodos, parseTodos } from "./todos.ts";
import type { TodoItem } from "./todos.ts";

export interface TodoOwner {
  readonly userId: string;
  readonly threadId: string;
}

export interface TodoStore {
  /** 读取当前用户和 thread 的完整清单，不存在时返回空数组。 */
  read(owner: TodoOwner): TodoItem[];
  /** 用完整新清单替换当前用户和 thread 的待办数据。 */
  write(owner: TodoOwner, todos: readonly TodoItem[]): void;
}

/** 使用无歧义的身份元组作为键，隔离同一用户的不同窗口及不同用户的同名窗口。 */
function ownerKey(owner: TodoOwner): string {
  return JSON.stringify([owner.userId, owner.threadId]);
}

export class MemoryTodoStore implements TodoStore {
  readonly #items = new Map<string, TodoItem[]>();

  /** 返回清单副本，避免多个运行实例共享可变的待办对象。 */
  read(owner: TodoOwner): TodoItem[] {
    return cloneTodos(this.#items.get(ownerKey(owner)) ?? []);
  }

  /** 校验并保存清单副本，确保替换操作不受调用方后续修改影响。 */
  write(owner: TodoOwner, todos: readonly TodoItem[]): void {
    this.#items.set(ownerKey(owner), parseTodos(cloneTodos(todos)));
  }
}

export class JsonTodoStore implements TodoStore {
  readonly #directory: string;

  /** 设置本地待办目录，实际读写时再创建目录和数据文件。 */
  constructor(directory: string) {
    if (!directory.trim()) throw new Error("待办数据目录不能为空");
    this.#directory = directory;
  }

  /** 读取并校验磁盘中的身份及完整清单；损坏的数据会报错，不会被空列表覆盖。 */
  read(owner: TodoOwner): TodoItem[] {
    const path = this.#path(owner);
    try {
      const saved = objectValue(parseJson(readFileSync(path, "utf8")), "待办存储");
      if (saved.userId !== owner.userId || saved.threadId !== owner.threadId) throw new Error("待办存储身份不匹配");
      return parseTodos(saved.todos);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw new ToolError("TODO_STORAGE_ERROR", "无法读取当前 thread 的待办数据，请检查数据文件是否损坏或不可访问");
    }
  }

  /** 先写同目录临时文件，再替换目标文件，保存完成状态并支持下一次进程加载。 */
  write(owner: TodoOwner, todos: readonly TodoItem[]): void {
    const next = parseTodos(cloneTodos(todos));
    const path = this.#path(owner);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(this.#directory, { recursive: true });
      writeFileSync(temporary, JSON.stringify({ userId: owner.userId, threadId: owner.threadId, todos: next, updatedAt: new Date().toISOString() }, null, 2), { encoding: "utf8", flag: "wx" });
      renameSync(temporary, path);
    } catch {
      if (existsSync(temporary)) {
        try { unlinkSync(temporary); } catch { /* 保留原始存储错误，临时文件不影响已有清单。 */ }
      }
      throw new ToolError("TODO_STORAGE_ERROR", "无法保存当前 thread 的待办数据，请检查目录写入权限");
    }
  }

  /** 将身份元组哈希为文件名，防止 thread 标识中的路径字符影响文件位置。 */
  #path(owner: TodoOwner): string {
    const digest = createHash("sha256").update(ownerKey(owner)).digest("hex");
    return join(this.#directory, `${digest}.todos.json`);
  }
}
