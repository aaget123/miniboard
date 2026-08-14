import { App, Rect, Ellipse, Line, Path, Text, Image, PointerEvent } from "leafer-ui";
import type { UI } from "leafer-ui";
import { Editor, EditorEvent } from "@leafer-in/editor";
import {
  EditorMoveEvent,
  EditorScaleEvent,
  EditorRotateEvent,
  InnerEditorEvent,
} from "@leafer-in/editor";
// 注册导出插件（app.export 需要），须在创建 App 前导入
import "@leafer-in/export";
// 注册箭头插件（Line 的 endArrow 属性需要）
import "@leafer-in/arrow";
// 注册文本内联编辑器（新建/双击文字后就地 WYSIWYG 编辑），须在创建 App 前导入
import "@leafer-in/text-editor";
import type { IPointerEvent } from "@leafer-ui/interface";
import type { BoardStyle, ElementData } from "../types";
import { beautifyScene } from "./beautify";
import type { BeautifyStats } from "./beautify";
import { History } from "./history";
import type { ToolRegistry } from "./registry";
import { isSketchable, sketchifyData } from "./rough";
import { penSizeOf, strokeOutlinePath } from "./stroke";

export const BACKGROUND = "#1e1f22";
export const TEXT_FONT_SIZE = 18;

// 画布缩放：倍率范围与单步系数（滚轮/按钮共用）
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.25;

// 框选/套索草稿的描边颜色（画在 sky 层，不随缩放变化）
const MARQUEE_STROKE = "#4f8cff";

// ================= 几何工具 =================

