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
import type { CoordBox } from "./coords";
import { beautifyScene } from "./beautify";
import type { BeautifyStats } from "./beautify";
import { translatePath } from "./path";
import { offsetElementData } from "./offset";
import { History } from "./history";
import type { ToolRegistry } from "./registry";
import { isSketchable, sketchifyData } from "./rough";
import { penSizeOf, strokeOutlinePath } from "./stroke";
import { canvasToLocal, round1 } from "./coords";
import { elementsToSVG } from "./svg";
import type { GridSettings } from "../ui/settings";

export const BACKGROUND = "#1e1f22";
export const TEXT_FONT_SIZE = 18;

// 画布缩放：倍率范围与单步系数（滚轮/按钮共用）
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.25;

// 框选/套索草稿的描边颜色（画在 sky 层，不随缩放变化）
const MARQUEE_STROKE = "#4f8cff";

// 线性元素点编辑手柄尺寸（sky 层，不随缩放变化）
const POINT_HANDLE_SIZE = 10;
// 端点吸附绑定的屏幕距离（px，缩放后世界距离换算保证手感恒定）
const SNAP_BIND_PX = 10;
// 图片裁剪框的最小尺寸（元素局部坐标）
const CROP_MIN = 8;

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

/**
 * 目标元素包围盒边框上离给定世界点最近的点（世界坐标）。
 * 点在内部时取最近边上的投影（保证绑定端点始终落在边框上）。
 */
