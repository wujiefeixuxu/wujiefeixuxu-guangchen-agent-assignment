import { assertKeys, numberField, stringField } from "../json.ts";
import { ToolError } from "../tool-errors.ts";
import type { Tool } from "../types.ts";
import { mockPages } from "./mock-pages.ts";
import { parseTodos, todoStatuses } from "../todos.ts";
import type { WriteTodosArgs, WriteTodosResult } from "../todos.ts";
import { ToolRegistry } from "./registry.ts";
import { parseMemoryWrite, validateMemoryId } from "../memory.ts";
import type { MemoryReadResult, MemoryWriteArgs, MemoryWriteResult } from "../memory.ts";

const operations = ["+", "-", "*", "/"] as const;
type Operation = (typeof operations)[number];
type CalculatorArgs = { a: number; b: number; operation: Operation };
type SearchArgs = { query: string; count: number };
type SearchResult = { mock: true; results: { title: string; url: string; snippet: string }[] };
type FetchArgs = { url: string };
type FetchResult = { mock: true; title: string; content: string };

/** 判断字符串是否为允许的四则运算符，并将其收窄为 Operation 类型。 */
function isOperation(value: string): value is Operation {
  return operations.some((operation) => operation === value);
}

export const calculatorTool: Tool<CalculatorArgs, number> = {
  name: "calculator",
  description: "计算两个数的加、减、乘、除。复杂计算可在获得结果后分多次调用。使用 JavaScript 双精度数字。",
  parameters: {
    type: "object",
    properties: {
      a: { type: "number", description: "第一个操作数" },
      b: { type: "number", description: "第二个操作数" },
      operation: { type: "string", enum: [...operations], description: "+ 加法，- 减法，* 乘法，/ 除法" },
    },
    required: ["a", "b", "operation"],
    additionalProperties: false,
  },
  /** 校验两个操作数及符号枚举，拒绝额外字段和 "12A" 等非法数字。 */
  parse(argumentsObject) {
    assertKeys(argumentsObject, ["a", "b", "operation"]);
    const a = numberField(argumentsObject, "a");
    const b = numberField(argumentsObject, "b");
    const operation = stringField(argumentsObject, "operation");
    if (!isOperation(operation)) {
      throw new ToolError("INVALID_OPERATION", "operation 只支持 +、-、*、/，请修正后重新调用", "operation");
    }
    return { a, b, operation };
  },
  /** 通过固定分支执行四则运算，除零和结果溢出时返回明确的工具异常。 */
  async execute({ a, b, operation }) {
    let result: number;
    switch (operation) {
      case "+": result = a + b; break;
      case "-": result = a - b; break;
      case "*": result = a * b; break;
      case "/":
        if (b === 0) throw new ToolError("DIVISION_BY_ZERO", "除数不能为零，请检查参数 b", "b");
        result = a / b;
        break;
    }
    if (!Number.isFinite(result)) {
      throw new ToolError("NUMERIC_OVERFLOW", "计算结果超出有限数字范围");
    }
    return result;
  },
};

export const searchTool: Tool<SearchArgs, SearchResult> = {
  name: "search",
  description: "按关键词搜索本地模拟网页，返回标题、链接和摘要。结果为 Mock 数据，不代表实时搜索。需要正文时调用 fetch。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词", minLength: 1, maxLength: 128 },
      count: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "最多返回多少条结果" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  /** 校验查询长度和结果数量，count 缺省为 10，合法范围为 1～50 的整数。 */
  parse(argumentsObject) {
    assertKeys(argumentsObject, ["query", "count"]);
    const query = stringField(argumentsObject, "query");
    if ([...query].length > 128) throw new ToolError("INVALID_ARGUMENT", "query 最多允许 128 个 Unicode 字符", "query");
    const count = argumentsObject.count === undefined ? 10 : numberField(argumentsObject, "count");
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new ToolError("INVALID_ARGUMENT", "count 必须是 1 到 50 之间的整数", "count");
    }
    return { query: query.trim(), count };
  },
  /** 在本地模拟资料中匹配全部查询词，按 count 截取结果并标记 mock。 */
  async execute({ query, count }) {
    const terms = query.toLowerCase().split(/\s+/);
    const results = mockPages.filter((page) => {
      const text = [page.title, page.content, ...page.keywords].join(" ").toLowerCase();
      return terms.every((term) => text.includes(term));
    }).slice(0, count).map(({ title, url, snippet }) => ({ title, url, snippet }));
    return { mock: true, results };
  },
};

