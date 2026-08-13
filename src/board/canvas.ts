import { App, Rect, Ellipse, Line, Path, Text, PointerEvent } from "leafer-ui";
import type { UI } from "leafer-ui";
import { Editor } from "@leafer-in/editor";
import {
  EditorMoveEvent,
  EditorScaleEvent,
  EditorRotateEvent,
} from "@leafer-in/editor";
// 注册导出插件（app.export 需要），须在创建 App 前导入
import "@leafer-in/export";
// 注册箭头插件（Line 的 endArrow 属性需要）
import "@leafer-in/arrow";
import type { IPointerEvent } from "@leafer-ui/interface";
import type { ElementData, ToolType } from "../types";
import { History } from "./history";
import { TextOverlay } from "./textedit";

export const BACKGROUND = "#1e1f22";
export const TEXT_FONT_SIZE = 18;

// 画布缩放：倍率范围与单步系数（滚轮/按钮共用）
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.25;

type AppWithEditor = App & { editor: Editor };

export type BoardStyle = {
  stroke: string;
  strokeWidth: number;
  fillEnabled: boolean;
};

export type BoardOptions = {
  getStyle: () => BoardStyle;
  onMutated: () => void;
};

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function colorOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** 画笔路径：点序折线 + 中点二次贝塞尔平滑 */
function buildPenPath(points: number[][]): string {
  const pts = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [px, py] = points[i];
    const [lx, ly] = pts[pts.length - 1];
    if (Math.hypot(px - lx, py - ly) >= 1.5) {
      pts.push([px, py]);
    }
  }
  if (pts.length < 2) {
    return "";
  }
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [mx, my] = [
      (pts[i][0] + pts[i + 1][0]) / 2,
      (pts[i][1] + pts[i + 1][1]) / 2,
    ];
    d += ` Q ${pts[i][0]} ${pts[i][1]} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}

export class Board {
  readonly app: App;
  readonly editor: Editor;
  private opts: BoardOptions;
  private tool: ToolType = "select";
  private drawing = false;
  private draft: UI | null = null;
  private startX = 0;
  private startY = 0;
  private penPoints: number[][] = [];
  private history = new History();
  private textOverlay: TextOverlay;
  private historyTimer = 0;
  private lastTapTime = 0;
  private lastTapTarget: unknown = null;

  constructor(container: HTMLElement, opts: BoardOptions) {
    this.opts = opts;
    // leafer-ui 2.x：editor 作为 App 配置项传入，App 会自动创建 tree/sky 层并挂载编辑器
    this.app = new App({
      view: container,
      fill: BACKGROUND,
      // 注意：leafer 2.2.9 的 InteractionBase 中 move/zoom/wheel 均为空实现，
      // 滚轮缩放由下方原生 wheel 监听自行实现（操作 tree.zoomLayer）
      move: { holdMiddleKey: true, holdSpaceKey: true },
      editor: {
        selector: false,
        hover: false,
        keyEvent: false,
        stroke: "#4f8cff",
        strokeWidth: 1.5,
        pointSize: 7,
        pointRadius: 1,
        lockRatio: true,
      },
    });
    this.editor = (this.app as AppWithEditor).editor;
    this.textOverlay = new TextOverlay(container);
    this.bindEvents();
    // 自研滚轮缩放：以鼠标位置为不动点
    (this.app.canvas.view as HTMLElement).addEventListener(
      "wheel",
      this.onWheel,
      { passive: false },
    );
  }

  private bindEvents() {
    // 监听 app 层：leafer 2.x 的 pointer 事件仅沿命中路径传播，
    // 空白处命中路径不含 tree 层，监听 tree 会导致空白处绘制/点击全部失效
    const app = this.app;
    app.on(PointerEvent.DOWN, (e: IPointerEvent) => this.onDown(e));
    app.on(PointerEvent.MOVE, (e: IPointerEvent) => this.onMove(e));
    app.on(PointerEvent.UP, () => this.onUp());
    app.on(PointerEvent.TAP, (e: IPointerEvent) => this.onTap(e));

    this.editor.on(EditorMoveEvent.MOVE, () => this.scheduleHistory());
    this.editor.on(EditorScaleEvent.SCALE, () => this.scheduleHistory());
    this.editor.on(EditorRotateEvent.ROTATE, () => this.scheduleHistory());
  }

  // ================= 工具 =================

  setTool(tool: ToolType) {
    this.tool = tool;
    if (tool !== "select") {
      this.editor.cancel();
    }
    this.textOverlay.close();
  }

  // ================= 缩放 =================

  /** 当前缩放倍率（tree.zoomLayer 承载画布缩放/平移变换） */
  get scale(): number {
    return this.app.tree.zoomLayer?.scaleX ?? 1;
  }

  /**
   * 以视口坐标 (fx, fy) 为不动点，将画布缩放到 newScale（限制在 MIN~MAX）。
   * 不动点处的内容缩放前后保持在原视口位置：
   * 世界坐标 w = (fx - layer.x) / s，缩放后 layer.x' = fx - w * s'
   */
  private zoomTo(newScale: number, fx: number, fy: number) {
    const layer = this.app.tree.zoomLayer;
    if (!layer) return;
    const s = layer.scaleX ?? 1;
    const target = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
    if (Math.abs(s - target) < 0.001) return;
    const lx = layer.x ?? 0;
    const ly = layer.y ?? 0;
    layer.x = fx - ((fx - lx) * target) / s;
    layer.y = fy - ((fy - ly) * target) / s;
    layer.scaleX = target;
    layer.scaleY = target;
  }

  zoomIn() {
    const c = this.viewCenter();
    this.zoomTo(this.scale * ZOOM_STEP, c.x, c.y);
  }

  zoomOut() {
    const c = this.viewCenter();
    this.zoomTo(this.scale / ZOOM_STEP, c.x, c.y);
  }

  zoomReset() {
    const c = this.viewCenter();
    this.zoomTo(1, c.x, c.y);
  }

  /** 视口中心（app 局部坐标） */
  private viewCenter(): { x: number; y: number } {
    const view = this.app.canvas.view as HTMLElement;
    const w = this.app.width ?? view.clientWidth;
    const h = this.app.height ?? view.clientHeight;
    return { x: w / 2, y: h / 2 };
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const view = this.app.canvas.view as HTMLElement;
    const rect = view.getBoundingClientRect();
    // 向上滚放大、向下滚缩小
    const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
    this.zoomTo(
      this.scale * factor,
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
  };

  get currentTool() {
    return this.tool;
  }

  // ================= 绘制交互 =================

  private onDown(e: IPointerEvent) {
    if (this.textOverlay.isOpen) {
      return;
    }
    // app 事件坐标为 app 局部坐标，转换为 tree 局部坐标（含缩放/平移）
    const p = this.app.tree.getInnerPoint({ x: e.x ?? 0, y: e.y ?? 0 });
    const px = p.x;
    const py = p.y;
    if (this.tool === "select") {
      // 用 app 坐标做命中检测（el.hit 内部按世界矩阵转换，缩放/平移下也准确）
      const hit = this.hitTest({ x: e.x ?? 0, y: e.y ?? 0 });
      this.editor.target = hit ?? undefined;
      return;
    }
    if (this.tool === "text") {
      this.openTextEditor(px, py, null);
      return;
    }
    this.drawing = true;
    this.startX = px;
    this.startY = py;
    const style = this.opts.getStyle();
    const fill = style.fillEnabled
      ? hexToRgba(style.stroke, 0.15)
      : undefined; // 注意：leafer 2.x 中 "none" 会被渲染为黑色实心，必须用 undefined
    switch (this.tool) {
      case "pen":
        this.penPoints = [[px, py]];
        this.draft = new Path({
          path: `M ${px} ${py}`,
          stroke: style.stroke,
          strokeWidth: style.strokeWidth,
          fill: undefined,
          strokeCap: "round",
          strokeJoin: "round",
        });
        break;
      case "line":
        this.draft = new Line({
          points: [
            { x: px, y: py },
            { x: px, y: py },
          ],
          stroke: style.stroke,
          strokeWidth: style.strokeWidth,
        });
        break;
      case "arrow":
        this.draft = new Line({
          points: [
            { x: px, y: py },
            { x: px, y: py },
          ],
          stroke: style.stroke,
          strokeWidth: style.strokeWidth,
          endArrow: "triangle",
        });
        break;
      case "rect":
        this.draft = new Rect({
          x: px,
          y: py,
          width: 0,
          height: 0,
          stroke: style.stroke,
          strokeWidth: style.strokeWidth,
          fill,
        });
        break;
      case "ellipse":
        this.draft = new Ellipse({
          x: px,
          y: py,
          width: 0,
          height: 0,
          stroke: style.stroke,
          strokeWidth: style.strokeWidth,
          fill,
        });
        break;
    }
    if (this.draft) {
      this.app.tree.add(this.draft);
    }
  }

  private onMove(e: IPointerEvent) {
    if (!this.drawing || !this.draft) {
      return;
    }
    const p = this.app.tree.getInnerPoint({ x: e.x ?? 0, y: e.y ?? 0 });
    const px = p.x;
    const py = p.y;
    switch (this.tool) {
      case "pen": {
        this.penPoints.push([px, py]);
        const path = buildPenPath(this.penPoints);
        if (path) {
          (this.draft as Path).path = path as string;
        }
        break;
      }
      case "line":
      case "arrow": {
        (this.draft as Line).points = [
          { x: this.startX, y: this.startY },
          { x: px, y: py },
        ];
        break;
      }
      case "rect":
      case "ellipse": {
        const x = Math.min(this.startX, px);
        const y = Math.min(this.startY, py);
        this.draft.x = x;
        this.draft.y = y;
        this.draft.width = Math.abs(px - this.startX);
        this.draft.height = Math.abs(py - this.startY);
        break;
      }
    }
  }

  private onUp() {
    if (!this.drawing) {
      return;
    }
    this.drawing = false;
    if (this.draft) {
      if (this.isTiny(this.draft)) {
        this.draft.remove();
      }
      this.draft = null;
      this.commitHistory();
    }
  }

  private isTiny(el: UI): boolean {
    switch (this.tool) {
      case "pen":
        return this.penPoints.length < 2;
      case "line":
      case "arrow": {
        const pts = (el as Line).points as
          | { x: number; y: number }[]
          | undefined;
        const p0 = pts?.[0];
        const p1 = pts?.[1];
        if (!p0 || !p1) {
          return true;
        }
        return Math.hypot(p1.x - p0.x, p1.y - p0.y) < 4;
      }
      case "rect":
      case "ellipse":
        return (el.width ?? 0) < 4 || (el.height ?? 0) < 4;
      default:
        return false;
    }
  }

  // ================= 文本编辑 =================

  private onTap(e: IPointerEvent) {
    const now = Date.now();
    const isDouble =
      this.lastTapTarget === e.target && now - this.lastTapTime < 300;
    this.lastTapTime = now;
    this.lastTapTarget = e.target;

    if (
      isDouble &&
      this.tool === "select" &&
      e.target instanceof Text
    ) {
      const el = e.target as unknown as Text;
      this.openTextEditor(el.x ?? 0, el.y ?? 0, el);
    }
  }

  private openTextEditor(worldX: number, worldY: number, existing: Text | null) {
    const rect = (this.app.config.view as HTMLElement).getBoundingClientRect();
    const inner = this.app.tree.getInnerPoint({ x: worldX, y: worldY });
    const zoom = this.app.tree.zoomLayer?.scaleX ?? 1;
    this.textOverlay.open({
      innerX: rect.left + inner.x,
      innerY: rect.top + inner.y,
      initialText: existing?.text != null ? String(existing.text) : "",
      fontSize:
        (typeof existing?.fontSize === "number"
          ? existing.fontSize
          : TEXT_FONT_SIZE) * zoom,
      onSubmit: (text) => {
        if (existing) {
          existing.text = text;
        } else {
          this.app.tree.add(
            new Text({
              x: worldX,
              y: worldY,
              text,
              fontSize: TEXT_FONT_SIZE,
              fill: this.opts.getStyle().stroke,
            }),
          );
        }
        this.commitHistory();
      },
    });
  }

  // ================= 选择命中 =================

  private hitTest(world: { x: number; y: number }): UI | null {
    // 逐元素像素级命中：线段/箭头/画笔按实际描边命中；
    // 空心图形内部透明区域不命中，可穿透选中下层元素。
    // hitRadius=5 扩大命中容差（细线也容易点中）
    const children = this.app.tree.children as UI[];
    for (let i = children.length - 1; i >= 0; i--) {
      const el = children[i];
      if (el.hit(world, 5)) {
        return el;
      }
    }
    return null;
  }

  // ================= 历史 =================

  private scheduleHistory() {
    clearTimeout(this.historyTimer);
    this.historyTimer = window.setTimeout(() => this.commitHistory(), 250);
  }

  private commitHistory() {
    this.pushSnapshot(this.serialize());
  }

  /** 公开：压入一个历史快照并触发变化回调（美化/导入等场景） */
  pushSnapshot(snapshot: ElementData[]) {
    this.history.push(snapshot);
    this.opts.onMutated();
  }

  undo() {
    const snapshot = this.history.undo();
    if (snapshot) {
      this.loadElements(snapshot);
      this.opts.onMutated();
    }
  }

  redo() {
    const snapshot = this.history.redo();
    if (snapshot) {
      this.loadElements(snapshot);
      this.opts.onMutated();
    }
  }

  get canUndo() {
    return this.history.canUndo;
  }

  get canRedo() {
    return this.history.canRedo;
  }

  resetHistory() {
    this.history.clear();
  }

  // ================= 元素操作 =================

  deleteSelected() {
    const list = (this.editor as unknown as { list: UI[] }).list ?? [];
    if (!list.length) {
      return;
    }
    list.forEach((el) => el.remove());
    this.editor.cancel();
    this.commitHistory();
  }

  clearAll() {
    this.app.tree.clear();
    this.editor.cancel();
    this.commitHistory();
  }

  get elementCount() {
    return this.app.tree.children.length;
  }

  // ================= 序列化 =================

  serialize(): ElementData[] {
    const result: ElementData[] = [];
    for (const el of this.app.tree.children as UI[]) {
      const data = this.elementToData(el);
      if (data) {
        result.push(data);
      }
    }
    return result;
  }

  private elementToData(el: UI): ElementData | null {
    const base = {
      x: el.x ?? 0,
      y: el.y ?? 0,
      rotation: el.rotation || undefined,
      stroke: colorOf(el.stroke),
      strokeWidth: numOf(el.strokeWidth),
    };
    if (el instanceof Rect) {
      return {
        ...base,
        type: "rect",
        width: el.width ?? 0,
        height: el.height ?? 0,
        fill: colorOf(el.fill),
      };
    }
    if (el instanceof Ellipse) {
      return {
        ...base,
        type: "ellipse",
        width: el.width ?? 0,
        height: el.height ?? 0,
        fill: colorOf(el.fill),
      };
    }
    if (el instanceof Line) {
      return {
        ...base,
        // leafer 2.x 的 endArrow 默认值是字符串 "none"（truthy），需排除
        type: (el.endArrow && el.endArrow !== "none"
          ? "arrow"
          : "line") as "arrow" | "line",
        width: el.width ?? 0,
        height: el.height ?? 0,
        points: el.points as { x: number; y: number }[] | undefined,
      };
    }
    if (el instanceof Path) {
      return {
        ...base,
        type: "path",
        width: el.width ?? 0,
        height: el.height ?? 0,
        path: el.path as string,
      };
    }
    if (el instanceof Text) {
      return {
        ...base,
        type: "text",
        width: el.width ?? 0,
        height: el.height ?? 0,
        text: el.text == null ? undefined : String(el.text),
        fontSize: typeof el.fontSize === "number" ? el.fontSize : undefined,
        fill: colorOf(el.fill),
      };
    }
    return null;
  }

  loadElements(data: ElementData[]) {
    this.app.tree.clear();
    for (const d of data) {
      const el = this.dataToElement(d);
      if (el) {
        this.app.tree.add(el);
      }
    }
    this.editor.cancel();
  }

  private dataToElement(d: ElementData): UI | null {
    const common = {
      x: d.x,
      y: d.y,
      rotation: d.rotation,
      stroke: d.stroke,
      strokeWidth: d.strokeWidth,
    };
    const fill = d.fill === "none" ? undefined : d.fill;
    switch (d.type) {
      case "rect":
        return new Rect({
          ...common,
          width: d.width,
          height: d.height,
          fill,
        });
      case "ellipse":
        return new Ellipse({
          ...common,
          width: d.width,
          height: d.height,
          fill,
        });
      case "line":
        return new Line({ ...common, points: d.points });
      case "arrow":
        return new Line({
          ...common,
          points: d.points,
          endArrow: "triangle",
        });
      case "path":
        return new Path({
          ...common,
          path: d.path,
          fill: undefined,
          strokeCap: "round",
          strokeJoin: "round",
        });
      case "text":
        return new Text({
          ...common,
          text: d.text,
          fontSize: d.fontSize,
          fill: fill ?? d.stroke,
        });
    }
  }

  // ================= 导出 =================

  async exportPNG(): Promise<string> {
    const out = await this.app.export("png", {
      padding: 24,
      fill: BACKGROUND,
    });
    if (typeof out === "string") {
      return out;
    }
    const data = (out as { data?: unknown })?.data;
    if (typeof data === "string") {
      return data;
    }
    if (data instanceof Blob) {
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(data);
      });
    }
    throw new Error("导出失败：无法识别的结果");
  }

  /** 自动保存时使用：仅返回 JSON 字符串 */
  toJSON(): string {
    return JSON.stringify({
      app: "miniboard",
      version: 1,
      background: BACKGROUND,
      elements: this.serialize(),
    });
  }
}
