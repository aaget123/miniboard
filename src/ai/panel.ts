import type { Board } from "../board/canvas";
import type { ToolRegistry } from "../board/registry";
import type { Toolbar } from "../ui/toolbar";
import { loadConfig, isConfigReady } from "./config";
import { chatTurn } from "./client";
import { buildSystemPrompt } from "./prompts";
import { describeCanvas, executeTool, toOpenAiTools, toolsForMode } from "./tools";
import type { ElementData } from "../types";
import type {
  AiContentPart,
  AiMode,
  AiToolExecution,
  ChatMessage,
} from "./types";

const MAX_TOOL_ROUNDS = 4;
/** 对话历史 token 预算（含系统提示词）：超限时从头部压缩，保证最近上下文完整 */
const MAX_HISTORY_TOKENS = 8000;
/** 单条消息 token 上限：超限截断（主要针对画布 JSON 等大内容） */
const MAX_MSG_TOKENS = 4000;
/** 图片片段的固定 token 估算（1280px JPEG 视觉 token 的保守值，因模型而异） */
const IMAGE_TOKENS = 1200;

/** 工具名 → 面板回执显示名 */
const TOOL_LABELS: Record<string, string> = {
  get_canvas: "查看画布",
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
        return cand + "\n…（内容过长已截断）";
      } catch {
        // 该处不是完整边界，继续向前回溯
      }
    }
  }
  return cut + "\n…（内容过长已截断）";
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
  private history: ChatMessage[] = [];
  /** 历史总 token 估算（与 history 同步维护，用于超限压缩） */
  private historyTokens = 0;
  /** 当前系统提示词 token 估算（与 historyTokens 一并计入预算） */
  private systemTokens = 0;
  /** 压缩提示只展示一次，避免每次发送刷屏 */
  private compressNotified = false;
  private modeTabs = new Map<AiMode, HTMLButtonElement>();
  /** @ 选区：当前已选区（发送时注入对话上下文），null 表示未 @ */
  private pendingAt: ElementData[] | null = null;

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
    this.bindEvents();
    this.appendSystem(this.modeHint(this.mode));
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
    this.mode = mode;
    for (const [m, btn] of this.modeTabs) {
      btn.classList.toggle("active", m === mode);
    }
    this.history = [];
    this.historyTokens = 0;
    this.systemTokens = 0;
    this.compressNotified = false;
    this.clearAt();
    this.messagesEl.innerHTML = "";
    this.appendSystem(this.modeHint(mode));
  }

  private modeHint(mode: AiMode): string {
    return mode === "chat"
      ? "交流模式：我能通过画布数据看到画布上的内容，可以评价、给建议，并把你的想法画成流程图。"
      : "编辑模式：告诉我你想添加/修改的绘制工具（如五角星、云朵、高亮笔），我会按统一功能规则直接加到工具栏。";
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

  /** 工具执行回执：居中灰条（显示给用户的操作记录） */
  private renderToolReceipt(exec: AiToolExecution) {
    const el = document.createElement("div");
    el.className = "ai-msg ai-receipt";
    const label = TOOL_LABELS[exec.name] ?? exec.name;
    el.textContent = `${label}：${exec.result}`;
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
    this.pendingAt = null;
    this.atBtn.classList.remove("active");
  }

  /** @ 按钮：抓取画布当前选区，再次点击取消 */
  private toggleAt() {
    if (this.pendingAt) {
      this.clearAt();
      return;
    }
    const data = this.board.getSelectionData();
    if (!data.length) {
      this.appendError("请先在画布上选中一些元素，再点击 @");
      return;
    }
    this.pendingAt = data;
    this.atBtn.classList.add("active");
    this.appendSystem(
      `已 @ ${data.length} 个元素：${data
        .map((d) => d.id)
        .join("、")}。发送后 AI 将重点分析并优化它们。`,
    );
  }

  // ---------- 发送流程 ----------

  private pushHistory(msg: ChatMessage) {
    this.history.push(msg);
    this.historyTokens += estimateTokens(msg.content);
    // 单条超长截断（画布 JSON 等）：保留开头并尽量保持 JSON 结构完整
    if (typeof msg.content === "string") {
      const trimmed = trimLongString(msg.content, MAX_MSG_TOKENS);
      if (trimmed !== msg.content) {
        this.historyTokens -= estimateTokens(msg.content) - estimateTokens(trimmed);
        msg.content = trimmed;
      }
    }
    // 超预算：优先从头丢弃完整的历史轮次（user 及其配套的 assistant/tool 消息），
    // 整轮不拆散，避免破坏 assistant(tool_calls) 与 tool 消息的配对；至少保留最近 1 轮
    while (this.historyTokens + this.systemTokens > MAX_HISTORY_TOKENS) {
      if (this.history.filter((m) => m.role === "user").length <= 1) {
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
    if (this.historyTokens + this.systemTokens > MAX_HISTORY_TOKENS && !this.compressNotified) {
      this.compressNotified = true;
      this.appendSystem("对话较长，较早的内容已按长度自动压缩，AI 可能不清楚最早的信息。");
    }
  }

  /**
   * 仅剩当前轮仍超预算时：把较早的 get_canvas 工具结果替换为占位说明，释放 token。
   * 从历史头部开始替换（最旧优先），保留最近一次画布数据供模型继续引用。
   */
  private shrinkCanvasData(): boolean {
    let changed = false;
    for (let i = 0; i < this.history.length; i++) {
      const m = this.history[i];
      if (m.role !== "tool" || typeof m.content !== "string") {
        continue;
      }
      if (!m.content.startsWith("当前画布元素数据")) {
        continue;
      }
      const before = estimateTokens(m.content);
      m.content = "（画布数据已省略，如需最新内容请重新调用 get_canvas）";
      this.historyTokens -= before - estimateTokens(m.content);
      changed = true;
      if (this.historyTokens + this.systemTokens <= MAX_HISTORY_TOKENS) {
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
    const firstUser = this.history.findIndex((m) => m.role === "user");
    if (firstUser < 0) {
      // 极端残留：全是工具轮次消息（无 user 的非法序列），整体清空
      this.historyTokens = 0;
      this.history = [];
      return true;
    }
    // 轮次终点：下一条 user 消息之前；开头的非 user 残留（中断留下）一并丢弃
    let end = this.history.length;
    for (let i = firstUser + 1; i < this.history.length; i++) {
      if (this.history[i].role === "user") {
        end = i;
        break;
      }
    }
    const dropped = this.history.splice(0, end);
    for (const m of dropped) {
      this.historyTokens -= estimateTokens(m.content);
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
    // 记录发送前历史长度：失败时回滚本轮写入，避免残留未配对的工具轮次消息
    const historyLen = this.history.length;
    this.appendUser(text);
    // @ 选区上下文与用户文字合并为一条 user 消息（避免连续两条 user 消息语义割裂），
    // 选区数据为发送时快照，不随画布变化
    const atData = this.pendingAt;
    let userContent = text;
    if (atData?.length) {
      const ids = atData.map((d) => d.id).filter((v): v is string => !!v);
      userContent = `【@选区】使用者选中了 ${atData.length} 个元素，请重点针对它们评价与优化（可用 get_canvas 传 ids 复查，用 update_elements 修改它们；不要改动其他元素）：\n${describeCanvas(this.board, ids)}\n\n使用者的请求：${text}`;
      this.clearAt();
    }
    this.pushHistory({ role: "user", content: userContent });

    // 多模态：交流模式开启视觉时，随消息附带画布截图（发送时快照；失败静默降级纯文本）
    if (this.mode === "chat" && cfg.multimodal === true) {
      try {
        const shot = await this.board.exportImage();
        if (shot) {
          this.history[this.history.length - 1].content = [
            { type: "text", text: userContent },
            { type: "image_url", image_url: { url: shot } },
          ];
          this.historyTokens += IMAGE_TOKENS;
        }
      } catch {
        // 截图失败：降级为纯文本
      }
    }

    const mode = this.mode;
    const system: ChatMessage = {
      role: "system",
      content: buildSystemPrompt(mode),
    };
    // 系统提示词计入 token 预算（压缩时与 historyTokens 一并判断）
    this.systemTokens = estimateTokens(system.content);
    const openAiTools = toOpenAiTools(toolsForMode(mode));

    const bubble = this.appendAi("");
    let fullText = "";
    let canvasChanged = false;
    // 画布改动合并为一步历史：执行前快照，整轮工具结束后统一提交
    const before = this.board.serialize();
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
        const res = await chatTurn(cfg, [system, ...this.history], openAiTools, {
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
            ? executeTool(tool, call.function.arguments, {
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
        const res = await chatTurn(cfg, [system, ...this.history], [], {
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
      while (this.history.length > historyLen) {
        const popped = this.history.pop();
        if (popped) {
          this.historyTokens -= estimateTokens(popped.content);
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