/** 两个轴对齐矩形是否相交 */
function rectsIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** 点到线段的最短距离 */
function distToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 射线法判断点是否在多边形内（含边界） */
function pointInPolygon(
  p: { x: number; y: number },
  poly: { x: number; y: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** 点是否在线段上（含端点，容差 0.5） */
function pointOnSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  const cross = (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
  if (Math.abs(cross) > 0.5) {
    return false;
  }
  return (
    Math.min(a.x, b.x) - 0.5 <= p.x &&
    p.x <= Math.max(a.x, b.x) + 0.5 &&
    Math.min(a.y, b.y) - 0.5 <= p.y &&
    p.y <= Math.max(a.y, b.y) + 0.5
  );
}

/** 两条线段是否相交（含共线/端点接触） */
function segmentsIntersect(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number },
): boolean {
  const d =
    (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
  if (Math.abs(d) < 1e-9) {
    // 平行或共线：任一端点落在另一线段上即相交
    return (
      pointOnSegment(a1, b1, b2) ||
      pointOnSegment(a2, b1, b2) ||
      pointOnSegment(b1, a1, a2) ||
      pointOnSegment(b2, a1, a2)
    );
  }
  const t =
    ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d;
  const u =
    ((b1.x - a1.x) * (a2.y - a1.y) - (b1.y - a1.y) * (a2.x - a1.x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** 套索多边形与轴对齐矩形是否相交（顶点包含 + 边相交，覆盖包含/部分相交/包含于三种情形） */
function polygonHitsBox(
  poly: { x: number; y: number }[],
  box: { x: number; y: number; width: number; height: number },
): boolean {
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
  // 矩形角点在套索内（套索完全包住矩形）
  for (const c of corners) {
    if (pointInPolygon(c, poly)) {
      return true;
    }
  }
  // 套索顶点在矩形内（矩形完全包住套索）
  for (const p of poly) {
    if (
      p.x >= box.x &&
      p.x <= box.x + box.width &&
      p.y >= box.y &&
      p.y <= box.y + box.height
    ) {
      return true;
    }
  }
  // 任一边与矩形任一边相交（部分相交）
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    for (let j = 0; j < 4; j++) {
      if (
        segmentsIntersect(p1, p2, corners[j], corners[(j + 1) % 4])
      ) {
        return true;
      }
    }
  }
  return false;
}

type AppWithEditor = App & { editor: Editor };

export type BoardOptions = {
  getStyle: () => BoardStyle;
  onMutated: () => void;
  /** 统一功能注册表：绘制工具分发/自定义工具生成器均从注册表取 */
  registry: ToolRegistry;
  /** 右键菜单：传入浏览器视口坐标，由外部弹菜单 */
  onContextMenu?: (clientX: number, clientY: number) => void;
  /** 选中变化（含取消选择）：回调当前选中元素的 id 列表 */
  onSelectionChange?: (ids: string[]) => void;
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

/** 判断 leafer 元素是否为 freehand 笔迹（Path 渲染 + 采样点元数据） */
function isFreehandEl(el: UI): boolean {
  return (
    (el as unknown as { __freehandPoints?: unknown }).__freehandPoints !==
    undefined
  );
}

export class Board {
  readonly app: App;
  readonly editor: Editor;
  private opts: BoardOptions;
  private tool: string = "select";
  private drawing = false;
  private draft: UI | null = null;
  /** 拖拽统一管线：最近一次生成器输出的元素数据（用于实时刷新草稿与微小判定） */
  private draftData: ElementData | null = null;
  private startX = 0;
  private startY = 0;
  private penPoints: number[][] = [];
  /** 当前笔迹的 perfect-freehand size（直径，由笔画粗细换算） */
  private penSize = 8;
  private history = new History();
  private historyTimer = 0;
  private lastTapTime = 0;
  private lastTapTarget: unknown = null;
  // 手型平移：记录按下时的指针/图层位置，拖拽时做差值移动 zoomLayer
  private panning = false;
  private panStart = { x: 0, y: 0 };
  private panLayerStart = { x: 0, y: 0 };
  // 框选/套索：selecting 进行中，selectPoints 存套索路径点（app 坐标）
  private selecting = false;
  private selectPoints: { x: number; y: number }[] = [];
  // 橡皮擦：按下/拖动擦除经过的元素（锁定元素不可擦除）
  private erasing = false;
  private eraserDeleted = false;
  private lastErase = { x: 0, y: 0 };
  // 选中框内拖动：点击点在选中元素包围盒内（而非元素本体）时手动移动整个选择
  private selectDragging = false;
  private dragStart = { x: 0, y: 0 };
  private dragEls: { el: UI; x: number; y: number }[] = [];
  private movedAny = false;
  // 内部剪贴板（复制/剪切/粘贴）
  private clipboard: ElementData[] = [];
  // 元素稳定 id 分配器（AI 编辑模式按 id 引用元素）
  private nextElId = 1;

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
    this.bindEvents();
    // 自研滚轮缩放：以鼠标位置为不动点
    (this.app.canvas.view as HTMLElement).addEventListener(
      "wheel",
      this.onWheel,
      { passive: false },
    );
    // 右键菜单：原生 contextmenu 事件（leafer 事件系统不覆盖 DOM 右键）
    (this.app.canvas.view as HTMLElement).addEventListener(
      "contextmenu",
      this.onContextMenu,
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
    // 选中变化（选中/多选/取消）：左侧浮动工具栏显隐依赖此事件
    this.editor.on(EditorEvent.AFTER_SELECT, () => {
      this.opts.onSelectionChange?.(this.selectedList.map((el) => this.aiIdOf(el)).filter((id): id is string => !!id));
    });
    // 文本内联编辑关闭：空文本即删；内容变化才入历史（对齐 fabric object:modified 时机）
    this.editor.on(InnerEditorEvent.CLOSE, (e) => this.onInnerEditorClose(e));
  }

  // ================= 工具 =================

  setTool(tool: string) {
    this.tool = tool;
    // 内联文本编辑中：先关闭编辑器（触发收尾：空文本删除/历史提交）
    if (this.editor.innerEditor) {
      this.editor.closeInnerEditor();
    }
    if (tool !== "select") {
      this.editor.cancel();
    }
    // 切换工具时终止未完成的拖拽/框选/擦除，并同步光标
    this.panning = false;
    this.erasing = false;
    this.selectDragging = false;
    this.dragEls = [];
    if (this.selecting) {
      this.selecting = false;
      this.draft?.remove();
      this.draft = null;
    }
    const view = this.app.canvas.view as HTMLElement;
    view.classList.toggle("hand-tool", tool === "hand");
    view.classList.toggle("eraser-tool", tool === "eraser");
    view.classList.remove("panning");
    view.classList.remove("move-cursor");
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

  /** 重置为 100%：缩放归 1 并清除画布平移（回到初始视图） */
  zoomReset() {
    const layer = this.app.tree.zoomLayer;
    if (!layer) {
      return;
    }
    layer.x = 0;
    layer.y = 0;
    layer.scaleX = 1;
    layer.scaleY = 1;
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
    // 内联文本编辑中：交互交由 TextEditor 处理
    // （点击输入框内定位光标，点击外部由它负责关闭编辑）
    if (this.editor.innerEditor) {
      return;
    }
    // 手型平移：拖动整块画布（zoomLayer），用 app 坐标差值即可
    if (this.tool === "hand") {
      const layer = this.app.tree.zoomLayer;
      if (!layer) {
        return;
      }
      this.editor.cancel();
      this.panning = true;
      this.panStart = { x: e.x ?? 0, y: e.y ?? 0 };
      this.panLayerStart = { x: layer.x ?? 0, y: layer.y ?? 0 };
      (this.app.canvas.view as HTMLElement).classList.add("panning");
      return;
    }
    // 框选：画一个矩形选框（sky 层，不随缩放变化），松开时选中相交元素
    if (this.tool === "marquee") {
      this.beginSelect(e.x ?? 0, e.y ?? 0);
      return;
    }
    // 套索：自由画闭合区域，松开时选中区域内的元素
    if (this.tool === "lasso") {
      this.beginLasso(e.x ?? 0, e.y ?? 0);
      return;
    }
    // 橡皮擦：按下即擦除，拖动时持续擦除经过的元素
    if (this.tool === "eraser") {
      this.editor.cancel();
      this.erasing = true;
      this.eraserDeleted = false;
      this.lastErase = { x: e.x ?? 0, y: e.y ?? 0 };
      this.eraseAt(e.x ?? 0, e.y ?? 0);
      return;
    }
    // app 事件坐标为 app 局部坐标，转换为 tree 局部坐标（含缩放/平移）
    const p = this.app.tree.getInnerPoint({ x: e.x ?? 0, y: e.y ?? 0 });
    const px = p.x;
    const py = p.y;
    if (this.tool === "select") {
      // 用 app 坐标做命中检测（el.hit 内部按世界矩阵转换，缩放/平移下也准确）
      const hit = this.hitTest({ x: e.x ?? 0, y: e.y ?? 0 });
      if (hit) {
        this.editor.target = hit ?? undefined;
        return;
      }
      // 未命中元素本体：点击点落在编辑框控制点/边框上时交给 editor 缩放/旋转
      if (this.hitEditBox(e.x ?? 0, e.y ?? 0)) {
        return;
      }
      // 未命中元素本体：点击点落在选中元素包围盒内时，
      // 手动拖动整个选择（覆盖选中框内空白区域）
      if (this.editor.list.length && this.pointInSelection(e.x ?? 0, e.y ?? 0)) {
        this.beginDragSelection(px, py);
        return;
      }
      this.editor.target = undefined;
      return;
    }
    if (this.tool === "text") {
      // 新建空文本元素并立即就地编辑（WYSIWYG：输入实时显示在画布上）
      const style = this.opts.getStyle();
      const el = new Text({
        x: px,
        y: py,
        text: "",
        fontSize: TEXT_FONT_SIZE,
        // 文字主色 = fill，跟随填充通道颜色
        fill: style.fillColor || style.stroke,
      });
      (el as unknown as Record<string, unknown>).__textBeforeEdit = "";
      this.app.tree.add(el);
      this.openTextEdit(el);
      return;
    }
    const kind = this.opts.registry.getKind(this.tool);
    // 画笔：压力敏感笔迹（perfect-freehand 轮廓，填充渲染）
    if (kind === "freehand") {
      this.drawing = true;
      this.penPoints = [[px, py]];
      const style = this.opts.getStyle();
      this.penSize = penSizeOf(style.strokeWidth);
      this.draft = new Path({
        path: strokeOutlinePath(this.penPoints, { size: this.penSize }),
        fill: style.stroke,
        stroke: undefined, // leafer 2.x 中 "none" 渲染为黑色实心，必须用 undefined
        strokeWidth: style.strokeWidth, // 数据透传：笔画粗细随元素保存（整理/序列化读取）
        strokeCap: "round",
        strokeJoin: "round",
      });
      if (this.draft) {
        this.app.tree.add(this.draft);
      }
      return;
    }
    // 统一拖拽管线：内置 rect/ellipse/line/arrow 与 AI 生成工具同一条路径
    if (kind !== "drag") {
      return;
    }
    this.drawing = true;
    this.startX = px;
    this.startY = py;
    this.draftData = this.runGenerator(px, py, px, py);
    if (!this.draftData) {
      this.drawing = false;
      return;
    }
    this.draft = this.dataToElement(this.draftData);
    if (this.draft) {
      this.app.tree.add(this.draft);
    }
  }

  /** 调用当前工具的生成器（统一拖拽管线），异常时安全返回 null */
  private runGenerator(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): ElementData | null {
    const gen = this.opts.registry.getGenerator(this.tool);
    if (!gen) {
      return null;
    }
    try {
      return gen({ x0, y0, x1, y1, style: this.opts.getStyle() });
    } catch (err) {
      console.error("[board] 生成器执行失败", err);
      return null;
    }
  }

  /** 把生成器输出的元素数据增量应用到草稿实例（拖拽中实时刷新） */
  private applyDataToDraft(draft: UI, d: ElementData) {
    const t = draft as unknown as Record<string, unknown>;
    if (d.x !== undefined) t.x = d.x;
    if (d.y !== undefined) t.y = d.y;
    if (d.width !== undefined) t.width = d.width;
    if (d.height !== undefined) t.height = d.height;
    if (d.rotation !== undefined) t.rotation = d.rotation;
    if (d.stroke !== undefined) t.stroke = d.stroke;
    if (d.strokeWidth !== undefined) t.strokeWidth = d.strokeWidth;
    if ("fill" in d) {
      // leafer 2.x 中 "none" 渲染为黑色实心，必须转 undefined
      t.fill = d.fill === "none" ? undefined : d.fill;
    }
    if (d.points !== undefined && draft instanceof Line) t.points = d.points;
    if (d.path !== undefined && draft instanceof Path) t.path = d.path;
    if (d.text !== undefined && draft instanceof Text) t.text = d.text;
    if (d.fontSize !== undefined && draft instanceof Text) t.fontSize = d.fontSize;
  }

  private onMove(e: IPointerEvent) {
    // 手型拖拽：按指针位移移动 zoomLayer
    if (this.panning) {
      const layer = this.app.tree.zoomLayer;
      if (layer) {
        layer.x = this.panLayerStart.x + (e.x ?? 0) - this.panStart.x;
        layer.y = this.panLayerStart.y + (e.y ?? 0) - this.panStart.y;
      }
      return;
    }
    // 橡皮擦拖动：隔段擦除，避免事件密集时重复命中
    if (this.erasing) {
      const ax = e.x ?? 0;
      const ay = e.y ?? 0;
      if (Math.hypot(ax - this.lastErase.x, ay - this.lastErase.y) >= 4) {
        this.lastErase = { x: ax, y: ay };
        this.eraseAt(ax, ay);
      }
      return;
    }
    // 选中框内拖动：整个选择跟随指针位移
    if (this.selectDragging) {
      const p = this.app.tree.getInnerPoint({ x: e.x ?? 0, y: e.y ?? 0 });
      const dx = p.x - this.dragStart.x;
      const dy = p.y - this.dragStart.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        this.movedAny = true;
      }
      for (const item of this.dragEls) {
        item.el.x = item.x + dx;
        item.el.y = item.y + dy;
      }
      this.scheduleHistory();
      return;
    }
    // 框选/套索拖拽：更新草稿形状
    if (this.selecting && this.draft) {
      const x = e.x ?? 0;
      const y = e.y ?? 0;
      if (this.tool === "lasso") {
        this.selectPoints.push({ x, y });
        this.draft.path = this.buildLassoPath(this.selectPoints);
      } else {
        this.draft.x = Math.min(this.startX, x);
        this.draft.y = Math.min(this.startY, y);
        this.draft.width = Math.abs(x - this.startX);
        this.draft.height = Math.abs(y - this.startY);
      }
      return;
    }
    // 未按下时：光标悬停在选中框内显示移动指针，提示可整体拖动
    if (this.tool === "select") {
      const view = this.app.canvas.view as HTMLElement;
      const movable =
        this.editor.list.length > 0 &&
        !this.hitEditBox(e.x ?? 0, e.y ?? 0) &&
        this.pointInSelection(e.x ?? 0, e.y ?? 0);
      view.classList.toggle("move-cursor", movable);
    }
    if (!this.drawing || !this.draft) {
      return;
    }
    const p = this.app.tree.getInnerPoint({ x: e.x ?? 0, y: e.y ?? 0 });
    const px = p.x;
    const py = p.y;
    const kind = this.opts.registry.getKind(this.tool);
    if (kind === "freehand") {
      this.penPoints.push([px, py]);
      const path = strokeOutlinePath(this.penPoints, { size: this.penSize });
      if (path) {
        (this.draft as Path).path = path;
      }
      return;
    }
    if (kind === "drag") {
      const data = this.runGenerator(this.startX, this.startY, px, py);
      if (data) {
        this.draftData = data;
        this.applyDataToDraft(this.draft, data);
      }
    }
  }

  private onUp() {
    // 手型拖拽结束
    if (this.panning) {
      this.panning = false;
      (this.app.canvas.view as HTMLElement).classList.remove("panning");
      return;
    }
    // 橡皮擦结束：有删除则入历史（一次按下到松开合成一步）
    if (this.erasing) {
      this.erasing = false;
      if (this.eraserDeleted) {
        this.commitHistory();
      }
      return;
    }
    // 选中框内拖动结束：实际移动过才入历史
    if (this.selectDragging) {
      this.selectDragging = false;
      this.dragEls = [];
      if (this.movedAny) {
        this.commitHistory();
      }
      return;
    }
    // 框选/套索结束：结算选中
    if (this.selecting) {
      this.finishSelect();
      return;
    }
    if (!this.drawing) {
      return;
    }
    this.drawing = false;
    if (this.draft) {
      if (this.isTinyDraft()) {
        this.draft.remove();
      } else if (this.opts.registry.getKind(this.tool) === "freehand") {
        // 笔迹转正：挂载采样点元数据，序列化时输出 freehand 元素（供整理识别/重绘）
        const t = this.draft as unknown as Record<string, unknown>;
        t.__freehandPoints = this.penPoints.map((p) => [...p]);
        t.__penSize = this.penSize;
      }
      this.draft = null;
      this.draftData = null;
      this.commitHistory();
    }
  }

  /** 草稿是否过于微小（点击而非拖拽）：自由笔迹看点数，拖拽管线看生成数据尺寸 */
  private isTinyDraft(): boolean {
    if (this.opts.registry.getKind(this.tool) === "freehand") {
      return this.penPoints.length < 2;
    }
    const d = this.draftData;
    if (!d) {
      return true;
    }
    if (d.type === "line" || d.type === "arrow") {
      const pts = d.points ?? [];
      const p0 = pts[0];
      const p1 = pts[pts.length - 1];
      if (!p0 || !p1) {
        return true;
      }
      return Math.hypot(p1.x - p0.x, p1.y - p0.y) < 4;
    }
    return (d.width ?? 0) < 4 || (d.height ?? 0) < 4;
  }

  // ================= 文本编辑 =================

  private onTap(e: IPointerEvent) {
    // 内联文本编辑中：单击/双击均不参与（避免干扰编辑框内的光标定位）
    if (this.editor.innerEditor) {
      return;
    }
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
      this.openTextEdit(el);
    }
  }

  /** 打开文本内联编辑：先选中元素（openInnerEditor 仅对单选状态生效），并聚焦覆盖层 */
  private openTextEdit(el: Text) {
    (el as unknown as Record<string, unknown>).__textBeforeEdit = String(
      el.text ?? "",
    );
    this.editor.openInnerEditor(el, "TextEditor", true);
    // TextEditor 只设置 selection 不 focus：主动聚焦，否则键盘输入被全局快捷键拦截
    document.querySelector<HTMLElement>(".leafer-text-editor")?.focus();
  }

  /** 文本内联编辑关闭：空文本删除元素；内容变化才提交历史 */
  private onInnerEditorClose(e: { editTarget?: unknown }) {
    const t = e.editTarget;
    if (!(t instanceof Text)) {
      return;
    }
    const before = (t as unknown as Record<string, unknown>).__textBeforeEdit;
    const text = String(t.text ?? "");
    if (!text.trim()) {
      // 空文本：元素未入过历史，直接移除不留痕
      t.remove();
    } else if (text !== before) {
      this.commitHistory();
    }
  }

  // ================= 选择命中 =================

  private hitTest(world: { x: number; y: number }): UI | null {
    // 逐元素像素级命中：线段/箭头/画笔按实际描边命中；
    // 空心图形内部透明区域不命中，可穿透选中下层元素。
    // hitRadius=5 扩大命中容差（细线也容易点中）
    const children = this.app.tree.children as UI[];
    for (let i = children.length - 1; i >= 0; i--) {
      const el = children[i];
      if (this.isEditorInternal(el)) {
        continue; // editor 内部元素（多选模拟层）不可交互
      }
      if (el.hit(world, 5)) {
        return el;
      }
    }
    return null;
  }

  /**
   * editor 多选时注入 tree 的模拟元素（SimulateElement，skipJSON=true），
   * 不可见也不可交互，需从序列化/全选/框选中排除。
   */
  private isEditorInternal(el: UI): boolean {
    return (el as unknown as { skipJSON?: boolean }).skipJSON === true;
  }

  // ================= 橡皮擦 =================

  /** 擦除指定 app 坐标处的元素（锁定元素受保护不可擦除） */
  private eraseAt(ax: number, ay: number) {
    const hit = this.hitTest({ x: ax, y: ay });
    if (hit && !hit.locked) {
      hit.remove();
      this.editor.cancel();
      this.eraserDeleted = true;
    }
  }

  // ================= 选中框内拖动 =================

  /** app 坐标点是否落在任一选中元素的包围盒内 */
  private pointInSelection(ax: number, ay: number): boolean {
    for (const el of this.selectedList) {
      const b = el.worldBoxBounds;
      if (
        b &&
        ax >= b.x &&
        ax <= b.x + b.width &&
        ay >= b.y &&
        ay <= b.y + b.height
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * app 坐标点是否落在编辑框的可交互区域（缩放手柄/旋转手柄/边框线）上。
   * 命中时交给 editor 处理缩放/旋转，避免被"框内拖动"逻辑抢先。
   */
  private hitEditBox(ax: number, ay: number): boolean {
    const eb = this.editor.editBox as unknown as
      | {
          rect?: { getLayoutPoints?: (type?: string, relative?: string) => { x: number; y: number }[] };
          resizePoints?: UI[];
          rotatePoints?: UI[];
          resizeLines?: UI[];
        }
      | undefined;
    if (!eb) {
      return false;
    }
    // 缩放手柄 / 旋转手柄 / 边线手柄：世界包围盒 + 容差
    const points = [
      ...(eb.resizePoints ?? []),
      ...(eb.rotatePoints ?? []),
      ...(eb.resizeLines ?? []),
    ];
    for (const p of points) {
      const b = p.worldBoxBounds;
      if (
        b &&
        ax >= b.x - 4 &&
        ax <= b.x + b.width + 4 &&
        ay >= b.y - 4 &&
        ay <= b.y + b.height + 4
      ) {
        return true;
      }
    }
    // 编辑框边框线（旋转后取四角世界坐标，点到线段距离容差 6px）
    const pts = eb.rect?.getLayoutPoints?.("box", "world");
    if (pts && pts.length >= 4) {
      for (let i = 0; i < 4; i++) {
        if (distToSegment({ x: ax, y: ay }, pts[i], pts[(i + 1) % 4]) <= 6) {
          return true;
        }
      }
    }
    return false;
  }

  /** 开始手动拖动整个选择（tree 局部坐标，锁定元素不参与） */
  private beginDragSelection(tx: number, ty: number) {
    this.selectDragging = true;
    this.dragStart = { x: tx, y: ty };
    this.dragEls = this.selectedList
      .filter((el) => !el.locked)
      .map((el) => ({ el, x: el.x ?? 0, y: el.y ?? 0 }));
    this.movedAny = false;
  }

  // ================= 样式应用 =================

  /**
   * 将当前样式（描边色/粗细/填充开关/填充色）应用到选中元素。
   * 有可编辑的选中元素时返回 true，否则返回 false（不产生历史记录）。
   * 规则：
   * - 锁定元素与图片（内部填充为图像数据）跳过
   * - Text：描边与填充通道均作用于 fill（文字颜色），填充开关不影响
   * - Line：无填充概念，填充通道与填充开关不影响
   * - Path（含 AI 生成的三角形/五角星等闭合形状）：可填充，填充开关/填充色生效
   * - 填充色独立于描边色：填充通道点击自动开启填充
   */
  applyStyleToSelection(partial: Partial<BoardStyle>): boolean {
    const list = this.selectedList.filter((el) => !el.locked);
    if (!list.length) {
      return false;
    }
    const style = this.opts.getStyle();
    for (const el of list) {
      if (el instanceof Image) {
        continue; // 图片内部填充为图像数据，不可改样式
      }
      if (partial.stroke !== undefined) {
        if (el instanceof Text) {
          el.fill = partial.stroke; // Text 主色 = fill，保持"点颜色改文字色"直觉
        } else if (isFreehandEl(el)) {
          el.fill = partial.stroke; // 笔迹颜色 = 轮廓填充色（渲染通道是 fill）
        } else {
          el.stroke = partial.stroke; // 描边独立变色，不影响填充
        }
      }
      if (partial.fillColor !== undefined) {
        if (el instanceof Text) {
          el.fill = partial.fillColor;
        } else if (!(el instanceof Line)) {
          // 设置填充色并自动开启填充（与描边色互相独立；Path 等闭合形状可填充）
          el.fill = hexToRgba(partial.fillColor, 0.15);
        }
      }
      if (partial.strokeWidth !== undefined) {
        el.strokeWidth = partial.strokeWidth;
      }
      if (partial.fillEnabled !== undefined) {
        if (el instanceof Text || el instanceof Line) {
          continue; // 文字/线条无填充概念；Path 等形状可填充
        }
        el.fill = partial.fillEnabled
          ? hexToRgba(String(style.fillColor || el.stroke || style.stroke), 0.15)
          : undefined;
      }
    }
    // 防抖合并：连续调色/调粗细合并为一步撤销
    this.scheduleHistory();
    this.opts.onMutated();
    return true;
  }

  /**
   * 手绘风格：把选中的标准图形（矩形/椭圆/直线/箭头/标准多边形）转为 rough.js 手绘外观。
   * 替换为 path 元素，抖动 seed 随数据保存（可复现）；锁定/文本/图片/笔迹跳过。
   * 返回是否发生了转换。
   */
  sketchifySelection(): boolean {
    const list = this.selectedList.filter((el) => !el.locked);
    if (!list.length) {
      return false;
    }
    let changed = 0;
    for (const el of list) {
      if (
        this.isEditorInternal(el) ||
        el instanceof Text ||
        el instanceof Image
      ) {
        continue;
      }
      const d = this.elementToData(el);
      if (!d || !isSketchable(d)) {
        continue;
      }
      const sketched = sketchifyData(d);
      if (!sketched) {
        continue;
      }
      const replaced = this.dataToElement({
        ...d,
        type: "path",
        path: sketched.path,
        rough: { seed: sketched.seed, original: d.type },
      });
      if (!replaced) {
        continue;
      }
      // 位置/旋转/样式/稳定 id 已随数据透传，替换 tree 节点
      el.remove();
      this.app.tree.add(replaced);
      changed++;
    }
    if (changed) {
      this.editor.cancel();
      this.commitHistory();
      this.opts.onMutated();
    }
    return changed > 0;
  }

  /**
   * 局部整理：只整理选中元素（手绘笔迹 → 标准图形/拉直），未选中的原样保留。
   * 元素 id 稳定（freehand → rect/ellipse/line/path 后保持），整理后恢复选中；
   * z-order 不变（loadElements 按数组顺序重建）；整轮改动合并为一步撤销。
   * 返回整理统计（空数组 = 没有需要整理的笔迹）。
   */
  beautifySelection(): { changed: number; stats: BeautifyStats } {
    const list = this.selectedList.filter(
      (el) => !el.locked && !this.isEditorInternal(el),
    );
    if (!list.length) {
      return { changed: 0, stats: [] };
    }
    // serialize 会为所有元素分配稳定 id，先序列化再取选中 id
    const before = this.serialize();
    const ids = list
      .map((el) => this.aiIdOf(el))
      .filter((id): id is string => !!id);
    const { elements, stats } = beautifyScene(before, ids);
    if (!stats.length) {
      return { changed: 0, stats: [] };
    }
    this.loadElements(elements);
    // 整理后按 id 恢复选中（类型可能已变，id 保持稳定），方便连续整理/调整
    const restored = (this.app.tree.children as UI[]).filter((el) => {
      const id = (el as unknown as { __aiId?: string }).__aiId;
      return !!id && ids.includes(id);
    });
    if (restored.length === 1) {
      this.editor.target = restored[0];
    } else if (restored.length > 1) {
      this.editor.select(restored);
    }
    this.pushSnapshot(before);
    this.pushSnapshot(elements);
    return { changed: stats.length, stats };
  }

  // ================= 右键菜单 =================

  /** 当前选中的元素（editor.list 运行时即 UI 实例，类型声明为 IUI 需转换） */
  private get selectedList(): UI[] {
    return this.editor.list as unknown as UI[];
  }

  /** 右键：命中元素则选中（含锁定元素，以便解锁），然后交给外部弹菜单 */
  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const view = this.app.canvas.view as HTMLElement;
    const rect = view.getBoundingClientRect();
    const hit = this.hitTest({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
    if (hit && !this.editor.hasItem(hit)) {
      this.editor.target = hit;
    }
    this.opts.onContextMenu?.(e.clientX, e.clientY);
  };

  // ================= 剪贴板 / 编辑操作 =================

  get canPaste() {
    return this.clipboard.length > 0;
  }

  /** 复制选中元素到内部剪贴板，返回是否有内容可复制 */
  /** 取元素的稳定 id：首次访问时分配并缓存到实例上（复制/导入/粘贴后保持稳定） */
  private aiIdOf(el: UI): string {
    const cached = (el as unknown as { __aiId?: string }).__aiId;
    if (cached) {
      return cached;
    }
    let id: string;
    do {
      id = `el-${this.nextElId++}`;
    } while (this.idInUse(id));
    (el as unknown as { __aiId?: string }).__aiId = id;
    return id;
  }

  /** 判断 id 是否已被画布中其他元素占用（防止恢复/导入后重复分配冲突） */
  private idInUse(id: string): boolean {
    return (this.app.tree.children as UI[]).some(
      (el) => (el as unknown as { __aiId?: string }).__aiId === id,
    );
  }

  copy(): boolean {
    this.clipboard = this.selectedList
      .map((el) => this.elementToData(el))
      .filter((d): d is ElementData => d !== null);
    return this.clipboard.length > 0;
  }

  /** 剪切 = 复制 + 删除 */
  cut() {
    if (this.copy()) {
      this.deleteSelected();
    }
  }

  /** 粘贴剪贴板内容：整体偏移 12px 避免与原位置完全重叠，粘贴后选中新元素 */
  paste() {
    if (!this.clipboard.length) {
      return;
    }
    const pasted: UI[] = [];
    for (const d of this.clipboard) {
      // id 不随粘贴复制：粘贴出的元素应分配全新 id（避免与原件冲突）
      const el = this.dataToElement({
        ...d,
        id: undefined,
        x: (d.x ?? 0) + 12,
        y: (d.y ?? 0) + 12,
      });
      if (el) {
        this.app.tree.add(el);
        pasted.push(el);
      }
    }
    if (pasted.length) {
      this.editor.target = pasted.length === 1 ? pasted[0] : pasted;
      this.commitHistory();
    }
  }

  /** 全选：锁定元素被 editor 自动排除 */
  selectAll() {
    const children = (this.app.tree.children as UI[]).filter(
      (el) => !this.isEditorInternal(el),
    );
    if (children.length === 1) {
      this.editor.target = children[0];
    } else if (children.length > 1) {
      this.editor.target = children;
    }
  }

  toFront() {
    this.editor.toTop();
    this.commitHistory();
  }

  toBack() {
    this.editor.toBottom();
    this.commitHistory();
  }

  lock() {
    this.editor.lock();
    this.commitHistory();
  }

  unlock() {
    this.editor.unlock();
    this.commitHistory();
  }

  // ================= 框选 / 套索 =================

  /** 框选按下：在 sky 层创建矩形草稿（sky 不随 zoomLayer 缩放，线宽恒定） */
  private beginSelect(x: number, y: number) {
    this.selecting = true;
    this.editor.cancel();
    this.startX = x;
    this.startY = y;
    this.draft = new Rect({
      x,
      y,
      width: 0,
      height: 0,
      stroke: MARQUEE_STROKE,
      strokeWidth: 1,
      fill: "rgba(79, 140, 255, 0.08)",
      dashPattern: [4, 4],
    });
    this.app.sky.add(this.draft);
  }

  /** 套索按下：在 sky 层创建路径草稿，跟踪指针轨迹 */
  private beginLasso(x: number, y: number) {
    this.selecting = true;
    this.editor.cancel();
    this.selectPoints = [{ x, y }];
    this.draft = new Path({
      path: `M ${x} ${y}`,
      stroke: MARQUEE_STROKE,
      strokeWidth: 1.5,
      fill: undefined, // leafer 2.x 中 "none" 会渲染为黑色实心，必须用 undefined
      strokeCap: "round",
      strokeJoin: "round",
    });
    this.app.sky.add(this.draft);
  }

  private buildLassoPath(points: { x: number; y: number }[]): string {
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      d += ` L ${points[i].x} ${points[i].y}`;
    }
    return d;
  }

  /** 框选/套索松开：移除草稿并按选区命中元素 */
  private finishSelect() {
    this.selecting = false;
    const draft = this.draft;
    this.draft = null;
    if (!draft) {
      return;
    }
    draft.remove();
    const hits =
      this.tool === "lasso"
        ? this.selectByPolygon(this.selectPoints)
        : this.selectByBox({
            x: draft.x ?? 0,
            y: draft.y ?? 0,
            width: draft.width ?? 0,
            height: draft.height ?? 0,
          });
    this.applySelection(hits);
  }

  /** 矩形框选：命中与选框相交的元素（世界包围盒，与 app 坐标同一体系） */
  private selectByBox(box: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): UI[] {
    const hits: UI[] = [];
    if (box.width < 3 || box.height < 3) {
      return hits; // 点击而非拖拽：视为取消选择
    }
    for (const el of this.app.tree.children as UI[]) {
      if (this.isEditorInternal(el)) {
        continue;
      }
      const b = el.worldBoxBounds;
      if (b && rectsIntersect(box, b)) {
        hits.push(el);
      }
    }
    return hits;
  }

  /** 套索选中：命中与套索多边形相交的元素（顶点包含 + 边相交） */
  private selectByPolygon(poly: { x: number; y: number }[]): UI[] {
    const hits: UI[] = [];
    if (poly.length < 3) {
      return hits;
    }
    for (const el of this.app.tree.children as UI[]) {
      if (this.isEditorInternal(el)) {
        continue;
      }
      const b = el.worldBoxBounds;
      if (b && polygonHitsBox(poly, b)) {
        hits.push(el);
      }
    }
    return hits;
  }

  private applySelection(hits: UI[]) {
    if (hits.length === 1) {
      this.editor.target = hits[0];
    } else if (hits.length > 1) {
      this.editor.target = hits;
    } else {
      this.editor.cancel();
    }
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
    // 锁定元素受保护，不可删除
    const targets = list.filter((el) => !el.locked);
    if (!targets.length) {
      return;
    }
    targets.forEach((el) => el.remove());
    this.editor.cancel();
    this.commitHistory();
  }

  // ================= AI 协作 =================

  /** 新增元素（AI 交流模式画流程图等场景），返回分配后的稳定 id；数据非法返回 null */
  addElement(data: ElementData): string | null {
    const el = this.dataToElement({ ...data, id: undefined });
    if (!el) {
      return null;
    }
    this.app.tree.add(el);
    return this.aiIdOf(el);
  }

  /** 当前选中元素的序列化数据（含稳定 id），供 AI 面板 @ 选区使用 */
  getSelectionData(): ElementData[] {
    return this.selectedList
      .map((el) => this.elementToData(el))
      .filter((d): d is ElementData => d !== null);
  }

  /** 按稳定 id 查找画布元素（AI 优化用） */
  private findByAiId(id: string): UI | null {
    const list = (this.app.tree.children ?? []) as UI[];
    return (
      list.find(
        (el) => (el as unknown as { __aiId?: string }).__aiId === id,
      ) ?? null
    );
  }

  /**
   * AI 优化：按稳定 id 更新元素属性（颜色/尺寸/位置/旋转/文字等），返回是否成功。
   * 锁定元素不可修改；fill 为 "none" 时转 undefined（leafer 中 "none" 渲染为黑色实心）。
   * 由调用方（AI 面板）负责合并历史快照。
   */
  updateElement(id: string, patch: Partial<ElementData>): boolean {
    const el = this.findByAiId(id);
    if (!el || el.locked) {
      return false;
    }
    if (patch.stroke !== undefined) {
      if (isFreehandEl(el)) {
        el.fill = patch.stroke || undefined;
      } else {
        el.stroke = patch.stroke || undefined;
      }
    }
    if (patch.strokeWidth !== undefined) {
      el.strokeWidth = patch.strokeWidth;
    }
    if (patch.fill !== undefined) {
      el.fill = patch.fill === "none" ? undefined : patch.fill;
    }
    if (patch.rotation !== undefined) {
      el.rotation = patch.rotation;
    }
    if (patch.x !== undefined) {
      el.x = patch.x;
    }
    if (patch.y !== undefined) {
      el.y = patch.y;
    }
    if (patch.width !== undefined) {
      el.width = patch.width;
    }
    if (patch.height !== undefined) {
      el.height = patch.height;
    }
    if (patch.text !== undefined && el instanceof Text) {
      el.text = patch.text;
    }
    if (patch.fontSize !== undefined && el instanceof Text) {
      el.fontSize = patch.fontSize;
    }
    if (patch.points !== undefined && el instanceof Line) {
      el.points = patch.points as { x: number; y: number }[];
    }
    if (patch.path !== undefined && el instanceof Path) {
      el.path = patch.path;
    }
    this.opts.onMutated();
    return true;
  }

  clearAll() {
    this.app.tree.clear();
    this.editor.cancel();
    this.commitHistory();
  }

  get elementCount() {
    // 排除 editor 内部元素（多选模拟层），避免计数虚增
    return (this.app.tree.children as UI[]).filter(
      (el) => !this.isEditorInternal(el),
    ).length;
  }

  // ================= 图片插入 =================

  /** 从本地文件插入图片：读取为 dataURL，按视口中心放置并限制最大尺寸 */
  async insertImage(file: File): Promise<boolean> {
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const size = await this.imageSize(url);
    if (!size) {
      return false;
    }
    // 大图缩到视口内，小图保持原尺寸
    const MAX = 600;
    const ratio = Math.min(1, MAX / Math.max(size.width, size.height));
    const w = Math.max(1, Math.round(size.width * ratio));
    const h = Math.max(1, Math.round(size.height * ratio));
    const c = this.viewCenter();
    const p = this.app.tree.getInnerPoint({ x: c.x, y: c.y });
    const img = new Image({
      url,
      x: p.x - w / 2,
      y: p.y - h / 2,
      width: w,
      height: h,
    });
    this.app.tree.add(img);
    // 强制重绘：图片为异步加载，避免极端时序下画布不刷新（图片不可见）
    this.app.tree.forceRender();
    this.editor.target = img;
    this.commitHistory();
    return true;
  }

  /** 读取图片自然尺寸（HTMLImageElement 预加载，与 leafer Image 无关） */
  private imageSize(
    url: string,
  ): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
      const img = new window.Image();
      img.onload = () =>
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = url;
    });
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
    // editor 内部元素（多选模拟层等）不参与序列化
    if (this.isEditorInternal(el)) {
      return null;
    }
    const base = {
      id: this.aiIdOf(el),
      x: el.x ?? 0,
      y: el.y ?? 0,
      rotation: el.rotation || undefined,
      stroke: colorOf(el.stroke),
      strokeWidth: numOf(el.strokeWidth),
      locked: el.locked || undefined,
    };
    // 注意：Image 继承自 Rect，必须先于 Rect 判断
    if (el instanceof Image) {
      return {
        ...base,
        type: "image",
        width: el.width ?? 0,
        height: el.height ?? 0,
        url: (el as unknown as { url?: unknown }).url as string | undefined,
      };
    }
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
      const t = el as unknown as {
        __freehandPoints?: number[][];
        __penSize?: number;
        __rough?: { seed: number; original?: string };
      };
      if (t.__freehandPoints) {
        // freehand 笔迹：颜色走 stroke 通道（渲染通道是 fill），采样点用于整理识别/重绘
        return {
          ...base,
          type: "freehand",
          width: el.width ?? 0,
          height: el.height ?? 0,
          path: el.path as string,
          penPoints: t.__freehandPoints,
          penSize: t.__penSize,
          stroke: colorOf(el.fill),
          fill: undefined,
        };
      }
      return {
        ...base,
        type: "path",
        width: el.width ?? 0,
        height: el.height ?? 0,
        path: el.path as string,
        fill: colorOf(el.fill),
        rough: t.__rough,
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
    const el = this.dataToElementInner(d);
    if (el && d.id) {
      // 恢复/导入时把文件里的 id 写回实例缓存，保证 id 稳定
      (el as unknown as { __aiId?: string }).__aiId = d.id;
    }
    return el;
  }

  private dataToElementInner(d: ElementData): UI | null {
    const common = {
      x: d.x,
      y: d.y,
      rotation: d.rotation,
      stroke: d.stroke,
      strokeWidth: d.strokeWidth,
      locked: d.locked || undefined,
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
      case "path": {
        const el = new Path({
          ...common,
          path: d.path,
          fill: fill,
          strokeCap: "round",
          strokeJoin: "round",
        });
        // 手绘风格元素：seed 随数据透传到实例（撤销/重载后序列化不丢）
        if (d.rough) {
          (el as unknown as Record<string, unknown>).__rough = d.rough;
        }
        return el;
      }
      case "freehand": {
        const el = new Path({
          ...common,
          path: d.path,
          fill: d.stroke,
          stroke: undefined,
          strokeCap: "round",
          strokeJoin: "round",
        });
        const t = el as unknown as Record<string, unknown>;
        t.__freehandPoints = d.penPoints;
        t.__penSize = d.penSize;
        return el;
      }
      case "text":
        return new Text({
          ...common,
          text: d.text,
          fontSize: d.fontSize,
          fill: fill ?? d.stroke,
        });
      case "image":
        return new Image({
          ...common,
          url: d.url,
          width: d.width,
          height: d.height,
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
