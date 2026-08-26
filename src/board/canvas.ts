import {
  App,
  Box,
  DragEvent,
  Ellipse,
  Image,
  Line,
  Path,
  PointerEvent,
  Rect,
  Text,
  ZoomEvent,
} from "leafer-ui";
import type { UI } from "leafer-ui";
import { type Editor, EditorEvent } from "@leafer-in/editor";
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
import type { IUI } from "@leafer-ui/interface";
import type { ArrowHead, BoardStyle, ElementData, FontWeight } from "../types";
import type { CoordBox } from "./coords";
import { beautifyScene } from "./beautify";
import type { BeautifyStats } from "./beautify";
import { rotatePoint, transformPath, translatePath } from "./path";
import { offsetElementData } from "./offset";
import {
  FRAME_CODE_FONT,
  FRAME_COLLAPSED_HEIGHT,
  FRAME_CONTENT_COLOR,
  FRAME_CONTENT_SIZE,
  FRAME_LINE_HEIGHT,
  FRAME_PADDING,
  clampShift,
  contractFrameContents,
  expandFrameContents,
  frameContentSize,
  frameScrollMax,
  normalizeContent,
} from "./frame";
import {
  alignElements,
  distributeElements,
  expandGroupMembers,
  flipElements,
  reorderElements,
} from "./arrange";
import type { ArrangeAction, ReorderMode } from "./arrange";
import { elementBounds, unionBounds } from "./bounds";
import { CropController } from "./crop-controller";
import { History } from "./history";
import type { ToolRegistry } from "./registry";
import {
  arrowHeadOf,
  bindingsToEl,
  colorOf,
  FRAME_FLAG,
  hasArrowHead,
  hexToRgba,
  isFrameEl,
  isFreehandEl,
  isSketchableEl,
  numOf,
  pointsOf,
  toLeaferArrow,
  typeOf,
} from "./element-utils";
import {
  distToSegment,
  nearestBorderPoint,
  polygonHitsBox,
  rectsIntersect,
} from "./geometry";
import { isSketchable, redrawRough, sketchifyData } from "./rough";
import {
  penSizeOf,
  splitArrowHeads,
  splitErasedPoints,
  strokeOutlinePath,
} from "./stroke";
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
// 内容约束的归属阈值：元素与 constrain 框架的包围盒重叠面积占比下限
const CONSTRAINT_ADOPT_RATIO = 0.6;

type AppWithEditor = App & { editor: Editor };

/**
 * 当前视口信息：画布世界坐标可见范围（与元素 x/y 同基准，经 tree.getInnerPoint 换算，
 * 不含 zoomLayer 变换）与画布像素尺寸、缩放倍率。AI 感知画布位置用：模型据此知道
 * "使用者当前看到哪里"，回答屏幕/眼前/视口相关内容时不至于答非所问。
 */
export type ViewportInfo = {
  /** 画布像素尺寸（app 局部坐标基准） */
  view: { width: number; height: number };
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  center: { x: number; y: number };
  scale: number;
};

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
  /** 橡皮半径变化（滑条 / [ ] 键 / 橡皮模式滚轮调节）：宿主同步 UI 与持久化 */
  onEraserRadiusChange?: (radiusPx: number) => void;
  /** 首次约束夹紧触发（拖动撞墙）：宿主提示 Alt 豁免（每次会话只报一次） */
  onConstraintHint?: () => void;
  /** 自定义工具运行时异常回执（每工具每会话一次）：宿主 toast 并引导修复 */
  onToolRuntimeError?: (toolId: string, message: string) => void;
};

/** 橡皮默认半径（px，屏幕像素）：分段擦除命中与光标圆圈共用 */
const ERASER_DEFAULT = 10;
// 橡皮半径可调范围（屏幕像素）
const ERASER_MIN = 2;
const ERASER_MAX = 80;

/** 橡皮分段擦除快照：一次手势内同一原始笔迹/线段的段集合（root 承载第一段，parts 为拆出的其余段） */
type EraseSnap = {
  root: Path | Line;
  kind: "freehand" | "line";
  /** 原始采样点 [x, y, pressure?]（freehand）或 [x, y]（line），手势内幂等重算基准 */
  points: number[][];
  /** freehand 的 perfect-freehand size（line 分段不使用） */
  size: number;
  /** 原始端点绑定（line 分段：首段保起点绑定、末段保终点绑定） */
  bindStart?: string;
  bindEnd?: string;
  parts: (Path | Line)[];
};

/** 橡皮圆圈光标（SVG data URI）：直径 = 2×半径，双圈描边保证深浅主题下均可见 */
function eraserCursorURL(radius: number): string {
  const d = radius * 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}" viewBox="0 0 ${d} ${d}">` +
    `<circle cx="${radius}" cy="${radius}" r="${radius - 2}" fill="rgba(127,127,127,0.15)" stroke="#fff" stroke-width="2"/>` +
    `<circle cx="${radius}" cy="${radius}" r="${radius - 2}" fill="none" stroke="#333" stroke-width="1"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${radius} ${radius}, crosshair`;
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
  /** 选中元素是否含组成员（组感知拖动/删除联动） */
  hasGroup: boolean;
  /** 单选未锁定文字时的字号（字号控件跟随） */
  fontSize?: number;
  /** 单选未锁定元素的不透明度（透明度滑条跟随；undefined = 不透明） */
  opacity?: number;
  /** 单选未锁定 rect 的圆角半径（圆角滑条跟随） */
  cornerRadius?: number;
  /** 单选未锁定文字的对齐（对齐按钮跟随） */
  textAlign?: "left" | "center" | "right";
  /** 单选未锁定文字的字体（字体下拉跟随） */
  fontFamily?: string;
  /** 单选未锁定文字的字重（字重滑条跟随，100-900） */
  fontWeight?: FontWeight;
  /** 单选未锁定 line/arrow 的起点端点样式（端点按钮组跟随） */
  startArrow?: ArrowHead;
  /** 单选未锁定 line/arrow 的终点端点样式（端点按钮组跟随） */
  endArrow?: ArrowHead;
  /** 是否含已手绘元素（粗糙度滑条显隐） */
  hasRough: boolean;
  /** 单选未锁定已手绘元素的粗糙度（滑条跟随；默认 1） */
  roughness?: number;
};

/**
 * 框架缩放手势的内容元素快照（单选缩放框架时框内内容跟随的幂等重算基准）。
 * SCALE 事件的 scaleX/scaleY 是相对当前状态的增量，拖动中高频触发；就地增量
 * 缩放会让每步的坐标舍入沿 T 命令链累积放大。快照在手势第一次 SCALE 时建立，
 * 之后每次都用“快照 × 累计比例”重算，舍入只发生一次、误差不跨步累积。
 */
interface FrameContentSnap {
  el: UI;
  kind: "line" | "freehand" | "path" | "text" | "box";
  /** 快照时元素锚点 (0,0) 的世界坐标（x/y 重算基准） */
  worldAnchor: { x: number; y: number };
  /** line：各端点快照时的世界坐标 */
  worldPoints?: { x: number; y: number }[];
  /** freehand：局部轮廓 path；普通 path：已转世界坐标的 path */
  path?: string;
  /** freehand：笔迹采样点（与 path 同基准的局部坐标） */
  penPoints?: number[][];
  /** box（rect/ellipse/image）：宽高 */
  width?: number;
  height?: number;
  /** text：字号 */
  fontSize?: number;
}

/** 框架缩放手势级状态：累计比例 + 内容快照（手势结束即清空） */
interface FrameScaleSnap {
  frameId: string;
  /** 手势累计缩放比例（每次 SCALE 乘上事件增量） */
  kx: number;
  ky: number;
  items: FrameContentSnap[];
}

