import type { ApiResponse, ChatMessage, SessionDetail, SessionSummary } from "./contracts.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import type { MemoryIndexEntry } from "../memory.ts";

/** 获取必需的页面元素，缺失时明确报错而不是继续访问空引用。 */
function element<T extends HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`页面元素缺失：${selector}`);
  return result;
}

const ui = {
  sidebar: element<HTMLElement>(".sidebar"), inspector: element<HTMLElement>(".inspector"),
  sessions: element<HTMLElement>("#sessions"), title: element<HTMLElement>("#session-title"),
  prompt: element<HTMLTextAreaElement>("#prompt"), send: element<HTMLButtonElement>("#send"), stop: element<HTMLButtonElement>("#stop"),
  messages: element<HTMLElement>("#messages"), scroll: element<HTMLElement>("#conversation-scroll"), welcome: element<HTMLElement>("#welcome"),
  status: element<HTMLElement>("#run-status"), activity: element<HTMLElement>("#activity"), activityText: element<HTMLElement>("#activity-text"),
  todos: element<HTMLElement>("#todos"), todoCount: element<HTMLElement>("#todo-count"), todoProgress: element<HTMLElement>("#todo-progress"),
  progress: element<HTMLProgressElement>("#progress"), progressText: element<HTMLElement>("#todo-progress-text"),
  runPicker: element<HTMLSelectElement>("#run-picker"), traces: element<HTMLElement>("#traces"),
  user: element<HTMLSelectElement>("#user-select"), toast: element<HTMLElement>("#toast"), backdrop: element<HTMLButtonElement>("#backdrop"),
};
const query = new URLSearchParams(location.search);
const supportedUsers = ["user-A", "user-B", "local-user"];
let currentUser = query.get("user") ?? sessionStorage.getItem("agent-user") ?? "user-A";
if (!supportedUsers.includes(currentUser)) currentUser = "user-A";
let sessionId = "";
let detail: SessionDetail | null = null;
let sessions: readonly SessionSummary[] = [];
let selectedRunId = "";
let events: readonly JsonValue[] = [];
let sending = false;
let epoch = 0;
let pollTimer: number | undefined;
let toastTimer: number | undefined;
let messageSignature: string | null = null;
let thinkingEnabled = true;
let memories: readonly MemoryIndexEntry[] = [];
let memoryBusy = false;
const expanded = new Set<string>();
const statusLabels = { pending: "待运行", running: "运行中", completed: "完成", failed: "失败" };
const todoLabels = { pending: "等待", in_progress: "正在进行", completed: "已完成", failed: "失败" };

