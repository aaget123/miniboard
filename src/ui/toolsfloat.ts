export type ToolsFloatHandlers = {
  onOpen: () => void;
  onSave: () => void;
  onInsertImage: () => void;
  onExport: () => void;
  onExportSVG: () => void;
  onToggleAI: () => void;
  onClear: () => void;
  onSettings: () => void;
};

const POS_KEY = "miniboard:float-pos";

/** 拖拽超过该距离（px）视为拖动而非点击 */
const DRAG_THRESHOLD = 4;
/** 鼠标移出后延迟收起时长（ms）：主按钮与面板间有间隙，避免路过即误收 */
const COLLAPSE_DELAY = 300;

function makeItem(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "tf-item";
  btn.title = title;
  btn.textContent = icon;
  btn.addEventListener("click", onClick);
  return btn;
}

/**
 * 右侧圆形悬浮工具栏：文件操作（打开/保存/插入图片/导出 PNG/SVG）+ AI + 清空 + 设置。
 * 常驻可见（无需选中），主按钮点击展开/收起，鼠标移开自动收起；
 * 主按钮可自由拖拽移动（位置记忆在 localStorage）。
 */
export class ToolsFloat {
  private root: HTMLElement;
  private mainBtn!: HTMLButtonElement;
  private panel!: HTMLElement;
  private expanded = false;
  private aiBtn!: HTMLButtonElement;
  // 收起延迟计时器（pointerleave 启动，重新进入取消）
  private collapseTimer = 0;
  // 拖拽状态
  private dragging = false;
  private dragMoved = false;
  private startX = 0;
  private startY = 0;
  private originLeft = 0;
  private originTop = 0;

  constructor(
    container: HTMLElement,
    handlers: ToolsFloatHandlers,
  ) {
    this.root = document.createElement("div");
    this.root.id = "tools-float";

    this.panel = document.createElement("div");
    this.panel.className = "tf-panel";
    this.panel.hidden = true;
    this.panel.append(
      makeItem("📂", "打开文件 (Ctrl+O)", () => handlers.onOpen()),
      makeItem("💾", "保存文件 (Ctrl+S)", () => handlers.onSave()),
      makeItem("🖼", "插入图片", () => handlers.onInsertImage()),
      makeItem("📷", "导出 PNG 图片", () => handlers.onExport()),
      makeItem("📄", "导出 SVG 矢量图", () => handlers.onExportSVG()),
    );
    this.aiBtn = makeItem("🤖", "AI 助手 (K)", () => handlers.onToggleAI());
    this.panel.appendChild(this.aiBtn);
    this.panel.appendChild(makeItem("🗑", "清空画布", () => handlers.onClear()));
    this.panel.appendChild(
      makeItem("⚙", "设置（主题 / AI 模型）", () => handlers.onSettings()),
    );
    this.root.appendChild(this.panel);

    this.mainBtn = document.createElement("button");
    this.mainBtn.className = "tf-main";
    this.mainBtn.title = "文件与工具（可拖动位置）";
    this.mainBtn.textContent = "☰";
    this.root.appendChild(this.mainBtn);

    container.appendChild(this.root);

    this.mainBtn.addEventListener("click", () => this.toggle());
    // 鼠标移出延迟收起：移入（含主按钮与面板间的间隙）立即取消计时，防止误收
    this.root.addEventListener("pointerenter", () => {
      clearTimeout(this.collapseTimer);
    });
    this.root.addEventListener("pointerleave", () => {
      if (!this.expanded) {
        return;
      }
      clearTimeout(this.collapseTimer);
      this.collapseTimer = window.setTimeout(() => this.collapse(), COLLAPSE_DELAY);
    });
    this.bindDrag();
    this.restorePos();
    // 窗口尺寸变化时把浮层拉回视口内（防止窗口缩小后按钮被挤出屏幕外）
    window.addEventListener("resize", () => this.clampToViewport());
  }

  /** 将浮层位置夹回视口内（恢复位置、窗口缩放时调用） */
  private clampToViewport() {
    const r = this.root.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - r.width);
    const maxTop = Math.max(0, window.innerHeight - r.height);
    const x = Math.min(Math.max(0, r.left), maxLeft);
    const y = Math.min(Math.max(0, r.top), maxTop);
    if (x !== r.left || y !== r.top) {
      this.root.style.left = `${x}px`;
      this.root.style.top = `${y}px`;
      this.root.style.right = "auto";
    }
  }

  /** AI 面板开合状态 → 按钮激活态 */
  setAIActive(active: boolean) {
    this.aiBtn.classList.toggle("active", active);
    // AI 面板打开时整体让位（避免被右侧面板遮挡）：淡出并禁用交互
    this.root.classList.toggle("ai-open", active);
    if (active) {
      this.collapse();
    }
  }

  /** 收起面板（main.ts 互斥管理 closeAllFloating 调用） */
  collapse() {
    clearTimeout(this.collapseTimer);
    this.expanded = false;
    this.panel.hidden = true;
    this.mainBtn.classList.remove("open");
  }

  private toggle() {
    this.expanded ? this.collapse() : this.expand();
  }

  private expand() {
    this.expanded = true;
    this.panel.hidden = false;
    this.mainBtn.classList.add("open");
  }

  // ---------- 拖拽移动 ----------

  private bindDrag() {
    this.mainBtn.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.dragMoved = false;
      this.startX = e.clientX;
      this.startY = e.clientY;
      const r = this.root.getBoundingClientRect();
      this.originLeft = r.left;
      this.originTop = r.top;
      this.mainBtn.setPointerCapture(e.pointerId);
    });
    this.mainBtn.addEventListener("pointermove", (e) => {
      if (!this.dragging) {
        return;
      }
      const dx = e.clientX - this.startX;
      const dy = e.clientY - this.startY;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        this.dragMoved = true;
      }
      if (this.dragMoved) {
        this.root.style.left = `${this.originLeft + dx}px`;
        this.root.style.top = `${this.originTop + dy}px`;
        this.root.style.right = "auto";
      }
    });
    const end = () => {
      if (!this.dragging) {
        return;
      }
      this.dragging = false;
      if (this.dragMoved) {
        // 拖动结束：记忆位置（超出视口时夹回）
        const r = this.root.getBoundingClientRect();
        const maxLeft = Math.max(0, window.innerWidth - r.width);
        const maxTop = Math.max(0, window.innerHeight - r.height);
        const x = Math.min(Math.max(0, r.left), maxLeft);
        const y = Math.min(Math.max(0, r.top), maxTop);
        this.root.style.left = `${x}px`;
        this.root.style.top = `${y}px`;
        this.root.style.right = "auto";
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({ x, y }));
        } catch {
          // localStorage 不可用时忽略位置记忆
        }
      }
    };
    this.mainBtn.addEventListener("pointerup", end);
    this.mainBtn.addEventListener("pointercancel", end);
  }

  private restorePos() {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) {
        return;
      }
      const pos = JSON.parse(raw) as { x?: number; y?: number };
      if (typeof pos.x === "number" && typeof pos.y === "number") {
        this.root.style.left = `${pos.x}px`;
        this.root.style.top = `${pos.y}px`;
        this.root.style.right = "auto";
        // 恢复后立即夹回视口内（记忆的位置可能在更宽的窗口下保存）
        this.clampToViewport();
      }
    } catch {
      // 位置数据损坏时使用默认位置
    }
  }
}
