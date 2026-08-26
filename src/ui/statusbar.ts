import { iconHTML, isIconName, type IconName } from "./icons";

export type StatusBarHandlers = {
  /** 点击左下角项目名：打开项目管理弹窗（新建/切换/重命名/删除） */
  onProjectClick: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
};

function makeBtn(icon: IconName | string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "tool-btn sb-btn";
  btn.title = title;
  // 图标名渲染 SVG；非图标名（如缩放百分比文本）按文本渲染
  if (isIconName(icon)) {
    btn.innerHTML = iconHTML(icon, 14);
  } else {
    btn.textContent = icon;
  }
  btn.addEventListener("click", onClick);
  return btn;
}

/**
 * 右下角状态栏（半透明底栏）：左侧信息（元素数 + 光标画布坐标），
 * 右侧全局控制（撤销/重做/缩放），Excalidraw 底部状态栏同款布局。
 */
export class StatusBar {
  private el: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private zoomBtn!: HTMLButtonElement;
  private infoEl!: HTMLElement;
  private projectBtn!: HTMLButtonElement;
  private savedHint!: HTMLSpanElement;
  private savedTimer = 0;
  /** 选区整体包围盒（选中元素时展示 W×H） */
  private selSize: { width: number; height: number } | null = null;

  constructor(container: HTMLElement, handlers: StatusBarHandlers) {
    this.el = container;
    this.el.classList.add("docked");

    this.infoEl = document.createElement("span");
    this.infoEl.id = "sb-info";

    // 当前项目名（多项目）：点击打开项目管理；切换项目后由宿主更新文本
    this.projectBtn = document.createElement("button");
    this.projectBtn.type = "button";
    this.projectBtn.id = "sb-project";
    this.projectBtn.className = "sb-project";
    this.projectBtn.title = "项目管理（新建 / 切换 / 重命名 / 删除）";
    this.projectBtn.addEventListener("click", () => handlers.onProjectClick());

    const right = document.createElement("div");
    right.className = "sb-right";
    this.undoBtn = makeBtn("undo", "撤销 (Ctrl+Z)", () => handlers.onUndo());
    this.redoBtn = makeBtn("redo", "重做 (Ctrl+Y)", () => handlers.onRedo());
    right.append(this.undoBtn, this.redoBtn);
    right.append(makeBtn("zoomOut", "缩小 (Ctrl+−)", () => handlers.onZoomOut()));
    this.zoomBtn = makeBtn("100%", "重置为 100% (Ctrl+0)", () => handlers.onZoomReset());
    this.zoomBtn.classList.add("sb-zoom");
    right.append(this.zoomBtn);
    right.append(makeBtn("zoomIn", "放大 (Ctrl+＋)", () => handlers.onZoomIn()));

    this.el.append(this.projectBtn, this.infoEl, right);

    // 自动保存成功轻提示：项目名旁短暂显示后淡出（失败走 toast，成功走这里形成闭环）
    this.savedHint = document.createElement("span");
    this.savedHint.className = "sb-saved";
    this.savedHint.textContent = "已保存 ✓";
    this.savedHint.hidden = true;
    this.el.appendChild(this.savedHint);
  }

  /** 自动保存成功轻提示：显示约 900ms 后淡出；连续保存时节流重置 */
  flashSaved() {
    this.savedHint.hidden = false;
    this.savedHint.classList.remove("fade-out");
    clearTimeout(this.savedTimer);
    this.savedTimer = window.setTimeout(() => {
      this.savedHint.classList.add("fade-out");
      this.savedTimer = window.setTimeout(() => {
        this.savedHint.hidden = true;
        this.savedHint.classList.remove("fade-out");
      }, 400);
    }, 900);
  }

  /** 左下角项目名按钮（空串隐藏），与元素信息同栏展示；名称经文本节点渲染防注入 */
  setProject(name: string) {
    this.projectBtn.textContent = "";
    if (name) {
      const icon = document.createElement("span");
      icon.className = "sb-project-icon";
      icon.innerHTML = iconHTML("folder", 12);
      const label = document.createElement("span");
      label.textContent = name;
      this.projectBtn.append(icon, label);
    }
    this.projectBtn.hidden = !name;
  }

  setUndoRedo(canUndo: boolean, canRedo: boolean) {
    this.undoBtn.classList.toggle("disabled", !canUndo);
    this.redoBtn.classList.toggle("disabled", !canRedo);
  }

  setZoom(percent: number) {
    this.zoomBtn.textContent = `${Math.round(percent)}%`;
  }

  /** 记录选区包围盒（由宿主在选中变化时更新；null = 无选中） */
  setSelectionSize(size: { width: number; height: number } | null) {
    this.selSize = size;
    this.renderInfo();
  }

  /** 左侧信息：元素数与光标画布坐标（坐标为空时只显示元素数） */
  setInfo(count: number, coords?: { x: number; y: number }) {
    this.elCount = count;
    this.coords = coords ?? null;
    this.renderInfo();
  }

  private renderInfo() {
    const c = this.coords
      ? ` · x: ${this.coords.x.toFixed(1)}, y: ${this.coords.y.toFixed(1)}`
      : "";
    const s = this.selSize
      ? ` · ${Math.round(this.selSize.width)} × ${Math.round(this.selSize.height)}`
      : "";
    this.infoEl.textContent = `${this.elCount} 个元素${s}${c}`;
  }

  private elCount = 0;
  private coords: { x: number; y: number } | null = null;
}
