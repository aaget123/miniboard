import type { Board } from "../board/canvas";
import type { ToolRegistry } from "../board/registry";
import type { Toolbar } from "../ui/toolbar";
import { loadConfig, saveConfig, isConfigReady } from "./config";
import { chatTurn } from "./client";
import { buildSystemPrompt } from "./prompts";
import { describeCanvas, executeTool, toOpenAiTools, toolsForMode } from "./tools";
import type { ElementData } from "../types";
import type {
  AiConfig,
  AiMode,
  AiToolExecution,
  ChatMessage,
} from "./types";

const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY = 40;

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
  private history: ChatMessage[] = [];
  private modeTabs = new Map<AiMode, HTMLButtonElement>();
  private settingsModal: HTMLElement | null = null;
  /** @ 选区：当前已选区（发送时注入对话上下文），null 表示未 @ */
  private pendingAt: ElementData[] | null = null;

  constructor(
    private board: Board,
    private registry: ToolRegistry,
    private toolbar: Toolbar,
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
    document
      .getElementById("ai-settings-btn")!
      .addEventListener("click", () => this.openSettings());
    this.sendBtn.addEventListener("click", () => this.send());
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
    this.sendBtn.classList.toggle("disabled", busy);
    this.sendBtn.textContent = busy ? "…" : "发送";
    this.inputEl.disabled = busy;
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
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
  }

  private async send() {
    const text = this.inputEl.value.trim();
    if (!text || this.busy) {
      return;
    }
    const cfg = loadConfig();
    if (!isConfigReady(cfg)) {
      this.appendError("请先配置 AI 模型（接口地址 / API Key / 模型名）");
      this.openSettings();
      return;
    }

    this.setBusy(true);
    this.inputEl.value = "";
    this.appendUser(text);
    // @ 选区上下文：注入为一条 user 消息，AI 重点分析这些元素（快照，不随画布变化）
    const atData = this.pendingAt;
    if (atData?.length) {
      const ids = atData.map((d) => d.id).filter((v): v is string => !!v);
      this.pushHistory({
        role: "user",
        content: `【@选区】使用者选中了 ${atData.length} 个元素，请重点针对它们评价与优化（可用 get_canvas 传 ids 复查，用 update_elements 修改它们；不要改动其他元素）：\n${describeCanvas(this.board, ids)}`,
      });
      this.clearAt();
    }
    this.pushHistory({ role: "user", content: text });

    const mode = this.mode;
    const system: ChatMessage = {
      role: "system",
      content: buildSystemPrompt(mode),
    };
    const openAiTools = toOpenAiTools(toolsForMode(mode));

    const bubble = this.appendAi("");
    let fullText = "";
    let canvasChanged = false;
    // 画布改动合并为一步历史：执行前快照，整轮工具结束后统一提交
    const before = this.board.serialize();

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await chatTurn(cfg, [system, ...this.history], openAiTools, {
          onText: (delta) => {
            fullText += delta;
            this.renderBubble(bubble, fullText);
            this.scrollBottom();
          },
        });
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
      }
      // 整轮画布改动合并为一步撤销（同 beautify 语义）
      if (canvasChanged) {
        const after = this.board.serialize();
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          this.board.pushSnapshot(before);
          this.board.pushSnapshot(after);
        }
      }
      if (!fullText) {
        this.renderBubble(bubble, "（本轮没有文本回复）");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.renderBubble(bubble, fullText ? fullText : "");
      this.appendError(`请求失败：${msg}`);
    } finally {
      this.setBusy(false);
    }
  }

  // ---------- 设置弹窗 ----------

  private openSettings() {
    if (!this.settingsModal) {
      this.settingsModal = this.buildSettingsModal();
      document.body.appendChild(this.settingsModal);
    }
    this.settingsModal.hidden = false;
  }

  private buildSettingsModal(): HTMLElement {
    const cfg = loadConfig();
    const mask = document.createElement("div");
    mask.className = "ai-modal-mask";
    mask.addEventListener("click", (e) => {
      if (e.target === mask) {
        mask.hidden = true;
      }
    });

    const modal = document.createElement("div");
    modal.className = "ai-modal";

    const title = document.createElement("h3");
    title.textContent = "AI 模型设置（OpenAI 兼容）";
    modal.appendChild(title);

    const hint = document.createElement("p");
    hint.className = "ai-modal-hint";
    hint.textContent = "Key 仅保存在本机浏览器存储中，请自行保管。";
    modal.appendChild(hint);

    const fields: { key: keyof AiConfig; label: string; placeholder: string; password?: boolean }[] = [
      { key: "baseURL", label: "接口地址 baseURL", placeholder: "https://api.deepseek.com/v1" },
      { key: "apiKey", label: "API Key", placeholder: "sk-…", password: true },
      { key: "model", label: "模型名称", placeholder: "deepseek-chat" },
    ];
    const inputs = new Map<keyof AiConfig, HTMLInputElement>();
    for (const f of fields) {
      const label = document.createElement("label");
      label.className = "ai-modal-label";
      label.textContent = f.label;
      const input = document.createElement("input");
      input.type = f.password ? "password" : "text";
      input.placeholder = f.placeholder;
      input.value = cfg[f.key] ?? "";
      inputs.set(f.key, input);
      modal.appendChild(label);
      modal.appendChild(input);
    }

    const actions = document.createElement("div");
    actions.className = "ai-modal-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "tool-btn";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", () => {
      mask.hidden = true;
    });
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "tool-btn ai-modal-save";
    saveBtn.textContent = "保存";
    saveBtn.addEventListener("click", () => {
      const next: AiConfig = {
        baseURL: inputs.get("baseURL")?.value.trim() ?? "",
        apiKey: inputs.get("apiKey")?.value.trim() ?? "",
        model: inputs.get("model")?.value.trim() ?? "",
      };
      if (!isConfigReady(next)) {
        this.appendError("请完整填写 baseURL、API Key 与模型名称");
        return;
      }
      saveConfig(next);
      mask.hidden = true;
      this.appendSystem(`模型设置已保存：${next.model} @ ${next.baseURL}`);
    });
    actions.append(cancelBtn, saveBtn);
    modal.appendChild(actions);
    mask.appendChild(modal);
    return mask;
  }
}
