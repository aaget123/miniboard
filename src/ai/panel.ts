import type { Board } from "../board/canvas";
import type { ToolRegistry } from "../board/registry";
import type { Toolbar } from "../ui/toolbar";
import { loadConfig, isConfigReady } from "./config";
import { chatTurn } from "./client";
import { buildSystemPrompt } from "./prompts";
import {
  compressImageDataURL,
  describeCanvas,
  executeTool,
  toOpenAiTools,
  toolsForMode,
} from "./tools";
import { iconHTML } from "../ui/icons";
import type { ElementData } from "../types";
import type {
  AiContentPart,
  AiMode,
  AiToolExecution,
  ChatMessage,
} from "./types";
import { LS_CHAT_PREFIX, sanitizeForStorage, textOf } from "./history";

const MAX_TOOL_ROUNDS = 4;
/** 对话历史 token 预算（含系统提示词）：超限时从头部压缩，保证最近上下文完整 */
const MAX_HISTORY_TOKENS = 8000;
/** 单条消息 token 上限：超限截断（主要针对画布 JSON 等大内容） */
const MAX_MSG_TOKENS = 4000;
/** 图片片段的固定 token 估算（1280px JPEG 视觉 token 的保守值，因模型而异） */
const IMAGE_TOKENS = 1200;
/** @ 选区附带单图：图片数量上限与压缩后最长边（px），控制 token 与流量 */
const MAX_AT_IMAGES = 3;
const IMAGE_SEND_MAX_SIDE = 1024;

// ---------- 对话持久化（按 项目×模式 分桶存储，切换模式/刷新/换项目不丢） ----------

/** 一个模式分桶的对话状态：切换模式时整体保存/恢复，互不清空 */
type HistoryState = {
  history: ChatMessage[];
  historyTokens: number;
  systemTokens: number;
  compressNotified: boolean;
  pendingAt: ElementData[] | null;
  inputText: string;
};

function emptyHistoryState(): HistoryState {
  return {
    history: [],
    historyTokens: 0,
    systemTokens: 0,
    compressNotified: false,
    pendingAt: null,
    inputText: "",
  };
}

/** 工具名 → 面板回执显示名 */
const TOOL_LABELS: Record<string, string> = {
  get_canvas: "查看画布",
  read_image: "读取图片",
  draw_flowchart: "画流程图",
  update_elements: "优化元素",
  list_tools: "查看功能区",
  add_tool: "添加工具",
  update_tool: "修改工具",
  remove_tool: "删除工具",
};

// ---------- 轻量 markdown 渲染 ----------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 粗略 token 估算：中文/全角字符按 1 token，其余按 4 字符/token；
 * 图片片段按固定 IMAGE_TOKENS 计（视觉模型图片计价因模型而异，取保守值）。
 */
function estimateTokens(content: string | AiContentPart[] | null): number {
  if (content === null) {
    return 0;
  }
  if (typeof content === "string" && content.startsWith("data:image/")) {
    // 图片 dataURL 按固定值估算（按字符数会虚高数十倍）
    return IMAGE_TOKENS;
  }
  if (Array.isArray(content)) {
    return content.reduce(
      (n, part) => n + (part.type === "text" ? estimateTokens(part.text) : IMAGE_TOKENS),
      0,
    );
  }
  let zh = 0;
  let other = 0;
  for (const ch of content) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) {
      zh++;
    } else {
      other++;
    }
  }
  return zh + Math.ceil(other / 4);
}

/**
 * 超长消息截断：保留开头并尽量保持 JSON 结构完整（数组/对象补闭合括号），
 * 避免画布数据被拦腰截断成非法 JSON，造成模型理解混乱。
 */
function trimLongString(s: string, maxTokens: number): string {
  if (s.includes("data:image/")) {
    // 图片 dataURL 不可截断（截断会破坏图片），token 已按固定值估算
    return s;
  }
  const tokens = estimateTokens(s);
  if (tokens <= maxTokens) {
    return s;
  }
  const keep = Math.floor((s.length * maxTokens) / tokens);
  const cut = s.slice(0, keep);
  const isArray = cut.trimStart().startsWith("[") && s.trimEnd().endsWith("]");
  const isObject = cut.trimStart().startsWith("{") && s.trimEnd().endsWith("}");
  if (isArray || isObject) {
    const close = isArray ? "]" : "}";
    // 从截断点向前回溯最近的完整对象/值闭合点（上限 50 次尝试），补闭合括号
    const from = Math.max(0, cut.length - 500);
    let attempts = 0;
    for (let i = cut.length - 1; i >= from && attempts < 50; i--) {
      if (cut[i] !== "}") {
        continue;
      }
      attempts++;
      const cand = cut.slice(0, i + 1) + close;
      try {
        JSON.parse(cand);
        return `${cand}\n…（内容过长已截断）`;
      } catch {
        // 该处不是完整边界，继续向前回溯
      }
    }
  }
  return `${cut}\n…（内容过长已截断）`;
}