export class Board {
  readonly app: App;
  readonly editor: Editor;
  private opts: BoardOptions;
  private tool: string = "select";
  private drawing = false;
  private draft: UI | null = null;
  /** 修饰键状态（编辑器 MOVE/SCALE 事件不携带按键信息，由 DOM 键盘事件维护） */
  private modKeys = { alt: false, shift: false };
  /** 组合工具草稿的其余元素（拖拽中与主草稿同步实时预览，松手时无需再补齐） */
  private draftExtras: UI[] = [];
  /** 拖拽统一管线：最近一次生成器输出的元素数据列表（首个为主元素，用于实时刷新草稿与微小判定；组合工具其余元素随草稿实时预览） */
  private draftData: ElementData[] | null = null;
  private startX = 0;
  private startY = 0;
  /** 绘制约束：绘制起点落在 constrain 框架内时记录该框架，生成结果实时夹紧（画不出框） */
  private drawingFrame: UI | null = null;
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
  // 橡皮半径（px，屏幕像素）：左侧栏滑条 / [ ] 键 / 橡皮模式滚轮实时调节
  private eraserRadius = ERASER_DEFAULT;
  // 待删预览高亮（sky 层红色虚线框）：实时指示橡皮当前命中的目标
  private erasePreview: Rect | null = null;
  private erasePreviewPending: { x: number; y: number } | null = null;
  private erasePreviewRaf = 0;
  // 缩放/旋转手势中标记：手势结束（DragEvent.END）时对受约束成员做收尾夹紧
  private frameClampDirty = false;
  // 约束夹紧首次触发提示（Alt 豁免）只报一次
  private constraintHintShown = false;
  // 已报过运行时错误的自定义工具（每工具每次会话一次）
  private toolRuntimeErrShown = new Set<string>();
  /** 橡皮手势轨迹（app 坐标）：分段擦除按轨迹剔除笔迹区间 */
  private eraseTrail: { x: number; y: number }[] = [];
  /** 分段擦除快照：本手势已拆分的笔迹元素 → 原始点列（元素局部坐标） */
  private eraseSnap = new Map<UI, EraseSnap>();
  // 选中框内拖动：点击点在选中元素包围盒内（而非元素本体）时手动移动整个选择
  private selectDragging = false;
  private dragStart = { x: 0, y: 0 };
  private dragEls: { el: UI; x: number; y: number }[] = [];
  private movedAny = false;
  /** leafer 拖动涉及的契约元素（拖动结束统一归一化 x/y → points/path） */
  private moveNormalizeEls = new Set<UI>();
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
  // 图片裁剪：独立交互控制器（sky 层裁剪框 + 8 手柄，松手即应用）
  private cropCtrl!: CropController;
  /** 文本缩放语义：横向拉伸换行、纵向/对角改字号（记录缩放前的原始状态） */
  private textScaleOrig = new Map<Text, { fontSize: number; width: number }>();
  /** 框架缩放手势的内容快照（幂等重算基准；手势结束清空） */
  private frameScaleSnap: FrameScaleSnap | null = null;
  /** 框架聚焦状态：保存聚焦前视口，再次聚焦/退出时恢复（会话级，不序列化） */
  private frameFocus: {
    id: string;
    view: { x: number; y: number; sx: number; sy: number };
  } | null = null;
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
        // 拖动位移修正钩子：leafer 按“拖动起点 + pointer 总位移”计算移动，
        // MOVE 事件里直接改位置会被其 totalOffset 补偿抵消（“吸不住”），
        // 必须在移动前修正增量：网格吸附 + 约束框架夹紧。x/y 为 local 增量。
        beforeMove: ({ target, x, y }) => {
          let nx = x;
          let ny = y;
          // 网格吸附：单选拖动时把期望位置对齐网格
          if (
            this.grid.snap &&
            (this.editor as unknown as { list?: UI[] }).list?.length === 1
          ) {
            const tx = (target.x ?? 0) + nx;
            const ty = (target.y ?? 0) + ny;
            nx = this.snapGrid(tx) - (target.x ?? 0);
            ny = this.snapGrid(ty) - (target.y ?? 0);
          }
          // 约束框架夹紧：非框架元素与 constrain 框架重叠率达标时，期望位置整体
          // 夹回框架（Alt 按住豁免拖出；修正发生在移动前，编辑器按修正值
          // 移动，夹紧稳定生效不会“移动一点就掉出去”）
          // 多选整体夹紧：以选区联合 bbox 求一次修正量应用到每个成员，
          // 避免逐元素独立夹紧把框内的相对布局拉歪
          if (target && !isFrameEl(target) && !this.modKeys.alt) {
            const fb = this.constrainFrameOf(target);
            if (fb) {
              const t = target as UI;
              // nx/ny 为 local 增量、bbox 为世界基准：画布缩放/平移后
              // local≠world，先转世界增量再夹紧，修正量再转回父级局部
              const wd = t.getWorldPointByLocal(
                { x: nx, y: ny },
                undefined,
                true,
              );
              const moverList = (
                (this.editor as unknown as { list?: UI[] }).list ?? []
              ).filter((m) => m && !m.locked && !isFrameEl(m));
              const movers = moverList.length > 1 ? moverList : [t];
              let box: {
                minX: number;
                minY: number;
                maxX: number;
                maxY: number;
              } | null = null;
              for (const m of movers) {
                const mb = m.worldBoxBounds;
                if (!mb) {
                  continue;
                }
                box = box
                  ? {
                      minX: Math.min(box.minX, mb.x),
                      minY: Math.min(box.minY, mb.y),
                      maxX: Math.max(box.maxX, mb.x + mb.width),
                      maxY: Math.max(box.maxY, mb.y + mb.height),
                    }
                  : {
                      minX: mb.x,
                      minY: mb.y,
                      maxX: mb.x + mb.width,
                      maxY: mb.y + mb.height,
                    };
              }
              if (box) {
                box = {
                  minX: box.minX + wd.x,
                  minY: box.minY + wd.y,
                  maxX: box.maxX + wd.x,
                  maxY: box.maxY + wd.y,
                };
                const shift = clampShift(box, fb);
                if (shift.dx || shift.dy) {
                  const aw = t.getWorldPoint({ x: 0, y: 0 });
                  const lp = t.getLocalPoint({
                    x: aw.x + wd.x + shift.dx,
                    y: aw.y + wd.y + shift.dy,
                  });
                  nx = lp.x - (t.x ?? 0);
                  ny = lp.y - (t.y ?? 0);
                  if (!this.constraintHintShown) {
                    this.constraintHintShown = true;
                    this.opts.onConstraintHint?.();
                  }
                }
              }
            }
          }
          return { x: nx, y: ny };
        },
      },
    });
    this.editor = (this.app as AppWithEditor).editor;
    this.cropCtrl = new CropController({
      app: this.app,
      editorCancel: () => this.editor.cancel(),
      setEditorTarget: (el) => {
        this.editor.target = el;
      },
      selectedList: () => this.selectedList,
      exitPointEdit: () => this.exitPointEdit(),
      imageSize: (url) => this.imageSize(url),
      commitHistory: () => this.commitHistory(),
      onMutated: () => this.opts.onMutated(),
    });
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
    // 修饰键状态：编辑器 MOVE/SCALE 事件不携带按键信息，用 DOM 键盘事件维护
    // （夹紧豁免 Alt 拖出等交互依赖；窗口失焦时重置避免 Alt 卡死）
    // shift 同步给自定义工具生成器（ctx.shiftKey，正比约束等用途）
    document.addEventListener("keydown", (e) => {
      this.modKeys.alt = e.altKey;
      this.modKeys.shift = e.shiftKey;
    });
    document.addEventListener("keyup", (e) => {
      this.modKeys.alt = e.altKey;
      this.modKeys.shift = e.shiftKey;
    });
    window.addEventListener("blur", () => {
      this.modKeys.alt = false;
      this.modKeys.shift = false;
    });
    // 初始视图：画布原点 (0,0) 居中显示（X0Y0 居中，与 zoomReset 一致）
    this.centerOriginView();
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
      const ev = e as EditorMoveEvent;
      // 被移动元素：leafer 2.2.9 的 MOVE 事件 data 为 { target, editor, moveX,
      // moveY }，不含 operateEvent（历史写法导致 moved 恒为 undefined，框内
      // 跟随/组联动/吸附/拖动夹紧全部失效）
      const moved = (e as EditorMoveEvent).target as UI | undefined;
      // 组联动：同组未选中成员跟随本次位移（选中成员已由编辑器移动；
      // moveX/moveY 为 world 增量，缩放视图下位移一致；锁定成员不跟随）
      const gid = moved
        ? (moved as unknown as { __groupId?: string }).__groupId
        : undefined;
      if (moved && gid && (ev.moveX || ev.moveY)) {
        for (const other of this.app.tree.children as UI[]) {
          if (other === moved || other.locked) {
            continue;
          }
          if ((other as unknown as { __groupId?: string }).__groupId === gid) {
            other.moveWorld(ev.moveX, ev.moveY);
            this.normalizeContractEl(other);
          }
        }
      }
      // frame 框架移动：归属于该框架的内容元素（frameId 显式归属，不再靠
      // bbox 包含猜测）跟随位移——纯增量同步，无时序问题
      if (moved && isFrameEl(moved) && (ev.moveX || ev.moveY)) {
        this.moveFrameContents(moved, ev.moveX, ev.moveY);
      }
      // 契约元素（line/arrow/path）拖动时 leafer 改 x/y，但拖动中立即归零会
      // 破坏 leafer 的增量计算（getValidMove 按“拖起点位置 - 当前位置”求增量，
      // 归零后增量退化为累计总位移，元素被反复叠加放大、越拖越飞），
      // 改为拖动结束时统一并入 points/path 并归零
      if (moved) {
        this.moveNormalizeEls.add(moved);
      }
      // 内容归属同步：框架内容被拖出所属框架（中心点出框）即解除归属，
      // 变回自由元素（夹紧生效时中心保持在框内，不会误触发）；
      // 未归属元素拖入某框架（完全包含）时补挂归属，此后随框架移动/缩放联动
      if (moved && !isFrameEl(moved)) {
        const fid = this.frameIdOf(moved);
        if (!fid) {
          const frame = this.frameContaining(moved);
          if (frame) {
            this.setFrameId(moved, this.aiIdOf(frame));
          }
        } else {
          const frame = this.frameById(fid);
          const fb = frame?.worldBoxBounds;
          const eb = moved.worldBoxBounds;
          if (!fb || !eb) {
            this.setFrameId(moved, undefined);
          } else {
            const cx = eb.x + eb.width / 2;
            const cy = eb.y + eb.height / 2;
            if (
              cx < fb.x ||
              cx > fb.x + fb.width ||
              cy < fb.y ||
              cy > fb.y + fb.height
            ) {
              this.setFrameId(moved, undefined);
            }
          }
        }
      }
      // 移动元素后刷新绑定箭头端点（被绑元素移动时端点跟随）
      this.updateBindings(moved);
      this.scheduleHistory();
    });
    // 框架旋转：归属于该框架的内容元素绕旋转中心同步旋转（内容跟随框架，
    // 不会被“甩出来”；多选旋转时 leafer 对选中列表整体变换、内容已随动，
    // 仅单选时补偿，避免双重变换）
    this.editor.on(EditorRotateEvent.ROTATE, (e) => {
      const ev = e as EditorRotateEvent;
      this.frameClampDirty = true;
      const target = ev.target as UI | undefined;
      if (
        target &&
        isFrameEl(target) &&
        ev.rotation &&
        this.selectedList.length === 1
      ) {
        this.rotateFrameContents(
          target,
          ev.worldOrigin ?? { x: 0, y: 0 },
          ev.rotation,
        );
      }
      this.scheduleHistory();
    });
    // 文本缩放语义：记录缩放前的原始字号/宽度（横向拉伸换行、纵向/对角改字号）
    this.editor.on(EditorScaleEvent.BEFORE_SCALE, () => {
      this.onBeforeScale();
    });
    // 框架缩放：单选缩放框架时，归属于该框架的内容元素绕同一世界缩放中心
    // 同步缩放。用 SCALE 事件 data 的 worldOrigin + 缩放比例（不依赖 bbox
    // 快照对比——doScale 后 worldBoxBounds 可能尚未刷新，old==now 会导致
    // 内容纹丝不动）
    this.editor.on(EditorScaleEvent.SCALE, (e) => {
      const ev = e as EditorScaleEvent;
      this.frameClampDirty = true;
      this.onScaleText(ev);
      const target = ev.target as UI | undefined;
      const sx = ev.scaleX ?? 1;
      const sy = ev.scaleY ?? 1;
      if (
        target &&
        isFrameEl(target) &&
        this.selectedList.length === 1 &&
        (sx !== 1 || sy !== 1)
      ) {
        this.scaleFrameContents(
          target,
          ev.worldOrigin ?? { x: 0, y: 0 },
          sx,
          sy,
        );
      }
      this.scheduleHistory();
    });
    // 选中变化（选中/多选/取消）：左侧浮动工具栏显隐依赖此事件
    this.editor.on(EditorEvent.AFTER_SELECT, () => this.emitSelectionInfo());
    // 文本内联编辑关闭：空文本即删；内容变化才入历史（对齐 fabric object:modified 时机）
    this.editor.on(InnerEditorEvent.CLOSE, (e) => this.onInnerEditorClose(e));
    // 框架缩放手势结束：清空内容快照（拖拽/触摸捻合两种手势的结束事件；
    // 快照残留会导致下次缩放复用旧元素引用，必须及时清理）
    this.app.on(DragEvent.END, () => {
      this.frameScaleSnap = null;
      // 缩放/旋转手势收尾：把受约束成员拉回所属框架（松手后校正，
      // 不与编辑器的增量计算打架；Alt 豁免拖出时跳过）
      if (this.frameClampDirty) {
        this.frameClampDirty = false;
        if (!this.modKeys.alt) {
          this.clampConstrainedMembers();
        }
      }
      // 拖动结束统一归一化契约元素（line/arrow/path）：位移并入 points/path
      // 并归零，满足“绝对坐标 + x/y=0”数据契约
      if (this.moveNormalizeEls.size) {
        for (const el of this.moveNormalizeEls) {
          this.normalizeContractEl(el);
        }
        this.moveNormalizeEls.clear();
        this.scheduleHistory();
      }
    });
    this.app.on(ZoomEvent.END, () => {
      this.frameScaleSnap = null;
    });
  }

  /**
   * 汇总选中信息并通知左侧浮动栏（选中变化/内嵌文本编辑结束等时机触发）。
   * 单值字段（字号/对齐/端点等）仅在单选未锁定时给出，保证控件跟随不混乱。
   */
  private emitSelectionInfo() {
    const list = this.selectedList;
    const ids: string[] = [];
    const types: (ElementData["type"] | null)[] = [];
    let hasText = false;
    let hasFreehand = false;
    let hasSketchable = false;
    let hasImage = false;
    let anyLocked = false;
    let hasGroup = false;
    let hasRough = false;
    const texts: Text[] = [];
    for (const el of list) {
      const id = this.aiIdOf(el);
      if (id) {
        ids.push(id);
      }
      if ((el as unknown as { __groupId?: string }).__groupId) {
        hasGroup = true;
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
      if ((el as unknown as { __rough?: unknown }).__rough) {
        hasRough = true;
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
    // 文本排版信息：仅单选未锁定文字时给出（供对齐/字重/字体控件跟随）
    const textAlign =
      texts.length === 1 && list.length === 1
        ? ((texts[0].textAlign as "left" | "center" | "right" | undefined) ??
          undefined)
        : undefined;
    const fontFamily =
      texts.length === 1 && list.length === 1
        ? (typeof texts[0].fontFamily === "string"
            ? texts[0].fontFamily
            : undefined)
        : undefined;
    // 字重数值化：leafer 支持 100-900 数字（旧数据/旧代码可能存 "normal"/"bold" 字符串）
    const fontWeight =
      texts.length === 1 && list.length === 1
        ? (typeof texts[0].fontWeight === "number"
            ? (texts[0].fontWeight as FontWeight)
            : texts[0].fontWeight === "bold"
              ? 700
              : undefined)
        : undefined;
    // 端点信息：仅单选未锁定 line/arrow 时给出（端点按钮组高亮跟随）
    let startArrow: ArrowHead | undefined;
    let endArrow: ArrowHead | undefined;
    if (list.length === 1 && !list[0].locked) {
      const single = list[0];
      if (single instanceof Line) {
        startArrow = arrowHeadOf(single.startArrow);
        endArrow = arrowHeadOf(single.endArrow);
      }
    }
    // 单选未锁定元素：不透明度/圆角供样式浮层滑条跟随（多选时值混杂不给）
    let opacity: number | undefined;
    let cornerRadius: number | undefined;
    let roughness: number | undefined;
    if (list.length === 1 && !list[0].locked) {
      const single = list[0];
      opacity = numOf(single.opacity);
      if (typeOf(single) === "rect") {
        cornerRadius = numOf((single as Rect).cornerRadius);
      }
      const meta = (single as unknown as { __rough?: { roughness?: number } })
        .__rough;
      if (meta) {
        roughness = meta.roughness ?? 1;
      }
    }
    this.opts.onSelectionChange?.({
      ids,
      types,
      hasText,
      hasFreehand,
      hasSketchable,
      hasImage,
      anyLocked,
      allLocked: list.length > 0 && anyLocked,
      hasGroup,
      fontSize,
      textAlign,
      fontFamily,
      fontWeight,
      startArrow,
      endArrow,
      hasRough,
      roughness,
      opacity,
      cornerRadius,
    });
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
    // 橡皮圆圈光标：按当前半径渲染，所见即所擦（其他工具恢复默认）
    view.style.cursor =
      tool === "eraser" ? eraserCursorURL(this.eraserRadius) : "";
    // 切离橡皮时清除待删预览
    if (tool !== "eraser") {
      this.clearErasePreview();
    }
    view.classList.remove("panning");
    view.classList.remove("move-cursor");
  }

  // ================= 缩放 =================

  /** 当前缩放倍率（tree.zoomLayer 承载画布缩放/平移变换） */
  get scale(): number {
    return this.app.tree.zoomLayer?.scaleX ?? 1;
  }

  /**
   * 当前视口信息（画布世界坐标，与元素 x/y 同基准）：可见范围、中心、缩放倍率。
   * AI 感知画布位置用（describeCanvas 摘要、get_canvas 的 viewport 过滤、视口截图标注共用）。
   */
  get viewport(): ViewportInfo {
    const view = this.app.canvas.view as HTMLElement;
    const w = this.app.width ?? view.clientWidth;
    const h = this.app.height ?? view.clientHeight;
    // app 局部坐标 → 画布世界坐标（与 lastPointer/tools.ts 放置元素同基准）
    const tl = this.app.tree.getInnerPoint({ x: 0, y: 0 });
    const br = this.app.tree.getInnerPoint({ x: w, y: h });
    const center = this.app.tree.getInnerPoint({ x: w / 2, y: h / 2 });
    return {
      view: { width: w, height: h },
      minX: Math.min(tl.x, br.x),
      minY: Math.min(tl.y, br.y),
      maxX: Math.max(tl.x, br.x),
      maxY: Math.max(tl.y, br.y),
      center: { x: center.x, y: center.y },
      scale: this.scale,
    };
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

  /** 重置为 100%：缩放归 1，画布原点 (0,0) 回到视口中心（初始视图与重置共用） */
  zoomReset() {
    this.centerOriginView();
  }

  /**
   * 初始/重置视图：画布原点 (0,0) 居中显示在视口中心（X0Y0 居中，
   * 元素坐标数据不变，仅调整 zoomLayer 平移；缩放倍率归 1）。
   */
  private centerOriginView() {
    const layer = this.app.tree.zoomLayer;
    if (!layer) {
      return;
    }
    const view = this.app.canvas.view as HTMLElement;
    const w = this.app.width ?? view.clientWidth;
    const h = this.app.height ?? view.clientHeight;
    layer.x = w / 2;
    layer.y = h / 2;
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
    // 橡皮模式滚轮：实时调节橡皮半径（向上增大、向下减小），不缩放画布
    if (this.tool === "eraser") {
      this.adjustEraserRadius(e.deltaY < 0 ? 2 : -2);
      return;
    }
    // 折叠内容框架滚动优先：鼠标悬停在可滚动框架上时滚轮滚动内容，
    // 其余区域维持滚轮缩放（缩放不动点用视口坐标）
    const local = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const world = this.app.tree.getInnerPoint(local);
    const scrollEl = this.scrollableFrameAt(world);
    if (scrollEl) {
      this.scrollFrameContent(scrollEl, e.deltaY);
      return;
    }
    // 向上滚放大、向下滚缩小
    const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
    this.zoomTo(this.scale * factor, local.x, local.y);
    // 缩放后重建 sky 层手柄（点编辑/裁剪框跟随世界坐标）
    if (this.pointEditEl) {
      this.buildPointHandles();
    }
    if (this.cropCtrl.active) {
      this.cropCtrl.rebuild();
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
        const oldW = el.width ?? 0;
        el.textWrap = "break";
        el.width = Math.max(1, oldW * sx);
        this.fixAlignAfterWrap(el, oldW);
      } else if (isVertical && sy > TH) {
        // 纵向拉伸：字号变大，换行宽度不变
        el.fontSize = Math.max(4, Math.round(orig.fontSize * sy));
      } else if (sx > TH && sy > TH) {
        // 对角拉伸：字号按缩放面积开方等比放大
        el.fontSize = Math.max(4, Math.round(orig.fontSize * Math.sqrt(sx * sy)));
      } else if (sx > TH) {
        const oldW = el.width ?? 0;
        el.textWrap = "break";
        el.width = Math.max(1, oldW * sx);
        this.fixAlignAfterWrap(el, oldW);
      } else if (sy > TH) {
        el.fontSize = Math.max(4, Math.round(orig.fontSize * sy));
      }
      el.scaleX = 1;
      el.scaleY = 1;
    }
    this.scheduleHistory();
  }

  /**
   * 横向拉伸换行后固定宽度：居中/右对齐的自动宽度文本（autoSizeAlign 基准失效）
   * 视觉位置会向右跳变，补正 x 让文本保持原位（居中左移半宽差、右对齐左移整宽差）。
   */
  private fixAlignAfterWrap(el: Text, oldW: number) {
    const align = el.textAlign;
    const newW = el.width ?? oldW;
    if (align === "center") {
      el.x = (el.x ?? 0) - (newW - oldW) / 2;
    } else if (align === "right") {
      el.x = (el.x ?? 0) - (newW - oldW);
    }
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
      this.eraseTrail = [{ x: e.x ?? 0, y: e.y ?? 0 }];
      this.eraseSnap = new Map();
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
      if (this.cropCtrl.active) {
        this.cropCtrl.handleDown(e.x ?? 0, e.y ?? 0);
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
        // 连续点击选取：Ctrl/Cmd 切换选中（点未选中的加入、点已选中的移出），
        // Shift 累加（只加不减）；无修饰键保持单选替换（现有行为）
        if (e.ctrlKey || e.metaKey) {
          if (this.editor.hasItem(hit)) {
            this.editor.removeItem(hit); // 点已选中的元素 → 取消选中
          } else {
            // 点未选中的元素 → 加入多选（addItem 内部跳过锁定元素）
            this.editor.addItem(hit);
          }
          return;
        }
        if (e.shiftKey) {
          if (!this.editor.hasItem(hit) && !hit.locked) {
            this.editor.addItem(hit); // 累加：只加不减
          }
          return;
        }
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
        // 修饰键点击包围盒内空白：保持选择不变（连续选取中误点空白不丢失已选内容）
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
          return;
        }
        this.beginDragSelection(px, py);
        return;
      }
      // 修饰键点击空白：保持当前选择（连续多选过程中误点空白不取消全部）
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
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
      this.addToTree(el);
      // 框架内容归属：文本创建点在框架 bbox 内 → 归属该框架
      this.adoptIntoFrame(el);
      this.openTextEdit(el);
      return;
    }
    const kind = this.opts.registry.getKind(this.tool);
    // 画笔：压力敏感笔迹（perfect-freehand 轮廓，填充渲染）
    if (kind === "freehand") {
      this.drawing = true;
      this.penPoints = [[px, py]];
      // 约束框架判定：起点落在 constrain 框架内时，笔迹采样点逐点钳制在框内
      this.drawingFrame = this.constrainFrameAt(px, py);
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
        this.addToTree(this.draft);
      }
      return;
    }
    // 点击工具：点击点即生成位置（x0=x1=点击点），生成器返回固定大小元素，一次性提交
    if (kind === "click") {
      const sx = this.snapGrid(px);
      const sy = this.snapGrid(py);
      let list = this.runGenerator(sx, sy, sx, sy);
      if (list?.length) {
        // 点击生成同样受约束框架夹紧（起点在 constrain 框架内时）
        const f = this.constrainFrameAt(sx, sy);
        if (f) {
          list = this.clampListToFrame(list, f);
        }
        for (const d of list) {
          const el = this.dataToElement(d);
          if (el) {
            this.addToTree(el);
            // 框架内容归属：点击生成的元素完全落在框架 bbox 内 → 归属该框架
            this.adoptIntoFrame(el);
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
    // 约束框架判定：绘制起点落在 constrain 框架内时，生成结果实时夹紧（画不出框）
    this.drawingFrame = this.constrainFrameAt(this.startX, this.startY);
    this.draftData = this.runGenerator(this.startX, this.startY, this.startX, this.startY);
    if (!this.draftData) {
      this.drawing = false;
      return;
    }
    this.draft = this.dataToElement(this.draftData[0]);
    if (this.draft) {
      this.addToTree(this.draft);
    }
    // 组合工具：其余元素同步建草稿（拖拽中实时预览全貌，松手时无需再补齐）
    for (const d of this.draftData.slice(1)) {
      const el = this.dataToElement(d);
      if (el) {
        this.addToTree(el);
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
      const out = gen({
        x0, y0, x1, y1,
        style: this.opts.getStyle(),
        // ctx v2 可选字段：屏幕恒定大小换算与修饰键约束
        zoom: this.zoomScale(),
        shiftKey: this.modKeys.shift,
        altKey: this.modKeys.alt,
      });
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
      // 运行时错误回执：冒烟测试拦不住的执行期异常（此前完全黑盒），
  // 每个工具每次会话只报一次，避免拖拽高频调用刷屏
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.toolRuntimeErrShown.has(this.tool)) {
        this.toolRuntimeErrShown.add(this.tool);
        this.opts.onToolRuntimeError?.(this.tool, msg);
      }
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
    // 橡皮擦拖动：实时更新待删预览；隔段擦除避免事件密集时重复命中
    if (this.erasing) {
      const ax = e.x ?? 0;
      const ay = e.y ?? 0;
      this.updateErasePreview(ax, ay);
      if (Math.hypot(ax - this.lastErase.x, ay - this.lastErase.y) >= 4) {
        this.lastErase = { x: ax, y: ay };
        this.eraseTrail.push({ x: ax, y: ay });
        this.eraseAt(ax, ay);
      }
      return;
    }
    // 橡皮悬停（未按下）：同样显示待删预览，给用户反悔预期
    if (this.tool === "eraser") {
      this.updateErasePreview(e.x ?? 0, e.y ?? 0);
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
        // frame 框架拖动：框内元素（世界 bbox 完全包含）跟随位移
        if (isFrameEl(item.el) && (dx || dy)) {
          this.moveFrameContents(item.el, dx, dy);
        }
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
    // 图片裁剪：拖动手柄调整裁剪区域（非拖动状态返回 false 走其他分支）
    if (this.cropCtrl.handleMove(e.x ?? 0, e.y ?? 0)) {
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
      // 约束夹紧：起点在 constrain 框架内时采样点钳制在框内（笔画画不出框）
      const cp = this.clampPointToFrame(px, py);
      this.penPoints.push([cp.x, cp.y]);
      const path = strokeOutlinePath(this.penPoints, { size: this.penSize });
      if (path) {
        (this.draft as Path).path = path;
      }
      return;
    }
    if (kind === "drag") {
      let data = this.runGenerator(
        this.startX,
        this.startY,
        this.snapGrid(px),
        this.snapGrid(py),
      );
      if (data) {
        // 约束夹紧：起点在 constrain 框架内时生成结果整体限制在框内
        if (this.drawingFrame) {
          data = this.clampListToFrame(data, this.drawingFrame);
        }
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
    // 框架缩放快照兜底清理（手势结束事件漏发时防残留；通常由 DragEvent.END 清理）
    this.frameScaleSnap = null;
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
      this.eraseTrail = [];
      this.eraseSnap = new Map();
      this.clearErasePreview();
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
    if (this.cropCtrl.handleUp()) {
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
    this.drawingFrame = null;
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
      // 框架内容归属：绘制结果完全落在框架 bbox 内 → 挂上该框架的 frameId
      if (this.draft) {
        this.adoptIntoFrame(this.draft);
      }
      for (const el of this.draftExtras) {
        this.adoptIntoFrame(el);
      }
      this.draft = null;
      this.draftExtras = [];
      this.draftData = null;
      this.commitHistory();
    }
  }

  /** 草稿是否过于微小（点击而非拖拽）：自由笔迹看点数，拖拽管线看生成数据尺寸 */
  private isTinyDraft(): boolean {
    if (this.opts.registry.getKind(this.tool) === "freehand") {
      // 单击（1 个采样点）也是有效笔迹：perfect-freehand 对单点生成圆形轮廓（直径≈笔粗），
      // 允许保留为圆点；仅 0 点（无按下）视为微小
      return this.penPoints.length < 1;
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
    } else if (typeOf(target as UI) === null) {
      // 双击空白：就地创建文本并进入编辑（Excalidraw 同款快捷输入）
      const p = this.app.tree.getInnerPoint({ x: e.x ?? 0, y: e.y ?? 0 });
      this.createTextAt(p.x, p.y);
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

  /** 退出点编辑：清除手柄与拖动状态（ESC/点击空白/切换工具时调用）；收尾时约束兜底 */
  exitPointEdit() {
    if (this.pointEditEl) {
      // 点编辑可能把端点拖出约束框架：以整元素 bbox 兜底拉回
      this.clampConstrainedMembers([this.pointEditEl]);
    }
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
  private updateBindings(moved?: UI) {
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

  private hitTest(world: { x: number; y: number }, radius = 5): UI | null {
    // 逐元素像素级命中：线段/箭头/画笔按实际描边命中；
    // 空心图形内部透明区域不命中，可穿透选中下层元素。
    // hitRadius 扩大命中容差（细线也容易点中；橡皮按光标半径命中）
    const children = this.app.tree.children as UI[];
    for (let i = children.length - 1; i >= 0; i--) {
      const el = children[i];
      if (this.isEditorInternal(el)) {
        continue; // editor 内部元素（多选模拟层）不可交互
      }
      if (el.hit(world, radius)) {
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

  /**
   * 橡皮命中解析（预览与实际擦除共用同一判定，保证所见即所删）：
   * - 笔迹/线性元素走分段：先按"触及本体"小容差判定，未中再按完整橡皮半径判定
   *   （扫过细线/笔迹附近也能分段）；
   * - 其余元素整条删除：仅当圆心触及元素本体（容差取橡皮半径与 12px 的较小者，
   *   且按缩放补偿为世界单位）——大半径蹭边不再误删整块图形。
   */
  private resolveEraseTarget(
    ax: number,
    ay: number,
  ): { el: UI; segment: boolean } | null {
    const zoom = this.zoomScale();
    const solidTol = Math.min(this.eraserRadius, 12) / zoom;
    const solid = this.hitTest({ x: ax, y: ay }, solidTol);
    if (solid && !solid.locked) {
      if (isFreehandEl(solid)) {
        return { el: solid, segment: true };
      }
      if (solid instanceof Line && pointsOf(solid).length >= 2) {
        return { el: solid, segment: true };
      }
      return { el: solid, segment: false };
    }
    const seg = this.hitTest({ x: ax, y: ay }, this.eraserRadius / zoom);
    if (!seg || seg.locked) {
      // 几何兜底：leafer 对细线中段的元素级命中不稳定（端点处才可靠），
      // 改为直接计算指针到各线段的距离（≤ 橡皮半径即命中），保证沿中段扫过也能分段
      const children = this.app.tree.children as UI[];
      for (let i = children.length - 1; i >= 0; i--) {
        const el = children[i];
        if (this.isEditorInternal(el) || el.locked || !(el instanceof Line)) {
          continue;
        }
        const pts = pointsOf(el);
        if (pts.length < 2) {
          continue;
        }
        const lp = el.getInnerPoint({ x: ax, y: ay });
        const r = this.localEraserRadius(el);
        for (let j = 0; j < pts.length - 1; j++) {
          if (distToSegment(lp, pts[j], pts[j + 1]) <= r) {
            return { el, segment: true };
          }
        }
      }
      return null;
    }
    if (isFreehandEl(seg)) {
      return { el: seg, segment: true };
    }
    if (seg instanceof Line && pointsOf(seg).length >= 2) {
      return { el: seg, segment: true };
    }
    return null;
  }

  /**
   * 擦除指定 app 坐标处的元素：笔迹与线段按橡皮轨迹分段擦除（只擦被覆盖的区间，
   * 剩余部分拆成独立元素）；其余元素在圆心触及本体时整条删除。锁定元素受保护。
   */
  private eraseAt(ax: number, ay: number) {
    const target = this.resolveEraseTarget(ax, ay);
    if (!target) {
      return;
    }
    if (target.segment) {
      if (isFreehandEl(target.el)) {
        this.eraseFreehandAt(target.el as Path);
      } else {
        this.eraseLineAt(target.el as Line);
      }
      return;
    }
    target.el.remove();
    this.editor.cancel();
    this.eraserDeleted = true;
  }

  /**
   * 笔迹分段擦除：橡皮轨迹换算到笔迹局部坐标，从快照的原始点列中剔除
   * 被轨迹覆盖（距离 <= 橡皮半径）的点，剩余连续段各自重生成轮廓——
   * 第一段留在原元素（保 id），其余段拆成新元素；全擦完则整条删除。
   * 同一手势内反复经过同一笔迹时按快照幂等重算（已拆段共享快照，不会重复拆）。
   */
  private eraseFreehandAt(el: Path) {
    let snap = this.eraseSnap.get(el);
    if (!snap) {
      const t = el as unknown as { __freehandPoints?: number[][] };
      const pts = t.__freehandPoints;
      if (!pts || pts.length < 2) {
        // 元数据缺失或单点笔迹：无法分段，整条删除
        el.remove();
        this.editor.cancel();
        this.eraserDeleted = true;
        return;
      }
      snap = {
        root: el,
        kind: "freehand",
        points: pts.map((p) => [...p]),
        size:
          (el as unknown as { __penSize?: number }).__penSize ??
          penSizeOf(typeof el.strokeWidth === "number" ? el.strokeWidth : 2),
        parts: [],
      };
      this.eraseSnap.set(el, snap);
    }
    const root = snap.root as Path;
    // 橡皮半径：屏幕像素 → 笔迹局部单位（防御画布缩放与元素缩放）
    const radius = this.localEraserRadius(root);
    // 轨迹：app 坐标 → 笔迹局部坐标（getInnerPoint 按完整世界矩阵一步逆变换，
    // 不能先转画布坐标再转局部，否则 tree 有平移/缩放时基准错位）
    const trail = this.eraseTrail.map((p) => root.getInnerPoint(p));
    const segs = splitErasedPoints(snap.points, trail, radius);
    if (segs.length === 0) {
      // 整条擦除：移除根元素与已拆出的所有段
      root.remove();
      for (const part of snap.parts) {
        this.eraseSnap.delete(part);
        part.remove();
      }
      this.eraseSnap.delete(el);
      this.editor.cancel();
      this.eraserDeleted = true;
      return;
    }
    this.applyFreehandSeg(root, segs[0], snap.size);
    // 段数变多：复用已有 part 或新建；段数变少：移除多余 part
    for (let i = 1; i < segs.length; i++) {
      if (i - 1 < snap.parts.length) {
        this.applyFreehandSeg(snap.parts[i - 1], segs[i], snap.size);
      } else {
        const part = this.makeFreehandPart(root, segs[i], snap.size);
        snap.parts.push(part);
        this.eraseSnap.set(part, snap);
      }
    }
    while (snap.parts.length > segs.length - 1) {
      const extra = snap.parts.pop();
      if (extra) {
        this.eraseSnap.delete(extra);
        extra.remove();
      }
    }
    this.eraserDeleted = true;
  }

  /** 把一段保留点列应用到笔迹元素：重算轮廓并同步采样点元数据 */
  private applyFreehandSeg(el: Path, seg: number[][], size: number) {
    const path = strokeOutlinePath(seg, { size });
    if (path) {
      el.path = path;
    }
    (el as unknown as { __freehandPoints?: number[][] }).__freehandPoints =
      seg.map((p) => [...p]);
  }

  /**
   * 分段擦除拆出的新笔迹元素：继承原元素锚点/旋转/样式与框架、分组归属，
   * 追加到画布末尾（同一快照内的段共享后续擦除状态）。
   */
  private makeFreehandPart(root: Path, seg: number[][], size: number): Path {
    const part = new Path({
      x: root.x,
      y: root.y,
      path: strokeOutlinePath(seg, { size }),
      fill: root.fill,
      stroke: root.stroke,
      strokeWidth: root.strokeWidth,
      opacity: root.opacity,
      rotation: root.rotation,
    });
    const m = part as unknown as Record<string, unknown>;
    m.__freehandPoints = seg.map((p) => [...p]);
    m.__penSize = size;
    this.setFrameId(part, this.frameIdOf(root));
    const gid = (root as unknown as { __groupId?: string }).__groupId;
    if (gid) {
      (part as unknown as { __groupId?: string }).__groupId = gid;
    }
    this.app.tree.add(part);
    return part;
  }

  // ================= 橡皮：半径调节 / 线段分段 / 待删预览 =================

  /** 当前画布缩放（世界 → 屏幕系数下限防御） */
  private zoomScale(): number {
    return Math.max(this.app.tree.zoomLayer?.scaleX ?? 1, 0.01);
  }

  /** 橡皮半径换算到指定元素的局部单位（防御画布缩放与元素缩放） */
  private localEraserRadius(el: UI): number {
    return (
      this.eraserRadius /
      this.zoomScale() /
      Math.max(el.scaleX ?? 1, 0.01)
    );
  }

  /** 分段类元素的局部采样点列（freehand 笔迹 / 线性元素）；非分段类返回 null */
  private segmentPointsOf(el: UI): number[][] | null {
    if (isFreehandEl(el)) {
      return (
        (el as unknown as { __freehandPoints?: number[][] }).__freehandPoints ??
        null
      );
    }
    if (el instanceof Line) {
      return pointsOf(el).map((p) => [p.x, p.y]);
    }
    return null;
  }

  /** 当前橡皮半径（px，屏幕像素） */
  get eraserRadiusPx(): number {
    return this.eraserRadius;
  }

  /** 是否正在橡皮擦手势中（长按临时橡皮的松手还原需避让） */
  get isErasing(): boolean {
    return this.erasing;
  }

  /** 设置橡皮半径（px，屏幕像素）：同步光标圆圈，所见即所擦 */
  setEraserRadius(px: number) {
    const r = Math.min(ERASER_MAX, Math.max(ERASER_MIN, Math.round(px)));
    this.eraserRadius = r;
    this.applyEraserCursor();
  }

  /** 增减橡皮半径（[ ] 键 / 橡皮模式滚轮） */
  adjustEraserRadius(deltaPx: number) {
    this.setEraserRadius(this.eraserRadius + deltaPx);
    this.opts.onEraserRadiusChange?.(this.eraserRadius);
  }

  private applyEraserCursor() {
    if (this.tool === "eraser") {
      (this.app.canvas.view as HTMLElement).style.cursor = eraserCursorURL(
        this.eraserRadius,
      );
    }
  }

  /**
   * 线性元素（line/arrow/polyline）分段擦除：与笔迹同一算法——首段留在原元素
   * （保 id 与起点绑定/箭头），其余段拆成新线元素；端点样式按首末段分配，
   * 中间段两端无端点；框架/分组归属随段继承。全擦完则整条删除。
   */
  private eraseLineAt(el: Line) {
    let snap = this.eraseSnap.get(el);
    if (!snap) {
      const pts = pointsOf(el);
      if (pts.length < 2) {
        el.remove();
        this.editor.cancel();
        this.eraserDeleted = true;
        return;
      }
      const t = el as unknown as { __bindStart?: string; __bindEnd?: string };
      snap = {
        root: el,
        kind: "line",
        points: pts.map((p) => [p.x, p.y]),
        size: 0,
        bindStart: t.__bindStart,
        bindEnd: t.__bindEnd,
        parts: [],
      };
      this.eraseSnap.set(el, snap);
    }
    const root = snap.root as Line;
    // 橡皮半径：屏幕像素 → 元素局部单位（同 freehand 的缩放补偿）
    const radius = this.localEraserRadius(root);
    const trail = this.eraseTrail.map((p) => root.getInnerPoint(p));
    const segs = splitErasedPoints(snap.points, trail, radius);
    if (segs.length === 0) {
      root.remove();
      for (const part of snap.parts) {
        this.eraseSnap.delete(part);
        part.remove();
      }
      this.eraseSnap.delete(el);
      this.editor.cancel();
      this.eraserDeleted = true;
      return;
    }
    // 端点样式分配：首段保起点箭头、末段保终点箭头、中间段无端点
    const heads = splitArrowHeads(
      segs.length,
      arrowHeadOf(root.startArrow),
      arrowHeadOf(root.endArrow),
    );
    this.applyLineSeg(root as Line, segs[0], heads[0], {
      bindStart: snap.bindStart,
      bindEnd: segs.length === 1 ? snap.bindEnd : undefined,
    });
    for (let i = 1; i < segs.length; i++) {
      const head = heads[i];
      const isLast = i === segs.length - 1;
      if (i - 1 < snap.parts.length) {
        this.applyLineSeg(snap.parts[i - 1] as Line, segs[i], head, {
          bindEnd: isLast ? snap.bindEnd : undefined,
        });
      } else {
        const part = this.makeLinePart(root as Line, segs[i], head, {
          bindStart: i === 0 ? snap.bindStart : undefined,
          bindEnd: isLast ? snap.bindEnd : undefined,
        });
        snap.parts.push(part);
        this.eraseSnap.set(part, snap);
      }
    }
    while (snap.parts.length > segs.length - 1) {
      const extra = snap.parts.pop();
      if (extra) {
        this.eraseSnap.delete(extra);
        extra.remove();
      }
    }
    this.eraserDeleted = true;
  }

  /** 把一段保留点列应用回线元素：重写 points 并同步端点样式与绑定 */
  private applyLineSeg(
    el: Line,
    seg: number[][],
    head: { start: ArrowHead | undefined; end: ArrowHead | undefined },
    binds: { bindStart?: string; bindEnd?: string },
  ) {
    el.points = seg.map(([x, y]) => ({ x, y }));
    el.startArrow = head.start ?? "none";
    el.endArrow = head.end ?? "none";
    const m = el as unknown as Record<string, unknown>;
    if (binds.bindStart) {
      m.__bindStart = binds.bindStart;
    } else {
      delete m.__bindStart;
    }
    if (binds.bindEnd) {
      m.__bindEnd = binds.bindEnd;
    } else {
      delete m.__bindEnd;
    }
  }

  /** 分段擦除拆出的新线元素：继承原元素样式/变换与框架、分组归属 */
  private makeLinePart(
    root: Line,
    seg: number[][],
    head: { start: ArrowHead | undefined; end: ArrowHead | undefined },
    binds: { bindStart?: string; bindEnd?: string },
  ): Line {
    const part = new Line({
      x: root.x,
      y: root.y,
      points: seg.map(([x, y]) => ({ x, y })),
      stroke: root.stroke,
      strokeWidth: root.strokeWidth,
      dashPattern: root.dashPattern,
      opacity: root.opacity,
      rotation: root.rotation,
    });
    if (head.start) {
      part.startArrow = head.start;
    }
    if (head.end) {
      part.endArrow = head.end;
    }
    const m = part as unknown as Record<string, unknown>;
    if (binds.bindStart) {
      m.__bindStart = binds.bindStart;
    }
    if (binds.bindEnd) {
      m.__bindEnd = binds.bindEnd;
    }
    this.setFrameId(part, this.frameIdOf(root));
    const gid = (root as unknown as { __groupId?: string }).__groupId;
    if (gid) {
      (part as unknown as { __groupId?: string }).__groupId = gid;
    }
    this.app.tree.add(part);
    return part;
  }

  /**
   * 待删预览入口（rAF 合帧：拖拽高频移动时每帧至多重算一次命中）。
   * 实际渲染见 renderErasePreviewAt：
   * - 整删类元素：红色虚线框包住整个目标；
   * - 笔迹/线性等分段类元素：只高亮橡皮邻域内将被裁掉的区段
   *   （整条包围盒对长曲线毫无信息量，误导"全部要被删"）。
   */
  private updateErasePreview(ax: number, ay: number) {
    this.erasePreviewPending = { x: ax, y: ay };
    if (this.erasePreviewRaf) {
      return;
    }
    this.erasePreviewRaf = requestAnimationFrame(() => {
      this.erasePreviewRaf = 0;
      const p = this.erasePreviewPending;
      if (p) {
        this.renderErasePreviewAt(p.x, p.y);
      }
    });
  }

  private renderErasePreviewAt(ax: number, ay: number) {
    if (this.tool !== "eraser") {
      return;
    }
    const target = this.resolveEraseTarget(ax, ay);
    if (!target) {
      this.clearErasePreview();
      return;
    }
    let b = target.el.worldBoxBounds;
    if (target.segment) {
      const el = target.el;
      const pts = this.segmentPointsOf(el);
      const lp = el.getInnerPoint({ x: ax, y: ay });
      const r = this.localEraserRadius(el) * 1.4;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let near = 0;
      for (const p of pts ?? []) {
        const [x, y] = p;
        if (Math.hypot(x - lp.x, y - lp.y) <= r) {
          near++;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      if (!near) {
        this.clearErasePreview();
        return;
      }
      // 邻域 bbox 局部 → 世界两角 → 轴对齐世界矩形（含旋转框架内容也正确）
      const w1 = el.getWorldPoint({ x: minX, y: minY });
      const w2 = el.getWorldPoint({ x: maxX, y: maxY });
      b = {
        x: Math.min(w1.x, w2.x),
        y: Math.min(w1.y, w2.y),
        width: Math.abs(w2.x - w1.x),
        height: Math.abs(w2.y - w1.y),
      };
    }
    if (!b) {
      this.clearErasePreview();
      return;
    }
    if (!this.erasePreview) {
      this.erasePreview = new Rect({
        stroke: "#ff4d4f",
        strokeWidth: 1.5,
        dashPattern: [5, 4],
        fill: "rgba(255, 77, 79, 0.05)",
      });
      this.app.sky.add(this.erasePreview);
    }
    this.erasePreview.x = b.x - 3;
    this.erasePreview.y = b.y - 3;
    this.erasePreview.width = b.width + 6;
    this.erasePreview.height = b.height + 6;
  }

  private clearErasePreview() {
    if (this.erasePreviewRaf) {
      cancelAnimationFrame(this.erasePreviewRaf);
      this.erasePreviewRaf = 0;
    }
    this.erasePreviewPending = null;
    if (this.erasePreview) {
      this.erasePreview.remove();
      this.erasePreview = null;
    }
  }

  // ================= 方向键微移 / 缩放适配 =================

  /**
   * 方向键微移选中元素：世界位移换算到各元素父级局部坐标（含旋转/缩放元素）；
   * 契约元素并入 points/path（freehand 移锚点），框架带动框内内容。
   */
  nudgeSelected(dxWorld: number, dyWorld: number): boolean {
    const list = this.selectedList.filter(
      (el) => !el.locked && !this.isEditorInternal(el),
    );
    if (!list.length) {
      return false;
    }
    for (const el of list) {
      // 世界向量 → 局部向量（差值法，天然涵盖旋转/缩放）
      const a = el.getLocalPoint({ x: 0, y: 0 });
      const b = el.getLocalPoint({ x: dxWorld, y: dyWorld });
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (el instanceof Line) {
        el.points = pointsOf(el).map((p) => ({ x: p.x + dx, y: p.y + dy }));
        continue;
      }
      if (el instanceof Path) {
        const t = el as unknown as { __freehandPoints?: number[][] };
        if (t.__freehandPoints) {
          // freehand 轮廓为局部坐标：平移锚点即可整体移动
          el.x = (el.x ?? 0) + dx;
          el.y = (el.y ?? 0) + dy;
        } else {
          el.path = transformPath(el.path as string, (p) => ({
            x: p.x + dx,
            y: p.y + dy,
          }));
        }
        continue;
      }
      el.x = (el.x ?? 0) + dx;
      el.y = (el.y ?? 0) + dy;
      if (isFrameEl(el)) {
        // 框架微移带动框内内容（与世界坐标位移语义一致）
        this.moveFrameContents(el, dxWorld, dyWorld);
      }
    }
    this.updateBindings();
    this.commitHistory();
    this.opts.onMutated();
    return true;
  }

  /** 视口缩放/平移到指定世界 bbox（留 10% 边距，限幅在画布缩放范围内） */
  private zoomToFitBounds(b: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): boolean {
    const layer = this.app.tree.zoomLayer;
    if (!layer || b.width <= 0 || b.height <= 0) {
      return false;
    }
    const view = this.app.canvas.view as HTMLElement;
    const vw = this.app.width ?? view.clientWidth;
    const vh = this.app.height ?? view.clientHeight;
    const target = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min(vw / b.width, vh / b.height) * 0.9),
    );
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    layer.scaleX = target;
    layer.scaleY = target;
    layer.x = vw / 2 - cx * target;
    layer.y = vh / 2 - cy * target;
    this.updateGrid();
    return true;
  }

  /** 缩放到选中元素（Shift+2）：无选中返回 false */
  zoomToFitSelection(): boolean {
    let box: {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null = null;
    for (const el of this.selectedList) {
      const b = el.worldBoxBounds;
      if (!b || b.width <= 0 || b.height <= 0) {
        continue;
      }
      box = box
        ? {
            x: Math.min(box.x, b.x),
            y: Math.min(box.y, b.y),
            width: Math.max(box.x + box.width, b.x + b.width) - Math.min(box.x, b.x),
            height:
              Math.max(box.y + box.height, b.y + b.height) - Math.min(box.y, b.y),
          }
        : { ...b };
    }
    return box ? this.zoomToFitBounds(box) : false;
  }

  /** 缩放至全部内容（Shift+1）：空画布返回 false */
  zoomToFitAll(): boolean {
    let box: {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null = null;
    for (const el of this.app.tree.children as UI[]) {
      if (this.isEditorInternal(el)) {
        continue;
      }
      const b = el.worldBoxBounds;
      if (!b || b.width <= 0 || b.height <= 0) {
        continue;
      }
      box = box
        ? {
            x: Math.min(box.x, b.x),
            y: Math.min(box.y, b.y),
            width: Math.max(box.x + box.width, b.x + b.width) - Math.min(box.x, b.x),
            height:
              Math.max(box.y + box.height, b.y + b.height) - Math.min(box.y, b.y),
          }
        : { ...b };
    }
    return box ? this.zoomToFitBounds(box) : false;
  }

  // ================= 双击空白快捷建文本 =================

  /** 双击空白处就地创建文本并进入编辑（空文本取消时由内联编辑收尾自动删除） */
  private createTextAt(x: number, y: number) {
    const style = this.opts.getStyle();
    const el = this.dataToElement({
      type: "text",
      x: Math.round(x),
      y: Math.round(y) - TEXT_FONT_SIZE,
      width: 0,
      height: 0,
      text: "",
      stroke: style.stroke,
      fontSize: TEXT_FONT_SIZE,
    });
    if (!el) {
      return;
    }
    this.addToTree(el);
    if (this.tool !== "select") {
      this.setTool("select");
      this.opts.onToolChange?.("select");
    }
    this.editor.select(el as Text);
    this.openTextEdit(el as Text);
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

  /** 开始手动拖动整个选择（tree 局部坐标；组感知：选中含组成员时整组跟随，锁定元素不参与） */
  private beginDragSelection(tx: number, ty: number) {
    this.selectDragging = true;
    this.dragStart = { x: tx, y: ty };
    this.dragEls = this.groupExpandedSelection()
      .filter((el) => !el.locked)
      .map((el) => ({ el, x: el.x ?? 0, y: el.y ?? 0 }));
    this.movedAny = false;
  }

  /** 选中集合的组感知展开：选中含组成员时返回整组（拖拽联动用），否则原样返回 */
  private groupExpandedSelection(): UI[] {
    const list = this.selectedList;
    const gids = new Set(
      list
        .map((el) => (el as unknown as { __groupId?: string }).__groupId)
        .filter((g): g is string => !!g),
    );
    if (!gids.size) {
      return [...list];
    }
    const picked = new Set<UI>(list);
    for (const el of this.app.tree.children as UI[]) {
      const g = (el as unknown as { __groupId?: string }).__groupId;
      if (g !== undefined && gids.has(g)) {
        picked.add(el);
      }
    }
    return [...picked];
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
   * - P3：strokeDash/opacity/cornerRadius 透传到 leafer（dashPattern/opacity/cornerRadius）
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
      // 文本排版扩展：对齐/字体/粗细（仅文字）
      if (partial.textAlign !== undefined && el instanceof Text) {
        el.textAlign = partial.textAlign;
        // 自动宽度下居中/右对齐需 autoSizeAlign 才以 x 为基准生效（leafer 布局规则）；
        // 已固定宽度（拉伸换行）时 textAlign 在框内生效，autoSizeAlign 无副作用
        el.autoSizeAlign = partial.textAlign === "left" ? undefined : true;
      }
      if (partial.fontFamily !== undefined && el instanceof Text) {
        el.fontFamily = partial.fontFamily;
      }
      if (partial.fontWeight !== undefined && el instanceof Text) {
        el.fontWeight = partial.fontWeight;
      }
      // 箭头端点样式（仅 line/arrow，两端可独立设置）
      if (partial.startArrow !== undefined && el instanceof Line) {
        el.startArrow = toLeaferArrow(partial.startArrow);
      }
      if (partial.endArrow !== undefined && el instanceof Line) {
        el.endArrow = toLeaferArrow(partial.endArrow);
      }
      // P3 样式扩展：线型/透明度/圆角（图片跳过圆角——内部填充为图像数据）；
      // 线型用 in 判断：实线的 strokeDash 恰为 undefined，!== undefined 会漏掉“改回实线”
      if ("strokeDash" in partial) {
        (el as unknown as { dashPattern?: number[] }).dashPattern =
          partial.strokeDash;
      }
      if (partial.opacity !== undefined) {
        el.opacity = partial.opacity;
      }
      if (
        partial.cornerRadius !== undefined &&
        el instanceof Rect &&
        !(el instanceof Image)
      ) {
        el.cornerRadius = partial.cornerRadius;
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
   * 切换选中文字字重（Ctrl+B）：全部 ≥700 则改常规 400，否则加粗 700。
   * 整元素切换（TextEditor 纯文本机制不支持局部粗体）；返回是否有文字被切换。
   */
  toggleBold(): boolean {
    const texts = this.selectedList.filter(
      (el): el is Text => el instanceof Text && !el.locked,
    );
    if (!texts.length) {
      return false;
    }
    const weightOf = (t: Text) =>
      typeof t.fontWeight === "number"
        ? t.fontWeight
        : t.fontWeight === "bold"
          ? 700
          : 400;
    const allBold = texts.every((t) => weightOf(t) >= 700);
    for (const t of texts) {
      t.fontWeight = allBold ? 400 : 700;
    }
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
        rough: {
          seed: sketched.seed,
          original: d.type,
          roughness: 1,
          // 改粗糙度重绘需要原始几何：多边形记原始顶点 path，
          // rect/ellipse 记原始宽高、line/arrow 记原始端点（手绘化后原数据已丢失，
          // 且不能用含抖动的渲染尺寸，否则每次重绘逐次放大）
          originalPath: d.type === "path" ? d.path : undefined,
          originalWidth: sketched.originalWidth,
          originalHeight: sketched.originalHeight,
          originalPoints: sketched.originalPoints,
        },
      });
      if (!replaced) {
        continue;
      }
      // 位置/旋转/样式/稳定 id 已随数据透传，替换 tree 节点
      el.remove();
      this.addToTree(replaced);
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
   * 粗糙度：调整选中已手绘元素的抖动强度（0~2，同一 seed 重绘，抖动形态不变仅幅度变化）。
   * 不可重绘（元数据缺失/几何丢失）的元素跳过；返回是否发生了调整。
   */
  setRoughness(value: number): boolean {
    const list = this.selectedList.filter((el) => !el.locked);
    let changed = 0;
    for (const el of list) {
      const t = el as unknown as {
        __rough?: {
          seed: number;
          original?: string;
          originalPath?: string;
          roughness?: number;
        };
      };
      const meta = t.__rough;
      if (!meta) {
        continue;
      }
      const d = this.elementToData(el);
      if (!d) {
        continue;
      }
      const redrawn = redrawRough(d, meta, value);
      if (!redrawn) {
        continue;
      }
      (el as Path).path = redrawn.path;
      t.__rough = { ...meta, roughness: value };
      changed++;
    }
    if (changed) {
      this.scheduleHistory();
      this.opts.onMutated();
    }
    return changed > 0;
  }

  /**
   * frame 框架移动：归属于该框架的内容元素（frameId 显式归属）跟随位移。
   * 与组联动的语义差异：仅框架驱动框内内容（反向不成立，内容移动不带动框架）；
   * 其他框架与锁定元素不跟随（嵌套框架由各层自行驱动其内容）；
   * 内容 Text 是 Box 真子级，随父级自动移动。
   */
  private moveFrameContents(frame: UI, dx: number, dy: number) {
    const fid = this.aiIdOf(frame);
    for (const el of this.app.tree.children as UI[]) {
      if (el === frame || el.locked || isFrameEl(el)) {
        continue;
      }
      if (this.frameIdOf(el) !== fid) {
        continue;
      }
      el.moveWorld(dx, dy);
      this.normalizeContractEl(el);
    }
  }

  /**
   * 框架旋转：归属于该框架的内容元素绕旋转中心同步旋转（位置绕 worldOrigin
   * 转 rotation 度；x/y 元素叠加自身角度，契约元素逐点旋转并入 points/path）。
   * 坐标基准：元素 x/y、points 为 tree 局部坐标，worldOrigin 为世界坐标，
   * 画布缩放/平移后两者不一致，逐点经 getWorldPoint/getLocalPoint 换算。
   */
  private rotateFrameContents(
    frame: UI,
    worldOrigin: { x: number; y: number },
    rotation: number,
  ) {
    const fid = this.aiIdOf(frame);
    if (!rotation) {
      return;
    }
    for (const el of this.app.tree.children as UI[]) {
      if (el === frame || el.locked || isFrameEl(el)) {
        continue;
      }
      if (this.frameIdOf(el) !== fid) {
        continue;
      }
      if (this.selectedList.includes(el)) {
        continue;
      }
      this.normalizeContractEl(el);
      // rotPoint：inner → 世界绕旋转中心转 → 父级局部 → 转回 inner（契约元素
      // points/path 为 inner 坐标；元素自身带 rotation 时 inner≠local，必须
      // 两步换算）；anchorPoint：锚点（inner 原点）世界位置旋转后转回父级
      // 局部即新 x/y——x/y 元素的 x/y 就是父级局部锚点，不能用
      // getInnerPointByLocal（那会把锚点换算成 inner 值写回 x/y，产生偏移）
      const rotPoint = (p: { x: number; y: number }) =>
        el.getInnerPointByLocal(
          el.getLocalPoint(
            rotatePoint(el.getWorldPoint(p), rotation, worldOrigin),
          ),
        );
      const anchorPoint = () =>
        el.getLocalPoint(
          rotatePoint(el.getWorldPoint({ x: 0, y: 0 }), rotation, worldOrigin),
        );
      if (el instanceof Line) {
        const pts = (el.points ?? []).filter(
          (p): p is { x: number; y: number } =>
            typeof p === "object" && p !== null,
        );
        el.points = pts.map(rotPoint);
      } else if (el instanceof Path) {
        const t = el as unknown as { __freehandPoints?: number[][] };
        if (t.__freehandPoints) {
          // freehand 用 x/y + 局部轮廓：锚点绕中心旋转 + 自身角度叠加
          const p = anchorPoint();
          el.x = p.x;
          el.y = p.y;
          el.rotation = (el.rotation ?? 0) + rotation;
        } else {
          el.path = transformPath(el.path as string, rotPoint);
        }
      } else {
        // x/y 元素（rect/ellipse/text/image）：锚点绕中心旋转 + 自身角度叠加
        const p = anchorPoint();
        el.x = p.x;
        el.y = p.y;
        el.rotation = (el.rotation ?? 0) + rotation;
      }
    }
  }

  /**
   * 缩放框架时框内内容跟随：单选缩放框架（width/height 分支或 scale 变换分支，
   * 兄弟元素都不会自动跟随）时，归属于该框架的内容元素（frameId 显式归属）
   * 绕同一世界缩放中心同步缩放（leafer 框架缩放 = 绕 worldOrigin 等比缩放，
   * 与 bbox 仿射等价，直接用 SCALE 事件 data 的 worldOrigin + 比例，不依赖
   * bbox 快照）。坐标基准：元素 x/y、points 为 tree 局部坐标，worldOrigin 为
   * 世界坐标，逐点经 getWorldPoint/getLocalPoint 换算。
   */
  private scaleFrameContents(
    frame: UI,
    worldOrigin: { x: number; y: number },
    scaleX: number,
    scaleY: number,
  ) {
    if (scaleX === 1 && scaleY === 1) {
      return;
    }
    const fid = this.aiIdOf(frame);
    // 手势快照：一次缩放拖动会高频触发 SCALE（事件比例是相对当前状态的增量），
    // 若每次都就地增量缩放内容，每步都经过 transformPath 的两位小数舍入，误差沿
    // T 命令链累积放大（freehand 轮廓直线段被舍成波浪，多次缩放后肉眼可见）。
    // 改为手势第一次触发时快照内容原始状态，之后每次都用“快照 × 累计比例”幂等
    // 重算：舍入只发生一次、误差不跨步累积，多次缩放后轮廓仍保持笔直。
    if (!this.frameScaleSnap || this.frameScaleSnap.frameId !== fid) {
      this.frameScaleSnap = {
        frameId: fid,
        kx: 1,
        ky: 1,
        items: this.snapshotFrameContents(frame, fid),
      };
    }
    const snap = this.frameScaleSnap;
    snap.kx *= scaleX;
    snap.ky *= scaleY;
    const kx = snap.kx;
    const ky = snap.ky;
    // 世界坐标缩放映射（绕 worldOrigin 缩放；原点在整个手势中恒定）
    const tx = (v: number) => worldOrigin.x + (v - worldOrigin.x) * kx;
    const ty = (v: number) => worldOrigin.y + (v - worldOrigin.y) * ky;
    for (const item of snap.items) {
      const el = item.el;
      // 锚点：快照世界锚点绕缩放中心映射后转回父级局部即新 x/y（幂等：反复
      // 写入同一世界锚点，getLocalPoint 会给出同一结果，不会漂移）
      const lp = el.getLocalPoint({
        x: tx(item.worldAnchor.x),
        y: ty(item.worldAnchor.y),
      });
      if (item.kind === "line") {
        // 契约元素（line/arrow/path）位移并入 points/path，避免双重偏移
        (el as Line).points = item.worldPoints!.map((w) =>
          el.getInnerPointByLocal(
            el.getLocalPoint({ x: tx(w.x), y: ty(w.y) }),
          ),
        );
      } else if (item.kind === "freehand") {
        // freehand 用 x/y + 局部轮廓：锚点随缩放映射，局部轮廓按比例缩放
        // （等比缩放下直接乘比例与元素旋转可交换）；penPoints 与 path 同为
        // 局部坐标（绘制时 x/y=0 才恰等于画板坐标），必须绕局部原点缩放——
        // 若当世界坐标绕 worldOrigin 映射，缩放后数值基准变成世界坐标，
        // 整理识别（penPoints + x/y）与改粗细重绘会错位
        const t = el as unknown as { __freehandPoints?: number[][] };
        el.x = lp.x;
        el.y = lp.y;
        el.path = transformPath(item.path as string, (q) => ({
          x: q.x * kx,
          y: q.y * ky,
        }));
        t.__freehandPoints = item.penPoints!.map((pt) => [
          pt[0] * kx,
          pt[1] * ky,
          ...pt.slice(2),
        ]);
      } else if (item.kind === "path") {
        // 普通 path 绝对坐标：快照已是世界坐标，绕缩放中心映射后转回 inner
        el.path = transformPath(item.path as string, (p) =>
          el.getInnerPointByLocal(
            el.getLocalPoint({ x: tx(p.x), y: ty(p.y) }),
          ),
        );
      } else if (item.kind === "text") {
        el.x = lp.x;
        el.y = lp.y;
        (el as Text).fontSize = Math.max(
          4,
          Math.round(item.fontSize! * Math.sqrt(Math.abs(kx * ky))),
        );
      } else {
        // box（rect/ellipse/image）：锚点映射 + 宽高按轴缩放
        el.x = lp.x;
        el.y = lp.y;
        el.width = item.width! * kx;
        el.height = item.height! * ky;
      }
    }
  }

  /**
   * 快照框架内容元素的缩放前状态（单选缩放框架手势第一次 SCALE 时调用）。
   * 快照时把契约元素位移归一化（x/y 并入 points/path），并把参与变换的坐标
   * 统一转成世界坐标，保证重算只依赖快照与累计比例（幂等，不依赖元素当前值）。
   */
  private snapshotFrameContents(frame: UI, fid: string): FrameContentSnap[] {
    const items: FrameContentSnap[] = [];
    for (const el of this.app.tree.children as UI[]) {
      if (el === frame || el.locked || isFrameEl(el)) {
        continue;
      }
      // 归属于该框架的内容才跟随（frameId 显式匹配，不再靠 bbox 猜测）
      if (this.frameIdOf(el) !== fid) {
        continue;
      }
      // 多选缩放时选中的兄弟元素已由编辑器变换，跳过避免双重变换
      if (this.selectedList.includes(el)) {
        continue;
      }
      // 契约元素（line/arrow/path）位移并入 points/path，避免双重偏移
      this.normalizeContractEl(el);
      const t = el as unknown as { __freehandPoints?: number[][] };
      if (el instanceof Line) {
        // 画布内 line 的 points 均为对象数组（扁平 number[] 仅存在于类型定义中）
        const pts = (el.points ?? []).filter(
          (p): p is { x: number; y: number } =>
            typeof p === "object" && p !== null,
        );
        items.push({
          el,
          kind: "line",
          worldAnchor: el.getWorldPoint({ x: 0, y: 0 }),
          worldPoints: pts.map((p) => el.getWorldPoint(p)),
        });
      } else if (el instanceof Path) {
        if (t.__freehandPoints) {
          items.push({
            el,
            kind: "freehand",
            worldAnchor: el.getWorldPoint({ x: 0, y: 0 }),
            path: el.path as string,
            penPoints: t.__freehandPoints.map((pt) => [...pt]),
          });
        } else {
          // 普通 path 快照即转世界坐标：重算时从世界坐标绕缩放中心映射回，
          // 避免元素 x/y 在反复重算中漂移导致 getWorldPoint 基准变化
          items.push({
            el,
            kind: "path",
            worldAnchor: el.getWorldPoint({ x: 0, y: 0 }),
            path: transformPath(el.path as string, (p) =>
              el.getWorldPoint(p),
            ),
          });
        }
      } else if (el instanceof Text) {
        items.push({
          el,
          kind: "text",
          worldAnchor: el.getWorldPoint({ x: 0, y: 0 }),
          fontSize: el.fontSize ?? TEXT_FONT_SIZE,
        });
      } else if (el instanceof Rect || el instanceof Ellipse) {
        items.push({
          el,
          kind: "box",
          worldAnchor: el.getWorldPoint({ x: 0, y: 0 }),
          width: el.width ?? 0,
          height: el.height ?? 0,
        });
      }
    }
    return items;
  }

  // ================= frame 内容归属：frameId + 相对坐标 =================

  /** 读元素的内容归属框架 id（__frameId 实例标记，与序列化字段 frameId 对应） */
  private frameIdOf(el: UI): string | undefined {
    return (el as unknown as { __frameId?: string }).__frameId;
  }

  /** 写元素的内容归属框架 id（undefined = 自由元素） */
  private setFrameId(el: UI, fid: string | undefined) {
    (el as unknown as { __frameId?: string }).__frameId = fid;
  }

  /** 按稳定 id 找框架元素 */
  private frameById(id: string): UI | null {
    for (const el of this.app.tree.children as UI[]) {
      if (isFrameEl(el) && this.aiIdOf(el) === id) {
        return el;
      }
    }
    return null;
  }

  /**
   * 完全包含 el 的框架（归属判定共用：创建/拖入/旧数据升级一致）。
   * 世界 bbox 含描边外扩，容差取描边半宽 + 1px 浮点余量，避免贴边元素
   * （如夹紧后与框架边缘重合）因描边外扩 1px 而归属失败。
   */
  private frameContaining(el: UI): UI | null {
    const eb = el.worldBoxBounds;
    if (!eb) {
      return null;
    }
    const sw = typeof el.strokeWidth === "number" ? el.strokeWidth : 0;
    const tol = sw / 2 + 1;
    for (const frame of this.app.tree.children as UI[]) {
      if (!isFrameEl(frame)) {
        continue;
      }
      const fb = frame.worldBoxBounds;
      if (!fb) {
        continue;
      }
      if (
        eb.x >= fb.x - tol &&
        eb.y >= fb.y - tol &&
        eb.x + eb.width <= fb.x + fb.width + tol &&
        eb.y + eb.height <= fb.y + fb.height + tol
      ) {
        return frame;
      }
    }
    return null;
  }

  /**
   * 绘制/导入完成的元素归属判定：完全包含于某框架 → 挂上该框架的
   * frameId（一次性判定，此后跟随/拖出都由 frameId 显式驱动，不再靠 bbox 猜测）。
   */
  private adoptIntoFrame(el: UI) {
    if (isFrameEl(el) || this.frameIdOf(el)) {
      return;
    }
    const frame = this.frameContaining(el);
    if (frame) {
      this.setFrameId(el, this.aiIdOf(frame));
    }
  }

  /**
   * 内容元素坐标换算（相对 → 世界）：运行时元素始终以世界坐标渲染（兄弟元素），
   * 加载/粘贴带 frameId 的数据时按框架位置/旋转还原；框架不存在则解除归属。
   */
  private toWorldElement(el: UI) {
    const fid = this.frameIdOf(el);
    if (!fid) {
      return;
    }
    const frame = this.frameById(fid);
    if (!frame) {
      this.setFrameId(el, undefined);
      return;
    }
    const fx = frame.x ?? 0;
    const fy = frame.y ?? 0;
    const rot = frame.rotation ?? 0;
    const toWorld = (p: { x: number; y: number }) => {
      const q = rotatePoint(p, rot);
      return { x: q.x + fx, y: q.y + fy };
    };
    if (el instanceof Line) {
      const pts = (el.points ?? []).filter(
        (p): p is { x: number; y: number } =>
          typeof p === "object" && p !== null,
      );
      el.points = pts.map(toWorld);
    } else if (el instanceof Path) {
      const t = el as unknown as { __freehandPoints?: number[][] };
      if (t.__freehandPoints) {
        // freehand 用 x/y + 局部轮廓：只换算位置
        const p = toWorld({ x: el.x ?? 0, y: el.y ?? 0 });
        el.x = p.x;
        el.y = p.y;
      } else {
        el.path = transformPath(el.path as string, toWorld);
      }
    } else {
      const p = toWorld({ x: el.x ?? 0, y: el.y ?? 0 });
      el.x = p.x;
      el.y = p.y;
    }
  }

  /**
   * 场景归属解析（loadElements/粘贴后调用）：带 frameId 的内容元素换算坐标
   * （相对 → 世界；worldCoords 模式跳过，数据已是世界坐标），无 frameId 的
   * 旧数据元素按 bbox 包含自动补挂归属（旧文件升级兼容）。
   */
  private resolveFrameContents(worldCoords?: boolean) {
    for (const el of this.app.tree.children as UI[]) {
      if (this.frameIdOf(el)) {
        if (!worldCoords) {
          this.toWorldElement(el);
        }
      } else if (!isFrameEl(el)) {
        this.adoptIntoFrame(el);
      }
    }
  }

  // ================= frame 内容容器：转换 / 约束 / 创建 =================

  /** 选中单个未锁定 rect → 转为框架（虚线描边 + 容器标记），返回是否成功 */
  toFrame(): boolean {
    const list = this.selectedList.filter((el) => !el.locked);
    if (list.length !== 1 || !(list[0] instanceof Rect) || isFrameEl(list[0])) {
      return false;
    }
    const el = list[0];
    const meta = el as unknown as Record<string, unknown>;
    meta[FRAME_FLAG] = true;
    (el as unknown as { dashPattern?: number[] }).dashPattern = [8, 5];
    this.commitHistory();
    this.opts.onMutated();
    return true;
  }

  /** 选中单个未锁定 frame → 转为普通矩形（内容子元素一并移除），返回是否成功 */
  toRect(): boolean {
    const list = this.selectedList.filter((el) => !el.locked);
    if (list.length !== 1 || !isFrameEl(list[0])) {
      return false;
    }
    const el = list[0];
    const parent = el.parent;
    const index = parent ? (parent.children as UI[]).indexOf(el) : -1;
    // 框架是 Box（Group 子类）且内容 Text 为真子级：重建等价 Rect 替换节点
    // （普通矩形逻辑均按 Rect 类型判断，Box 无法原地降级），子元素随 destroy 级联销毁
    const rect = new Rect({
      x: el.x,
      y: el.y,
      rotation: el.rotation,
      width: el.width,
      height: el.height,
      fill: el.fill,
      stroke: el.stroke,
      strokeWidth: el.strokeWidth,
      opacity: el.opacity,
    });
    // 透传业务元数据（AI 标识/组关系/意图），框架专属 meta 不保留
    const srcMeta = el as unknown as Record<string, unknown>;
    const dstMeta = rect as unknown as Record<string, unknown>;
    for (const key of ["__aiId", "__groupId", "__intent"] as const) {
      const v = srcMeta[key];
      if (v !== undefined) {
        dstMeta[key] = v;
      }
    }
    // 框架转矩形：其内容归属元素解除归属变自由元素（不随旧框架销毁）
    const fid = this.aiIdOf(el);
    for (const other of this.app.tree.children as UI[]) {
      if (this.frameIdOf(other) === fid) {
        this.setFrameId(other, undefined);
      }
    }
    el.destroy();
    if (parent && index >= 0) {
      parent.add(rect, index);
    }
    this.editor.target = rect;
    this.commitHistory();
    this.opts.onMutated();
    return true;
  }

  /** 选中单个未锁定 frame：翻转内容约束开关（开启后框内绘制/拖动夹紧），返回是否成功 */
  toggleFrameConstrain(): boolean {
    const list = this.selectedList.filter((el) => !el.locked);
    if (list.length !== 1 || !isFrameEl(list[0])) {
      return false;
    }
    const meta = list[0] as unknown as Record<string, unknown>;
    meta.__frameConstrain = meta.__frameConstrain !== true;
    // 约束状态可视化：实线描边 = 约束开启，虚线 = 普通框
    this.applyFrameConstrainVisual(list[0]);
    this.commitHistory();
    this.opts.onMutated();
    return true;
  }

  /**
   * 选中元素框架操作资格（右键菜单用）：单选未锁定 rect/frame 时给出转换资格，
   * frame 额外给出内容约束/折叠开关状态与聚焦状态。
   */
  frameActionState(): {
    canToFrame: boolean;
    canToRect: boolean;
    constrainOn: boolean;
    canCollapse: boolean;
    collapsedOn: boolean;
    canFocus: boolean;
    focusOn: boolean;
  } {
    const list = this.selectedList.filter((el) => !el.locked);
    let canToFrame = false;
    let canToRect = false;
    let constrainOn = false;
    let canCollapse = false;
    let collapsedOn = false;
    let canFocus = false;
    let focusOn = false;
    if (list.length === 1) {
      const el = list[0];
      if (el instanceof Rect && !isFrameEl(el)) {
        canToFrame = true;
      }
      if (isFrameEl(el)) {
        canToRect = true;
        const meta = el as unknown as Record<string, unknown>;
        constrainOn = meta.__frameConstrain === true;
        collapsedOn = meta.__frameCollapsed === true;
        canFocus = true;
        focusOn = this.frameFocus?.id === this.aiIdOf(el);
        // 折叠资格：内容型框架且内容超高（不足一屏折叠无意义）
        if (
          typeof meta.__frameContent === "string" &&
          meta.__frameContent &&
          meta.__frameAutoSize !== false
        ) {
          const h = frameContentSize(
            meta.__frameContent,
            typeof meta.__frameContentType === "string"
              ? (meta.__frameContentType as "markdown" | "code" | "text")
              : undefined,
          ).height;
          canCollapse = collapsedOn || h > FRAME_COLLAPSED_HEIGHT;
        }
      }
    }
    return {
      canToFrame,
      canToRect,
      constrainOn,
      canCollapse,
      collapsedOn,
      canFocus,
      focusOn,
    };
  }

  /**
   * 选中单个未锁定内容框架：切换内容折叠（折叠后固定高度裁剪 + 滚轮滚动查看；
   * 展开恢复 autoSize 全部展示）。内容不足一屏时不提供折叠入口（资格见
   * frameActionState），此处按当前状态反转。返回是否成功。
   */
  toggleFrameCollapsed(): boolean {
    const list = this.selectedList.filter((el) => !el.locked);
    if (list.length !== 1 || !isFrameEl(list[0])) {
      return false;
    }
    const el = list[0] as Box;
    const meta = el as unknown as Record<string, unknown>;
    const content =
      typeof meta.__frameContent === "string" ? meta.__frameContent : "";
    if (!content) {
      return false;
    }
    const collapsing = meta.__frameCollapsed !== true;
    const size = frameContentSize(
      content,
      typeof meta.__frameContentType === "string"
        ? (meta.__frameContentType as "markdown" | "code" | "text")
        : undefined,
    );
    meta.__frameCollapsed = collapsing;
    if (collapsing) {
      // 折叠：高度压到上限（内容不足一屏时保持原高，无裁剪也无滚动）。
      // overflow 必须含 "scroll"：leafer Box 仅在 overflow 含 scroll 时把
      // scrollX/scrollY 应用于子级 bounds 平移（hide 只裁剪不平移），
      // 无 scroller 插件时不会出现滚动条 UI
      el.height = Math.min(size.height, FRAME_COLLAPSED_HEIGHT);
      el.overflow = "scroll";
      el.scrollY = 0;
    } else {
      // 展开：恢复 autoSize 高度，清滚动与裁剪
      el.height = size.height;
      el.overflow = undefined;
      el.scrollY = 0;
    }
    this.commitHistory();
    this.opts.onMutated();
    return true;
  }

  /**
   * 折叠框架内容滚动：滚轮向下（deltaY > 0）内容上移查看后文。
   * leafer 的 scrollY 正值让子级向下平移，因此用负值区间
   * [-max, 0] 表示内容向上滚动（0 = 顶部，-max = 底部），
   * 渲染管线按 overflow: "scroll" 平移子级并在框内裁剪。
   */
  private scrollFrameContent(el: Box, deltaY: number) {
    const meta = el as unknown as Record<string, unknown>;
    const content =
      typeof meta.__frameContent === "string" ? meta.__frameContent : "";
    const max = frameScrollMax(
      content,
      typeof meta.__frameContentType === "string"
        ? (meta.__frameContentType as "markdown" | "code" | "text")
        : undefined,
      el.height ?? 0,
    );
    if (max <= 0) {
      return;
    }
    const next = Math.min(Math.max((el.scrollY ?? 0) - deltaY, -max), 0);
    el.scrollY = next;
  }

  /** 命中可滚动的折叠框架：世界坐标落在其 bbox 内且内容有滚动余量（无则 null） */
  private scrollableFrameAt(p: { x: number; y: number }): Box | null {
    for (const el of this.app.tree.children as UI[]) {
      if (!isFrameEl(el)) {
        continue;
      }
      const meta = el as unknown as Record<string, unknown>;
      if (meta.__frameCollapsed !== true) {
        continue;
      }
      const b = el.worldBoxBounds;
      if (
        b &&
        p.x >= b.x &&
        p.x <= b.x + b.width &&
        p.y >= b.y &&
        p.y <= b.y + b.height
      ) {
        return el as Box;
      }
    }
    return null;
  }

  /**
   * 聚焦框架：视口缩放/平移到框架充满视口（留边距），保存聚焦前视口供退出恢复；
   * 折叠/展开状态均适用。已在聚焦且传入同一框架时退出恢复。
   */
  toggleFrameFocus(): boolean {
    const list = this.selectedList.filter((el) => !el.locked);
    if (list.length !== 1 || !isFrameEl(list[0])) {
      return false;
    }
    const el = list[0];
    const id = this.aiIdOf(el);
    const layer = this.app.tree.zoomLayer;
    if (!layer) {
      return false;
    }
    if (this.frameFocus?.id === id) {
      // 退出聚焦：恢复聚焦前视口
      const v = this.frameFocus.view;
      layer.x = v.x;
      layer.y = v.y;
      layer.scaleX = v.sx;
      layer.scaleY = v.sy;
      this.frameFocus = null;
      this.updateGrid();
      return true;
    }
    const b = el.worldBoxBounds;
    if (!b) {
      return false;
    }
    const view = this.app.canvas.view as HTMLElement;
    const vw = this.app.width ?? view.clientWidth;
    const vh = this.app.height ?? view.clientHeight;
    // 目标缩放：框架占视口 85%（留边距），限制在画布缩放范围内
    const target = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min(vw / b.width, vh / b.height) * 0.85),
    );
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    this.frameFocus = {
      id,
      view: {
        x: layer.x ?? 0,
        y: layer.y ?? 0,
        sx: layer.scaleX ?? 1,
        sy: layer.scaleY ?? 1,
      },
    };
    // 世界坐标 → 视口：layer 平移量 = 视口中心 - 框架中心 * target
    layer.scaleX = target;
    layer.scaleY = target;
    layer.x = vw / 2 - cx * target;
    layer.y = vh / 2 - cy * target;
    this.updateGrid();
    return true;
  }

  /**
   * 创建内容型框架（导入 MD/代码/文本用）：autoSize 按内容撑尺寸，
   * 新框架立即选中，返回是否成功。
   */
  createContentFrame(
    x: number,
    y: number,
    info: {
      name?: string;
      contentType: "markdown" | "code" | "text";
      content: string;
    },
  ): boolean {
    if (!info.content) {
      return false;
    }
    const style = this.opts.getStyle();
    const el = this.dataToElement({
      type: "frame",
      x,
      y,
      width: 0,
      height: 0,
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
      // 框架淡填充固定 10% 透明度（与生成器一致，区别于普通图形 15%）
      fill: hexToRgba(style.fillColor || style.stroke, 0.1),
      name: info.name,
      contentType: info.contentType,
      content: info.content,
      autoSize: true,
    });
    if (!el) {
      return false;
    }
    this.addToTree(el);
    this.editor.target = el;
    this.commitHistory();
    this.opts.onMutated();
    return true;
  }

  // ---------- 约束夹紧内部 ----------

  /** 点钳制到约束框架内：出框坐标压回框架边界（画笔逐点夹紧用） */
  private clampPointToFrame(px: number, py: number): { x: number; y: number } {
    const frame = this.drawingFrame;
    if (!frame) {
      return { x: px, y: py };
    }
    // page 基准 bbox：绘制坐标为 tree.getInnerPoint 结果（page，不含 zoomLayer
    // 变换），而 worldBoxBounds 是视口基准，缩放/平移后两者错位导致夹紧失效
    const b = frame.getBounds("box", "page");
    if (!b) {
      return { x: px, y: py };
    }
    return {
      x: Math.min(Math.max(px, b.x), b.x + b.width),
      y: Math.min(Math.max(py, b.y), b.y + b.height),
    };
  }

  /** 命中约束框架：点 (x, y) 落在的 constrain 框架（无则 null） */
  private constrainFrameAt(x: number, y: number): UI | null {
    for (const el of this.app.tree.children as UI[]) {
      if (
        !isFrameEl(el) ||
        (el as unknown as Record<string, unknown>).__frameConstrain !== true
      ) {
        continue;
      }
      // page 基准判定：x/y 来自 tree.getInnerPoint（page 坐标，不含 zoomLayer
      // 变换），与 worldBoxBounds（视口基准）比较在缩放/平移后必然错位
      const b = el.getBounds("box", "page");
      if (!b) {
        continue;
      }
      if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
        return el;
      }
    }
    return null;
  }

  /**
   * 元素所属约束框架 bbox：按包围盒重叠率归属——交集面积占元素面积 ≥60% 即受该框
   * 约束；多框命中取重叠率最高者（并列取面积更小的内层框，嵌套语义可预期）。
   * 旧实现用中心点判定：贴边元素中心在外则完全不受控、拖动中一越线即"逃逸"，手感飘忽。
   * 世界 bbox 直接判定（不用 elementToData，避免序列化坐标换算干扰）；
   * 夹紧会把 bbox 拉回框内，拖出需按住 Alt 豁免。
   */
  private constrainFrameOf(
    el: UI | IUI,
  ): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const eb = el.worldBoxBounds;
    if (!eb || eb.width <= 0 || eb.height <= 0) {
      return null;
    }
    const elArea = eb.width * eb.height;
    let best: {
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
    } | null = null;
    let bestRatio = CONSTRAINT_ADOPT_RATIO;
    let bestArea = Infinity;
    for (const other of this.app.tree.children as UI[]) {
      if (other === el || !isFrameEl(other)) {
        continue;
      }
      if (
        (other as unknown as Record<string, unknown>).__frameConstrain !== true
      ) {
        continue;
      }
      const fb = other.worldBoxBounds;
      if (!fb) {
        continue;
      }
      const ix =
        Math.min(eb.x + eb.width, fb.x + fb.width) - Math.max(eb.x, fb.x);
      const iy =
        Math.min(eb.y + eb.height, fb.y + fb.height) - Math.max(eb.y, fb.y);
      if (ix <= 0 || iy <= 0) {
        continue;
      }
      const ratio = (ix * iy) / elArea;
      if (ratio < bestRatio) {
        continue;
      }
      const area = fb.width * fb.height;
      if (ratio > bestRatio || area < bestArea) {
        bestRatio = ratio;
        bestArea = area;
        best = {
          minX: fb.x,
          minY: fb.y,
          maxX: fb.x + fb.width,
          maxY: fb.y + fb.height,
        };
      }
    }
    return best;
  }

  /**
   * 约束夹紧（事后校正）：把列表中受约束成员的世界 bbox 整体平移回所属框架内
   * （不改尺寸/旋转）。用于点编辑收尾、粘贴落点等移动管线之外的兜底。
   */
  private clampConstrainedMembers(list?: UI[]) {
    const movers =
      list ??
      ((this.editor as unknown as { list?: UI[] }).list ?? []);
    for (const el of movers) {
      if (!el || isFrameEl(el) || el.locked) {
        continue;
      }
      const fb = this.constrainFrameOf(el);
      if (!fb) {
        continue;
      }
      const b = el.worldBoxBounds;
      if (!b) {
        continue;
      }
      const shift = clampShift(
        {
          minX: b.x,
          minY: b.y,
          maxX: b.x + b.width,
          maxY: b.y + b.height,
        },
        fb,
      );
      if (shift.dx || shift.dy) {
        el.moveWorld(shift.dx, shift.dy);
      }
    }
  }

  /** 新元素接入框体系：完全落入框架即归属；落在约束框架内即夹紧入框 */
  private adoptAndClamp(el: UI) {
    this.adoptIntoFrame(el);
    this.clampConstrainedMembers([el]);
  }

  /** 约束状态可视化：开启约束的框架描边转实线（虚线 = 普通框），一眼区分 */
  private applyFrameConstrainVisual(el: UI) {
    const on =
      (el as unknown as Record<string, unknown>).__frameConstrain === true;
    (el as unknown as { dashPattern?: number[] }).dashPattern = on
      ? undefined
      : [8, 5];
  }

  /**
   * 生成器结果整体平移夹紧到约束框架内（联合 bbox 完全包含；
   * 元素大于框架时仅最小越界修正，保证绘制起点不丢）。
   */
  private clampListToFrame(list: ElementData[], frame: UI): ElementData[] {
    // page 基准：elementBounds 读数据坐标（page），框架 bbox 必须同基准
    // （worldBoxBounds 为视口基准，缩放/平移后与数据坐标错位）
    const fb = frame.getBounds("box", "page");
    if (!fb) {
      return list;
    }
    const frameBox = { minX: fb.x, minY: fb.y, maxX: fb.x + fb.width, maxY: fb.y + fb.height };
    let box: {
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
    } | null = null;
    for (const d of list) {
      const b = elementBounds(d);
      box = box
        ? {
            minX: Math.min(box.minX, b.minX),
            minY: Math.min(box.minY, b.minY),
            maxX: Math.max(box.maxX, b.maxX),
            maxY: Math.max(box.maxY, b.maxY),
          }
        : b;
    }
    if (!box) {
      return list;
    }
    const shift = clampShift(box, frameBox);
    if (!shift.dx && !shift.dy) {
      return list;
    }
    return list.map((d) => offsetElementData(d, shift.dx, shift.dy));
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
    // serialize 会为所有元素分配稳定 id，先序列化再取选中 id；
    // 内容归属元素先展开为世界坐标（相对坐标会让对齐/分布计算失真）
    const before = this.serialize();
    const ids = list
      .map((el) => this.aiIdOf(el))
      .filter((id): id is string => !!id);
    const { elements, stats } = beautifyScene(expandFrameContents(before), ids);
    if (!stats.length) {
      return { changed: 0, stats: [] };
    }
    // 整理输出已是世界坐标：worldCoords 模式跳过相对→世界换算，
    // 无 frameId 的元素按 bbox 包含自动重新归属（整理后仍在框架内的内容
    // 继续跟随框架）
    this.loadElements(elements, { worldCoords: true });
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
    // 整理后的场景重新序列化（相对坐标），保证历史快照坐标系一致
    this.pushSnapshot(this.serialize());
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
    // 内容归属：仅当所属框架也一起复制时才保留 frameId（相对坐标随框架平移），
    // 否则临时解除归属按世界坐标复制（粘贴为自由元素，避免失去框架后坐标错位）
    const frameIds = new Set(
      list.filter((el) => isFrameEl(el)).map((el) => this.aiIdOf(el)),
    );
    const detached: { el: UI; fid: string }[] = [];
    for (const el of list) {
      const fid = this.frameIdOf(el);
      if (fid && !frameIds.has(fid)) {
        detached.push({ el, fid });
        this.setFrameId(el, undefined);
      }
    }
    this.clipboard = list
      .map((el) => this.elementToData(el))
      .filter((d): d is ElementData => d !== null);
    // 恢复临时解除的归属（仅影响序列化输出，不改变运行态归属）
    for (const { el, fid } of detached) {
      this.setFrameId(el, fid);
    }
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

  /**
   * AI 按 id 删除元素：同组成员整组参与、锁定元素跳过计入手数；
   * 整轮合并一步撤销，删除后清理点编辑/裁剪/编辑器选中状态。
   */
  deleteByIds(ids: string[]): { removed: number; skipped: number } {
    const found: UI[] = [];
    const seen = new Set<UI>();
    let locked = 0;
    for (const raw of ids) {
      const el = this.findByAiId(raw);
      if (!el || seen.has(el)) {
        continue;
      }
      if (el.locked) {
        locked++;
        continue;
      }
      seen.add(el);
      found.push(el);
    }
    if (!found.length) {
      return { removed: 0, skipped: locked };
    }
    // 同组成员整组参与（与 arrange/beautify 的组联动语义一致）
    const gids = new Set<string>();
    for (const el of found) {
      const g = (el as unknown as { __groupId?: string }).__groupId;
      if (g) {
        gids.add(g);
      }
    }
    if (gids.size) {
      for (const el of this.app.tree.children as UI[]) {
        const g = (el as unknown as { __groupId?: string }).__groupId;
        if (g && gids.has(g) && !seen.has(el)) {
          if (el.locked) {
            locked++;
            continue;
          }
          seen.add(el);
          found.push(el);
        }
      }
    }
    for (const el of found) {
      el.destroy();
    }
    this.editor.cancel();
    this.exitPointEdit();
    this.cropCtrl.cancel();
    this.commitHistory();
    this.opts.onMutated();
    return { removed: found.length, skipped: locked };
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
      // 避免绝对坐标契约元素双重偏移；id 不随粘贴复制（粘贴出的元素分配全新 id）。
      // 内容归属元素（frameId）不平移：相对坐标由框架平移带动（框架同样在剪贴板时
      // 两者一致；框架不在时归属解析阶段会解除归属并保留相对坐标）
      let dd: ElementData = {
        ...d,
        id: undefined,
        // 副本不继承组关系，避免与原组联动
        groupId: undefined,
      };
      if (!dd.frameId) {
        dd = offsetElementData(dd, dx, dy);
      }
      const el = this.dataToElement(dd);
      if (el) {
        this.addToTree(el);
        pasted.push(el);
      }
    }
    // 归属解析：带 frameId 的内容换算相对→世界（框架不在时解除归属）；
    // 落在约束框架内的粘贴成员夹紧入框
    this.resolveFrameContents();
    this.clampConstrainedMembers(pasted);
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
    this.reorderSelection("front");
  }

  toBack() {
    this.reorderSelection("back");
  }

  /**
   * 层序重排通用管线：序列化 → 锁定过滤 + 组归一化 → reorderElements →
   * 全量重建 → 恢复选中 → 前后快照合并。顺序无变化时（已在目标层）不重建不写历史。
   */
  private reorderSelection(mode: ReorderMode) {
    const before = this.serialize();
    const selIds = this.selectedUnlockedIds();
    if (!selIds.length) {
      return;
    }
    const ids = expandGroupMembers(before, selIds);
    const next = reorderElements(before, [...ids], (d) => d.id ?? "", mode);
    if (next.every((d, i) => d === before[i])) {
      return;
    }
    this.loadElements(next);
    this.restoreSelectionByIds([...ids]);
    this.pushSnapshot(before);
    this.pushSnapshot(next);
  }

  // ================= AI 排列（对齐/分布/翻转/层序，供 arrange_elements 工具） =================
  arrangeByIds(
    ids: string[],
    action: ArrangeAction,
  ): { done: number; skipped: number } {
    // before 为相对坐标（历史快照基准）；计算在世界坐标下进行（frame 内元素
    // 相对坐标会让对齐/分布失真），loadElements 用 worldCoords 模式重建
    const before = this.serialize();
    const world = expandFrameContents(before);
    const byId = new Map(world.map((d) => [d.id, d]));
    const found = ids.filter((id) => byId.has(id));
    const skipped = found.filter((id) => byId.get(id)?.locked).length;
    const selIds = found.filter((id) => !byId.get(id)?.locked);
    if (!selIds.length) {
      return { done: 0, skipped };
    }
    const members = expandGroupMembers(world, selIds);
    const targets = world.filter((d) => members.has(d.id ?? ""));
    let next: ElementData[];
    if (
      action === "front" ||
      action === "back" ||
      action === "forward" ||
      action === "backward"
    ) {
      // 层序作用于全列表（组内成员必须保持相对顺序），其余动作只作用于目标元素
      next = reorderElements(world, [...members], (d) => d.id ?? "", action);
    } else {
      const changed = this.arrangeFn(action)(targets);
      const changedById = new Map(changed.map((d) => [d.id, d]));
      next = world.map((d) => changedById.get(d.id) ?? d);
    }
    if (next.every((d, i) => d === world[i])) {
      return { done: 0, skipped };
    }
    this.loadElements(next, { worldCoords: true });
    // 历史快照保持相对坐标（undo/redo 走默认换算路径）
    this.pushSnapshot(before);
    this.pushSnapshot(this.serialize());
    return { done: members.size, skipped };
  }

  // ================= AI 整理/手绘/粗糙度（beautify_elements 等工具，按 id 操作） =================

  /**
   * AI 整理（beautify_elements 工具）：按 id 把手绘笔迹识别为标准图形/拉直，
   * 未指名的元素原样保留；同组成员整组参与、锁定元素跳过；整轮改动一步撤销。
   */
  beautifyByIds(
    ids: string[],
  ): { changed: number; stats: BeautifyStats; skipped: number } {
    const before = this.serialize();
    const byId = new Map(before.map((d) => [d.id, d]));
    const found = ids.filter((id) => byId.has(id));
    const skipped = found.filter((id) => byId.get(id)?.locked).length;
    const selIds = found.filter((id) => !byId.get(id)?.locked);
    if (!selIds.length) {
      return { changed: 0, stats: [], skipped };
    }
    const members = expandGroupMembers(before, selIds);
    const { elements, stats } = beautifyScene(
      expandFrameContents(before),
      [...members],
    );
    if (!stats.length) {
      return { changed: 0, stats: [], skipped };
    }
    this.loadElements(elements, { worldCoords: true });
    this.pushSnapshot(before);
    this.pushSnapshot(this.serialize());
    return { changed: stats.length, stats, skipped };
  }

  /**
   * AI 手绘化（sketchify_elements 工具）：按 id 把标准图形转为 rough 手绘风格，
   * 已手绘/不可手绘的元素自动跳过；同组成员整组参与、锁定元素跳过。
   */
  sketchifyByIds(ids: string[]): { changed: number; skipped: number } {
    const before = this.serialize();
    const byId = new Map(before.map((d) => [d.id, d]));
    const found = ids.filter((id) => byId.has(id));
    const skipped = found.filter((id) => byId.get(id)?.locked).length;
    const selIds = found.filter((id) => !byId.get(id)?.locked);
    if (!selIds.length) {
      return { changed: 0, skipped };
    }
    const members = expandGroupMembers(before, selIds);
    let changed = 0;
    const next = expandFrameContents(before).map((d) => {
      if (!d.id || !members.has(d.id) || !isSketchable(d)) {
        return d;
      }
      const sketched = sketchifyData(d);
      if (!sketched) {
        return d;
      }
      changed++;
      return {
        ...d,
        type: "path" as const,
        path: sketched.path,
        rough: {
          seed: sketched.seed,
          original: d.type,
          roughness: 1,
          originalPath: d.type === "path" ? d.path : undefined,
          originalWidth: sketched.originalWidth,
          originalHeight: sketched.originalHeight,
          originalPoints: sketched.originalPoints,
        },
      };
    });
    if (!changed) {
      return { changed: 0, skipped };
    }
    this.loadElements(next, { worldCoords: true });
    this.pushSnapshot(before);
    this.pushSnapshot(this.serialize());
    return { changed, skipped };
  }

  /**
   * AI 粗糙度（set_roughness 工具）：按 id 调整已手绘元素的抖动强度（0~2），
   * 同一 seed 重绘（抖动态不变仅幅度变化）；无 rough 元数据的元素跳过。
   */
  setRoughnessByIds(
    ids: string[],
    value: number,
  ): { changed: number; skipped: number } {
    const before = this.serialize();
    const byId = new Map(before.map((d) => [d.id, d]));
    const found = ids.filter((id) => byId.has(id));
    const skipped = found.filter((id) => byId.get(id)?.locked).length;
    const selIds = found.filter((id) => !byId.get(id)?.locked);
    if (!selIds.length) {
      return { changed: 0, skipped };
    }
    const members = expandGroupMembers(before, selIds);
    let changed = 0;
    const next = expandFrameContents(before).map((d) => {
      if (!d.id || !members.has(d.id) || !d.rough) {
        return d;
      }
      const redrawn = redrawRough(d, d.rough, value);
      if (!redrawn) {
        return d;
      }
      changed++;
      return { ...d, path: redrawn.path, rough: { ...d.rough, roughness: value } };
    });
    if (!changed) {
      return { changed: 0, skipped };
    }
    this.loadElements(next, { worldCoords: true });
    this.pushSnapshot(before);
    this.pushSnapshot(this.serialize());
    return { changed, skipped };
  }

  /** ArrangeAction → 纯函数变换（对齐/分布/翻转；层序走 reorderElements 分支） */
  private arrangeFn(action: ArrangeAction): (els: ElementData[]) => ElementData[] {
    switch (action) {
      case "align-left":
        return (els) => alignElements(els, "left");
      case "align-centerX":
        return (els) => alignElements(els, "centerX");
      case "align-right":
        return (els) => alignElements(els, "right");
      case "align-top":
        return (els) => alignElements(els, "top");
      case "align-centerY":
        return (els) => alignElements(els, "centerY");
      case "align-bottom":
        return (els) => alignElements(els, "bottom");
      case "distribute-h":
        return (els) => distributeElements(els, "horizontal");
      case "distribute-v":
        return (els) => distributeElements(els, "vertical");
      case "flip-h":
      case "flip-v":
        return (els) => {
          const b = unionBounds(els);
          const axis = action === "flip-h" ? "h" : "v";
          return flipElements(
            els,
            axis,
            (b.minX + b.maxX) / 2,
            (b.minY + b.maxY) / 2,
          );
        };
      default:
        // 层序（front/back/forward/backward）不经过此分支
        return (els) => els;
    }
  }

  /** 当前选中中可操作（未锁定、非编辑器内部）元素的稳定 id */
  private selectedUnlockedIds(): string[] {
    return this.selectedList
      .filter((el) => !el.locked && !this.isEditorInternal(el))
      .map((el) => this.aiIdOf(el));
  }

  /** 按稳定 id 恢复选中（对齐/分布/翻转/层序后保持连续操作上下文） */
  private restoreSelectionByIds(ids: string[]) {
    const restored = (this.app.tree.children as UI[]).filter((el) => {
      const id = (el as unknown as { __aiId?: string }).__aiId;
      return !!id && ids.includes(id);
    });
    if (restored.length === 1) {
      this.editor.target = restored[0];
    } else if (restored.length > 1) {
      this.editor.select(restored);
    }
  }

  /** 重复选中元素：整体偏移 (12, 12) 并自动选中副本（Ctrl+D） */
  duplicateSelected(): boolean {
    const list = this.selectedList;
    const data = list
      .map((el) => this.elementToData(el))
      .filter((d): d is ElementData => d !== null);
    if (!data.length) {
      return false;
    }
    const pasted: UI[] = [];
    for (const d of data) {
      const el = this.dataToElement({
        ...offsetElementData(d, 12, 12),
        id: undefined,
        // 副本不继承组关系，避免与原组联动
        groupId: undefined,
      });
      if (el) {
        this.addToTree(el);
        pasted.push(el);
      }
    }
    if (pasted.length) {
      this.editor.target = pasted.length === 1 ? pasted[0] : pasted;
      this.commitHistory();
      return true;
    }
    return false;
  }

  // ================= 锁定 / 解锁 =================
  
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
    // 框选/套索本质是选择操作：松手后自动切回选择工具，
    // 选中元素可直接拖动移动、左侧选中栏随即出现（与 Excalidraw 行为一致）
    if (this.tool === "marquee" || this.tool === "lasso") {
      this.setTool("select");
      this.opts.onToolChange?.(this.tool);
    }
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
    let targets = list.filter((el) => !el.locked);
    if (!targets.length) {
      return;
    }
    // 组感知：组内任一成员被删除时整组删除（锁定成员仍受保护）
    const gids = new Set(
      targets
        .map((el) => (el as unknown as { __groupId?: string }).__groupId)
        .filter((g): g is string => !!g),
    );
    if (gids.size) {
      const all = this.app.tree.children as UI[];
      targets = all.filter((el) => {
        if (el.locked) {
          return false;
        }
        const g = (el as unknown as { __groupId?: string }).__groupId;
        return targets.includes(el) || (g !== undefined && gids.has(g));
      });
    }
    // 删除：从画布直接移除（无回收站），组内任一成员被删时整组删除；
    // 框架是 Box 容器，用 destroy 级联销毁内容子元素；其内容归属元素
    // （画笔/形状等兄弟内容）解除归属变自由元素
    targets.forEach((el) => {
      if (isFrameEl(el)) {
        const fid = this.aiIdOf(el);
        for (const other of this.app.tree.children as UI[]) {
          if (this.frameIdOf(other) === fid) {
            this.setFrameId(other, undefined);
          }
        }
        el.destroy();
      } else {
        el.remove();
      }
    });
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
    this.addToTree(el);
    // AI 创建同样接入框体系：完全落入框架即归属，落在约束框架内即夹紧入框
    this.adoptAndClamp(el);
    return this.aiIdOf(el);
  }

  /** 当前选中元素的序列化数据（含稳定 id），供 AI 面板 @ 选区使用 */
  getSelectionData(): ElementData[] {
    return this.selectedList
      .map((el) => this.elementToData(el))
      .filter((d): d is ElementData => d !== null);
  }

  /** 按稳定 id 查找画布元素（AI 工具执行器/试画清理用）；不存在返回 null */
  findElementByAiId(id: string): UI | null {
    return this.findByAiId(id);
  }

  /** 选区联合包围盒尺寸（状态栏 W×H 展示用）；无选中返回 null */
  getSelectionSize(): { width: number; height: number } | null {
    let box: {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null = null;
    for (const el of this.selectedList) {
      const b = el.worldBoxBounds;
      if (!b) {
        continue;
      }
      box = box
        ? {
            x: Math.min(box.x, b.x),
            y: Math.min(box.y, b.y),
            width: Math.max(box.x + box.width, b.x + b.width) - Math.min(box.x, b.x),
            height: Math.max(box.y + box.height, b.y + b.height) - Math.min(box.y, b.y),
          }
        : { ...b };
    }
    return box ? { width: box.width, height: box.height } : null;
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
    if (patch.textAlign !== undefined && el instanceof Text) {
      el.textAlign = patch.textAlign;
      el.autoSizeAlign = patch.textAlign === "left" ? undefined : true;
    }
    if (patch.fontFamily !== undefined && el instanceof Text) {
      el.fontFamily = patch.fontFamily;
    }
    if (patch.fontWeight !== undefined && el instanceof Text) {
      el.fontWeight = patch.fontWeight;
    }
    if (patch.startArrow !== undefined && el instanceof Line) {
      el.startArrow = toLeaferArrow(patch.startArrow);
    }
    if (patch.endArrow !== undefined && el instanceof Line) {
      el.endArrow = toLeaferArrow(patch.endArrow);
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
    if ("strokeDash" in patch) {
      (el as unknown as { dashPattern?: number[] }).dashPattern =
        patch.strokeDash;
    }
    if (patch.opacity !== undefined) {
      el.opacity = patch.opacity;
    }
    if (patch.cornerRadius !== undefined) {
      el.cornerRadius = patch.cornerRadius;
    }
    this.opts.onMutated();
    return true;
  }

  clearAll() {
    this.exitPointEdit();
    this.cancelCrop();
    const els = (this.app.tree.children as UI[]).filter(
      (el) => !this.isEditorInternal(el),
    );
    if (els.length) {
      this.app.tree.clear();
    }
    this.editor.cancel();
    this.commitHistory();
  }

  get elementCount() {
    // 排除 editor 内部元素（多选模拟层），避免计数虚增
    return (this.app.tree.children as UI[]).filter(
      (el) => !this.isEditorInternal(el),
    ).length;
  }

  // ================= 图片裁剪（委托 CropController） =================

  /**
   * 进入图片裁剪：选中单张未旋转图片时显示 sky 层裁剪框与 8 手柄，
   * 拖动手柄调整裁剪区域，松手即应用（canvas 2D 裁出新图替换 url）。
   */
  startCrop(): boolean {
    return this.cropCtrl.start();
  }

  /** 取消裁剪：清除裁剪 UI，不应用修改 */
  cancelCrop() {
    this.cropCtrl.cancel();
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
    this.addToTree(img);
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
    // 内容归属元素：世界坐标 → 相对框架原点的坐标（框架 id + 相对位置）
    return contractFrameContents(result);
  }

  /**
   * 世界坐标序列化（AI 画布感知/整理共用）：frame 内容展开为画布绝对坐标（清 frameId）。
   * 文件数据契约中 frame 内元素存相对坐标，AI 感知与写回均以世界坐标为准。
   */
  serializeWorld(): ElementData[] {
    return expandFrameContents(this.serialize());
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
      // 内容归属框架 id（序列化时由 contractFrameContents 统一把坐标转相对）
      frameId: this.frameIdOf(el),
      stroke: colorOf(el.stroke),
      strokeWidth: numOf(el.strokeWidth),
      locked: el.locked || undefined,
      groupId: (el as unknown as { __groupId?: string }).__groupId,
      strokeDash: (el as unknown as { dashPattern?: number[] }).dashPattern,
      opacity: numOf(el.opacity) || undefined,
      intent: (el as unknown as { __intent?: string }).__intent,
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
    if (isFrameEl(el)) {
      const meta = el as unknown as Record<string, unknown>;
      return {
        ...base,
        type: "frame",
        width: el.width ?? 0,
        height: el.height ?? 0,
        fill: colorOf(el.fill),
        // 虚线为 frame 固定风格，不序列化（恢复时兑底）
        strokeDash: undefined,
        // 内容容器元数据：运行时挂实例，序列化/恢复对称
        name: typeof meta.__frameName === "string" ? meta.__frameName : undefined,
        contentType:
          meta.__frameContentType === "markdown" ||
          meta.__frameContentType === "code" ||
          meta.__frameContentType === "text"
            ? meta.__frameContentType
            : undefined,
        content:
          typeof meta.__frameContent === "string" ? meta.__frameContent : undefined,
        autoSize:
          typeof meta.__frameAutoSize === "boolean" ? meta.__frameAutoSize : undefined,
        constrain:
          typeof meta.__frameConstrain === "boolean" ? meta.__frameConstrain : undefined,
        collapsed:
          typeof meta.__frameCollapsed === "boolean" ? meta.__frameCollapsed : undefined,
        // 滚动偏移读运行时 scrollY（滚动交互直接改装饰属性，meta 不随动）
        scrollY: numOf(el.scrollY),
      };
    }
    if (el instanceof Rect) {
      return {
        ...base,
        type: "rect",
        width: el.width ?? 0,
        height: el.height ?? 0,
        fill: colorOf(el.fill),
        cornerRadius: numOf(el.cornerRadius) || undefined,
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
        // leafer 2.x 的 endArrow 默认值是字符串 "none"（truthy），需排除；
        // 两端都无端点时按 line 序列化，任一端有端点则为 arrow
        type: (hasArrowHead(el) ? "arrow" : "line") as "arrow" | "line",
        width: el.width ?? 0,
        height: el.height ?? 0,
        points: el.points as { x: number; y: number }[] | undefined,
        bindStart: t.__bindStart,
        bindEnd: t.__bindEnd,
        startArrow: arrowHeadOf(el.startArrow),
        endArrow: arrowHeadOf(el.endArrow),
      };
    }
    if (el instanceof Path) {
      const t = el as unknown as {
        __freehandPoints?: number[][];
        __penSize?: number;
        __rough?: {
          seed: number;
          original?: string;
          roughness?: number;
          originalPath?: string;
        };
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
        // 文本排版扩展：对齐/字重/字体随文件保存（autoSizeAlign 按对齐自动推导，不单独存）
        textAlign: el.textAlign === "center" || el.textAlign === "right" ? el.textAlign : undefined,
        fontFamily:
          typeof el.fontFamily === "string" ? el.fontFamily : undefined,
        fontWeight:
          typeof el.fontWeight === "number"
            ? (el.fontWeight as FontWeight)
            : el.fontWeight === "bold"
              ? 700
              : undefined,
      };
    }
    return null;
  }

  loadElements(data: ElementData[], opts?: { worldCoords?: boolean }) {
    // 重建场景：退出点编辑/图片裁剪（sky 层手柄不随 tree.clear 清除）
    this.exitPointEdit();
    this.cancelCrop();
    // 先取消编辑器选择（多选模拟层 simulateTarget 挂在 tree.zoomLayer 下）：
    // 若不清除直接 tree.clear()，模拟层会被销毁，此后一切多选（框选/套索/editor.target=数组）
    // 都会尝试挂载已销毁的 simulateTarget 而立即被编辑器 cancel 清空（整理/撤销/重载后框选失效）
    this.editor.cancel();
    // 重建场景时旧元素全部销毁，框架缩放快照引用随之失效，必须清空
    this.frameScaleSnap = null;
    this.app.tree.clear();
    for (const d of data) {
      const el = this.dataToElement(d);
      if (el) {
        this.addToTree(el);
      }
    }
    // 归属解析：带 frameId 的内容元素把相对坐标换算为世界坐标（框架可能排在
    // 内容之后，必须两遍重建）；worldCoords 模式跳过换算（数据已是世界坐标，
    // 如整理/AI 重建）；无 frameId 的旧数据按 bbox 包含自动补挂归属
    this.resolveFrameContents(opts?.worldCoords);
    this.editor.cancel();
    this.updateGrid();
  }

  private dataToElement(d: ElementData): UI | null {
    const el = this.dataToElementInner(d);
    if (el && d.id) {
      // 恢复/导入时把文件里的 id 写回实例缓存，保证 id 稳定
      (el as unknown as { __aiId?: string }).__aiId = d.id;
    }
    if (el && d.groupId) {
      // 分组关系透传到实例（对齐/分布/层序/删除的组感知依赖实例缓存）
      (el as unknown as { __groupId?: string }).__groupId = d.groupId;
    }
    if (el && d.frameId) {
      // 内容归属透传到实例（坐标换算在 loadElements/paste 的归属解析阶段，
      // 因为框架可能在数据末尾，须等全部入树后再换算）
      (el as unknown as { __frameId?: string }).__frameId = d.frameId;
    }
    if (el && d.intent) {
      // AI 创建时自报的创建意图：透传到实例，序列化/恢复后不丢
      (el as unknown as { __intent?: string }).__intent = d.intent;
    }
    return el;
  }

  /** 元素入树（与原有 add 行为一致；内容子级随 Box 容器自动入树） */
  private addToTree(el: UI) {
    this.app.tree.add(el);
  }

  private dataToElementInner(d: ElementData): UI | null {
    const common = {
      x: d.x,
      y: d.y,
      rotation: d.rotation,
      stroke: d.stroke,
      strokeWidth: d.strokeWidth,
      locked: d.locked || undefined,
      dashPattern: d.strokeDash,
      opacity: d.opacity,
      cornerRadius: d.cornerRadius,
    };
    const fill = d.fill === "none" ? undefined : d.fill;
    switch (d.type) {
      case "rect": {
        return new Rect({
          ...common,
          width: d.width,
          height: d.height,
          fill,
        });
      }
      case "frame": {
        // 框架容器：内容型用 Box（Rect 的自身渲染 + Group 的子级渲染，是 leafer 2.x
        // 中唯一兼具“绘制矩形”与“容纳子级”的容器；Rect 不支持子级）。内容文本作为
        // 真子级挂载：随框架移动/缩放/旋转/删除自动跟随，序列化只读框架数据不读子级。
        // 普通型（无内容）保持 Rect。autoSize（默认开启）按内容撑尺寸。
        let boxW = d.width ?? 0;
        let boxH = d.height ?? 0;
        const text = normalizeContent(d.content ?? "");
        if (d.content && d.autoSize !== false) {
          const size = frameContentSize(d.content, d.contentType);
          boxW = size.width;
          boxH = size.height;
          // 折叠：内容超高时框架高度压到折叠上限，超出部分裁剪 + 滚轮滚动查看
          if (d.collapsed) {
            boxH = Math.min(boxH, FRAME_COLLAPSED_HEIGHT);
          }
        }
        let contentText: Text | null = null;
        if (text) {
          contentText = new Text({
            x: FRAME_PADDING,
            y: FRAME_PADDING,
            // 定宽 + 按宽度折行：长行在框内换行，配合 autoSize 折行高度不溢出
            width: Math.max(1, boxW - FRAME_PADDING * 2),
            textWrap: "break",
            text,
            fontSize: FRAME_CONTENT_SIZE,
            // leafer 的 lineHeight 数值为像素值（非倍数），倍数须用 percent 单位：
            // 直接传 1.6 会渲染为 1.6px 行高导致多行文字重叠
            lineHeight: { type: "percent", value: FRAME_LINE_HEIGHT },
            fontFamily: d.contentType === "code" ? FRAME_CODE_FONT : undefined,
            fill: d.stroke ?? FRAME_CONTENT_COLOR,
            // 内容文本不参与命中/编辑：点击穿透到框架本体，编辑器不可操作
            hit: false,
            locked: true,
          });
        }
        const el = new Box({
          ...common,
          width: boxW,
          height: boxH,
          fill,
          dashPattern: d.constrain ? undefined : d.strokeDash ?? [8, 5],
          // 折叠状态：裁剪超出内容，scrollY 偏移子级渲染。overflow 必须含
          // "scroll"（leafer Box 只在 overflow 含 scroll 时应用 scrollX/scrollY
          // 平移子级 bounds，hide 仅裁剪不滚动；无 scroller 插件不显示滚动条），
          // scrollY 负值内容上移（0 = 顶部，-max = 底部），无需手动遮罩
          overflow: d.collapsed ? "scroll" : undefined,
          scrollY: d.collapsed ? (d.scrollY ?? 0) : undefined,
          // 注意：children 显式传 undefined 会让 leafer 2.2.9 的 Group/Branch
          // children 保持 undefined，入树时 __bindLeafer 遍历其 length 崩溃并
          // 卡死布局管线（画布永不渲染），必须用空数组
          children: contentText ? [contentText] : [],
        });
        const meta = el as unknown as Record<string, unknown>;
        meta[FRAME_FLAG] = true;
        meta.__frameName = d.name;
        meta.__frameContentType = d.contentType;
        meta.__frameContent = d.content;
        meta.__frameAutoSize = d.autoSize;
        meta.__frameConstrain = d.constrain;
        meta.__frameCollapsed = d.collapsed;
        return el;
      }
      case "ellipse": {
        return new Ellipse({
          ...common,
          width: d.width,
          height: d.height,
          fill,
        });
      }
      case "line": {
        const el = new Line({
          ...common,
          points: d.points,
          startArrow: toLeaferArrow(d.startArrow),
          endArrow: toLeaferArrow(d.endArrow),
        });
        bindingsToEl(el, d);
        return el;
      }
      case "arrow": {
        const el = new Line({
          ...common,
          points: d.points,
          // 终点默认三角箭头（兼容旧文件）；显式 "none" 时保持无端点
          startArrow: toLeaferArrow(d.startArrow),
          endArrow:
            d.endArrow !== undefined
              ? toLeaferArrow(d.endArrow)
              : "triangle",
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
          // 文本排版扩展：对齐/字重/字体恢复；自动宽度下居中/右对齐需 autoSizeAlign
          textAlign: d.textAlign,
          fontFamily: d.fontFamily,
          fontWeight: d.fontWeight,
          autoSizeAlign:
            d.textAlign && d.textAlign !== "left" && !d.width
              ? true
              : undefined,
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
    // 内容归属元素先展开为世界坐标（文件里存的是相对坐标，直接导出会错位）
    return elementsToSVG(
      expandFrameContents(this.serialize()),
      this.background,
    );
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
   * 默认按内容包围盒导出（避免大片空白）；region 传入时按指定区域截图（app 局部坐标基准，
   * 如视口 {x:0,y:0,width,height}），失败时降级为整页导出。
   */
  async exportImage(
    size = 1280,
    region?: { x: number; y: number; width: number; height: number },
  ): Promise<string | null> {
    if (this.elementCount === 0) {
      return null;
    }
    try {
      const out = await this.app.export("jpg", {
        size,
        screenshot: region ?? this.contentWorldBounds(12),
        fill: this.background,
        quality: 0.85,
      });
      const url = await this.toDataUrl(out);
      return url ?? this.exportImageFull(size);
    } catch {
      return this.exportImageFull(size);
    }
  }

  /**
   * 导出当前视口所见区域的渲染截图（JPEG dataURL）：供 AI 多模态感知"使用者当前看到的画面"。
   * screenshot 区域为 app 局部坐标——视口原点即 (0,0)、尺寸即画布像素尺寸（与 contentWorldBounds
   * 输出同基准）；返回视口世界范围供文本标注，让模型把截图与 get_canvas 数据对齐。
   */
  async exportViewportImage(
    size = 1024,
  ): Promise<{ url: string; viewport: ViewportInfo } | null> {
    if (this.elementCount === 0) {
      return null;
    }
    const vp = this.viewport;
    try {
      const out = await this.app.export("jpg", {
        size,
        screenshot: { x: 0, y: 0, width: vp.view.width, height: vp.view.height },
        fill: this.background,
        quality: 0.85,
      });
      const url = await this.toDataUrl(out);
      if (!url) {
        return null;
      }
      return { url, viewport: vp };
    } catch {
      return null;
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
