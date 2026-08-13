import { App, Rect, Ellipse, Line, Path, Text, PointerEvent } from "leafer-ui";
import type { UI } from "leafer-ui";
import { Editor } from "@leafer-in/editor";
import {
  EditorMoveEvent,
  EditorScaleEvent,
  EditorRotateEvent,
} from "@leafer-in/editor";
import type { IPointerEvent } from "@leafer-ui/interface";
import type { ElementData, ToolType } from "../types";
import { History } from "./history";
import { TextOverlay } from "./textedit";

export const BACKGROUND = "#1e1f22";
export const TEXT_FONT_SIZE = 18;

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
    this.app = new App({
      view: container,
      fill: BACKGROUND,
      wheel: { zoomMode: "mouse", zoomSpeed: 1.15 },
      move: { holdMiddleKey: true, holdSpaceKey: true },
    });
    const EditorCtor = Editor as unknown as new (
      userConfig?: Record<string, unknown>,
    ) => Editor;
    this.editor = new EditorCtor({
      selector: false,
      hover: false,
      keyEvent: false,
      stroke: "#4f8cff",
      strokeWidth: 1.5,
      pointSize: 7,
      pointRadius: 1,
      lockRatio: true,
    });
    this.app.sky.add((this.app as AppWithEditor).editor = this.editor);
    this.textOverlay = new TextOverlay(container);
    this.bindEvents();
  }

  private bindEvents() {
    const tree = this.app.tree;
    tree.on(PointerEvent.DOWN, (e: IPointerEvent) => this.onDown(e));
    tree.on(PointerEvent.MOVE, (e: IPointerEvent) => this.onMove(e));
    tree.on(PointerEvent.UP, () => this.onUp());
    tree.on(PointerEvent.TAP, (e: IPointerEvent) => this.onTap(e));

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

  get currentTool() {
    return this.tool;
  }

  // ================= 绘制交互 =================

  private onDown(e: IPointerEvent) {
    if (this.textOverlay.isOpen) {
      return;
    }
    const px = e.x ?? 0;
    const py = e.y ?? 0;
    if (this.tool === "select") {
      const hit = this.hitTest({ x: px, y: py });
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
      : "none";
    switch (this.tool) {
      case "pen":
        this.penPoints = [[px, py]];
        this.draft = new Path({
          path: `M ${px} ${py}`,
          stroke: style.stroke,
          strokeWidth: style.strokeWidth,
          fill: "none",
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
    const px = e.x ?? 0;
    const py = e.y ?? 0;
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
    const children = this.app.tree.children as UI[];
    for (let i = children.length - 1; i >= 0; i--) {
      const el = children[i];
      const w = el.width ?? 0;
      const h = el.height ?? 0;
      const p = this.toLocal(el, world);
      if (p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h) {
        return el;
      }
    }
    return null;
  }

  private toLocal(el: UI, world: { x: number; y: number }) {
    const w = el.width ?? 0;
    const h = el.height ?? 0;
    const cx = (el.x ?? 0) + w / 2;
    const cy = (el.y ?? 0) + h / 2;
    const dx = world.x - cx;
    const dy = world.y - cy;
    const r = ((el.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    return {
      x: dx * cos + dy * sin + w / 2,
      y: -dx * sin + dy * cos + h / 2,
    };
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
        type: (el.endArrow ? "arrow" : "line") as "arrow" | "line",
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
          fill: "none",
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