class RequestError extends Error {
  readonly status: number;
  /** 保留 HTTP 状态，便于区分失效会话和临时连接问题。 */
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** 请求同源本地 API，用户标识按窗口发送，响应只在这个边界转换为共享协议类型。 */
async function request(path: string, method = "GET", data?: JsonObject): Promise<ApiResponse> {
  const response = await fetch(path, {
    method, headers: { "X-User-Id": currentUser, ...(method === "GET" ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = JSON.parse(await response.text()) as ApiResponse;
  if (result === null || typeof result !== "object" || !("kind" in result)) throw new Error("服务返回了无法识别的响应");
  if (result.kind === "error") throw new RequestError(response.status, result.message);
  if (!response.ok) throw new RequestError(response.status, "请求未能完成");
  return result;
}

/** 统一处理界面动作的异步异常，并显示简短可见提示。 */
async function handle(action: () => Promise<void>): Promise<void> {
  try { await action(); }
  catch (error) { toast(error instanceof Error ? error.message : "操作失败，请重试"); }
}

/** 显示操作反馈，自动隐藏上一条提示的计时器。 */
function toast(message: string): void {
  window.clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  toastTimer = window.setTimeout(() => { ui.toast.hidden = true; }, 4500);
}

/** 用 DOM 文本创建元素，用户内容不会作为 HTML 执行。 */
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  result.textContent = text;
  return result;
}

/** 将 ISO 时间按中国时区显示为简短时间。 */
function time(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

/** 仅解析加粗标记，其余内容始终作为文本节点写入。 */
function inline(target: HTMLElement, text: string): void {
  for (const token of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    if (token.startsWith("**") && token.endsWith("**")) target.append(node("strong", "", token.slice(2, -2)));
    else if (token.startsWith("`") && token.endsWith("`")) target.append(node("code", "inline-code", token.slice(1, -1)));
    else target.append(document.createTextNode(token));
  }
}

/** 格式化真实 token 数，页面不按字符长度估算用量。 */
function count(value: number): string { return new Intl.NumberFormat("zh-CN").format(value); }

/** 将有效 JSON 缩进显示，无效工具参数仍按原文呈现。 */
function pretty(text: string): string {
  try { return JSON.stringify(JSON.parse(text) as JsonValue, null, 2); } catch { return text; }
}

/** 创建可折叠区块，并在轮询刷新后保留用户的展开选择。 */
function disclosure(className: string, title: string, key: string): HTMLDetailsElement {
  const block = node("details", className);
  block.open = expanded.has(key);
  block.append(node("summary", "", title));
  block.addEventListener("toggle", () => { if (block.open) expanded.add(key); else expanded.delete(key); });
  return block;
}

/** 显示模型返回的思考正文，与最终答案分开，并提供服务端思考 token 数。 */
function reasoning(text: string, key: string, tokens?: number): HTMLElement {
  const block = disclosure("reasoning-block", "✦ 思考过程", key);
  const summary = block.querySelector("summary");
  summary?.append(node("span", "reasoning-count", tokens === undefined ? `${count([...text].length)} 字符` : `${count(tokens)} tokens`));
  const body = markdown(text); body.classList.add("reasoning-body");
  block.append(body);
  return block;
}

/** 打开这条助手消息所属运行的执行面板，方便从工具卡片定位真实结果。 */
async function inspectRun(id: string, toolCallId?: string): Promise<void> {
  selectedRunId = id; events = []; ui.runPicker.value = id;
  selectTab("log"); renderEvents();
  if (window.innerWidth <= 940) { ui.inspector.classList.add("open"); ui.backdrop.hidden = false; }
  await loadEvents();
  if (selectedRunId !== id || toolCallId === undefined) return;
  const target = [...ui.traces.querySelectorAll<HTMLDetailsElement>(".trace-card")].find((card) => card.dataset.toolCallId === toolCallId);
  if (target) { target.open = true; target.scrollIntoView({ block: "nearest" }); }
}

/** 渲染助手的思考、工具请求和最终回答，所有模型文字只作为安全 DOM 内容。 */
function assistantBody(message: ChatMessage): HTMLElement {
  const body = node("div", "assistant-output");
  if (message.reasoningContent?.trim()) body.append(reasoning(message.reasoningContent, `message:${message.id}:reasoning`, message.usage?.reasoningTokens));
  for (const tool of message.toolCalls ?? []) {
    const card = disclosure("tool-request", `↳ ${tool.name}`, `message:${message.id}:tool:${tool.id}`);
    card.querySelector("summary")?.append(node("span", "tool-request-label", "工具调用"));
    card.append(node("div", "tool-request-id", `调用 ID · ${tool.id}`), node("pre", "structured-data", pretty(tool.arguments)));
    body.append(card);
  }
  if (message.toolCalls?.length) {
    const inspect = node("button", "inspect-run-link", "查看参数与执行结果 ↗");
    inspect.type = "button"; inspect.addEventListener("click", () => { void handle(() => inspectRun(message.runId, message.toolCalls?.[0]?.id)); });
    body.append(inspect);
  }
  if (message.content.trim()) {
    const answer = node("div", "answer-block");
    if (!message.toolCalls?.length) answer.append(node("div", "answer-label", "最终回答"));
    answer.append(markdown(message.content)); body.append(answer);
  }
  if (message.usage) {
    const usage = message.usage;
    body.append(node("div", "message-usage", `输入 ${count(usage.promptTokens)} · 输出 ${count(usage.completionTokens)}${usage.reasoningTokens === undefined ? "" : ` · 思考 ${count(usage.reasoningTokens)}`}${usage.cacheHitTokens === undefined ? "" : ` · 缓存 ${count(usage.cacheHitTokens)}`}`));
  }
  return body;
}

/** 把 Markdown 表格的一行拆为纯文本单元格。 */
function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

/** 渲染基础段落、标题、列表和代码块，不解析任意 HTML 或执行脚本。 */
function markdown(text: string): HTMLElement {
  const body = node("div", "message-body");
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.startsWith("```")) {
      const code: string[] = [];
      while (++index < lines.length && !lines[index]?.startsWith("```")) code.push(lines[index] ?? "");
      body.append(node("pre", "", code.join("\n")));
    } else if (line.trim().startsWith("|") && /^\s*\|?[\s:|-]+\|\s*$/.test(lines[index + 1] ?? "")) {
      const wrapper = node("div", "markdown-table"); const table = node("table");
      const head = node("thead"); const heading = node("tr");
      for (const text of tableCells(line)) { const cell = node("th"); inline(cell, text); heading.append(cell); }
      head.append(heading); table.append(head);
      const rows = node("tbody"); index += 2;
      while (index < lines.length && lines[index]?.trim().startsWith("|")) {
        const row = node("tr");
        for (const text of tableCells(lines[index] ?? "")) { const cell = node("td"); inline(cell, text); row.append(cell); }
        rows.append(row); index++;
      }
      index--; table.append(rows); wrapper.append(table); body.append(wrapper);
    } else if (/^\s*---+\s*$/.test(line)) {
      body.append(node("hr"));
    } else if (/^#{1,6}\s/.test(line)) {
      const heading = node("h3"); inline(heading, line.replace(/^#{1,6}\s+/, "")); body.append(heading);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const list = node(/^\s*\d+\./.test(line) ? "ol" : "ul");
      let next = line;
      while (/^\s*([-*]|\d+\.)\s+/.test(next)) {
        const item = node("li"); inline(item, next.replace(/^\s*([-*]|\d+\.)\s+/, "")); list.append(item);
        next = lines[++index] ?? "";
      }
      index--;
      body.append(list);
    } else if (line.trim()) {
      const paragraph = node("p"); inline(paragraph, line); body.append(paragraph);
    }
  }
  return body;
}

/** 创建空列表的说明，不使用不可交互的装饰按钮。 */
function empty(title: string, description: string, icon = "☷"): HTMLElement {
  const block = node("div", "empty-state");
  block.append(node("span", "empty-icon", icon), node("strong", "", title), node("p", "", description));
  return block;
}

/** 按当前窗口选中的会话渲染侧栏，其他窗口没有共享选中状态。 */
function renderSessions(): void {
  ui.sessions.replaceChildren();
  element("#session-count").textContent = String(sessions.length);
  if (!sessions.length) ui.sessions.append(node("p", "sidebar-empty", "新建会话，开始第一项任务"));
  for (const session of sessions) {
    const button = node("button", `session-item${session.id === sessionId ? " selected" : ""}`);
    button.title = session.title;
    button.setAttribute("aria-label", `打开会话：${session.title}`);
    if (session.id === sessionId) button.setAttribute("aria-current", "page");
    const title = node("div", "session-title");
    title.append(node("span", session.activeRun ? "session-indicator" : "session-symbol", session.activeRun ? "" : "◫"), node("span", "", session.title));
    button.append(title, node("div", "session-preview", session.preview));
    button.addEventListener("click", () => { void handle(() => loadSession(session.id)); });
    ui.sessions.append(button);
  }
}

/** 获取当前用户的最新会话列表，忽略切换用户前发出的迟到响应。 */
async function refreshSessions(): Promise<void> {
  const user = currentUser;
  const result = await request("/api/sessions");
  if (user !== currentUser) return;
  if (result.kind !== "sessions") throw new Error("会话列表响应无效");
  sessions = result.sessions;
  renderSessions();
}

/** 根据消息变化更新聊天区，保留用户正在阅读历史记录时的滚动位置。 */
function renderMessages(): void {
  if (!detail) return;
  const signature = JSON.stringify(detail.messages);
  ui.welcome.hidden = detail.messages.length > 0;
  if (signature === messageSignature) return;
  const nearBottom = ui.scroll.scrollHeight - ui.scroll.clientHeight - ui.scroll.scrollTop < 100;
  const first = messageSignature === null;
  messageSignature = signature;
  ui.messages.replaceChildren();
  for (const message of detail.messages) {
    const item = node("article", `message ${message.role}`);
    const avatar = node("div", "message-avatar", message.role === "user" ? "你" : "A");
    const content = node("div", "message-content");
    const meta = node("div", "message-meta");
    meta.append(node("strong", "", message.role === "user" ? "你" : "Agent"));
    if (message.role === "assistant") meta.append(node("span", "message-stage", message.toolCalls?.length ? "执行步骤" : "回答"));
    meta.append(node("time", "", time(message.createdAt)));
    content.append(meta, message.role === "assistant" ? assistantBody(message) : node("div", "message-body", message.content));
    item.append(avatar, content);
    ui.messages.append(item);
  }
  if (nearBottom || first) ui.scroll.scrollTop = ui.scroll.scrollHeight;
}

/** 显示 AI 维护的四状态清单，失败原因可见，完成后不自动清空。 */
function renderTodos(): void {
  const todos = detail?.todos ?? [];
  ui.todoCount.textContent = String(todos.length);
  ui.todoProgress.hidden = todos.length === 0;
  ui.progress.max = Math.max(1, todos.length);
  ui.progress.value = todos.filter((todo) => todo.status === "completed").length;
  ui.progressText.textContent = `${ui.progress.value} / ${todos.length}`;
  ui.todos.replaceChildren();
  if (!todos.length) ui.todos.append(empty("还没有待办计划", "把复杂任务交给 Agent，计划会显示在这里。"));
  for (const todo of todos) {
    const item = node("div", `todo-item ${todo.status}`);
    item.append(node("span", "todo-icon", todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "•" : todo.status === "failed" ? "×" : ""));
    const content = node("div");
    content.append(node("p", "todo-content", todo.content), node("div", "todo-state", todoLabels[todo.status]));
    if (todo.error) content.append(node("div", "todo-error", todo.error));
    item.append(content); ui.todos.append(item);
  }
}

/** 显示当前用户共享的长期记忆索引，与当前 session 的任务清单分开。 */
function renderMemories(): void {
  const target = element("#memory-list"); target.replaceChildren();
  element("#memory-count").textContent = String(memories.length);
  element("#memory-owner").textContent = `${currentUser === "user-A" ? "用户 A" : currentUser === "user-B" ? "用户 B" : "本地用户"} 的记忆库 · 跨会话共享`;
  element<HTMLButtonElement>("#memory-organize").disabled = memoryBusy || sending || Boolean(detail?.session.activeRun) || !memories.length;
  element("#memory-index-preview").textContent = JSON.stringify(memories.filter((item) => item.id !== "preferences"), null, 2);
  if (!memories.length) target.append(empty("还没有长期记忆", "手动添加，或在聊天中明确告诉 Agent“记住这件事”。", "◈"));
  for (const memory of memories) {
    const card = node("button", "memory-card"); card.type = "button";
    const heading = node("span", "memory-card-heading");
    heading.append(node("strong", "", memory.name), node("span", "memory-time", memory.timeLabel));
    card.append(heading, node("span", "memory-card-summary", memory.summary), node("code", "memory-card-id", memory.id === "preferences" ? "preferences · 常驻偏好" : memory.id));
    card.setAttribute("aria-label", `查看记忆：${memory.name}`);
    card.addEventListener("click", () => { void handle(() => editMemory(memory.id)); });
    target.append(card);
  }
}

/** 按用户请求最新索引，迟到响应不能覆盖切换用户或会话后的页面。 */
async function refreshMemories(version = epoch): Promise<void> {
  const user = currentUser;
  const result = await request("/api/memories");
  if (version !== epoch || user !== currentUser) return;
  if (result.kind !== "memories") throw new Error("记忆索引响应无效");
  memories = result.items; renderMemories();
}

/** 打开单条完整 Markdown 记忆，不根据索引简介伪造正文。 */
async function editMemory(id: string): Promise<void> {
  const version = epoch; const user = currentUser;
  const result = await request(`/api/memories/${encodeURIComponent(id)}`);
  if (version !== epoch || user !== currentUser) return;
  if (result.kind !== "memory") throw new Error("记忆正文响应无效");
  openMemoryEditor(result.memory.id, result.memory.name, result.memory.summary, result.memory.content, true);
}

/** 打开创建或编辑表单，固定现有 ID，避免误把改名变成重复创建。 */
function openMemoryEditor(id = "", name = "", summary = "", content = "", existing = false): void {
  const input = element<HTMLInputElement>("#memory-id"); input.value = id; input.readOnly = existing;
  element<HTMLInputElement>("#memory-name").value = name;
  element<HTMLTextAreaElement>("#memory-summary").value = summary;
  const body = element<HTMLTextAreaElement>("#memory-content"); body.value = content; body.maxLength = id === "preferences" ? 4000 : 20000;
  element("#memory-editor").hidden = false;
  element<HTMLButtonElement>("#memory-delete").hidden = !existing;
  element("#memory-editor-title").textContent = existing ? "编辑记忆" : id === "preferences" ? "添加常驻偏好" : "添加记忆";
  element<HTMLInputElement>("#memory-name").focus();
}

/** 收起表单，编辑中的内容不会被自动保存进记忆库。 */
function closeMemoryEditor(): void { element("#memory-editor").hidden = true; }

/** 保存一条用户明确编辑的记忆，时间由服务端生成，下一轮输入加载新快照。 */
async function saveMemory(): Promise<void> {
  if (memoryBusy) return;
  const version = epoch; const user = currentUser;
  const payload = {
    operation: "upsert", id: element<HTMLInputElement>("#memory-id").value.trim(), name: element<HTMLInputElement>("#memory-name").value.trim(),
    summary: element<HTMLTextAreaElement>("#memory-summary").value.trim(), content: element<HTMLTextAreaElement>("#memory-content").value,
  };
  memoryBusy = true; element<HTMLButtonElement>("#memory-save").disabled = true;
  try {
    const result = await request("/api/memories", "POST", payload);
    if (version !== epoch || user !== currentUser) return;
    if (result.kind !== "memory") throw new Error("保存记忆响应无效");
    closeMemoryEditor(); await refreshMemories(version); toast("已保存，下一轮输入会加载新的记忆快照");
  } finally { memoryBusy = false; element<HTMLButtonElement>("#memory-save").disabled = false; renderMemories(); }
}

/** 用户确认后删除当前记录；聊天历史和其他记忆不随之删除。 */
async function deleteMemory(): Promise<void> {
  if (memoryBusy) return;
  const id = element<HTMLInputElement>("#memory-id").value;
  if (!window.confirm("删除这条长期记忆？删除后不能通过本页面恢复。")) return;
  const version = epoch; const user = currentUser;
  memoryBusy = true;
  try {
    const result = await request("/api/memories", "POST", { operation: "delete", id });
    if (version !== epoch || user !== currentUser) return;
    if (result.kind !== "memory_deleted") throw new Error("删除记忆响应无效");
    closeMemoryEditor(); await refreshMemories(version); toast("已删除这条长期记忆");
  } finally { memoryBusy = false; renderMemories(); }
}

/** 将手动整理作为当前会话的一次普通运行，保留工具轨迹、预算和取消入口。 */
async function organizeMemories(): Promise<void> {
  if (!detail || sending || detail.session.activeRun || !memories.length) return;
  const id = sessionId; const version = epoch;
  sending = true; render();
  try {
    const result = await request(`/api/sessions/${encodeURIComponent(id)}/memory-organize`, "POST", {});
    if (version !== epoch || id !== sessionId) return;
    if (result.kind !== "started") throw new Error("整理记忆响应无效");
    await loadSession(id); selectTab("memory"); await refreshSessions();
  } finally { sending = false; render(); }
}

/** 从 JSON 日志中安全地读取对象，非对象数据不参与工具轨迹聚合。 */
function object(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** 渲染每次模型调用的思考和错误，摘要调用与正常任务决策使用不同标签。 */
function renderModelEvents(): void {
  const target = element("#model-traces"); target.replaceChildren();
  const groups = new Map<number, JsonObject[]>();
  const totals = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cacheHitTokens: 0 };
  let hasUsage = false, hasReasoning = false;
  for (const value of events) {
    const entry = object(value);
    if (!entry || typeof entry.event !== "string" || !entry.event.startsWith("model.") || typeof entry.modelCallNo !== "number") continue;
    const group = groups.get(entry.modelCallNo) ?? []; group.push(entry); groups.set(entry.modelCallNo, group);
    if (entry.event !== "model.succeeded") continue;
    const usage = object(object(entry.data)?.usage);
    if (!usage) continue;
    hasUsage = true; hasReasoning ||= typeof usage.reasoningTokens === "number";
    for (const key of ["promptTokens", "completionTokens", "reasoningTokens", "cacheHitTokens"] as const) if (typeof usage[key] === "number") totals[key] += usage[key];
  }
  element("#usage-input").textContent = hasUsage ? count(totals.promptTokens) : "—";
  element("#usage-output").textContent = hasUsage ? count(totals.completionTokens) : "—";
  element("#usage-reasoning").textContent = hasReasoning ? count(totals.reasoningTokens) : "—";
  element("#usage-cache").textContent = hasUsage ? count(totals.cacheHitTokens) : "—";
  for (const [number, group] of groups) {
    const first = group[0]; const last = group.at(-1); if (!first || !last) continue;
    const payload = object(last.data); const request = object(first.data);
    const done = last.event === "model.succeeded", failed = last.event === "model.failed";
    const card = node("div", `model-step${failed ? " failed" : ""}`);
    const heading = node("div", "model-step-heading");
    heading.append(node("span", "step-number", String(number)), node("strong", "", request?.purpose === "summary" ? "压缩历史" : "模型决策"), node("span", `trace-state${failed ? " bad" : ""}`, done ? "完成" : failed ? "失败" : "思考中"));
    card.append(heading);
    if (typeof payload?.reasoningContent === "string" && payload.reasoningContent.trim()) card.append(reasoning(payload.reasoningContent, `model:${selectedRunId}:${number}`, typeof object(payload.usage)?.reasoningTokens === "number" ? Number(object(payload.usage)?.reasoningTokens) : undefined));
    if (failed) card.append(node("p", "execution-error", typeof payload?.error === "string" ? payload.error : "模型请求失败"));
    if (done) {
      const tools = Array.isArray(payload?.toolCalls) ? payload.toolCalls.length : 0;
      card.append(node("div", "model-step-result", tools ? `决定调用 ${tools} 个工具` : request?.purpose === "summary" ? "历史摘要已生成" : "已生成最终回答"));
    }
    target.append(card);
  }
  if (!groups.size) target.append(empty("思考步骤会显示在这里", "每轮决策的思考、工具选择和真实用量都会保留。", "✦"));
}

/** 依次显示本次执行的工具请求、结果和关联 ID，并保留完整原始事件。 */
function renderEvents(): void {
  const run = detail?.runs.find((item) => item.id === selectedRunId);
  element("#metric-model").textContent = String(run?.metrics.modelCalls ?? 0);
  element("#metric-tool").textContent = String(run?.metrics.actualExecutions ?? 0);
  element("#metric-error").textContent = String((run?.metrics.toolFailed ?? 0) + (run?.metrics.toolRejected ?? 0));
  const groups = new Map<string, JsonObject[]>();
  for (const value of events) {
    const event = object(value);
    if (!event || typeof event.invocationId !== "string" || event.event === "todos.updated") continue;
    const group = groups.get(event.invocationId) ?? [];
    group.push(event); groups.set(event.invocationId, group);
  }
  ui.traces.replaceChildren();
  if (!groups.size) ui.traces.append(empty(run ? "这一轮还没有工具调用" : "执行过程会记录在这里", "每次调用都保留参数、结果、耗时和 ID。", "↳"));
  for (const group of groups.values()) {
    const first = group[0]; const last = group.at(-1);
    if (!first || !last) continue;
    const card = disclosure("trace-card", "", `tool:${String(first.invocationId)}`);
    card.dataset.toolCallId = String(first.toolCallId);
    const summary = card.querySelector("summary"); if (!summary) continue;
    const event = last.event;
    const label = event === "tool.succeeded" ? "成功" : event === "tool.failed" ? "失败" : event === "tool.rejected" ? "已拒绝" : event === "tool.started" ? "执行中" : "等待执行";
    summary.append(node("span", "", `${first.toolCallNo ?? ""}`), node("strong", "", typeof first.toolName === "string" ? first.toolName : "tool"), node("span", `trace-state${event === "tool.failed" || event === "tool.rejected" ? " bad" : ""}`, label));
    if (typeof last.durationMs === "number") summary.append(node("span", "trace-duration", `${Math.round(last.durationMs)} ms`));
    const content = node("div", "trace-body");
    const requestData = object(first.data); const resultData = object(last.data);
    content.append(node("div", "trace-section-label", "调用参数"), node("pre", "structured-data", typeof requestData?.arguments === "string" ? pretty(requestData.arguments) : "尚无参数"));
    if (typeof resultData?.ok === "boolean") content.append(node("div", `trace-section-label${resultData.ok ? "" : " bad"}`, resultData.ok ? "执行结果" : "错误反馈"), node("pre", "structured-data", JSON.stringify(resultData.ok ? resultData.result : resultData.error, null, 2)));
    content.append(node("div", "trace-identifiers", `tool_call_id: ${String(first.toolCallId)}\ninvocation_id: ${String(first.invocationId)}\n模型调用: #${String(first.modelCallNo)} · 工具请求: #${String(first.toolCallNo)}`));
    card.append(content); ui.traces.append(card);
  }
  renderModelEvents();
  element("#raw-log-content").textContent = JSON.stringify(events, null, 2);
  const latest = events.map(object).filter((entry) => entry !== null).at(-1);
  if (detail?.session.activeRun) ui.activityText.textContent = latest?.toolName ? `正在执行 ${String(latest.toolName)}…` : latest?.event === "tokens.started" ? "正在核算上下文…" : object(latest?.data)?.purpose === "summary" ? "正在压缩历史，保留重要信息…" : thinkingEnabled ? "DeepSeek 正在深度思考，完成后显示过程…" : "Agent 正在决定下一步…";
}

/** 更新运行选择器和发送状态，后台运行不会阻止切换到另一个会话。 */
function render(): void {
  if (!detail) { ui.send.disabled = true; ui.prompt.disabled = true; return; }
  ui.title.textContent = detail.session.title;
  document.title = `${detail.session.title} · Agent 工作台`;
  element("#session-label").textContent = `会话 ${detail.session.id.slice(0, 8)}`;
  const active = detail.session.activeRun;
  const latest = detail.runs[0];
  const status = active?.status ?? latest?.status ?? "pending";
  const error = element("#run-error"); error.hidden = status !== "failed";
  error.textContent = status === "failed" ? latest?.error ?? "本轮执行失败，可以继续对话。" : "";
  ui.status.className = `status-badge ${status}`;
  ui.status.replaceChildren(node("span"), document.createTextNode(statusLabels[status]));
  ui.activity.hidden = !active && !sending;
  ui.stop.hidden = !active;
  ui.send.hidden = Boolean(active);
  ui.prompt.disabled = sending || Boolean(active);
  ui.send.disabled = sending || !ui.prompt.value.trim();
  ui.runPicker.replaceChildren();
  if (!detail.runs.length) ui.runPicker.append(new Option("尚无执行记录", ""));
  for (let index = 0; index < detail.runs.length; index++) {
    const run = detail.runs[index];
    if (run) ui.runPicker.append(new Option(`第 ${detail.runs.length - index} 轮 · ${time(run.startedAt)} · ${statusLabels[run.status]}`, run.id));
  }
  if (!detail.runs.some((run) => run.id === selectedRunId)) selectedRunId = latest?.id ?? "";
  ui.runPicker.value = selectedRunId;
  renderMessages(); renderTodos(); renderEvents(); renderMemories();
}

/** 获取所选运行的完整日志，并忽略已切换会话或执行记录后的响应。 */
async function loadEvents(version = epoch): Promise<void> {
  const id = selectedRunId; const session = sessionId;
  if (!id) { events = []; renderEvents(); return; }
  const result = await request(`/api/sessions/${encodeURIComponent(session)}/runs/${encodeURIComponent(id)}/events`);
  if (version !== epoch || id !== selectedRunId || session !== sessionId) return;
  if (result.kind !== "events") throw new Error("执行日志响应无效");
  events = result.events; renderEvents();
}

/** 活跃会话每隔片刻恢复页面状态，刷新页面也能重新跟随尚在执行的任务。 */
function schedulePoll(): void {
  window.clearTimeout(pollTimer);
  if (!detail?.session.activeRun) return;
  const version = epoch; const id = sessionId;
  pollTimer = window.setTimeout(() => {
    void handle(async () => {
      const result = await request(`/api/sessions/${encodeURIComponent(id)}`);
      if (version !== epoch || id !== sessionId) return;
      if (result.kind !== "session") throw new Error("会话响应无效");
      detail = result.detail; render();
      await Promise.all([loadEvents(version), refreshMemories(version)]); await refreshSessions(); schedulePoll();
    });
  }, 650);
}

/** 将选中状态保存在当前标签页及 URL，避免不同窗口互相覆盖。 */
function remember(): void {
  sessionStorage.setItem("agent-user", currentUser);
  sessionStorage.setItem(`agent-session:${currentUser}`, sessionId);
  history.replaceState(null, "", `/?user=${encodeURIComponent(currentUser)}&session=${encodeURIComponent(sessionId)}`);
}

/** 从数据库恢复指定会话的消息、待办与运行，不依赖浏览器缓存拼接历史。 */
async function loadSession(id: string): Promise<void> {
  const version = ++epoch;
  window.clearTimeout(pollTimer);
  detail = null; render();
  sessionId = id; events = []; selectedRunId = ""; messageSignature = null; closeMemoryEditor();
  const result = await request(`/api/sessions/${encodeURIComponent(id)}`);
  if (version !== epoch) return;
  if (result.kind !== "session") throw new Error("会话响应无效");
  detail = result.detail; selectedRunId = detail.runs[0]?.id ?? "";
  remember(); renderSessions(); render(); closePanels();
  await Promise.all([loadEvents(version), refreshMemories(version)]); schedulePoll();
  if (!detail.session.activeRun) ui.prompt.focus();
}

/** 新建会话只改变当前窗口；没有 URL 或标签页记录的新窗口也走这个入口。 */
async function newSession(): Promise<void> {
  const result = await request("/api/sessions", "POST", {});
  if (result.kind !== "session") throw new Error("新建会话失败");
  ui.prompt.value = "";
  await loadSession(result.detail.session.id); await refreshSessions();
}

/** 将用户消息交给后台执行，页面立即显示用户输入并持续恢复执行进度。 */
async function send(): Promise<void> {
  const content = ui.prompt.value.trim();
  if (!content || sending || !detail || detail.session.activeRun) return;
  const id = sessionId; const version = epoch;
  sending = true; render();
  try {
    const started = await request(`/api/sessions/${encodeURIComponent(id)}/messages`, "POST", { content });
    if (version !== epoch) return;
    if (started.kind !== "started") throw new Error("消息提交失败");
    ui.prompt.value = ""; selectedRunId = started.run.id;
    const result = await request(`/api/sessions/${encodeURIComponent(id)}`);
    if (version !== epoch) return;
    if (result.kind !== "session") throw new Error("会话响应无效");
    detail = result.detail; events = []; render();
    ui.scroll.scrollTop = ui.scroll.scrollHeight;
    await refreshSessions(); await loadEvents(version); schedulePoll();
  } finally { sending = false; render(); }
}

/** 取消当前会话的活跃运行，其他窗口中的任务继续执行。 */
async function stop(): Promise<void> {
  const run = detail?.session.activeRun;
  if (!run) return;
  await request(`/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(run.id)}/cancel`, "POST", {});
  ui.activityText.textContent = "正在停止当前任务…";
  schedulePoll();
}

/** 在窄屏上关闭侧栏和检查面板。 */
function closePanels(): void {
  ui.sidebar.classList.remove("open"); ui.inspector.classList.remove("open"); ui.backdrop.hidden = true;
}

/** 切换计划和日志面板，更新无障碍选中状态。 */
function selectTab(tab: "todo" | "log" | "memory"): void {
  for (const name of ["todo", "log", "memory"]) {
    const selected = tab === name;
    const button = element(`#${name}-tab`);
    button.classList.toggle("selected", selected); button.setAttribute("aria-selected", String(selected));
    element(`#${name}-panel`).hidden = !selected;
  }
}

/** 加载本地配置与会话；新窗口默认创建独立会话，刷新则恢复 URL 中的会话。 */
async function boot(): Promise<void> {
  ui.user.value = currentUser;
  element("#user-avatar").textContent = currentUser === "user-B" ? "B" : currentUser === "user-A" ? "A" : "L";
  const config = await request("/api/config");
  if (config.kind === "config") {
    element("#model-name").textContent = config.model;
    thinkingEnabled = config.thinkingMode === "enabled";
    element("#thinking-mode").textContent = thinkingEnabled ? `✦ 深度思考 · ${config.reasoningEffort.toUpperCase()}` : "直接回答";
    element("#thinking-mode").classList.toggle("disabled", !thinkingEnabled);
  }
  await refreshSessions();
  const id = query.get("session") ?? sessionStorage.getItem(`agent-session:${currentUser}`);
  if (id) {
    try { await loadSession(id); }
    catch (error) { if (error instanceof RequestError && error.status === 404) await newSession(); else throw error; }
  } else await newSession();
}

element("#new-session").addEventListener("click", () => { void handle(newSession); });
element("#new-window").addEventListener("click", () => { window.open(`/?user=${encodeURIComponent(currentUser)}`, "_blank", "noopener"); });
element("#refresh").addEventListener("click", () => { void handle(async () => { if (sessionId) await loadSession(sessionId); else await boot(); await refreshSessions(); }); });
element<HTMLFormElement>("#composer").addEventListener("submit", (event) => { event.preventDefault(); void handle(send); });
ui.prompt.addEventListener("input", render);
ui.prompt.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void handle(send); } });
ui.stop.addEventListener("click", () => { void handle(stop); });
ui.runPicker.addEventListener("change", () => { selectedRunId = ui.runPicker.value; void handle(() => loadEvents()); });
element("#todo-tab").addEventListener("click", () => selectTab("todo"));
element("#log-tab").addEventListener("click", () => selectTab("log"));
element("#memory-tab").addEventListener("click", () => { selectTab("memory"); void handle(() => refreshMemories()); });
element("#memory-new").addEventListener("click", () => openMemoryEditor());
element("#memory-cancel").addEventListener("click", closeMemoryEditor);
element("#memory-delete").addEventListener("click", () => { void handle(deleteMemory); });
element("#memory-organize").addEventListener("click", () => { void handle(organizeMemories); });
element("#memory-preferences").addEventListener("click", () => { void handle(async () => {
  if (memories.some((item) => item.id === "preferences")) await editMemory("preferences");
  else openMemoryEditor("preferences", "回答偏好", "语言、格式与表达偏好", "");
}); });
element<HTMLFormElement>("#memory-form").addEventListener("submit", (event) => { event.preventDefault(); void handle(saveMemory); });
element("#menu-button").addEventListener("click", () => { ui.sidebar.classList.toggle("open"); ui.backdrop.hidden = !ui.sidebar.classList.contains("open"); });
element("#inspector-button").addEventListener("click", () => { ui.inspector.classList.toggle("open"); ui.backdrop.hidden = !ui.inspector.classList.contains("open"); });
element("#close-inspector").addEventListener("click", closePanels);
ui.backdrop.addEventListener("click", closePanels);
ui.user.addEventListener("change", () => { void handle(async () => {
  ++epoch; window.clearTimeout(pollTimer); currentUser = ui.user.value; sessionStorage.setItem("agent-user", currentUser);
  memories = []; closeMemoryEditor(); renderMemories();
  element("#user-avatar").textContent = currentUser === "user-B" ? "B" : currentUser === "user-A" ? "A" : "L";
  await newSession(); await refreshSessions();
}); });
for (const button of document.querySelectorAll<HTMLButtonElement>(".suggestion")) button.addEventListener("click", () => { ui.prompt.value = button.dataset.prompt ?? ""; render(); ui.prompt.focus(); });
render();
void handle(boot);