function renderInline(text: string): string {
  let t = escapeHtml(text);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const lines = t.split("\n");
  let out = "";
  let inList = false;
  for (const line of lines) {
    const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (m) {
      if (!inList) {
        out += '<ul class="ai-list">';
        inList = true;
      }
      out += `<li>${m[1]}</li>`;
    } else {
      if (inList) {
        out += "</ul>";
        inList = false;
      }
      if (line.trim()) {
        out += `<p>${line}</p>`;
      }
    }
  }
  if (inList) {
    out += "</ul>";
  }
  return out;
}

function renderMarkdown(text: string): string {
  let html = "";
  const blocks = text.split(/```/);
  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      // 代码块：去掉首行语言标记
      const code = block.replace(/^[a-zA-Z]+\n/, "");
      html += `<pre class="ai-code">${escapeHtml(code)}</pre>`;
    } else {
      html += renderInline(block);
    }
  });
  return html;
}

// ---------- 面板 ----------

export class AiPanel {
  private panel: HTMLElement;
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private atBtn!: HTMLButtonElement;
  private mode: AiMode = "chat";
  private busy = false;
  /** 当前请求的取消句柄：生成中点击“停止”中断（请求随后抛 AbortError） */
  private abortCtrl: AbortController | null = null;
  /** 每个模式独立的对话分桶：切换模式时整体保存/恢复，互不清空 */
  private modeHistories: Record<AiMode, HistoryState> = {
    chat: emptyHistoryState(),
    edit: emptyHistoryState(),
  };
  /** 当前激活项目 id（对话按 项目×模式 持久化），由 main.ts 在项目切换时更新 */
  private projectId = "";
  /** 存档防抖定时器（历史变化 500ms 后落盘） */
  private persistTimer = 0;
  private modeTabs = new Map<AiMode, HTMLButtonElement>();
  /** 清除对话按钮 */
  private clearBtn!: HTMLButtonElement;

  /** 当前模式分桶的便捷访问（所有对话状态读写统一走这里） */
  private get st(): HistoryState {
    return this.modeHistories[this.mode];
  }

  constructor(
    private board: Board,
    private registry: ToolRegistry,
    private toolbar: Toolbar,
    /** 打开设置弹窗（☰ 文件与工具 → ⚙，配置缺失时自动唤起） */
    private onOpenSettings: () => void,
  ) {
    this.panel = document.getElementById("ai-panel") as HTMLElement;
    this.messagesEl = document.getElementById("ai-messages") as HTMLElement;
    this.inputEl = document.getElementById("ai-input") as HTMLTextAreaElement;
    this.sendBtn = document.getElementById("ai-send-btn") as HTMLButtonElement;
    this.atBtn = document.getElementById("ai-at-btn") as HTMLButtonElement;
    this.clearBtn = document.getElementById("ai-clear-btn") as HTMLButtonElement;
    this.clearBtn.innerHTML = iconHTML("trash", 13);
    this.clearBtn.addEventListener("click", () => this.clearConversation());
    // 复制最后回复 / 重试最后一次请求（动态插入头部，免改 index.html）
    const headerBtn = document.createElement("button");
    headerBtn.className = this.clearBtn.className;
    headerBtn.type = "button";
    headerBtn.innerHTML = iconHTML("clipboard", 13);
    headerBtn.title = "复制最后回复";
    headerBtn.addEventListener("click", () => {
      const last = [...this.st.history]
        .reverse()
        .find((m) => m.role === "assistant");
      const text =
        typeof last?.content === "string" && last.content ? last.content : "";
      if (!text) {
        headerBtn.title = "暂无可复制的回复";
        return;
      }
      void navigator.clipboard.writeText(text).then(() => {
        headerBtn.title = "已复制 ✓";
      });
    });
    const retryBtn = document.createElement("button");
    retryBtn.className = this.clearBtn.className;
    retryBtn.type = "button";
    retryBtn.innerHTML = iconHTML("rotate", 13);
    retryBtn.title = "重试最后一次请求（多模态附件不会重发）";
    retryBtn.addEventListener("click", () => this.retryLast());
    this.clearBtn.parentElement?.insertBefore(headerBtn, this.clearBtn);
    this.clearBtn.parentElement?.insertBefore(retryBtn, this.clearBtn);
    this.bindEvents();
    // 输入草稿实时同步到当前分桶（切换模式/持久化时一并带走）
    this.inputEl.addEventListener("input", () => {
      this.st.inputText = this.inputEl.value;
    });
    this.restoreConversation();
  }

  get isOpen() {
    return !this.panel.hidden;
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    this.panel.hidden = false;
    this.inputEl.focus();
  }

  close() {
    this.panel.hidden = true;
  }

  // ---------- 事件 ----------

  private bindEvents() {
    document
      .querySelectorAll<HTMLButtonElement>(".ai-mode-tab")
      .forEach((btn) => {
        const mode = btn.dataset.mode as AiMode;
        this.modeTabs.set(mode, btn);
        btn.addEventListener("click", () => this.setMode(mode));
      });
    document
      .getElementById("ai-close-btn")!
      .addEventListener("click", () => this.close());
    this.sendBtn.addEventListener("click", () => {
      if (this.busy) {
        // 生成中：按钮变为“停止”，中断当前请求
        this.abortCtrl?.abort();
        return;
      }
      this.send();
    });
    this.atBtn.addEventListener("click", () => this.toggleAt());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });
  }

  private setMode(mode: AiMode) {
    if (this.busy || mode === this.mode) {
      return;
    }
    // 切换模式不再清空对话：先落盘当前桶，再切换指针并渲染目标桶（含输入草稿与 @ 选区）
    this.persistNow();
    this.mode = mode;
    for (const [m, btn] of this.modeTabs) {
      btn.classList.toggle("active", m === mode);
    }
    this.renderConversation();
  }

  private modeHint(mode: AiMode): string {
    return mode === "chat"
      ? "交流模式：我能通过画布数据看到画布上的内容，可以评价、给建议，并把你的想法画成流程图。"
      : "编辑模式：告诉我你想添加/修改的绘制工具（如五角星、云朵、高亮笔、点击即生成的印章），我会按统一功能规则直接加到工具栏，并自动验证、试画效果。";
  }

  /** 清除当前对话：清空当前模式分桶的历史与消息列表，仅保留模式引导（不影响画布内容） */
  private clearConversation() {
    this.modeHistories[this.mode] = emptyHistoryState();
    this.inputEl.value = "";
    this.renderConversation();
    this.schedulePersist();
  }

  /**
   * 重试最后一次请求：回退到最近一条 user 消息之前并原样重发
   * （多模态消息的图片附件不重发，仅文本部分；生成中忽略）。
   */
  private retryLast() {
    if (this.busy) {
      return;
    }
    const h = this.st.history;
    let lastUser = -1;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].role === "user") {
        lastUser = i;
        break;
      }
    }
    if (lastUser === -1) {
      return;
    }
    const msg = h[lastUser];
    const text =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content
              .filter((p) => p.type === "text")
              .map((p) => ("text" in p ? p.text : ""))
              .join("\n")
          : "";
    if (!text.trim() && !Array.isArray(msg.content)) {
      return;
    }
    this.st.history = h.slice(0, lastUser);
    this.inputEl.value = text;
    this.st.inputText = text;
    this.renderConversation();
    void this.send();
  }

  // ---------- 对话持久化（按 项目×模式 分桶存档） ----------

  /** 当前模式分桶的存档键 */
  private storageKey(): string {
    return `${LS_CHAT_PREFIX}${this.projectId || "default"}:${this.mode}`;
  }

  /** 历史变化后防抖落盘（清空对话同样落盘为空，避免旧存档复活） */
  private schedulePersist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => this.persistNow(), 500);
  }

  /**
   * 落盘前的压缩：工具调用轮次不存原始请求/结果，替换为一行摘要
   * （［工具调用：create_elements、get_canvas］），恢复后模型仍能知道
   * "之前做过什么"，不再因刷新而完全失忆；图片数据照旧不落盘。
   */
  private compactForStorage(msgs: ChatMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const m of msgs) {
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const names = m.tool_calls.map(
          (c) => c.function?.name ?? "?",
        );
        out.push({
          role: "assistant",
          content: `［工具调用：${names.join("、")}］`,
        });
        continue;
      }
      if (m.role === "tool") {
        continue;
      }
      out.push(m);
    }
    return out;
  }

  /** 立即落盘当前分桶：治理后仅存 user/assistant 文本轮次（工具轮压缩为摘要） */
  private persistNow() {
    clearTimeout(this.persistTimer);
    try {
      const cleaned = sanitizeForStorage(this.compactForStorage(this.st.history));
      if (!cleaned.length) {
        localStorage.removeItem(this.storageKey());
      } else {
        localStorage.setItem(
          this.storageKey(),
          JSON.stringify({ history: cleaned }),
        );
      }
    } catch {
      // localStorage 不可用时忽略持久化（对话仍在内存中）
    }
  }

  /** 从存档恢复当前分桶（启动与切项目时调用）；无存档时仅显示引导 */
  private restoreConversation() {
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (raw) {
        const parsed = JSON.parse(raw) as { history?: unknown };
        if (Array.isArray(parsed.history)) {
          const cleaned = sanitizeForStorage(
            parsed.history.filter(
              (m): m is ChatMessage =>
                !!m &&
                typeof m === "object" &&
                ((m as ChatMessage).role === "user" ||
                  (m as ChatMessage).role === "assistant"),
            ),
          );
          this.st.history = cleaned;
          this.st.historyTokens = cleaned.reduce(
            (n, m) => n + estimateTokens(m.content),
            0,
          );
        }
      }
    } catch {
      // 存档损坏：从空对话开始
    }
    this.renderConversation();
  }

  /** 按当前分桶重绘消息列表：引导提示 + 历史消息 + 恢复标注（@ 按钮态与输入草稿同步） */
  private renderConversation() {
    const st = this.st;
    this.messagesEl.innerHTML = "";
    this.appendSystem(this.modeHint(this.mode));
    const restored = st.history.length > 0;
    for (const m of st.history) {
      if (m.role === "user") {
        this.appendUser(textOf(m.content));
      } else if (m.role === "assistant" && m.content) {
        this.appendAi(textOf(m.content));
      }
      // tool 轮次仅存在于内存（不落盘、不重渲染），跳过
    }
    if (restored) {
      this.appendSystem("已恢复上次对话；画布数据可能已变化，AI 会按需重新查看。");
    }
    this.atBtn.classList.toggle("active", !!st.pendingAt);
    this.inputEl.value = st.inputText;
  }

  /**
   * 切换当前项目：先把当前分桶落盘到旧项目键，再从新项目键恢复对应分桶。
   * 由 main.ts 在项目切换/启动恢复时调用，保证对话随项目走。
   */
  setProject(projectId: string) {
    if (projectId === this.projectId) {
      return;
    }
    this.persistNow();
    this.projectId = projectId || "";
    this.restoreConversation();
  }

  // ---------- 消息渲染 ----------

  private scrollBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private appendSystem(text: string) {
    const el = document.createElement("div");
    el.className = "ai-msg ai-system";
    el.textContent = text;
    this.messagesEl.appendChild(el);
    this.scrollBottom();
  }

  private appendUser(text: string) {
    const el = document.createElement("div");
    el.className = "ai-msg ai-user";
    const inner = document.createElement("div");
    inner.className = "ai-bubble";
    inner.textContent = text;
    el.appendChild(inner);
    this.messagesEl.appendChild(el);
    this.scrollBottom();
  }

  private appendAi(text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "ai-msg ai-assistant";
    const inner = document.createElement("div");
    inner.className = "ai-bubble";
    inner.innerHTML = renderMarkdown(text || "…");
    el.appendChild(inner);
    this.messagesEl.appendChild(el);
    this.scrollBottom();
    return inner;
  }

  private renderBubble(bubble: HTMLElement, text: string) {
    bubble.innerHTML = renderMarkdown(text || "…");
  }

  private appendError(text: string) {
    const el = document.createElement("div");
    el.className = "ai-msg ai-error";
    el.textContent = text;
    this.messagesEl.appendChild(el);
    this.scrollBottom();
  }

  /** 工具执行回执：功能区工具操作显示工具卡片（图标+名称+分组/快捷键徽章），其余保持居中灰条 */
  private renderToolReceipt(exec: AiToolExecution) {
    const el = document.createElement("div");
    el.className = "ai-msg ai-receipt";
    const isToolCard =
      exec.tool && !exec.result.startsWith("错误：") && exec.name !== "list_tools";
    if (isToolCard) {
      el.classList.add("tool-card");
      const titleMap: Record<string, string> = {
        add_tool: "已添加工具",
        update_tool: "已修改工具",
        remove_tool: "已删除工具",
      };
      const icon = document.createElement("span");
      icon.className = "tool-card-icon";
      icon.textContent = exec.tool!.icon;
      const info = document.createElement("span");
      info.className = "tool-card-info";
      const title = document.createElement("span");
      title.className = "tool-card-title";
      title.textContent = `${titleMap[exec.name] ?? TOOL_LABELS[exec.name] ?? exec.name}：${exec.tool!.name}`;
      const badges = document.createElement("span");
      badges.className = "tool-card-badges";
      if (exec.tool!.group) {
        const g = document.createElement("span");
        g.className = "tool-badge";
        g.textContent =
          exec.tool!.group === "shape"
            ? "形状▾"
            : exec.tool!.group === "ai"
              ? "AI 工具▾"
              : exec.tool!.group;
        badges.appendChild(g);
      }
      if (exec.tool!.shortcut) {
        const s = document.createElement("span");
        s.className = "tool-badge key-badge";
        s.textContent = `快捷键 ${exec.tool!.shortcut.toUpperCase()}`;
        badges.appendChild(s);
      }
      info.append(title, badges);
      el.append(icon, info);
    } else {
      const label = TOOL_LABELS[exec.name] ?? exec.name;
      // 读图结果含图片 dataURL：面板不展示 base64，仅保留说明前缀
      const shown = exec.result.includes("data:image/")
        ? exec.result.slice(0, exec.result.indexOf("data:image/")) +
          "[图片数据已发送给模型]"
        : exec.result;
      el.textContent = `${label}：${shown}`;
    }
    this.messagesEl.appendChild(el);
    this.scrollBottom();
  }

  private setBusy(busy: boolean) {
    this.busy = busy;
    this.sendBtn.classList.toggle("stop", busy);
    this.sendBtn.textContent = busy ? "停止" : "发送";
    this.sendBtn.title = busy ? "停止生成（已输出的内容会保留）" : "发送";
    this.inputEl.disabled = busy;
    if (!busy) {
      this.abortCtrl = null;
    }
  }

  // ---------- @ 选区 ----------

  private clearAt() {
    this.st.pendingAt = null;
    this.atBtn.classList.remove("active");
  }

  /** @ 按钮：抓取画布当前选区，再次点击取消 */
  private toggleAt() {
    if (this.st.pendingAt) {
      this.clearAt();
      return;
    }
    const data = this.board.getSelectionData();
    if (!data.length) {
      this.appendError("请先在画布上选中一些元素，再点击 @");
      return;
    }
    this.st.pendingAt = data;
    this.atBtn.classList.add("active");
    this.appendSystem(
      `已 @ ${data.length} 个元素：${data
        .map((d) => d.id)
        .join("、")}。发送后 AI 将重点分析并优化它们。`,
    );
  }

  // ---------- 发送流程 ----------

  private pushHistory(msg: ChatMessage) {
    this.st.history.push(msg);
    this.st.historyTokens += estimateTokens(msg.content);
    // 单条超长截断（画布 JSON 等）：保留开头并尽量保持 JSON 结构完整
    if (typeof msg.content === "string") {
      const trimmed = trimLongString(msg.content, MAX_MSG_TOKENS);
      if (trimmed !== msg.content) {
        this.st.historyTokens -= estimateTokens(msg.content) - estimateTokens(trimmed);
        msg.content = trimmed;
      }
    }
    // 超预算：优先从头丢弃完整的历史轮次（user 及其配套的 assistant/tool 消息），
    // 整轮不拆散，避免破坏 assistant(tool_calls) 与 tool 消息的配对；至少保留最近 1 轮
    while (this.st.historyTokens + this.st.systemTokens > MAX_HISTORY_TOKENS) {
      if (this.st.history.filter((m) => m.role === "user").length <= 1) {
        // 仅剩当前轮：压缩较早的 get_canvas 大结果，无法再压缩才停止
        if (!this.shrinkCanvasData()) {
          break;
        }
        continue;
      }
      if (!this.dropFirstTurn()) {
        break;
      }
    }
    if (this.st.historyTokens + this.st.systemTokens > MAX_HISTORY_TOKENS && !this.st.compressNotified) {
      this.st.compressNotified = true;
      this.appendSystem("对话较长，较早的内容已按长度自动压缩，AI 可能不清楚最早的信息。");
    }
    this.schedulePersist();
  }

  /**
   * 仅剩当前轮仍超预算时：把较早的 get_canvas 工具结果替换为占位说明，释放 token。
   * 从历史头部开始替换（最旧优先），保留最近一次画布数据供模型继续引用。
   */
  private shrinkCanvasData(): boolean {
    let changed = false;
    for (let i = 0; i < this.st.history.length; i++) {
      const m = this.st.history[i];
      if (m.role !== "tool" || typeof m.content !== "string") {
        continue;
      }
      // 图片型工具结果（read_image 的 dataURL）：替换为占位释放 token
      if (m.content.includes("data:image/")) {
        const before = estimateTokens(m.content);
        m.content = "（图片数据已省略，如需再次查看请重新调用 read_image）";
        this.st.historyTokens -= before - estimateTokens(m.content);
        changed = true;
        if (this.st.historyTokens + this.st.systemTokens <= MAX_HISTORY_TOKENS) {
          break;
        }
        continue;
      }
      if (!m.content.startsWith("当前画布元素数据")) {
        continue;
      }
      const before = estimateTokens(m.content);
      m.content = "（画布数据已省略，如需最新内容请重新调用 get_canvas）";
      this.st.historyTokens -= before - estimateTokens(m.content);
      changed = true;
      if (this.st.historyTokens + this.st.systemTokens <= MAX_HISTORY_TOKENS) {
        break;
      }
    }
    return changed;
  }

  /**
   * 丢弃最早的一轮对话：从头部到第二条 user 消息之前（含开头的残留工具消息）。
   * 以"轮"为单位保证 assistant(tool_calls) 与其 tool 消息不拆散。
   */
  private dropFirstTurn(): boolean {
    const firstUser = this.st.history.findIndex((m) => m.role === "user");
    if (firstUser < 0) {
      // 极端残留：全是工具轮次消息（无 user 的非法序列），整体清空
      this.st.historyTokens = 0;
      this.st.history = [];
      return true;
    }
    // 轮次终点：下一条 user 消息之前；开头的非 user 残留（中断留下）一并丢弃
    let end = this.st.history.length;
    for (let i = firstUser + 1; i < this.st.history.length; i++) {
      if (this.st.history[i].role === "user") {
        end = i;
        break;
      }
    }
    const dropped = this.st.history.splice(0, end);
    for (const m of dropped) {
      this.st.historyTokens -= estimateTokens(m.content);
    }
    return dropped.length > 0;
  }

  private async send() {
    const text = this.inputEl.value.trim();
    if (!text || this.busy) {
      return;
    }
    const cfg = loadConfig();
    if (!isConfigReady(cfg)) {
      this.appendError("请先配置 AI 模型（接口地址 / API Key / 模型名）");
      this.onOpenSettings();
      return;
    }

    // 本轮请求取消句柄：中断后 catch 分支区分“停止”与真实失败
    this.abortCtrl = new AbortController();
    this.setBusy(true);
    this.inputEl.value = "";
    this.st.inputText = "";
    // 记录发送前历史长度：失败时回滚本轮写入，避免残留未配对的工具轮次消息
    const historyLen = this.st.history.length;
    this.appendUser(text);
    // @ 选区上下文与用户文字合并为一条 user 消息（避免连续两条 user 消息语义割裂），
    // 选区数据为发送时快照，不随画布变化
    const atData = this.st.pendingAt;
    let userContent = text;
    if (atData?.length) {
      const ids = atData.map((d) => d.id).filter((v): v is string => !!v);
      userContent = `【@选区】使用者选中了 ${atData.length} 个元素，请重点针对它们评价与优化（可用 get_canvas 传 ids 复查，用 update_elements 修改它们；不要改动其他元素）：\n${describeCanvas(this.board, ids)}\n\n使用者的请求：${text}`;
      this.clearAt();
    } else {
      // 未 @ 但画布有选中：静默附带选中 id，让模型感知使用者当前关注的对象（不要求其改动）
      const selIds = this.board
        .getSelectionData()
        .map((d) => d.id)
        .filter((v): v is string => !!v);
      if (selIds.length) {
        userContent = `【当前画布选中】使用者当前选中了 ${selIds.length} 个元素（id：${selIds.join("、")}），回答时可参考这些元素，但除非使用者明确要求，不要改动它们。\n\n使用者的请求：${text}`;
      }
    }
    this.pushHistory({ role: "user", content: userContent });

    // 多模态：开启视觉时随消息附带图像（发送时快照；失败静默降级纯文本）。
    // 优先级：@ 选区含图片 → 附带压缩后的单图（比整画布截图清晰、省 token，两种模式可用）；
    // 否则交流模式附带整画布截图供理解整体布局
    if (cfg.multimodal === true) {
      const atImages = (atData ?? []).filter(
        (d): d is ElementData & { url: string } =>
          d.type === "image" && !!d.url,
      );
      if (atImages.length) {
        const parts: AiContentPart[] = [{ type: "text", text: userContent }];
        const attached: string[] = [];
        for (const img of atImages.slice(0, MAX_AT_IMAGES)) {
          const shot = await compressImageDataURL(img.url, IMAGE_SEND_MAX_SIDE);
          if (!shot) {
            continue;
          }
          parts.push({ type: "image_url", image_url: { url: shot } });
          attached.push(
            `- id=${img.id}：${Math.round(img.width ?? 0)}x${Math.round(img.height ?? 0)}px${img.rotation ? `（画布上旋转 ${Math.round(img.rotation)}°）` : ""}`,
          );
        }
        // 至少一张图压缩成功才切换为多模态消息；图片清单写入文本供模型建立 id↔图映射
        if (attached.length) {
          const extra =
            atImages.length > MAX_AT_IMAGES
              ? `\n（其余 ${atImages.length - MAX_AT_IMAGES} 张未附带，可用 read_image 工具按 id 查看）`
              : "";
          parts[0] = {
            type: "text",
            text: userContent +
              `\n\n随本消息附带画布中以下图片的实际内容（请直接看图）：\n${attached.join("\n")}${extra}`,
          };
          const msg = this.st.history[this.st.history.length - 1];
          this.st.historyTokens +=
            estimateTokens(parts) - estimateTokens(msg.content as string);
          msg.content = parts;
        }
      } else if (this.mode === "chat") {
        try {
          // 视口渲染截图：模型看到"使用者当前看到的画面"（含手绘风格与缩放观感），
          // 附世界坐标范围便于与 get_canvas 数据对齐；导出失败时降级为内容包围盒截图
          let shot: { url: string; viewport: { minX: number; minY: number; maxX: number; maxY: number; scale: number } | null } | null = null;
          const vpShot = await this.board.exportViewportImage(1024);
          if (vpShot) {
            shot = vpShot;
          } else {
            const url = await this.board.exportImage(1024);
            if (url) {
              shot = { url, viewport: null };
            }
          }
          if (shot) {
            const vp = shot.viewport;
            const rangeNote = vp
              ? `（世界坐标范围 x ${Math.round(vp.minX)}~${Math.round(vp.maxX)}，y ${Math.round(vp.minY)}~${Math.round(vp.maxY)}，缩放 ${Math.round(vp.scale * 100)}%；坐标系：左上角原点、y 轴向下、单位 px）`
              : "（按画布内容包围盒截取）";
            this.st.history[this.st.history.length - 1].content = [
              {
                type: "text",
                text:
                  userContent +
                  `\n\n随本消息附带当前视口渲染截图${rangeNote}。截图反映渲染观感（含手绘风格），文字等具体数据请以 get_canvas 返回的结构化 JSON 为准。`,
              },
              { type: "image_url", image_url: { url: shot.url } },
            ];
            this.st.historyTokens += IMAGE_TOKENS;
          }
        } catch {
          // 截图失败：降级为纯文本
        }
      }
    }

    const mode = this.mode;
    const system: ChatMessage = {
      role: "system",
      content: buildSystemPrompt(mode),
    };
    // 系统提示词计入 token 预算（压缩时与 historyTokens 一并判断）
    this.st.systemTokens = estimateTokens(system.content);
    const openAiTools = toOpenAiTools(toolsForMode(mode));

    const bubble = this.appendAi("");
    let fullText = "";
    let canvasChanged = false;
    // 画布改动合并为一步历史：执行前快照，整轮工具结束后统一提交
    const before = this.board.serialize();
    // 发送时快照：检测对话期间画布被外部修改（工具执行或使用者手动编辑），提示模型数据可能过期
    const beforeJson = JSON.stringify(before);
    let staleNotified = false;
    // 提交函数在正常结束与失败时共用：失败时已执行的修改同样保留可撤销
    const commitCanvasChange = () => {
      if (canvasChanged) {
        const after = this.board.serialize();
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          this.board.pushSnapshot(before);
          this.board.pushSnapshot(after);
        }
      }
    };

    try {
      let exhausted = false;
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        // 画布在对话期间被外部修改（工具执行或使用者手动编辑）：提示模型最新数据需重新获取
        if (!staleNotified && JSON.stringify(this.board.serialize()) !== beforeJson) {
          staleNotified = true;
          this.pushHistory({
            role: "user",
            content:
              "注意：画布内容在对话期间发生了变化（可能是工具执行或使用者手动编辑导致），如需准确数据请重新调用 get_canvas。",
          });
        }
        const res = await chatTurn(cfg, [system, ...this.st.history], openAiTools, {
          onText: (delta) => {
            fullText += delta;
            this.renderBubble(bubble, fullText);
            this.scrollBottom();
          },
        }, this.abortCtrl.signal);
        if (!res.toolCalls.length) {
          if (res.text) {
            this.pushHistory({ role: "assistant", content: res.text });
          }
          break;
        }
        // 工具调用轮次：执行并把结果回填给模型
        this.pushHistory({
          role: "assistant",
          content: res.text || null,
          tool_calls: res.toolCalls,
        });
        for (const call of res.toolCalls) {
          const tool = toolsForMode(mode).find(
            (t) => t.name === call.function.name,
          );
          const exec = tool
            ? await executeTool(tool, call.function.arguments, {
                board: this.board,
                registry: this.registry,
                toolbar: this.toolbar,
                mode,
              })
            : {
                name: call.function.name,
                args: {},
                result: "错误：未知工具",
                changed: false,
              };
          if (exec.changed) {
            canvasChanged = true;
          }
          this.pushHistory({
            role: "tool",
            tool_call_id: call.id,
            content: exec.result,
          });
          this.renderToolReceipt(exec);
        }
        // 最后一轮仍请求了工具：标记轮数耗尽，循环结束后让模型收尾
        if (round === MAX_TOOL_ROUNDS - 1) {
          exhausted = true;
        }
      }
      // 轮数耗尽：追加"停止调用"指令，让模型基于已执行的结果总结（不带工具，防止再调用）
      if (exhausted) {
        this.pushHistory({
          role: "user",
          content:
            "工具调用轮次已达上限，请基于已执行的结果直接给出总结回答，不要再调用任何工具。",
        });
        const res = await chatTurn(cfg, [system, ...this.st.history], [], {
          onText: (delta) => {
            fullText += delta;
            this.renderBubble(bubble, fullText);
            this.scrollBottom();
          },
        }, this.abortCtrl.signal);
        if (res.text) {
          this.pushHistory({ role: "assistant", content: res.text });
        }
      }
      commitCanvasChange();
      if (!fullText) {
        this.renderBubble(bubble, "（本轮没有文本回复）");
      }
    } catch (err) {
      // 回滚本轮写入的历史：中断可能残留未配对的工具轮次消息，避免污染后续对话
      while (this.st.history.length > historyLen) {
        const popped = this.st.history.pop();
        if (popped) {
          this.st.historyTokens -= estimateTokens(popped.content);
        }
      }
      commitCanvasChange();
      this.renderBubble(bubble, fullText ? fullText : "");
      const stopped =
        err instanceof Error &&
        (err.name === "AbortError" || err.name === "TimeoutError");
      if (stopped) {
        this.appendError(fullText ? "已停止生成（已输出的内容保留）" : "已停止");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendError(`请求失败：${msg}`);
      }
    } finally {
      this.setBusy(false);
    }
  }
}
