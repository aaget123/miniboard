import { loadSystemPrompt, resetSystemPrompt, saveSystemPrompt } from "../ai/prompts";
import type { AiMode } from "../ai/types";
import { showConfirm } from "./confirm";

/**
 * 「系统提示词」页签控制器：交流/编辑双模式提示词的查看、编辑与保存。
 * 页签 DOM（模式切换行/编辑区/操作行/状态行）由控制器自建并挂到容器内。
 */
export class PromptPaneController {
  private mode: AiMode = "chat";
  private tabs = new Map<AiMode, HTMLButtonElement>();
  private area!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;

  /** container 为「系统提示词」页签容器（标题/提示文案由设置弹窗负责） */
  constructor(container: HTMLElement) {
    const modeRow = document.createElement("div");
    modeRow.className = "prompt-mode-row";
    for (const m of ["chat", "edit"] as AiMode[]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "prompt-mode-tab";
      btn.textContent = m === "chat" ? "交流模式" : "编辑模式";
      // 初始模式为交流，先标 active（切换走 setMode）
      btn.classList.toggle("active", m === "chat");
      btn.addEventListener("click", () => this.setMode(m));
      this.tabs.set(m, btn);
      modeRow.appendChild(btn);
    }
    container.appendChild(modeRow);

    this.area = document.createElement("textarea");
    this.area.className = "prompt-area";
    this.area.spellcheck = false;
    container.appendChild(this.area);

    const actions = document.createElement("div");
    actions.className = "ai-modal-actions prompt-actions";
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "tool-btn prompt-reset";
    resetBtn.textContent = "恢复默认";
    resetBtn.addEventListener("click", () => this.reset());
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "tool-btn ai-modal-save";
    saveBtn.textContent = "保存提示词";
    saveBtn.addEventListener("click", () => this.save());
    actions.append(resetBtn, saveBtn);
    container.appendChild(actions);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "ai-modal-status";
    container.appendChild(this.statusEl);
  }

  /** 载入当前模式提示词（打开弹窗/切换模式时调用，未保存的编辑会被覆盖） */
  refresh() {
    this.area.value = loadSystemPrompt(this.mode);
    this.setStatus("", "");
  }

  private setMode(mode: AiMode) {
    this.mode = mode;
    for (const [m, btn] of this.tabs) {
      btn.classList.toggle("active", m === mode);
    }
    this.refresh();
  }

  private save() {
    saveSystemPrompt(this.mode, this.area.value);
    this.setStatus("已保存，对新对话生效", "ok");
  }

  private reset() {
    // 应用内弹窗替代 window.confirm：WKWebView 等环境同步对话框静默失败
    void showConfirm({
      title: "恢复默认提示词",
      message: "恢复默认提示词？自定义内容将被清除。",
      confirmLabel: "恢复",
      danger: true,
    }).then((ok) => {
      if (ok) {
        resetSystemPrompt(this.mode);
        this.refresh();
        this.setStatus("已恢复默认提示词", "ok");
      }
    });
  }

  private setStatus(text: string, cls: "" | "ok" | "error") {
    this.statusEl.textContent = text;
    this.statusEl.className = cls ? `ai-modal-status ${cls}` : "ai-modal-status";
  }
}