export const fetchTool: Tool<FetchArgs, FetchResult> = {
  name: "fetch",
  description: "按 URL 读取本地模拟网页的标题和 Markdown 正文。只读取 Mock 资料，优先使用 search 返回的链接。",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "要读取的 HTTP 或 HTTPS 网页地址", minLength: 1, maxLength: 8192 } },
    required: ["url"],
    additionalProperties: false,
  },
  /** 校验网页地址长度、HTTP/HTTPS 协议和认证信息，返回规范化 URL。 */
  parse(argumentsObject) {
    assertKeys(argumentsObject, ["url"]);
    const text = stringField(argumentsObject, "url");
    if ([...text].length > 8192) throw new ToolError("INVALID_ARGUMENT", "url 最多允许 8192 个字符", "url");
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new ToolError("INVALID_ARGUMENT", "url 必须是有效的 HTTP 或 HTTPS 网页地址", "url");
    }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
      throw new ToolError("INVALID_ARGUMENT", "url 必须是带有主机名且不含用户名、密码的 HTTP 或 HTTPS 地址", "url");
    }
    return { url: url.href };
  },
  /** 按 URL 读取本地模拟正文；没有对应资料时抛出 MOCK_PAGE_NOT_FOUND。 */
  async execute({ url }) {
    const page = mockPages.find((item) => item.url === url);
    if (page === undefined) throw new ToolError("MOCK_PAGE_NOT_FOUND", "模拟资料中没有该网页，请使用 search 返回的链接", "url");
    return { mock: true, title: page.title, content: page.content };
  },
};

export const writeTodosTool: Tool<WriteTodosArgs, WriteTodosResult> = {
  name: "write_todos",
  description: "创建或更改当前 thread 的待办计划。每次提交完整 todos 数组并替换旧清单；状态由模型判断。failed 必须填写 error 原因，其他状态的 error 省略或为 null。todos=[] 表示清空。每轮模型回复最多调用一次。更新后继续执行或给出最终答复，不会自动结束任务。",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "当前完整待办列表，包含需要保留的所有事项及其最新状态",
        items: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1, description: "具体待办内容" },
            status: { type: "string", enum: [...todoStatuses], description: "等待、正在进行、完成、失败" },
            error: { type: ["string", "null"], description: "失败时必须提供非空原因；其他状态省略或设为 null" },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
  /** 校验完整清单的每项内容、四种状态和失败原因，拒绝身份及其他额外参数。 */
  parse(argumentsObject) {
    assertKeys(argumentsObject, ["todos"]);
    return { todos: parseTodos(argumentsObject.todos) };
  },
  /** 通过 Runtime 注入的上下文替换当前 thread 清单，并回传保存后的完整状态。 */
  async execute({ todos }, context) {
    return { todos: context.writeTodos(todos) };
  },
};

export const memoryReadTool: Tool<{ readonly id?: string }, MemoryReadResult> = {
  name: "memory_read",
  description: "读取当前用户已明确保存的长期记忆。不传id时返回最新索引，传id时返回完整Markdown正文。索引相关时先读取正文再回答。preferences为偏好记录。",
  parameters: { type: "object", properties: { id: { type: "string", description: "要读取的记忆ID；省略时列索引", maxLength: 64 } }, additionalProperties: false },
  /** 只接受可选的逻辑 ID，不接受用户身份、时间或主机文件路径。 */
  parse(args) { assertKeys(args, ["id"]); return args.id === undefined ? {} : { id: validateMemoryId(stringField(args, "id")) }; },
  /** 由运行时注入当前用户，从存储读取完整结果而非只重复本轮旧快照。 */
  async execute({ id }, context) { return context.readMemory(id); },
};

export const memoryWriteTool: Tool<MemoryWriteArgs, MemoryWriteResult> = {
  name: "memory_write",
  description: "用户明确要求记住、更正或忘记时管理长期记忆。upsert需提供id、name、summary、完整content；delete只提供id。只改一条记录，不整库覆盖。用户和准确时间由程序决定，偏好固定id为preferences。手动整理时保留旧时间和preferences，不能创造新ID；删除重复项前必须先upsert保留项，即使正文不变也要先保存。",
  parameters: {
    type: "object", properties: {
      operation: { type: "string", enum: ["upsert", "delete"] },
      id: { type: "string", description: "用户范围内唯一的稳定ID，如agent-project或preferences", maxLength: 64 },
      name: { type: "string", description: "记忆名称，upsert必填", maxLength: 100 },
      summary: { type: "string", description: "供索引使用的一句话简介，upsert必填", maxLength: 240 },
      content: { type: "string", description: "完整Markdown正文，upsert必填", maxLength: 20000 },
    }, required: ["operation", "id"], additionalProperties: false,
  },
  /** 根据操作枚举严格校验字段，日期与用户标识不能由模型伪造。 */
  parse(args) { return parseMemoryWrite(args); },
  /** 经运行时检查调用是否仍有效后，保存或删除并回传相对时间与完整结果。 */
  async execute(args, context) { return context.writeMemory(args); },
};

/** 将计算、模拟搜索、待办和两个长期记忆工具注册到同一个表。 */
export function createBuiltinTools(): ToolRegistry {
  return new ToolRegistry().register(calculatorTool).register(searchTool).register(fetchTool).register(writeTodosTool).register(memoryReadTool).register(memoryWriteTool);
}
