export type StatusBarHandlers = {
  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
};

function makeBtn(
  icon: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "tool-btn sb-btn";
  btn.title = title;
  btn.textContent = icon;
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
  private projectEl!: HTMLElement;

  constructor(
    container: HTMLElement,
    handlers: StatusBarHandlers,
  ) {
    this.el = container;
    this.el.classList.add("docked");

    this.infoEl = document.createElement("span");
    this.infoEl.id = "sb-info";

    // 当前项目名（多项目）：切换项目后由宿主更新
    this.projectEl = document.createElement("span");
    this.projectEl.id = "sb-project";

    const right = document.createElement("div");
    right.className = "sb-right";
    this.undoBtn = makeBtn("↩", "撤销 (Ctrl+Z)", () => handlers.onUndo());
    this.redoBtn = makeBtn("↪", "重做 (Ctrl+Y)", () => handlers.onRedo());
    right.append(
      this.undoBtn,
      this.redoBtn,
      makeBtn("−", "缩小 (Ctrl+−)", () => handlers.onZoomOut()),
    );
    this.zoomBtn = makeBtn("100%", "重置为 100% (Ctrl+0)", () =>
      handlers.onZoomReset(),
    );
    this.zoomBtn.classList.add("sb-zoom");
    right.append(this.zoomBtn);
    right.append(makeBtn("＋", "放大 (Ctrl+＋)", () => handlers.onZoomIn()));

    this.el.append(this.projectEl, this.infoEl, right);
  }

  /** 左侧项目名（空串隐藏），与元素信息同栏展示 */
  setProject(name: string) {
    this.projectEl.textContent = name ? `📁 ${name} · ` : "";
  }

  setUndoRedo(canUndo: boolean, canRedo: boolean) {
    this.undoBtn.classList.toggle("disabled", !canUndo);
    this.redoBtn.classList.toggle("disabled", !canRedo);
  }

  setZoom(percent: number) {
    this.zoomBtn.textContent = `${Math.round(percent)}%`;
  }

  /** 左侧信息：元素数与光标画布坐标（坐标为空时只显示元素数） */
  setInfo(count: number, coords?: { x: number; y: number }) {
    const c = coords
      ? ` · x: ${coords.x.toFixed(1)}, y: ${coords.y.toFixed(1)}`
      : "";
    this.infoEl.textContent = `${count} 个元素${c}`;
  }
}
