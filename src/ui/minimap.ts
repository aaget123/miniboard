import type { Board } from "../board/canvas";

/**
 * Ctrl 概览浮层（小地图）：按住 Ctrl 显示全画布简化矩形 + 当前视口框，
 * 点击/拖动浮层把视口中心导航到对应位置，松开 Ctrl 隐藏。
 * - 渲染为元素包围盒矩形（非真实快照）：千级元素下重绘仍即时，按需重算；
 * - 映射范围 = 内容联合 bbox ∪ 当前视口（再外扩 5%），保证视口框始终可见。
 */
export class Minimap {
  private root: HTMLElement;
  private canvasEl: HTMLCanvasElement;
  /** 当前映射的画布范围（page 基准），点击导航时反算世界坐标用 */
  private mapBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  /** 拖动导航中（pointerdown 后持续跟随） */
  private navigating = false;

  constructor(
    private board: Board,
    host: HTMLElement = document.body,
  ) {
    this.root = document.createElement("div");
    this.root.className = "minimap";
    this.root.hidden = true;
    this.canvasEl = document.createElement("canvas");
    this.canvasEl.className = "minimap-canvas";
    this.root.appendChild(this.canvasEl);
    const hint = document.createElement("div");
    hint.className = "minimap-hint";
    hint.textContent = "点击或拖动以定位 · 松开 Ctrl 关闭";
    this.root.appendChild(hint);
    host.appendChild(this.root);

    this.canvasEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.navigating = true;
      this.canvasEl.setPointerCapture(e.pointerId);
      this.navigateAt(e.clientX, e.clientY);
    });
    this.canvasEl.addEventListener("pointermove", (e) => {
      if (this.navigating) {
        this.navigateAt(e.clientX, e.clientY);
      }
    });
    this.canvasEl.addEventListener("pointerup", () => {
      this.navigating = false;
    });
  }

  show() {
    this.render();
    this.root.hidden = false;
  }

  hide() {
    this.root.hidden = true;
    this.navigating = false;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  /** 浮层内指针位置 → 画布坐标，平移视口中心并刷新视口框 */
  private navigateAt(clientX: number, clientY: number) {
    const rect = this.canvasEl.getBoundingClientRect();
    const fx = (clientX - rect.left) / Math.max(rect.width, 1);
    const fy = (clientY - rect.top) / Math.max(rect.height, 1);
    const { minX, minY, maxX, maxY } = this.mapBounds;
    this.board.centerViewAt(
      minX + fx * (maxX - minX),
      minY + fy * (maxY - minY),
    );
    this.render();
  }

  /** 重绘概览：元素矩形 + 视口框（dpr 感知） */
  private render() {
    const CSS_W = 240;
    const CSS_H = 160;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvasEl.width !== CSS_W * dpr || this.canvasEl.height !== CSS_H * dpr) {
      this.canvasEl.width = CSS_W * dpr;
      this.canvasEl.height = CSS_H * dpr;
    }
    const ctx = this.canvasEl.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CSS_W, CSS_H);

    const vp = this.board.viewport;
    const items = this.board.overviewItems();

    // 映射范围：内容 ∪ 视口，外扩 5% 留白
    let minX = vp.minX;
    let minY = vp.minY;
    let maxX = vp.maxX;
    let maxY = vp.maxY;
    for (const it of items) {
      minX = Math.min(minX, it.x);
      minY = Math.min(minY, it.y);
      maxX = Math.max(maxX, it.x + it.w);
      maxY = Math.max(maxY, it.y + it.h);
    }
    const padX = (maxX - minX) * 0.05 || 1;
    const padY = (maxY - minY) * 0.05 || 1;
    minX -= padX;
    minY -= padY;
    maxX += padX;
    maxY += padY;
    // 保持画布纵横比：取覆盖范围的等比缩放
    const k = Math.min(CSS_W / (maxX - minX), CSS_H / (maxY - minY));
    const ox = (CSS_W - (maxX - minX) * k) / 2;
    const oy = (CSS_H - (maxY - minY) * k) / 2;
    this.mapBounds = { minX, minY, maxX, maxY };
    const toX = (x: number) => ox + (x - minX) * k;
    const toY = (y: number) => oy + (y - minY) * k;

    // 元素简化矩形
    ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
    for (const it of items) {
      ctx.fillRect(toX(it.x), toY(it.y), Math.max(it.w * k, 1), Math.max(it.h * k, 1));
    }

    // 视口框
    ctx.strokeStyle = "#4f8cff";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      toX(vp.minX),
      toY(vp.minY),
      Math.max((vp.maxX - vp.minX) * k, 2),
      Math.max((vp.maxY - vp.minY) * k, 2),
    );
  }
}