function nearestBorderPoint(
  target: UI,
  world: { x: number; y: number },
): { x: number; y: number } | null {
  const b = target.worldBoxBounds;
  if (!b) {
    return null;
  }
  if (
    world.x >= b.x &&
    world.x <= b.x + b.width &&
    world.y >= b.y &&
    world.y <= b.y + b.height
  ) {
    // 点在包围盒内部：取到四条边距离最小的边上的投影
    const dL = world.x - b.x;
    const dR = b.x + b.width - world.x;
    const dT = world.y - b.y;
    const dB = b.y + b.height - world.y;
    const m = Math.min(dL, dR, dT, dB);
    if (m === dL) {
      return { x: b.x, y: world.y };
    }
    if (m === dR) {
      return { x: b.x + b.width, y: world.y };
    }
    if (m === dT) {
      return { x: world.x, y: b.y };
    }
    return { x: world.x, y: b.y + b.height };
  }
  // 点在外部：clamp 到边框最近点
  return {
    x: Math.max(b.x, Math.min(world.x, b.x + b.width)),
    y: Math.max(b.y, Math.min(world.y, b.y + b.height)),
  };
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
  /** 选中变化（含取消选择）：回调类型感知的选中信息（供悬浮栏差异化显隐） */
  onSelectionChange?: (info: SelectionInfo) => void;
  /** 文本内联编辑开合变化：编辑中隐藏左侧选中栏（避免遮挡输入框） */
  onTextEditChange?: (editing: boolean) => void;
  /** 画布内自动切换工具（双击文本/线元素切到选择工具）时同步外部 UI（顶栏激活态） */
  onToolChange?: (tool: string) => void;
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

/**
 * 元素数据类型的轻量判定（与 elementToData 的类型分支一致，无序列化副作用）。
 * 供选中信息类型感知（左侧悬浮栏差异化显隐）与绑定判定复用。
 */
function typeOf(el: UI): ElementData["type"] | null {
  // 注意：Image 继承自 Rect，必须先于 Rect 判断
  if (el instanceof Image) {
    return "image";
  }
  if (el instanceof Rect) {
    return "rect";
  }
  if (el instanceof Ellipse) {
    return "ellipse";
  }
  if (el instanceof Line) {
    // leafer 2.x 的 endArrow 默认值是字符串 "none"（truthy），需排除
    return el.endArrow && el.endArrow !== "none" ? "arrow" : "line";
  }
  if (el instanceof Path) {
    return isFreehandEl(el) ? "freehand" : "path";
  }
  if (el instanceof Text) {
    return "text";
  }
  return null;
}

/** 元素是否可应用手绘风格（对齐 rough.isSketchable：已手绘/画笔/文本/图片跳过） */
function isSketchableEl(el: UI): boolean {
  const t = typeOf(el);
  if (t === "rect" || t === "ellipse" || t === "line" || t === "arrow") {
    return true;
  }
  if (t === "path") {
    const rough = (el as unknown as { __rough?: unknown }).__rough;
    const path = String((el as Path).path ?? "");
    // 标准多边形（beautify 输出的 M/L/Z）：仅含 M/L/Z 命令才可手绘化
    return !rough && /^[MLZ\s\d.\-]+$/.test(path) && path.includes("Z");
  }
  return false;
}

/**
 * Line.points 的运行时形态：始终为对象数组（元素数据从 ElementData 透传，
 * leafer 类型声明含 number[] 兼容形态，统一断言避免联合类型困扰）。
 */
function pointsOf(el: Line): { x: number; y: number }[] {
  return (el.points ?? []) as { x: number; y: number }[];
}

/** 恢复元素时把端点绑定 id 透传到实例（序列化/反序列化对称） */
function bindingsToEl(el: UI, d: ElementData) {
  const t = el as unknown as Record<string, unknown>;
  if (d.bindStart) {
    t.__bindStart = d.bindStart;
  }
  if (d.bindEnd) {
    t.__bindEnd = d.bindEnd;
  }
}

/**
 * 选中信息（类型感知）：左侧悬浮栏按选中内容差异化显示按钮。
 * ids 与 types 一一对应（与 elementToData 的类型判定一致）。
 */
export type SelectionInfo = {
  ids: string[];
  types: (ElementData["type"] | null)[];
  hasText: boolean;
  /** 是否含手绘笔迹（✨ 整理按钮显隐） */
  hasFreehand: boolean;
  /** 是否含可手绘化的标准图形（✎ 手绘按钮显隐） */
  hasSketchable: boolean;
  hasImage: boolean;
  anyLocked: boolean;
  allLocked: boolean;
  /** 单选未锁定文字时的字号（字号控件跟随） */
  fontSize?: number;
};

export class Board {
  readonly app: App;
  readonly editor: Editor;
  private opts: BoardOptions;
  private tool: string = "select";
  private drawing = false;
  private draft: UI | null = null;
  /** 组合工具草稿的其余元素（拖拽中与主草稿同步实时预览，松手时无需再补齐） */
  private draftExtras: UI[] = [];
  /** 拖拽统一管线：最近一次生成器输出的元素数据列表（首个为主元素，用于实时刷新草稿与微小判定；组合工具其余元素随草稿实时预览） */
  private draftData: ElementData[] | null = null;
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
  /** 剪贴板内容原始包围盒（复制时从选中元素实际渲染 bounds 记录，含 path/points 坐标语义，粘贴时用于中心对齐） */
  private clipboardBox: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  // 元素稳定 id 分配器（AI 编辑模式按 id 引用元素）
  private nextElId = 1;
  /** 鼠标最后位置（画布坐标，粘贴跟随鼠标用）；null 表示鼠标从未进入画布 */
  private lastPointer: { x: number; y: number } | null = null;
  /** 当前画布背景色（主题切换/导出共用，默认深色） */
  private background = BACKGROUND;
  // 线性元素点编辑：双击 line/arrow 进入，sky 层手柄拖点/双击线段加点
  private pointEditEl: Line | null = null;
  private pointHandles: Rect[] = [];
  private draggingPoint: number | null = null;
  // 拖动端点时原本绑定的端（拖走后解除绑定）
  private dragUnbindStart = false;
  private dragUnbindEnd = false;
  // 图片裁剪：选中单图后 sky 层裁剪框 + 8 手柄，松手即应用（canvas 2D 裁出新图）
  private cropEl: Image | null = null;
  private cropRect: { x: number; y: number; width: number; height: number } | null = null;
  private cropHandles: Rect[] = [];
  private cropDragDir: string | null = null;
  private cropDragged = false;
  /** 文本缩放语义：横向拉伸换行、纵向/对角改字号（记录缩放前的原始状态） */
  private textScaleOrig = new Map<Text, { fontSize: number; width: number }>();
  // 网格：设置（大小/显示/吸附）与网格线层（挂在 zoomLayer 最底层，随缩放/平移重建）
  private grid: GridSettings = { size: 20, show: false, snap: false };
  private gridPath: Path | null = null;

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

    this.editor.on(EditorMoveEvent.MOVE, (e) => {
      // 网格吸附：单选拖动时位置对齐网格（多选保持相对位置不吸附）
      const moved = (e as { operateEvent?: { target?: unknown } }).operateEvent
        ?.target as UI | undefined;
      if (
        this.grid.snap &&
        moved &&
        this.editor.list.length === 1
      ) {
        moved.x = this.snapGrid(moved.x ?? 0);
        moved.y = this.snapGrid(moved.y ?? 0);
      }
      // 契约元素（line/arrow/path）拖动时 leafer 改 x/y，把位移并入 points/path 并归零
      if (moved) {
        this.normalizeContractEl(moved);
      }
      // 移动元素后刷新绑定箭头端点（被绑元素移动时端点跟随）
      this.updateBindings(e);
      this.scheduleHistory();
    });
    this.editor.on(EditorScaleEvent.SCALE, () => this.scheduleHistory());
    this.editor.on(EditorRotateEvent.ROTATE, () => this.scheduleHistory());
    // 文本缩放语义：记录缩放前的原始字号/宽度（横向拉伸换行、纵向/对角改字号）
    this.editor.on(EditorScaleEvent.BEFORE_SCALE, () => this.onBeforeScale());
    this.editor.on(EditorScaleEvent.SCALE, (e) => this.onScaleText(e));
    // 选中变化（选中/多选/取消）：左侧浮动工具栏显隐依赖此事件
    this.editor.on(EditorEvent.AFTER_SELECT, () => {
      const list = this.selectedList;
      const ids: string[] = [];
      const types: (ElementData["type"] | null)[] = [];
      let hasText = false;
      let hasFreehand = false;
      let hasSketchable = false;
      let hasImage = false;
      let anyLocked = false;
      const texts: Text[] = [];
      for (const el of list) {
        const id = this.aiIdOf(el);
        if (id) {
          ids.push(id);
        }
        const t = typeOf(el);
        types.push(t);
        if (t === "text") {
          hasText = true;
          if (!el.locked) {
            texts.push(el as Text);
          }
        } else if (t === "freehand") {
          hasFreehand = true;
        } else if (t === "image") {
          hasImage = true;
        }
        if (isSketchableEl(el)) {
          hasSketchable = true;
        }
        if (el.locked) {
          anyLocked = true;
        }
      }
      // 字号信息：供左侧栏字号控件显隐/跟随（仅单选未锁定文字时给出）
      const fontSize =
        texts.length === 1 && list.length === 1
          ? (texts[0].fontSize ?? TEXT_FONT_SIZE)
          : undefined;
      this.opts.onSelectionChange?.({
        ids,
        types,
        hasText,
        hasFreehand,
        hasSketchable,
        hasImage,
        anyLocked,
        allLocked: list.length > 0 && anyLocked,
        fontSize,
      });
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
      // 非选择工具下退出点编辑/图片裁剪（sky 层手柄不可残留）
      this.exitPointEdit();
      this.cancelCrop();
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
    this.updateGrid();
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
    this.updateGrid();
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
    // 缩放后重建 sky 层手柄（点编辑/裁剪框跟随世界坐标）
    if (this.pointEditEl) {
      this.buildPointHandles();
    }
    if (this.cropEl) {
      this.buildCropUI();
    }
  };

  get currentTool() {
    return this.tool;
  }

  // ================= 文本缩放语义 =================

  /** 缩放开始：记录选中 Text 的原始字号/宽度（BEFORE_SCALE 在变换前触发一次） */
  private onBeforeScale() {
    this.textScaleOrig.clear();
    for (const el of this.selectedList) {
      if (el instanceof Text && !el.locked) {
        this.textScaleOrig.set(el, {
          fontSize: el.fontSize ?? TEXT_FONT_SIZE,
          width: el.width ?? 0,
        });
      }
    }
  }

  /**
   * 文本缩放语义（对齐 Excalidraw）：横向拉伸→换行区域变宽；纵向拉伸→字号变大；
   * 对角拉伸→字号按面积开方等比放大。SCALE 在变换应用后触发，scaleX/scaleY
   * 为相对缩放开始时的累计比例。方向用 e.direction 判定（editor 配置 lockRatio
   * 时边中点缩放会锁定另一轴同比例，按 sx/sy 比值无法区分横纵）。
   * 语义化修改后把 scaleX/scaleY 归 1，避免文字被非均匀拉伸变形。
   */
  private onScaleText(e: EditorScaleEvent) {
    if (!this.textScaleOrig.size) {
      return;
    }
    const sx = Math.abs(e.scaleX ?? 1);
    const sy = Math.abs(e.scaleY ?? 1);
    const TH = 1.03; // 3% 死区：避免微小拖动触发语义切换
    const dir = String(e.direction ?? "");
    const isHorizontal = dir === "right" || dir === "left";
    const isVertical = dir === "top" || dir === "bottom";
    for (const [el, orig] of this.textScaleOrig) {
      if (el.locked) {
        continue;
      }
      if (isHorizontal && sx > TH) {
        // 横向拉伸：开启按宽度换行，字号不变
        el.textWrap = "break";
        el.width = Math.max(1, orig.width * sx);
      } else if (isVertical && sy > TH) {
        // 纵向拉伸：字号变大，换行宽度不变
        el.fontSize = Math.max(4, Math.round(orig.fontSize * sy));
      } else if (sx > TH && sy > TH) {
        // 对角拉伸：字号按缩放面积开方等比放大
        el.fontSize = Math.max(4, Math.round(orig.fontSize * Math.sqrt(sx * sy)));
      } else if (sx > TH) {
        el.textWrap = "break";
        el.width = Math.max(1, orig.width * sx);
      } else if (sy > TH) {
        el.fontSize = Math.max(4, Math.round(orig.fontSize * sy));
      }
      el.scaleX = 1;
      el.scaleY = 1;
    }
    this.scheduleHistory();
  }

  // ================= 绘制交互 =================

  private onDown(e: IPointerEvent) {
    // 右键（button=2）不参与绘制/选择交互：选择变更仅由 contextmenu 流程决定，
    // 避免多选后右键时 leafer 的 DOWN 事件把选择取消/替换
    if (e.right) {
      return;
    }
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
      // 图片裁剪中：拖动裁剪框手柄调整 / 点击外部取消
      if (this.cropEl) {
        this.handleCropDown(e.x ?? 0, e.y ?? 0);
        return;
      }
      // 点编辑中：命中手柄开始拖点；点击空白退出；点击其他元素切换编辑目标
      if (this.pointEditEl) {
        const idx = this.hitPointHandle(e.x ?? 0, e.y ?? 0);
        if (idx >= 0) {
          this.draggingPoint = idx;
          const t = this.pointEditEl as unknown as {
            __bindStart?: string;
            __bindEnd?: string;
          };
          // 拖动原本绑定的端点：松手后解除该端绑定（拖走即解绑）
          const pts = pointsOf(this.pointEditEl);
          this.dragUnbindStart = idx === 0 && !!t.__bindStart;
          this.dragUnbindEnd = idx === pts.length - 1 && !!t.__bindEnd;
          return;
        }
        const hit = this.hitTest({ x: e.x ?? 0, y: e.y ?? 0 });
        if (!hit) {
          // 点击空白：退出点编辑，继续走下方正常 select 流程（取消选择）
          this.exitPointEdit();
        } else if (hit !== this.pointEditEl) {
          if (hit instanceof Line) {
            this.enterPointEdit(hit);
          } else {
            this.exitPointEdit();
            this.editor.target = hit ?? undefined;
          }
          return;
        } else {
          return; // 点击元素本体：保持点编辑
        }
      }
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
    // 点击工具：点击点即生成位置（x0=x1=点击点），生成器返回固定大小元素，一次性提交
    if (kind === "click") {
      const sx = this.snapGrid(px);
      const sy = this.snapGrid(py);
      const list = this.runGenerator(sx, sy, sx, sy);
      if (list?.length) {
        for (const d of list) {
          const el = this.dataToElement(d);
          if (el) {
            this.app.tree.add(el);
          }
        }
        this.commitHistory();
      }
      return;
    }
    // 统一拖拽管线：内置 rect/ellipse/line/arrow 与 AI 生成工具同一条路径
    if (kind !== "drag") {
      return;
    }
    this.drawing = true;
    this.startX = this.snapGrid(px);
    this.startY = this.snapGrid(py);
    this.draftData = this.runGenerator(this.startX, this.startY, this.startX, this.startY);
    if (!this.draftData) {
      this.drawing = false;
      return;
    }
    this.draft = this.dataToElement(this.draftData[0]);
    if (this.draft) {
      this.app.tree.add(this.draft);
    }
    // 组合工具：其余元素同步建草稿（拖拽中实时预览全貌，松手时无需再补齐）
    for (const d of this.draftData.slice(1)) {
      const el = this.dataToElement(d);
      if (el) {
        this.app.tree.add(el);
        this.draftExtras.push(el);
      }
    }
  }

  /** 调用当前工具的生成器（统一拖拽管线），异常时安全返回 null；返回值统一为元素列表 */
  private runGenerator(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): ElementData[] | null {
    const gen = this.opts.registry.getGenerator(this.tool);
    if (!gen) {
      return null;
    }
    try {
      const out = gen({ x0, y0, x1, y1, style: this.opts.getStyle() });
      const list = Array.isArray(out) ? out : [out];
      // 轻量校验：高频调用不做全量 schema 校验，只拦明显非法输出
      if (
        !list.length ||
        !list.every((d) => d && typeof d === "object" && typeof d.type === "string")
      ) {
        return null;
      }
      return list;
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
    // 记录鼠标画布坐标（粘贴跟随鼠标；状态栏坐标由 main.ts 另行监听）
    if (e.x != null && e.y != null) {
      const p = this.app.tree.getInnerPoint({ x: e.x, y: e.y });
      this.lastPointer = { x: p.x, y: p.y };
    }
    // 手型拖拽：按指针位移移动 zoomLayer
    if (this.panning) {
      const layer = this.app.tree.zoomLayer;
      if (layer) {
        layer.x = this.panLayerStart.x + (e.x ?? 0) - this.panStart.x;
        layer.y = this.panLayerStart.y + (e.y ?? 0) - this.panStart.y;
      }
      this.updateGrid();
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
        item.el.x = this.snapGrid(item.x + dx);
        item.el.y = this.snapGrid(item.y + dy);
        // 契约元素（line/arrow/path）位移并入 points/path，避免双重偏移
        this.normalizeContractEl(item.el);
      }
      this.scheduleHistory();
      return;
    }
    // 点编辑拖点：指针跟随（Shift 锁 45° 角；端点靠近形状时吸附绑定）
    if (this.draggingPoint !== null && this.pointEditEl) {
      this.movePointTo(
        this.draggingPoint,
        { x: e.x ?? 0, y: e.y ?? 0 },
        e.shiftKey,
      );
      this.scheduleHistory();
      return;
    }
    // 图片裁剪：拖动手柄调整裁剪区域
    if (this.cropEl && this.cropDragDir) {
      this.cropDragged = true;
      this.resizeCrop(e.x ?? 0, e.y ?? 0);
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
      const data = this.runGenerator(
        this.startX,
        this.startY,
        this.snapGrid(px),
        this.snapGrid(py),
      );
      if (data) {
        this.draftData = data;
        this.applyDataToDraft(this.draft, data[0]);
        // 组合工具其余草稿元素同步刷新
        for (let i = 0; i < this.draftExtras.length; i++) {
          const d = data[i + 1];
          if (d) {
            this.applyDataToDraft(this.draftExtras[i], d);
          }
        }
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
    // 点编辑拖点结束：拖走原本绑定的端点即解除绑定，并提交历史
    if (this.draggingPoint !== null) {
      this.draggingPoint = null;
      if ((this.dragUnbindStart || this.dragUnbindEnd) && this.pointEditEl) {
        const t = this.pointEditEl as unknown as {
          __bindStart?: string;
          __bindEnd?: string;
        };
        if (this.dragUnbindStart) {
          t.__bindStart = undefined;
        }
        if (this.dragUnbindEnd) {
          t.__bindEnd = undefined;
        }
      }
      this.dragUnbindStart = false;
      this.dragUnbindEnd = false;
      this.commitHistory();
      return;
    }
    // 裁剪框调整结束：松手即应用裁剪（canvas 2D 裁出新图）
    if (this.cropEl && this.cropDragDir) {
      this.cropDragDir = null;
      if (this.cropDragged) {
        void this.applyCrop();
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
        for (const el of this.draftExtras) {
          el.remove();
        }
      } else if (this.opts.registry.getKind(this.tool) === "freehand") {
        // 笔迹转正：挂载采样点元数据，序列化时输出 freehand 元素（供整理识别/重绘）
        const t = this.draft as unknown as Record<string, unknown>;
        t.__freehandPoints = this.penPoints.map((p) => [...p]);
        t.__penSize = this.penSize;
      }
      // 组合工具草稿其余元素已在画布上（拖拽中实时预览），无需补齐
      this.draft = null;
      this.draftExtras = [];
      this.draftData = null;
      this.commitHistory();
    }
  }

  /** 草稿是否过于微小（点击而非拖拽）：自由笔迹看点数，拖拽管线看生成数据尺寸 */
  private isTinyDraft(): boolean {
    if (this.opts.registry.getKind(this.tool) === "freehand") {
      return this.penPoints.length < 2;
    }
    const list = this.draftData;
    if (!list?.length) {
      return true;
    }
    // 组合工具：任一元素达到有效尺寸即非微小（避免首元素是短文本时误删整个组合）
    return list.every((d) => {
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
    });
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

    if (!isDouble) {
      return;
    }
    // 双击：文本就地编辑；线性元素进入点编辑（再次双击线段则插入新点）
    // 当前工具不是选择工具时自动切换（组合工具画完即可直接双击修改标题，无需手动切回选择）
    const target = e.target;
    if (target instanceof Text || target instanceof Line) {
      if (this.tool !== "select") {
        this.setTool("select");
        this.opts.onToolChange?.(this.tool);
      }
      this.editor.select(target);
    }
    if (target instanceof Text) {
      this.openTextEdit(target);
    } else if (target instanceof Line) {
      if (this.pointEditEl === target) {
        this.addPointAt(e.x ?? 0, e.y ?? 0);
      } else {
        this.enterPointEdit(target);
      }
    }
  }

  /** 打开文本内联编辑：先选中元素（openInnerEditor 仅对单选状态生效），并聚焦覆盖层 */
  private openTextEdit(el: Text) {
    (el as unknown as Record<string, unknown>).__textBeforeEdit = String(
      el.text ?? "",
    );
    // 编辑中隐藏左侧选中栏（避免遮挡输入框与干扰交互）
    this.opts.onTextEditChange?.(true);
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
    // 编辑结束：恢复左侧选中栏显隐判定
    this.opts.onTextEditChange?.(false);
  }

  // ================= 线性元素点编辑（双击进入） =================

  /** 进入点编辑：隐藏编辑框，显示 sky 层点手柄（拖点/双击线段加点/Shift 锁角） */
  private enterPointEdit(el: Line) {
    if (el.locked) {
      return;
    }
    this.exitPointEdit();
    this.cancelCrop();
    this.editor.cancel();
    this.pointEditEl = el;
    this.buildPointHandles();
  }

  /** 退出点编辑：清除手柄与拖动状态（ESC/点击空白/切换工具时调用） */
  exitPointEdit() {
    this.draggingPoint = null;
    this.dragUnbindStart = false;
    this.dragUnbindEnd = false;
    this.pointEditEl = null;
    this.clearPointHandles();
  }

  private clearPointHandles() {
    for (const h of this.pointHandles) {
      h.remove();
    }
    this.pointHandles = [];
  }

  /** 按当前 points 重建点手柄（sky 层，元素局部坐标 → 世界坐标摆放） */
  private buildPointHandles() {
    this.clearPointHandles();
    const el = this.pointEditEl;
    if (!el) {
      return;
    }
    for (const p of pointsOf(el)) {
      const world = el.getWorldPoint(p);
      const h = new Rect({
        x: world.x - POINT_HANDLE_SIZE / 2,
        y: world.y - POINT_HANDLE_SIZE / 2,
        width: POINT_HANDLE_SIZE,
        height: POINT_HANDLE_SIZE,
        cornerRadius: POINT_HANDLE_SIZE / 2,
        fill: "#4f8cff",
        stroke: "#ffffff",
        strokeWidth: 1,
      });
      this.pointHandles.push(h);
      this.app.sky.add(h);
    }
  }

  /** 命中的手柄索引（app 坐标），未命中返回 -1 */
  private hitPointHandle(ax: number, ay: number): number {
    for (let i = 0; i < this.pointHandles.length; i++) {
      const b = this.pointHandles[i].worldBoxBounds;
      if (
        b &&
        ax >= b.x - 4 &&
        ax <= b.x + b.width + 4 &&
        ay >= b.y - 4 &&
        ay <= b.y + b.height + 4
      ) {
        return i;
      }
    }
    return -1;
  }

  /** 拖动中的点跟随指针（世界坐标 → 元素局部，Shift 锁 45° 角；端点吸附绑定） */
  private movePointTo(
    idx: number,
    world: { x: number; y: number },
    shiftKey: boolean | undefined,
  ) {
    const el = this.pointEditEl;
    if (!el) {
      return;
    }
    const pts = [...pointsOf(el)];
    if (idx < 0 || idx >= pts.length) {
      return;
    }
    let p = el.getLocalPoint(world);
    if (shiftKey) {
      // 45° 锁角：以相邻点为基准（首点取后一点，其余取前一点）
      const ref = pts[idx > 0 ? idx - 1 : Math.min(1, pts.length - 1)];
      const angle =
        Math.round(Math.atan2(p.y - ref.y, p.x - ref.x) / (Math.PI / 4)) *
        (Math.PI / 4);
      const dist = Math.hypot(p.x - ref.x, p.y - ref.y);
      p = { x: ref.x + dist * Math.cos(angle), y: ref.y + dist * Math.sin(angle) };
    }
    // 端点靠近形状包围盒边框时吸附并绑定（P3-2）
    const snapped = this.snapEndpoint(pts, idx, p);
    if (snapped) {
      p = snapped;
    }
    pts[idx] = p;
    el.points = pts;
    this.buildPointHandles();
  }

  /** 双击线段插入新点（app 坐标，命中线段容差 10 局部单位） */
  private addPointAt(ax: number, ay: number) {
    const el = this.pointEditEl;
    if (!el) {
      return;
    }
    const local = el.getLocalPoint({ x: ax, y: ay });
    const pts = pointsOf(el);
    if (pts.length < 2) {
      return;
    }
    let seg = -1;
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = distToSegment(local, pts[i], pts[i + 1]);
      if (d < best) {
        best = d;
        seg = i;
      }
    }
    if (seg < 0 || best > 10) {
      return;
    }
    const np = [...pts];
    np.splice(seg + 1, 0, { x: local.x, y: local.y });
    el.points = np;
    this.buildPointHandles();
    this.scheduleHistory();
  }

  // ================= 箭头端点绑定 =================

  /**
   * 端点吸附绑定：拖动端点靠近形状包围盒边框时吸附到最近点并记录绑定 id
   * （被绑元素移动时端点自动跟随）。返回吸附后的局部坐标；未吸附返回 null。
   */
  private snapEndpoint(
    pts: { x: number; y: number }[],
    idx: number,
    local: { x: number; y: number },
  ): { x: number; y: number } | null {
    const el = this.pointEditEl;
    if (!el) {
      return null;
    }
    // 屏幕距离换算世界距离（缩放后吸附手感恒定）
    const snap = SNAP_BIND_PX / this.scale;
    const world = el.getWorldPoint(local);
    let best: UI | null = null;
    let bestD = snap;
    for (const other of this.app.tree.children as UI[]) {
      if (other === el || this.isEditorInternal(other) || other.locked) {
        continue;
      }
      const b = other.worldBoxBounds;
      if (!b) {
        continue;
      }
      const cx = Math.max(b.x, Math.min(world.x, b.x + b.width));
      const cy = Math.max(b.y, Math.min(world.y, b.y + b.height));
      const d = Math.hypot(world.x - cx, world.y - cy);
      if (d <= bestD) {
        bestD = d;
        best = other;
      }
    }
    if (!best) {
      return null;
    }
    const anchor = nearestBorderPoint(best, world);
    if (!anchor) {
      return null;
    }
    const t = el as unknown as Record<string, unknown>;
    if (idx === 0) {
      t.__bindStart = this.aiIdOf(best);
    } else if (idx === pts.length - 1) {
      t.__bindEnd = this.aiIdOf(best);
    }
    return el.getLocalPoint(anchor);
  }

  /**
   * 移动元素后刷新绑定箭头端点：绑定端跟随被绑元素包围盒边框最近点。
   * 正在被移动的箭头本体跳过（保留用户拖动的相对位置）；被绑元素已删除时解除绑定。
   */
  private updateBindings(e?: { operateEvent?: { target?: unknown } }) {
    const moved = (e?.operateEvent as { target?: unknown } | undefined)
      ?.target;
    for (const el of this.app.tree.children as UI[]) {
      if (el === moved || !(el instanceof Line)) {
        continue;
      }
      const t = el as unknown as { __bindStart?: string; __bindEnd?: string };
      const pts = pointsOf(el);
      if (pts.length < 2 || (!t.__bindStart && !t.__bindEnd)) {
        continue;
      }
      let changed = false;
      if (t.__bindStart) {
        const target = this.findByAiId(t.__bindStart);
        if (!target || target === el) {
          t.__bindStart = undefined; // 被绑元素已删除：解除绑定
          changed = true;
        } else {
          const far = el.getWorldPoint(pts[pts.length - 1]);
          const anchor = nearestBorderPoint(target, far);
          if (anchor) {
            pts[0] = el.getLocalPoint(anchor);
            changed = true;
          }
        }
      }
      if (t.__bindEnd) {
        const target = this.findByAiId(t.__bindEnd);
        if (!target || target === el) {
          t.__bindEnd = undefined;
          changed = true;
        } else {
          const far = el.getWorldPoint(pts[0]);
          const anchor = nearestBorderPoint(target, far);
          if (anchor) {
            pts[pts.length - 1] = el.getLocalPoint(anchor);
            changed = true;
          }
        }
      }
      if (changed) {
        el.points = pts;
      }
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
        if (isFreehandEl(el)) {
          // 画笔笔迹视觉粗细由轮廓（penSize）决定：按新粗细重算轮廓并更新元数据，
          // 否则仅改 strokeWidth 数据透传，画面粗细不变
          const pts = (el as unknown as { __freehandPoints?: number[][] })
            .__freehandPoints;
          const pen = penSizeOf(partial.strokeWidth);
          const path = strokeOutlinePath(pts ?? [], { size: pen });
          if (path) {
            (el as Path).path = path;
            (el as unknown as { __penSize?: number }).__penSize = pen;
          }
        }
        el.strokeWidth = partial.strokeWidth;
      }
      if (partial.fontSize !== undefined && el instanceof Text) {
        el.fontSize = partial.fontSize;
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
      // 右键未选中元素：追加进当前选择（多选不取消），无选择时直接选中
      const cur = this.selectedList;
      this.editor.target = cur.length ? [...cur, hit] : hit;
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
    const list = this.selectedList;
    this.clipboard = list
      .map((el) => this.elementToData(el))
      .filter((d): d is ElementData => d !== null);
    // 记录选中元素实际渲染包围盒（本地坐标 = 画布世界坐标，与 lastPointer 的 tree.getInnerPoint 同基准；
    // 不能用默认 world 基准——tree 承载缩放/平移时 world 是视口坐标，粘贴定位会错乱）
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of list) {
      try {
        const b = el.getBounds("box", "local");
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + b.height);
      } catch {
        // bounds 不可用时跳过（clipboardBox 为 null 时粘贴回退为原位置偏移）
      }
    }
    this.clipboardBox = Number.isFinite(minX)
      ? { minX, minY, maxX, maxY }
      : null;
    return this.clipboard.length > 0;
  }

  /** 剪切 = 复制 + 删除 */
  cut() {
    if (this.copy()) {
      this.deleteSelected();
    }
  }

  /** 粘贴剪贴板内容：优先跟随鼠标最后位置（剪贴板实际渲染包围盒中心对齐），
   * 鼠标未进入过画布时回退为原位置偏移 12px；粘贴后选中新元素 */
  paste() {
    if (!this.clipboard.length) {
      return;
    }
    let dx = 12;
    let dy = 12;
    if (this.lastPointer && this.clipboardBox) {
      // 跟随鼠标：剪贴板原始包围盒中心对齐（复制时从元素实际渲染 bounds 记录）
      dx =
        this.lastPointer.x -
        (this.clipboardBox.minX + this.clipboardBox.maxX) / 2;
      dy =
        this.lastPointer.y -
        (this.clipboardBox.minY + this.clipboardBox.maxY) / 2;
    }
    const pasted: UI[] = [];
    for (const d of this.clipboard) {
      // 整体平移按元素坐标语义区分（line/arrow/path 平移 points/path、其余平移 x/y），
      // 避免绝对坐标契约元素双重偏移；id 不随粘贴复制（粘贴出的元素分配全新 id）
      const el = this.dataToElement({
        ...offsetElementData(d, dx, dy),
        id: undefined,
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

  /**
   * 契约元素归一化：line/arrow/path（非 freehand）的数据契约是“points/path 画布绝对坐标 + x/y 置 0”，
   * leafer 拖动/吸附这类元素时改的是 x/y，需把位移并入 points/path 并归零，避免双重偏移。
   */
  private normalizeContractEl(el: UI) {
    if (el instanceof Line) {
      const dx = el.x ?? 0;
      const dy = el.y ?? 0;
      if (dx || dy) {
        // 画布内 line 的 points 均为对象数组（扁平 number[] 仅存在于类型定义中）
        const pts = (el.points ?? []).filter(
          (p): p is { x: number; y: number } =>
            typeof p === "object" && p !== null,
        );
        el.points = pts.map((p) => ({
          x: p.x + dx,
          y: p.y + dy,
        }));
        el.x = 0;
        el.y = 0;
      }
    } else if (el instanceof Path) {
      const t = el as unknown as { __freehandPoints?: number[][] };
      // freehand 的 x/y + 局部轮廓 path 语义自洽，不归一化
      if (!t.__freehandPoints) {
        const dx = el.x ?? 0;
        const dy = el.y ?? 0;
        if (dx || dy) {
          el.path = translatePath(el.path as string, dx, dy);
          el.x = 0;
          el.y = 0;
        }
      }
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
    // 删除可能命中点编辑/裁剪中的元素：一并退出对应模式
    this.exitPointEdit();
    this.cancelCrop();
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
      // AI 传入画布绝对坐标（describeCanvas 输出基准），换算回元素局部坐标
      el.points = (patch.points as { x: number; y: number }[]).map((p) =>
        canvasToLocal(el as unknown as CoordBox, p),
      );
    }
    if (patch.path !== undefined && el instanceof Path) {
      el.path = patch.path;
    }
    this.opts.onMutated();
    return true;
  }

  clearAll() {
    this.exitPointEdit();
    this.cancelCrop();
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

  // ================= 图片裁剪 =================

  /**
   * 进入图片裁剪：选中单张未旋转图片时显示 sky 层裁剪框与 8 手柄，
   * 拖动手柄调整裁剪区域，松手即应用（canvas 2D 裁出新图替换 url）。
   */
  startCrop(): boolean {
    const list = this.selectedList;
    if (list.length !== 1 || !(list[0] instanceof Image)) {
      return false;
    }
    const img = list[0] as Image;
    if (img.locked || (img.rotation ?? 0) !== 0) {
      return false;
    }
    this.exitPointEdit();
    this.editor.cancel();
    this.cropEl = img;
    this.cropRect = { x: 0, y: 0, width: img.width ?? 0, height: img.height ?? 0 };
    this.cropDragDir = null;
    this.cropDragged = false;
    this.buildCropUI();
    return true;
  }

  /** 取消裁剪：清除裁剪 UI，不应用修改 */
  cancelCrop() {
    this.cropEl = null;
    this.cropRect = null;
    this.cropDragDir = null;
    this.cropDragged = false;
    for (const h of this.cropHandles) {
      h.remove();
    }
    this.cropHandles = [];
  }

  /** 重建裁剪框与 8 方向手柄（sky 层，图片局部坐标 → 世界坐标摆放） */
  private buildCropUI() {
    const img = this.cropEl;
    const r = this.cropRect;
    if (!img || !r) {
      return;
    }
    for (const h of this.cropHandles) {
      h.remove();
    }
    this.cropHandles = [];
    const tl = img.getWorldPoint({ x: r.x, y: r.y });
    const tr = img.getWorldPoint({ x: r.x + r.width, y: r.y });
    const bl = img.getWorldPoint({ x: r.x, y: r.y + r.height });
    const br = img.getWorldPoint({ x: r.x + r.width, y: r.y + r.height });
    const box = {
      x: Math.min(tl.x, tr.x, bl.x, br.x),
      y: Math.min(tl.y, tr.y, bl.y, br.y),
      width: Math.max(tl.x, tr.x, bl.x, br.x) - Math.min(tl.x, tr.x, bl.x, br.x),
      height:
        Math.max(tl.y, tr.y, bl.y, br.y) - Math.min(tl.y, tr.y, bl.y, br.y),
    };
    // 裁剪框（index 0 为框体，非手柄）
    const frame = new Rect({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      stroke: MARQUEE_STROKE,
      strokeWidth: 1.5,
      fill: "rgba(79, 140, 255, 0.06)",
      dashPattern: [4, 4],
    });
    this.cropHandles.push(frame);
    this.app.sky.add(frame);
    const SIZE = 9;
    for (const dir of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
      const pos = this.cropHandlePos(dir, box);
      const h = new Rect({
        x: pos.x - SIZE / 2,
        y: pos.y - SIZE / 2,
        width: SIZE,
        height: SIZE,
        fill: "#ffffff",
        stroke: MARQUEE_STROKE,
        strokeWidth: 1,
      });
      (h as unknown as Record<string, unknown>).__dir = dir;
      this.cropHandles.push(h);
      this.app.sky.add(h);
    }
  }

  /** 8 方向手柄在裁剪框上的锚点位置（世界坐标） */
  private cropHandlePos(
    dir: string,
    box: { x: number; y: number; width: number; height: number },
  ): { x: number; y: number } {
    switch (dir) {
      case "nw":
        return { x: box.x, y: box.y };
      case "n":
        return { x: box.x + box.width / 2, y: box.y };
      case "ne":
        return { x: box.x + box.width, y: box.y };
      case "e":
        return { x: box.x + box.width, y: box.y + box.height / 2 };
      case "se":
        return { x: box.x + box.width, y: box.y + box.height };
      case "s":
        return { x: box.x + box.width / 2, y: box.y + box.height };
      case "sw":
        return { x: box.x, y: box.y + box.height };
      case "w":
        return { x: box.x, y: box.y + box.height / 2 };
    }
    return { x: box.x, y: box.y };
  }

  /** 裁剪中按下：命中手柄开始调整；未命中（含点击框内空白）取消裁剪 */
  private handleCropDown(ax: number, ay: number) {
    // index 0 是裁剪框体，从 1 开始才是可拖手柄
    for (let i = 1; i < this.cropHandles.length; i++) {
      const b = this.cropHandles[i].worldBoxBounds;
      if (
        b &&
        ax >= b.x - 4 &&
        ax <= b.x + b.width + 4 &&
        ay >= b.y - 4 &&
        ay <= b.y + b.height + 4
      ) {
        this.cropDragDir =
          (this.cropHandles[i] as unknown as { __dir?: string }).__dir ?? null;
        this.cropDragged = false;
        return;
      }
    }
    this.cancelCrop();
  }

  /** 拖动手柄调整裁剪区域（指针世界坐标 → 图片局部坐标，clamp 在图片内） */
  private resizeCrop(ax: number, ay: number) {
    const img = this.cropEl;
    const r = this.cropRect;
    const dir = this.cropDragDir;
    if (!img || !r || !dir) {
      return;
    }
    const p = img.getLocalPoint({ x: ax, y: ay });
    const W = img.width ?? 1;
    const H = img.height ?? 1;
    let { x, y, width, height } = r;
    if (dir.includes("n")) {
      const ny = Math.min(p.y, y + height - CROP_MIN);
      height = y + height - Math.max(0, ny);
      y = Math.max(0, ny);
    }
    if (dir.includes("s")) {
      height = Math.max(CROP_MIN, Math.min(p.y, H) - y);
    }
    if (dir.includes("w")) {
      const nx = Math.min(p.x, x + width - CROP_MIN);
      width = x + width - Math.max(0, nx);
      x = Math.max(0, nx);
    }
    if (dir.includes("e")) {
      width = Math.max(CROP_MIN, Math.min(p.x, W) - x);
    }
    this.cropRect = { x, y, width, height };
    this.buildCropUI();
  }

  /**
   * 应用裁剪：leafer 无 clip 能力，用 canvas 2D 按裁剪区域裁出新图替换 url，
   * 图片元素位置偏移到裁剪框左上角、宽高收窄为裁剪区域。
   */
  private async applyCrop() {
    const img = this.cropEl;
    const r = this.cropRect;
    if (!img || !r) {
      this.cancelCrop();
      return;
    }
    const url = (img as unknown as { url?: unknown }).url as string | undefined;
    const natural = url ? await this.imageSize(url) : null;
    if (!url || !natural) {
      this.cancelCrop();
      return;
    }
    // 元素局部坐标 → 图片像素坐标（按显示尺寸与自然尺寸的比例换算）
    const iw = img.width ?? 1;
    const ih = img.height ?? 1;
    const sx = Math.max(0, Math.round((r.x / iw) * natural.width));
    const sy = Math.max(0, Math.round((r.y / ih) * natural.height));
    const sw = Math.max(1, Math.round((r.width / iw) * natural.width));
    const sh = Math.max(1, Math.round((r.height / ih) * natural.height));
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      this.cancelCrop();
      return;
    }
    const source = new window.Image();
    await new Promise<void>((resolve, reject) => {
      source.onload = () => resolve();
      source.onerror = () => reject(new Error("图片加载失败"));
      source.src = url;
    }).catch(() => undefined);
    if (!source.naturalWidth) {
      this.cancelCrop();
      return;
    }
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    const newUrl = canvas.toDataURL("image/png");
    // 裁剪区域（元素局部坐标）→ 元素位置偏移与尺寸收窄（startCrop 已排除旋转）
    img.x = (img.x ?? 0) + r.x;
    img.y = (img.y ?? 0) + r.y;
    img.width = r.width;
    img.height = r.height;
    (img as unknown as { url?: string }).url = newUrl;
    this.cancelCrop();
    this.editor.target = img;
    this.commitHistory();
    this.opts.onMutated();
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
      const t = el as unknown as { __bindStart?: string; __bindEnd?: string };
      return {
        ...base,
        // leafer 2.x 的 endArrow 默认值是字符串 "none"（truthy），需排除
        type: (el.endArrow && el.endArrow !== "none"
          ? "arrow"
          : "line") as "arrow" | "line",
        width: el.width ?? 0,
        height: el.height ?? 0,
        points: el.points as { x: number; y: number }[] | undefined,
        bindStart: t.__bindStart,
        bindEnd: t.__bindEnd,
      };
    }
    if (el instanceof Path) {
      const t = el as unknown as {
        __freehandPoints?: number[][];
        __penSize?: number;
        __rough?: { seed: number; original?: string };
      };
      // 元素位移（leafer 移动 Path 时改 x/y、path 不变），导出时并入 path
      const dx = el.x ?? 0;
      const dy = el.y ?? 0;
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
        // 归一化：leafer Path 渲染 = (x, y) + path 坐标，数据契约统一为
        // “path 画布绝对坐标 + x/y 置 0”，导出时把元素位移并入 path，避免双重偏移
        x: 0,
        y: 0,
        path: dx || dy ? translatePath(el.path as string, dx, dy) : (el.path as string),
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
    // 重建场景：退出点编辑/图片裁剪（sky 层手柄不随 tree.clear 清除）
    this.exitPointEdit();
    this.cancelCrop();
    this.app.tree.clear();
    for (const d of data) {
      const el = this.dataToElement(d);
      if (el) {
        this.app.tree.add(el);
      }
    }
    this.editor.cancel();
    this.updateGrid();
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
      case "line": {
        const el = new Line({ ...common, points: d.points });
        bindingsToEl(el, d);
        return el;
      }
      case "arrow": {
        const el = new Line({
          ...common,
          points: d.points,
          endArrow: "triangle",
        });
        bindingsToEl(el, d);
        return el;
      }
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

  /** 导出画布为 SVG 文档字符串（矢量，可无损缩放；图片以 dataURL 内嵌） */
  exportSVG(): string {
    return elementsToSVG(this.serialize(), this.background);
  }

  // ================= 网格 =================

  /**
   * 应用网格设置（设置弹窗调用）：保存并重建网格线；吸附在绘制/移动时即时生效。
   */
  applyGrid(g: GridSettings) {
    this.grid = { ...g };
    this.updateGrid();
  }

  /** 数值对齐到网格（吸附关闭或网格尺寸非法时原样返回） */
  private snapGrid(v: number): number {
    if (!this.grid.snap || !this.grid.size || this.grid.size < 4) {
      return v;
    }
    return Math.round(v / this.grid.size) * this.grid.size;
  }

  /**
   * 重建网格线：挂在 zoomLayer 最底层，覆盖当前视口的画布世界范围，
   * 线宽随缩放反向（1/scale）保持 1px 屏幕宽度；关闭时移除。
   */
  private updateGrid() {
    const layer = this.app.tree.zoomLayer;
    if (!layer) {
      return;
    }
    if (!this.grid.show || !this.grid.size || this.grid.size < 4) {
      this.gridPath?.remove();
      this.gridPath = null;
      return;
    }
    const view = this.app.canvas.view as HTMLElement;
    const vw = this.app.width ?? view.clientWidth;
    const vh = this.app.height ?? view.clientHeight;
    const s = layer.scaleX ?? 1;
    const ox = layer.x ?? 0;
    const oy = layer.y ?? 0;
    const size = this.grid.size;
    // 视口四角的画布世界坐标 → 对齐到网格整数倍（与吸附同基准，线/元素对齐）
    const x0 = Math.floor((0 - ox) / s / size) * size;
    const y0 = Math.floor((0 - oy) / s / size) * size;
    const x1 = Math.ceil((vw - ox) / s / size) * size;
    const y1 = Math.ceil((vh - oy) / s / size) * size;
    const parts: string[] = [];
    for (let x = x0; x <= x1; x += size) {
      parts.push(`M ${x} ${y0} L ${x} ${y1}`);
    }
    for (let y = y0; y <= y1; y += size) {
      parts.push(`M ${x0} ${y} L ${x1} ${y}`);
    }
    const d = parts.join(" ");
    if (this.gridPath) {
      this.gridPath.path = d;
      this.gridPath.strokeWidth = 1 / s;
      this.gridPath.remove();
    } else {
      this.gridPath = new Path({
        path: d,
        stroke: "rgba(127, 127, 127, 0.35)",
        strokeWidth: 1 / s,
        strokeCap: "round",
      });
    }
    layer.addAt(this.gridPath, 0);
  }

  async exportPNG(): Promise<string> {
    const out = await this.app.export("png", {
      padding: 24,
      fill: this.background,
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

  /**
   * 导出画布为限尺寸 JPEG dataURL（AI 多模态感知用）；画布为空返回 null。
   * size 限制输出最长边（px），JPEG + quality 控制体积，避免发给模型时流量/token 过大。
   * 默认按内容包围盒导出（避免大片空白），失败时降级为整页导出。
   */
  async exportImage(size = 1280): Promise<string | null> {
    if (this.elementCount === 0) {
      return null;
    }
    try {
      const out = await this.app.export("jpg", {
        size,
        screenshot: this.contentWorldBounds(12),
        fill: this.background,
        quality: 0.85,
      });
      const url = await this.toDataUrl(out);
      return url ?? this.exportImageFull(size);
    } catch {
      return this.exportImageFull(size);
    }
  }

  /** 整页导出（包围盒截图失败时的降级路径） */
  private async exportImageFull(size: number): Promise<string | null> {
    try {
      const out = await this.app.export("jpg", {
        size,
        padding: 12,
        fill: this.background,
        quality: 0.85,
      });
      return this.toDataUrl(out);
    } catch {
      return null;
    }
  }

  /** leafer 导出结果 → dataURL；失败返回 null */
  private async toDataUrl(out: unknown): Promise<string | null> {
    if (typeof out === "string") {
      return out;
    }
    const data = (out as { data?: unknown })?.data;
    if (typeof data === "string") {
      return data;
    }
    if (data instanceof Blob) {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(data);
      });
    }
    return null;
  }

  /**
   * 内容世界坐标包围盒（含 zoomLayer 缩放/平移与元素 rotation 的四角），
   * 作为 export 的 screenshot 区域（leafer 世界坐标）；画布为空返回 1x1 兜底。
   */
  private contentWorldBounds(padding: number) {
    const els = this.serialize();
    const layer = this.app.tree.zoomLayer;
    const sx = layer?.scaleX ?? 1;
    const sy = layer?.scaleY ?? 1;
    const ox = layer?.x ?? 0;
    const oy = layer?.y ?? 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const e of els) {
      const w = e.width ?? 0;
      const h = e.height ?? 0;
      const cx = w / 2;
      const cy = h / 2;
      const rad = ((e.rotation ?? 0) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      for (const [lx, ly] of [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ] as const) {
        // 元素四角绕中心旋转后叠加 x/y（tree 局部）→ 经 zoomLayer 变换到世界坐标
        const dx = lx - cx;
        const dy = ly - cy;
        const px = e.x + dx * cos - dy * sin + cx;
        const py = e.y + dx * sin + dy * cos + cy;
        const wx = px * sx + ox;
        const wy = py * sy + oy;
        minX = Math.min(minX, wx);
        minY = Math.min(minY, wy);
        maxX = Math.max(maxX, wx);
        maxY = Math.max(maxY, wy);
      }
    }
    if (!Number.isFinite(minX)) {
      return { x: 0, y: 0, width: 1, height: 1 };
    }
    return {
      x: round1(minX - padding),
      y: round1(minY - padding),
      width: round1(maxX - minX + padding * 2),
      height: round1(maxY - minY + padding * 2),
    };
  }

  /** 当前画布背景色（主题切换/导出共用） */
  get backgroundColor(): string {
    return this.background;
  }

  /** 切换画布背景色（主题设置调用；leafer fill 为可运行时赋值属性） */
  setBackground(color: string) {
    this.background = color;
    this.app.fill = color;
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
