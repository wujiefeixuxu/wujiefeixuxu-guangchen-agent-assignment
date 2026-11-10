type MockPage = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly content: string;
  readonly keywords: readonly string[];
};

// 本地固定资料。search 和 fetch 共同读取，不包含任何联网兜底。
export const mockPages: readonly MockPage[] = [
  {
    title: "Node.js 入门教程（模拟资料）",
    url: "https://mock.example.test/nodejs",
    snippet: "模拟资料：Node.js 的用途、异步执行及内置能力。",
    keywords: ["node", "nodejs", "node.js", "javascript", "入门", "教程"],
    content: "# Node.js 入门教程（模拟资料）\n\n这是一份本地 Mock 文档。Node.js 可以运行 JavaScript，并通过内置模块提供 HTTP、文件和进程等能力。异步 I/O 适合等待网络或磁盘的任务。示例练习：先计算 12 × 3，再加 4。",
  },
  {
    title: "TypeScript 类型检查（模拟资料）",
    url: "https://mock.example.test/typescript",
    snippet: "模拟资料：使用 TypeScript 为 Node.js 项目添加类型检查。",
    keywords: ["typescript", "ts", "node.js", "类型", "教程"],
    content: "# TypeScript 类型检查（模拟资料）\n\n这是一份本地 Mock 文档。TypeScript 为 JavaScript 增加静态类型。Node.js 项目可以用 tsc --noEmit 单独检查类型。外部输入仍需要运行时校验。",
  },
  {
    title: "最小 Agent Loop（模拟资料）",
    url: "https://mock.example.test/agent",
    snippet: "模拟资料：用户输入、模型决策、工具执行和结果反馈的循环。",
    keywords: ["agent", "runtime", "loop", "工具", "智能体"],
    content: "# 最小 Agent Loop（模拟资料）\n\n接收用户输入后调用模型。模型可以直接回答，也可以发出工具调用。工具结果回传模型，再由模型决定继续调用或返回最终回答。Runtime 负责步数、超时和四种运行状态。",
  },
  {
    title: "上海天气示例（模拟资料）",
    url: "https://mock.example.test/shanghai-weather",
    snippet: "固定模拟天气：上海，晴，26°C。该数据不代表实时天气。",
    keywords: ["上海", "天气", "上海天气", "shanghai", "weather"],
    content: "# 上海天气示例（模拟资料）\n\n固定示例：上海，晴，26°C。此内容是本地测试数据，不是真实天气查询结果。",
  },
];
