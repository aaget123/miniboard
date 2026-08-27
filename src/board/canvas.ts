import { App, DragEvent, Image, Line, Path, PointerEvent, Rect, Text, ZoomEvent } from "leafer-ui";
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
import type { ArrowHead, BoardStyle, ElementData, FontWeight } from "../types";
import type { CoordBox } from "./coords";
import { beautifyScene } from "./beautify";
import type { BeautifyStats } from "./beautify";
import { transformPath, translatePath } from "./path";
import { offsetElementData } from "./offset";
import { clampShift, contractFrameContents, expandFrameContents } from "./frame";
import {
  alignElements,
  distributeElements,
  expandGroupMembers,
  flipElements,
  reorderElements,
} from "./arrange";
import type { ArrangeAction, ReorderMode } from "./arrange";
import { unionBounds } from "./bounds";
import { CropController } from "./crop-controller";
import { PointEditController } from "./point-edit-controller";
import { eraserCursorURL, EraserController } from "./eraser-controller";
import { FrameController } from "./frame-controller";
import { ConnectorController, type Side } from "./connector-controller";
import {
  applyDataToDraft as sceneApplyDataToDraft,
  dataToElement as sceneDataToElement,
  elementToData as sceneElementToData,
} from "./scene-format";
import { History } from "./history";
import type { ToolRegistry } from "./registry";
import {
  arrowHeadOf,
  hexToRgba,
  isFrameEl,
  isFreehandEl,
  isSketchableEl,
  numOf,
  parseHexColor,
  pointsOf,
  toLeaferArrow,
  typeOf,
} from "./element-utils";
import {
  buildOrthoWaypoints,
  distToSegment,
  nearestBorderPoint,
  polygonHitsBox,
  rectsIntersect,
} from "./geometry";
import { SpatialGrid, type SpatialItem } from "./spatial-grid";

/** 空间索引 z 序表缺失时的兜底：线性回查元素在 tree 子序中的位置 */
function kidsIndexOf(tree: unknown, el: UI): number {
  const kids = (tree as { children?: UI[] }).children ?? [];
  return kids.indexOf(el);
}
import { isSketchable, redrawRough, sketchifyData } from "./rough";
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

// 智能对齐吸附的屏幕距离阈值（px）；已锁定吸附线的迟滞退出阈值（> 进入阈值）
const ALIGN_SNAP_PX = 6;
const ALIGN_HYST_PX = 18;
// 落框高亮覆盖框的颜色（sky 层）
const DROP_HIGHLIGHT_STROKE = "#f24aa0";

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
  // 橡皮擦：独立交互控制器（分段擦除/待删预览/半径与光标）
  private eraser!: EraserController;
  // 缩放/旋转手势中标记：手势结束（DragEvent.END）时对受约束成员做收尾夹紧
  private frameClampDirty = false;
  // 约束夹紧首次触发提示（Alt 豁免）只报一次
  private constraintHintShown = false;
  // 已报过运行时错误的自定义工具（每工具每次会话一次）
  private toolRuntimeErrShown = new Set<string>();
  /** Alt+拖拽复制（落点克隆）：手势内按住 Alt 拖动元素时快照，松手后在拖动前
   * 原位重建快照元素——移动中的元素即副本。约束开启的框架内禁用（Alt 在那里
   * 保留「出框豁免」语义，BACKLOG P0 决策）。 */
  private altCopySnap: { data: ElementData; z: number }[] | null = null;
  /** 本手势已判定为不可复制（约束框架内等），不再逐帧重试 */
  private altCopyBlocked = false;
  /** 快照后实际发生过位移才产生副本（Alt+轻点不生成隐形重复） */
  private altCopyMoved = false;
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
  /** 指针最后 app 坐标（连接器拖出松手取落点用；onUp 不携带事件） */
  private lastAppPoint: { x: number; y: number } | null = null;
  /** 当前画布背景色（主题切换/导出共用，默认深色） */
  private background = BACKGROUND;
  // 线性元素点编辑：独立交互控制器（双击 line/arrow 进入，sky 层手柄拖点/加点）
  private pointEdit!: PointEditController;
  // 图片裁剪：独立交互控制器（sky 层裁剪框 + 8 手柄，松手即应用）
  private cropCtrl!: CropController;
  private connectorCtrl!: ConnectorController;
  // 框架域控制器：归属注册表/内容跟随/互转/折叠/聚焦/约束夹紧
  private frameCtrl!: FrameController;
  /** 文本缩放语义：横向拉伸换行、纵向/对角改字号（记录缩放前的原始状态） */
  private textScaleOrig = new Map<Text, { fontSize: number; width: number }>();
  // 网格：设置（大小/显示/吸附）与网格线层（挂在 zoomLayer 最底层，随缩放/平移重建）
  private grid: GridSettings = { size: 20, show: false, snap: false };
  private gridPath: Path | null = null;
  /** 绘制后自动切回选择工具（Excalidraw 同款默认行为；设置页可关） */
  private autoBackToSelect = true;
  /** 画布感知版本：内容变更点自增（AI 增量感知缓存命中判定用） */
  private perceptionVersionN = 0;
  // 智能对齐吸附（单选拖动）：候选边每手势收集一次；已锁定的吸附线在迟滞
  // 期内只认锁定线，防阈值边界抖动（吸附生效但不显示参考线）
  private alignCandidates: { xs: number[]; ys: number[] } | null = null;
  private alignLockX: number | null = null;
  private alignLockY: number | null = null;
  // 落框高亮：拖动中联合 bbox 完全落入某框架时，sky 层画高亮框预判归属
  // （不修改框架本体属性——拖动中的防抖历史快照不会捕获高亮态）
  private dropHighlightFrame: UI | null = null;
  private dropHighlightRect: Rect | null = null;
  /** 取色模式：下一次画布点击采样像素色（Esc/右键取消） */
  private pickState: {
    resolve: (hex: string | null) => void;
    onKey: (e: KeyboardEvent) => void;
  } | null = null;
  private pickPromise: Promise<string | null> | null = null;

  // ================= 空间索引（命中类查询加速） =================
  // 坐标基准：与既有命中语义一致——元素登记 worldBoxBounds（视口基准），
  // 查询侧传 app/世界坐标 + 半径。脏标记由 tree 层 property.change /
  // child.add / child.remove 全局冒泡兜底（自研滚轮缩放改 zoomLayer 属性
  // 同样触发），配合少量显式标记（loadElements 等批量重建）。
  /** 视口基准的元素空间索引（不含 editor 内部模拟层） */
  private sceneIndex = new SpatialGrid<UI>();
  /** 框架子集缓存（与场景索引同批重建；遍历帧相关逻辑用，避免全树扫描） */
  private frameCacheList: UI[] | null = null;
  /** z 序位置表：元素 → tree.children 下标（与索引同批重建；排序免 indexOf O(k²)） */
  private sceneZOrder = new Map<UI, number>();
  /** 索引已建过（built 后才可信任空结果） */
  private sceneIndexBuilt = false;
  /** 脏标记：true 时下一次查询前全量重建 */
  private sceneIndexDirty = true;

  /**
   * 场景变更打标：属性冒泡监听覆盖所有子孙的 x/y/scale/width/path/points/
   * text 等（含编辑器拖拽、框内内容跟随、滚轮缩放的 zoomLayer 变换）；
   * 少量批量路径（载入/撤销）显式补充调用本方法。
   */
  private markSceneSpatialDirty() {
    this.sceneIndexDirty = true;
  }

  /** 全量重建空间索引 + 框架列表 + z 序表（懒执行：仅在查询时且脏时发生） */
  private ensureSceneIndex() {
    if (this.sceneIndexBuilt && !this.sceneIndexDirty) {
      return;
    }
    const kids = this.app.tree.children as UI[];
    const items: SpatialItem<UI>[] = [];
    const frames: UI[] = [];
    this.sceneZOrder.clear();
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      this.sceneZOrder.set(el, i);
      if (this.isEditorInternal(el)) {
        continue;
      }
      if (isFrameEl(el)) {
        frames.push(el);
      }
      const b = el.worldBoxBounds;
      if (!b || !Number.isFinite(b.x)) {
        continue;
      }
      // 插入盒按描边外扩补偿（leafer boxBounds 不含居中描边外溢、
      // 箭头端点符号在端点外侧延伸约数倍描边宽）：外扩后候选集恒为
      // 精确判定的超集，最终仍由 el.hit()/几何判定收口，语义不变。
      const sw = typeof el.strokeWidth === "number" ? Math.abs(el.strokeWidth) : 0;
      const sc = Math.max(Math.abs(el.scaleX ?? 1), Math.abs(el.scaleY ?? 1), 0.01);
      const pad = sw * 3 * sc + 16;
      items.push({
        item: el,
        bounds: {
          minX: b.x - pad,
          minY: b.y - pad,
          maxX: b.x + b.width + pad,
          maxY: b.y + b.height + pad,
        },
      });
    }
    this.sceneIndex.rebuild(items);
    this.frameCacheList = frames;
    this.sceneIndexBuilt = true;
    this.sceneIndexDirty = false;
  }

  /**
   * 按 tree 子序排序（支持正序/倒排）。用重建时缓存的 z 序表，全选
   * 万级元素时也是 O(k log k)；z 序表缺失的元素回退 indexOf 兜底。
   */
  private sortByZOrder(els: UI[], ascending: boolean): UI[] {
    const z = this.sceneZOrder;
    return els.sort((a, b) => {
      const ia = z.get(a) ?? kidsIndexOf(this.app.tree, a);
      const ib = z.get(b) ?? kidsIndexOf(this.app.tree, b);
      return ascending ? ia - ib : ib - ia;
    });
  }

  /** 框架子集（ensureSceneIndex 同批刷新；全部 isFrameEl 元素） */
  private frameElements(): UI[] {
    this.ensureSceneIndex();
    return this.frameCacheList ?? [];
  }

  /**
   * 点命中候选：空间索引预筛 → 按 tree 子序倒排（自顶向下），与原
   * 「倒序全扫第一个 hit」优先级完全一致。
   */
  private hitCandidates(ax: number, ay: number, radius: number): UI[] {
    this.ensureSceneIndex();
    const cands = this.sceneIndex.queryPoint(ax, ay, radius);
    if (cands.length <= 1) {
      return cands;
    }
    return this.sortByZOrder(cands, false);
  }

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
        // 关闭等比锁定：抓边缩放时只改单轴，不会把元素等比放大到失控
        // （此前 lockRatio 开启时，用户误抓框架边线会把框架“撑爆”）
        lockRatio: false,
        // 全程关闭编辑器内置框选（boxSelect）：其结算按「命中式」进行，
        // 被顶层填充元素遮挡的元素选不中（套索/框选遮挡问题的根源）。
        // 框选/套索统一走本应用的 M/Q 工具（包围盒式、无遮挡语义）
        boxSelect: false,
        // 拖动位移修正钩子：leafer 按“拖动起点 + pointer 总位移”计算移动，
        // MOVE 事件里直接改位置会被其 totalOffset 补偿抵消（“吸不住”），
        // 必须在移动前修正增量：网格吸附 + 约束框架夹紧。x/y 为 local 增量。
        beforeMove: ({ target, x, y }) => {
          let nx = x;
          let ny = y;
          // 网格吸附：单选拖动时把期望位置对齐网格
          if (this.grid.snap && (this.editor as unknown as { list?: UI[] }).list?.length === 1) {
            const tx = (target.x ?? 0) + nx;
            const ty = (target.y ?? 0) + ny;
            nx = this.snapGrid(tx) - (target.x ?? 0);
            ny = this.snapGrid(ty) - (target.y ?? 0);
          }
          // 智能对齐吸附（单选拖动）：期望 bbox 的左/中/右、上/中/下与其它元素
          // 对应边/中心线距离 ≤ 阈值时吸附并画 sky 层参考线；对齐命中覆盖网格
          // 吸附（同轴）。候选边在手势首次进入前收集一次（O(n)，拖动高频调用零开销）
          const singleTarget =
            target && (this.editor as unknown as { list?: UI[] }).list?.length === 1;
          if (singleTarget) {
            const t = target as UI;
            if (!this.alignCandidates) {
              this.alignCandidates = this.collectAlignCandidates(t);
            }
            // nx/ny 为 local 增量：转世界增量后在世界基准上比对
            // （worldBoxBounds 含缩放，阈值即屏幕恒定手感）
            const wd0 = t.getWorldPointByLocal({ x: nx, y: ny }, undefined, true);
            const b = t.worldBoxBounds;
            if (b && this.alignCandidates) {
              const hitX = this.snapAxisLocked(
                [b.x + wd0.x, b.x + b.width / 2 + wd0.x, b.x + b.width + wd0.x],
                this.alignCandidates.xs,
                "x",
              );
              const hitY = this.snapAxisLocked(
                [b.y + wd0.y, b.y + b.height / 2 + wd0.y, b.y + b.height + wd0.y],
                this.alignCandidates.ys,
                "y",
              );
              if (hitX || hitY) {
                const wd = {
                  x: wd0.x + (hitX?.offset ?? 0),
                  y: wd0.y + (hitY?.offset ?? 0),
                };
                const aw = t.getWorldPoint({ x: 0, y: 0 });
                const lp = t.getLocalPoint({ x: aw.x + wd.x, y: aw.y + wd.y });
                nx = lp.x - (t.x ?? 0);
                ny = lp.y - (t.y ?? 0);
              }
            }
          }
          // 约束框架夹紧：非框架元素与 constrain 框架重叠率达标时，期望位置整体
          // 夹回框架（Alt 按住豁免拖出；修正发生在移动前，编辑器按修正值
          // 移动，夹紧稳定生效不会“移动一点就掉出去”）
          // 多选整体夹紧：以选区联合 bbox 求一次修正量应用到每个成员，
          // 避免逐元素独立夹紧把框内的相对布局拉歪
          if (target && !isFrameEl(target) && !this.modKeys.alt) {
            const fb = this.frameCtrl.constrainOf(target);
            if (fb) {
              const t = target as UI;
              // nx/ny 为 local 增量、bbox 为世界基准：画布缩放/平移后
              // local≠world，先转世界增量再夹紧，修正量再转回父级局部
              const wd = t.getWorldPointByLocal({ x: nx, y: ny }, undefined, true);
              const moverList = ((this.editor as unknown as { list?: UI[] }).list ?? []).filter(
                (m) => m && !m.locked && !isFrameEl(m),
              );
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
    // 线性元素点编辑控制器（依赖经注入，Board 门面保留原公开方法名）
    this.pointEdit = new PointEditController({
      app: this.app,
      editorCancel: () => this.editor.cancel(),
      cancelCrop: () => this.cancelCrop(),
      aiIdOf: (el) => this.aiIdOf(el),
      clampConstrained: (el) => this.frameCtrl.clampMembers([el]),
      rebuildRoute: (el) => this.rebuildRoutePoints(el),
      scheduleHistory: () => this.scheduleHistory(),
    });
    // 框架域控制器（依赖经注入：空间索引的框架子集、编辑器选中集、契约归一化等）
    this.frameCtrl = new FrameController({
      app: this.app,
      frameList: () => this.frameElements(),
      treeChildren: () => this.app.tree.children as UI[],
      selectedList: () => this.selectedList,
      aiIdOf: (el) => this.aiIdOf(el),
      normalizeContract: (el) => this.normalizeContractEl(el),
      defaultFontSize: () => TEXT_FONT_SIZE,
      zoomRange: { min: MIN_SCALE, max: MAX_SCALE },
      updateGrid: () => this.updateGrid(),
      commitHistory: () => this.commitHistory(),
      onMutated: () => this.opts.onMutated(),
      editorTarget: (el) => {
        this.editor.target = el;
      },
      editorList: () => (this.editor as unknown as { list?: UI[] }).list ?? [],
      getStyle: () => this.opts.getStyle(),
      addToTree: (el) => this.addToTree(el),
      dataToElement: (d) => this.dataToElement(d),
      drawingFrame: () => this.drawingFrame,
    });
    // 橡皮擦控制器（分段擦除/待删预览；命中经 Board 的空间索引 hitTest）
    this.eraser = new EraserController({
      app: this.app,
      treeChildren: () => this.app.tree.children as UI[],
      addToTree: (el) => this.addToTree(el),
      editorCancel: () => this.editor.cancel(),
      hitTest: (world, radius, exclude) => this.hitTest(world, radius, exclude),
      zoomScale: () => this.zoomScale(),
      isEditorInternal: (el) => this.isEditorInternal(el),
      inheritOwnership: (part, root) => this.frameCtrl.setId(part, this.frameCtrl.idOf(root)),
      isToolEraser: () => this.tool === "eraser",
    });
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
    this.connectorCtrl = new ConnectorController({
      app: this.app,
      allowed: () =>
        this.tool === "select" &&
        !this.editor.innerEditor &&
        !this.cropCtrl.active &&
        !this.pointEdit.editing,
      selectedList: () => this.selectedList,
      isConnectable: (el) => {
        const t = typeOf(el);
        return t === "rect" || t === "ellipse" || t === "text" || t === "frame" || t === "image";
      },
      findTargetAt: (ax, ay, exclude) => this.hitTest({ x: ax, y: ay }, 5, exclude),
      aiIdOf: (el) => this.aiIdOf(el),
      onAnchorDown: () => {
        // 锚点按下阻断传播后执行：先取消编辑器选择与点编辑（拖出期间
        // 选择保持为空，避免编辑框遮住落点判定）
        this.editor.cancel();
        this.exitPointEdit();
      },
      createArrow: (sourceId, targetId, endWorld, prefer) =>
        this.createBoundArrow(sourceId, targetId, endWorld, prefer),
    });
    this.bindEvents();
    // 空间索引脏标记：tree 层全局冒泡监听——任何子孙属性变更（含编辑器
    // 拖拽位移、框内内容跟随、自研滚轮缩放的 zoomLayer 变换）与增删都置脏，
    // 下一次命中查询前懒重建。运行时已验证 leafer 的这三类事件可从 tree 收到。
    const sceneTree = this.app.tree as unknown as {
      on_: (type: string, fn: () => void, ctx?: unknown) => void;
    };
    sceneTree.on_("property.change", () => this.markSceneSpatialDirty());
    sceneTree.on_("child.add", () => this.markSceneSpatialDirty());
    sceneTree.on_("child.remove", () => this.markSceneSpatialDirty());
    // 自研滚轮缩放：以鼠标位置为不动点
    (this.app.canvas.view as HTMLElement).addEventListener("wheel", this.onWheel, {
      passive: false,
    });
    // 右键菜单：原生 contextmenu 事件（leafer 事件系统不覆盖 DOM 右键）
    (this.app.canvas.view as HTMLElement).addEventListener("contextmenu", this.onContextMenu);
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
    // 抬起时按最新选中状态重建连接器锚点（点击空白取消选择等 AFTER_SELECT
    // 覆盖不到的情形）。锚点的「非锚点按下隐藏」收敛在 onDown 内完成——
    // 独立监听器无法保证与主 onDown 的触发顺序，会把刚开始的拖出清掉
    app.on(PointerEvent.UP, () => this.connectorCtrl.refresh());

    this.editor.on(EditorMoveEvent.MOVE, (e) => {
      const ev = e as EditorMoveEvent;
      // Alt+拖拽复制挂靠：按住 Alt 且尚未快照/未判禁用时，以编辑器选中集为
      // 移动单元尝试快照（支持拖动中途按下 Alt，下一帧生效）
      if (!this.altCopySnap && !this.altCopyBlocked && this.modKeys.alt) {
        const movers = ((this.editor as unknown as { list?: UI[] }).list ?? []).filter(
          (m) => m && !m.locked,
        );
        if (!movers.length || !this.tryLatchAltCopy(movers)) {
          this.altCopyBlocked = true;
        }
      }
      if (this.altCopySnap && (ev.moveX || ev.moveY)) {
        this.altCopyMoved = true;
      }
      // 被移动元素：leafer 2.2.9 的 MOVE 事件 data 为 { target, editor, moveX,
      // moveY }，不含 operateEvent（历史写法导致 moved 恒为 undefined，框内
      // 跟随/组联动/吸附/拖动夹紧全部失效）。多选拖拽时 target 是编辑器内部
      // 的 simulateTarget，归属同步/组联动/框架跟随必须作用到真实成员上
      const moved = (e as EditorMoveEvent).target as UI | undefined;
      const movedReal =
        moved && this.isEditorInternal(moved)
          ? ((this.editor as unknown as { list?: UI[] }).list ?? []).filter((m) => m && !m.locked)
          : moved
            ? [moved]
            : [];
      if (!movedReal.length) {
        return;
      }
      // 组联动：同组未选中成员跟随本次位移（选中成员已由编辑器移动；
      // moveX/moveY 为 world 增量，缩放视图下位移一致；锁定成员不跟随）
      if (ev.moveX || ev.moveY) {
        const gids = new Set<string>();
        for (const m of movedReal) {
          const g = (m as unknown as { __groupId?: string }).__groupId;
          if (g) {
            gids.add(g);
          }
        }
        if (gids.size) {
          for (const other of this.app.tree.children as UI[]) {
            if (other.locked || movedReal.includes(other)) {
              continue;
            }
            const g = (other as unknown as { __groupId?: string }).__groupId;
            if (g && gids.has(g)) {
              other.moveWorld(ev.moveX, ev.moveY);
              this.normalizeContractEl(other);
            }
          }
        }
      }
      // frame 框架移动：归属于该框架的内容元素（frameId 显式归属，不再靠
      // bbox 包含猜测）跟随位移——纯增量同步，无时序问题
      if (ev.moveX || ev.moveY) {
        for (const m of movedReal) {
          if (isFrameEl(m)) {
            this.frameCtrl.moveContents(m, ev.moveX, ev.moveY);
          }
        }
      }
      // 契约元素（line/arrow/path）拖动时 leafer 改 x/y，但拖动中立即归零会
      // 破坏 leafer 的增量计算（getValidMove 按“拖起点位置 - 当前位置”求增量，
      // 归零后增量退化为累计总位移，元素被反复叠加放大、越拖越飞），
      // 改为拖动结束时统一并入 points/path 并归零
      for (const m of movedReal) {
        this.moveNormalizeEls.add(m);
      }
      // 内容归属同步：框架内容被拖出所属框架（中心点出框）即解除归属，
      // 变回自由元素（夹紧生效时中心保持在框内，不会误触发）；
      // 未归属元素拖入某框架（完全包含）时补挂归属，此后随框架移动/缩放联动
      for (const m of movedReal) {
        this.syncMoverAdoption(m);
      }
      // 移动元素后刷新绑定箭头端点（被绑元素移动时端点跟随；
      // 多选拖拽 target 是模拟层，改为全量刷新）
      if (movedReal.length > 1) {
        this.updateBindings();
      } else {
        this.updateBindings(movedReal[0]);
      }
      // 落框预判高亮（移动集合的联合 bbox 完全落入某框架时）
      this.updateDropHighlight(movedReal);
      this.scheduleHistory();
    });
    // 框架旋转：归属于该框架的内容元素绕旋转中心同步旋转（内容跟随框架，
    // 不会被“甩出来”；多选旋转时 leafer 对选中列表整体变换、内容已随动，
    // 仅单选时补偿，避免双重变换）
    this.editor.on(EditorRotateEvent.ROTATE, (e) => {
      const ev = e as EditorRotateEvent;
      this.frameClampDirty = true;
      const target = ev.target as UI | undefined;
      if (target && isFrameEl(target) && ev.rotation && this.selectedList.length === 1) {
        this.frameCtrl.rotateContents(target, ev.worldOrigin ?? { x: 0, y: 0 }, ev.rotation);
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
      if (target && isFrameEl(target) && this.selectedList.length === 1 && (sx !== 1 || sy !== 1)) {
        this.frameCtrl.scaleContents(target, ev.worldOrigin ?? { x: 0, y: 0 }, sx, sy);
      }
      this.scheduleHistory();
    });
    // 选中变化（选中/多选/取消）：左侧浮动工具栏显隐依赖此事件
    this.editor.on(EditorEvent.AFTER_SELECT, () => this.emitSelectionInfo());
    // 选择被清空（editor.cancel / target=undefined）后，编辑框矩形仍是可命中的
    // （leafer unload 不重置 hittable）——下一手势的拖拽检测落在其上会让
    // EditBox.onTransformStart 读空列表的 editor.element（undefined）抛
    // TypeError，交互管线随之冻结（“画板无法操作”根因）。统一在此收口：
    // 列表为空即禁命中，下次 load() 会自动恢复
    this.editor.on(EditorEvent.SELECT, () => {
      if (!this.editor.list.length) {
        const rect = this.editor.editBox?.rect as unknown as { hittable?: boolean } | undefined;
        if (rect) {
          rect.hittable = false;
        }
      }
    });
    // 文本内联编辑关闭：空文本即删；内容变化才入历史（对齐 fabric object:modified 时机）
    this.editor.on(InnerEditorEvent.CLOSE, (e) => this.onInnerEditorClose(e));
    // 框架缩放手势结束：清空内容快照（拖拽/触摸捻合两种手势的结束事件；
    // 快照残留会导致下次缩放复用旧元素引用，必须及时清理）
    this.app.on(DragEvent.END, () => {
      this.frameCtrl.resetScaleSnap();
      // 缩放/旋转手势收尾：把受约束成员拉回所属框架（松手后校正，
      // 不与编辑器的增量计算打架；Alt 豁免拖出时跳过）
      if (this.frameClampDirty) {
        this.frameClampDirty = false;
        if (!this.modKeys.alt) {
          this.frameCtrl.clampMembers();
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
      // 内容归属兜底：拖动结束 bounds 已定型，补挂/解除归属
      // （编辑器多选模拟层平移期间的世界包围盒可能滞后导致判定失败）
      this.syncMoversAdoption((this.editor as unknown as { list?: UI[] }).list ?? []);
      // Alt+拖拽复制收尾（落点克隆）：拖动结束统一在此还原快照
      this.commitAltCopy();
      // 落框高亮手势收尾清空；对齐吸附候选缓存与迟滞锁一并失效
      this.clearDropHighlight();
      this.alignCandidates = null;
      this.alignLockX = null;
      this.alignLockY = null;
    });
    this.app.on(ZoomEvent.END, () => {
      this.frameCtrl.resetScaleSnap();
      // 视口变化后重建 sky 层连接器锚点（与点编辑手柄同策略）
      this.connectorCtrl.refresh();
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
      texts.length === 1 && list.length === 1 ? (texts[0].fontSize ?? TEXT_FONT_SIZE) : undefined;
    // 文本排版信息：仅单选未锁定文字时给出（供对齐/字重/字体控件跟随）
    const textAlign =
      texts.length === 1 && list.length === 1
        ? ((texts[0].textAlign as "left" | "center" | "right" | undefined) ?? undefined)
        : undefined;
    const fontFamily =
      texts.length === 1 && list.length === 1
        ? typeof texts[0].fontFamily === "string"
          ? texts[0].fontFamily
          : undefined
        : undefined;
    // 字重数值化：leafer 支持 100-900 数字（旧数据/旧代码可能存 "normal"/"bold" 字符串）
    const fontWeight =
      texts.length === 1 && list.length === 1
        ? typeof texts[0].fontWeight === "number"
          ? (texts[0].fontWeight as FontWeight)
          : texts[0].fontWeight === "bold"
            ? 700
            : undefined
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
      const meta = (single as unknown as { __rough?: { roughness?: number } }).__rough;
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
    // 连接器锚点跟随选中状态（单选可连接节点时显示）
    this.connectorCtrl.refresh();
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
    // 连接器锚点仅在 select 工具显示（allowed 判定在 refresh 内）
    this.connectorCtrl.refresh();
    // 切换工具时终止未完成的拖拽/框选/擦除，并同步光标
    this.panning = false;
    this.eraser.deactivate();
    if (this.selecting) {
      this.selecting = false;
      this.draft?.remove();
      this.draft = null;
    }
    const view = this.app.canvas.view as HTMLElement;
    view.classList.toggle("hand-tool", tool === "hand");
    view.classList.toggle("eraser-tool", tool === "eraser");
    // 橡皮圆圈光标：按当前半径渲染，所见即所擦（其他工具恢复默认）
    view.style.cursor = tool === "eraser" ? eraserCursorURL(this.eraser.radiusPx) : "";
    // 切离橡皮时清除待删预览（deactivate 已复位手势态，这里兜底清残留框）
    if (tool !== "eraser") {
      this.eraser.clearPreview();
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
   * 将视口中心平移到指定画布坐标（page 基准，保持当前缩放不变）。
   * 小地图点击导航用；仅调整 zoomLayer 平移。
   */
  centerViewAt(cx: number, cy: number) {
    const layer = this.app.tree.zoomLayer;
    if (!layer) {
      return;
    }
    const view = this.app.canvas.view as HTMLElement;
    const w = this.app.width ?? view.clientWidth;
    const h = this.app.height ?? view.clientHeight;
    const s = layer.scaleX ?? 1;
    layer.x = w / 2 - cx * s;
    layer.y = h / 2 - cy * s;
    this.updateGrid();
  }

  /**
   * 概览浮层数据：全部元素的包围盒（page 基准，与 viewport 同基准可直接映射；
   * 单个元素 bounds 异常时跳过）。供 Ctrl 小地图渲染简化矩形。
   */
  overviewItems(): { x: number; y: number; w: number; h: number }[] {
    const items: { x: number; y: number; w: number; h: number }[] = [];
    for (const el of this.app.tree.children as UI[]) {
      try {
        const b = el.getBounds("box", "page");
        if (!b || b.width <= 0 || b.height <= 0 || !Number.isFinite(b.x)) {
          continue;
        }
        items.push({ x: b.x, y: b.y, w: b.width, h: b.height });
      } catch {
        // 个别元素 bounds 计算异常不影响整体概览
      }
    }
    return items;
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
    const scrollEl = this.frameCtrl.scrollableAt(world);
    if (scrollEl) {
      this.frameCtrl.scrollContent(scrollEl, e.deltaY);
      return;
    }
    // 向上滚放大、向下滚缩小
    const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
    this.zoomTo(this.scale * factor, local.x, local.y);
    // 缩放后重建 sky 层手柄（点编辑/裁剪框跟随世界坐标）
    if (this.pointEdit.editing) {
      this.pointEdit.buildHandles();
    }
    if (this.cropCtrl.active) {
      this.cropCtrl.rebuild();
    }
    // 自研滚轮缩放不走 leafer 缩放管线（无 ZoomEvent），连接器锚点在此跟随
    this.connectorCtrl.refresh();
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
    // 修饰键以指针事件为准同步（同 onMove：浏览器可能吞掉 Alt 的 keydown）
    this.modKeys.alt = !!e.altKey;
    this.modKeys.shift = !!e.shiftKey;
    // 新手势：清空 Alt+拖拽复制的挂靠状态（快照 / 禁用判定 / 位移标记）
    this.altCopySnap = null;
    this.altCopyBlocked = false;
    this.altCopyMoved = false;
    // 新手势：对齐候选重新收集、迟滞锁重置；落框高亮清空
    this.alignCandidates = null;
    this.alignLockX = null;
    this.alignLockY = null;
    this.clearDropHighlight();
    // 取色模式下右键 = 取消
    if (e.right && this.pickState) {
      this.finishPick(null);
      return;
    }
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
    // 取色模式：本次点击即采样（不进入绘制/选择管线）
    if (this.pickState) {
      this.finishPick(this.samplePixelAt(e.x ?? 0, e.y ?? 0));
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
      this.eraser.beginStroke(e.x ?? 0, e.y ?? 0);
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
      // 连接器锚点拖出（选中节点四边中点圆点）：短路后续选择/拖动流程
      const side: Side | null = this.connectorCtrl.hitAnchor(e.x ?? 0, e.y ?? 0);
      if (side) {
        this.editor.cancel();
        this.exitPointEdit();
        if (this.connectorCtrl.beginDrag(side)) {
          return;
        }
      }
      // 非锚点按下（或锚点拖出未建立）：隐藏连接器锚点。
      // 收敛在 onDown 内而不依赖监听器顺序，避免竞态把拖出清掉
      if (!this.connectorCtrl.dragging) {
        this.connectorCtrl.cancel();
      }
      // 点编辑中：命中手柄开始拖点；点击空白退出；点击其他元素切换编辑目标
      if (this.pointEdit.editing) {
        const idx = this.pointEdit.hitHandle(e.x ?? 0, e.y ?? 0);
        if (idx >= 0) {
          // 拖动原本绑定的端点：松手后解除该端绑定（控制器内记录，拖走即解绑）
          this.pointEdit.beginDrag(idx);
          return;
        }
        const hit = this.hitTest({ x: e.x ?? 0, y: e.y ?? 0 });
        if (!hit) {
          // 点击空白：退出点编辑，继续走下方正常 select 流程（取消选择）
          this.exitPointEdit();
        } else if (hit !== this.pointEdit.activeEl) {
          if (hit instanceof Line) {
            this.pointEdit.enter(hit);
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
        // 命中已选中的元素：保持当前选择不变（不塌缩为单选）。
        // 此前无条件 editor.target = hit 会把多选（套索/框选出的组）塌缩成
        // 被按住的单个元素——顶层填充矩形遮挡下层元素时，拖拽就只剩下大矩形。
        // 多选拖动由编辑框矩形（move 点）承接，按下已选成员应整体移动全组
        if (this.editor.hasItem(hit)) {
          return;
        }
        this.editor.target = hit ?? undefined;
        return;
      }
      // 未命中元素本体：点击点落在编辑框控制点/边框上时交给 editor 缩放/旋转
      if (this.hitEditBox(e.x ?? 0, e.y ?? 0)) {
        return;
      }
      // 未命中元素本体：点击点落在选中元素包围盒内时，视为选区内的按下——
      // 一律短路，不取消选择（多选空隙被清空会让编辑器 simulateTarget
      // 拖拽读到空列表而崩溃、冻结画布）。拖动本身交给编辑器：单选由编辑框
      // 矩形（move 点）承接，多选由 simulateTarget 承接，此处不再手动处理
      if (this.pointInSelection(e.x ?? 0, e.y ?? 0)) {
        // 修饰键点击包围盒内空白：保持选择不变（连续选取中误点空白不丢失已选内容）
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
          return;
        }
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
      this.frameCtrl.adopt(el);
      this.openTextEdit(el);
      return;
    }
    const kind = this.opts.registry.getKind(this.tool);
    // 画笔：压力敏感笔迹（perfect-freehand 轮廓，填充渲染）
    if (kind === "freehand") {
      this.drawing = true;
      this.penPoints = [[px, py]];
      // 约束框架判定：起点落在 constrain 框架内时，笔迹采样点逐点钳制在框内
      this.drawingFrame = this.frameCtrl.constrainAt(px, py);
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
        const f = this.frameCtrl.constrainAt(sx, sy);
        if (f) {
          list = this.frameCtrl.clampListToFrame(list, f);
        }
        for (const d of list) {
          const el = this.dataToElement(d);
          if (el) {
            this.addToTree(el);
            // 框架内容归属：点击生成的元素完全落在框架 bbox 内 → 归属该框架
            this.frameCtrl.adopt(el);
          }
        }
        this.commitHistory();
        // 使用统计：实际生成成功才计数（自定义工具用，内置忽略）
        this.opts.registry.markUsed(this.tool);
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
    this.drawingFrame = this.frameCtrl.constrainAt(this.startX, this.startY);
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
  private runGenerator(x0: number, y0: number, x1: number, y1: number): ElementData[] | null {
    const gen = this.opts.registry.getGenerator(this.tool);
    if (!gen) {
      return null;
    }
    try {
      const out = gen({
        x0,
        y0,
        x1,
        y1,
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

  /** 把生成器输出的元素数据增量应用到草稿实例（拖拽中实时刷新；实现在 scene-format） */
  private applyDataToDraft(draft: UI, d: ElementData) {
    sceneApplyDataToDraft(draft, d);
  }

  private onMove(e: IPointerEvent) {
    // 修饰键以指针事件为准实时同步：Alt 在按下前单独按住时，浏览器的菜单
    // 焦点行为可能吞掉后续 keydown（tracked 状态失真导致 Alt+拖拽复制失效）；
    // 拖动中每次 move 都用事件携带的真实修饰键校正
    this.modKeys.alt = !!e.altKey;
    this.modKeys.shift = !!e.shiftKey;
    // 记录鼠标画布坐标（粘贴跟随鼠标；状态栏坐标由 main.ts 另行监听）
    if (e.x != null && e.y != null) {
      const p = this.app.tree.getInnerPoint({ x: e.x, y: e.y });
      this.lastPointer = { x: p.x, y: p.y };
      this.lastAppPoint = { x: e.x, y: e.y };
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
    if (this.eraser.erasingNow) {
      this.eraser.moveStroke(e.x ?? 0, e.y ?? 0);
      return;
    }
    // 连接器拖出中：临时连线跟随指针
    if (this.connectorCtrl.dragging) {
      this.connectorCtrl.updateDrag(e.x ?? 0, e.y ?? 0);
      return;
    }
    // 橡皮悬停（未按下）：同样显示待删预览，给用户反悔预期
    if (this.tool === "eraser") {
      this.eraser.hover(e.x ?? 0, e.y ?? 0);
    }
    // 点编辑拖点：指针跟随（Shift 锁 45° 角；端点靠近形状时吸附绑定）
    if (this.pointEdit.draggingIndex !== null && this.pointEdit.editing) {
      this.pointEdit.moveDragging(e.x ?? 0, e.y ?? 0, e.shiftKey);
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
      const cp = this.frameCtrl.clampPoint(px, py);
      this.penPoints.push([cp.x, cp.y]);
      const path = strokeOutlinePath(this.penPoints, { size: this.penSize });
      if (path) {
        (this.draft as Path).path = path;
      }
      return;
    }
    if (kind === "drag") {
      let data = this.runGenerator(this.startX, this.startY, this.snapGrid(px), this.snapGrid(py));
      if (data) {
        // 约束夹紧：起点在 constrain 框架内时生成结果整体限制在框内
        if (this.drawingFrame) {
          data = this.frameCtrl.clampListToFrame(data, this.drawingFrame);
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
    this.frameCtrl.resetScaleSnap();
    // 连接器拖出结束：按落点创建箭头（onUp 不携带事件，用最近 app 坐标）
    if (this.connectorCtrl.dragging) {
      const p = this.lastAppPoint ?? { x: 0, y: 0 };
      this.connectorCtrl.finishDrag(p.x, p.y);
      return;
    }
    // 手型拖拽结束
    if (this.panning) {
      this.panning = false;
      (this.app.canvas.view as HTMLElement).classList.remove("panning");
      return;
    }
    // 橡皮擦结束：有删除则入历史（一次按下到松开合成一步）
    if (this.eraser.erasingNow) {
      if (this.eraser.endStroke()) {
        this.commitHistory();
      }
      return;
    }
    // 点编辑拖点结束：拖走原本绑定的端点即解除绑定，并提交历史
    if (this.pointEdit.finishDrag()) {
      this.commitHistory();
      return;
    }
    // 裁剪框调整结束：松手即应用裁剪（canvas 2D 裁出新图）
    if (this.cropCtrl.handleUp()) {
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
      let created = true;
      if (this.isTinyDraft()) {
        this.draft.remove();
        for (const el of this.draftExtras) {
          el.remove();
        }
        created = false;
      } else if (this.opts.registry.getKind(this.tool) === "freehand") {
        // 笔迹转正：挂载采样点元数据，序列化时输出 freehand 元素（供整理识别/重绘）
        const t = this.draft as unknown as Record<string, unknown>;
        t.__freehandPoints = this.penPoints.map((p) => [...p]);
        t.__penSize = this.penSize;
      }
      // 组合工具草稿其余元素已在画布上（拖拽中实时预览），无需补齐
      // 框架内容归属：绘制结果完全落在框架 bbox 内 → 挂上该框架的 frameId
      if (this.draft) {
        this.frameCtrl.adopt(this.draft);
      }
      for (const el of this.draftExtras) {
        this.frameCtrl.adopt(el);
      }
      this.draft = null;
      this.draftExtras = [];
      this.draftData = null;
      this.commitHistory();
      // 使用统计：实际生成元素才计数（丢弃的微小草稿不计；自定义工具用，内置忽略）
      if (created) {
        this.opts.registry.markUsed(this.tool);
      }
      // 绘制后自动回选择工具（Excalidraw 同款；设置可关）：仅在实际生成元素时
      // 切换（点击落空不切），双击空白建文本走 onTap 管线不受影响
      if (created && this.autoBackToSelect && this.tool !== "select") {
        this.setTool("select");
        this.opts.onToolChange?.(this.tool);
      }
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
    const isDouble = this.lastTapTarget === e.target && now - this.lastTapTime < 300;
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
      if (this.pointEdit.activeEl === target && this.pointEdit.editing) {
        this.pointEdit.addPointAt(e.x ?? 0, e.y ?? 0);
      } else {
        this.pointEdit.enter(target);
      }
    } else if (typeOf(target as UI) === null) {
      // 双击空白：就地创建文本并进入编辑（Excalidraw 同款快捷输入）
      const p = this.app.tree.getInnerPoint({ x: e.x ?? 0, y: e.y ?? 0 });
      this.createTextAt(p.x, p.y);
    }
  }

  /** 打开文本内联编辑：先选中元素（openInnerEditor 仅对单选状态生效），并聚焦覆盖层 */
  private openTextEdit(el: Text) {
    (el as unknown as Record<string, unknown>).__textBeforeEdit = String(el.text ?? "");
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

  // ================= 线性元素点编辑（委托 PointEditController） =================

  /** 退出点编辑（ESC/点击空白/切换工具/载入场景等时机；收尾约束兜底在控制器内） */
  exitPointEdit() {
    this.pointEdit.exit();
  }

  // ================= 箭头端点绑定 =================

  /** 内容归属同步（单个元素）：拖出所属框架（中心出框）解除归属；
   * 未归属元素完全落入某框架时补挂归属。拖动中调用时 bounds 可能滞后
   * （多选模拟层平移异步刷新），结束兜底再跑一次 */
  private syncMoverAdoption(m: UI) {
    if (isFrameEl(m)) {
      return;
    }
    const fid = this.frameCtrl.idOf(m);
    if (!fid) {
      const frame = this.frameCtrl.containing(m);
      if (frame) {
        this.frameCtrl.setId(m, this.aiIdOf(frame));
      }
      return;
    }
    const frame = this.frameCtrl.byId(fid);
    const fb = frame?.worldBoxBounds;
    const eb = m.worldBoxBounds;
    if (!fb || !eb) {
      this.frameCtrl.setId(m, undefined);
      return;
    }
    const cx = eb.x + eb.width / 2;
    const cy = eb.y + eb.height / 2;
    if (cx < fb.x || cx > fb.x + fb.width || cy < fb.y || cy > fb.y + fb.height) {
      this.frameCtrl.setId(m, undefined);
    }
  }

  /** 内容归属同步（移动集合）：拖动结束兜底（bounds 已定型），
   * 覆盖编辑器多选模拟层平移期间判定滞后的情况 */
  private syncMoversAdoption(list: UI[]) {
    for (const m of list) {
      if (m && !m.locked) {
        this.syncMoverAdoption(m);
      }
    }
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
        // 正交折线（route）：端点变化后重建 L 形中间路径点
        if ((el as unknown as { __isRoute?: boolean }).__isRoute === true) {
          this.rebuildRoutePoints(el);
        }
      }
    }
  }

  /**
   * 正交折线重建：以两端点的世界坐标生成 L 形中间路径点（不含端点），
   * 出入方向优先按两个绑定节点中心的相对方位（水平/垂直连接），
   * 无绑定时按端点主导轴。仅替换中间点，端点保持调用方刚写入的位置。
   */
  private rebuildRoutePoints(el: Line) {
    const pts = pointsOf(el);
    if (pts.length < 2) {
      return;
    }
    const t = el as unknown as { __bindStart?: string; __bindEnd?: string };
    let prefer: "h" | "v" | undefined;
    if (t.__bindStart && t.__bindEnd) {
      const a = this.findByAiId(t.__bindStart)?.worldBoxBounds;
      const b = this.findByAiId(t.__bindEnd)?.worldBoxBounds;
      if (a && b) {
        prefer =
          Math.abs(b.x + b.width / 2 - (a.x + a.width / 2)) >=
          Math.abs(b.y + b.height / 2 - (a.y + a.height / 2))
            ? "h"
            : "v";
      }
    }
    const s = el.getWorldPoint(pts[0]);
    const e = el.getWorldPoint(pts[pts.length - 1]);
    const mid = buildOrthoWaypoints(s, e, prefer).map((p) => el.getLocalPoint(p));
    el.points = [pts[0], ...mid, pts[pts.length - 1]];
  }

  /**
   * 连接器落点：创建箭头。targetId 非空 → route 绑定连线（端点取双方边框
   * 最近点，bindStart/bindEnd 记录绑定，L 形按绑定节点方位重算）；为空 →
   * 普通直线箭头延伸到落点。样式取当前默认描边，创建即入历史。
   */
  createBoundArrow(
    sourceId: string,
    targetId: string | null,
    endWorld: { x: number; y: number },
    _prefer: "h" | "v" = "h",
  ): boolean {
    const source = this.findByAiId(sourceId);
    if (!source) {
      return false;
    }
    const target = targetId ? this.findByAiId(targetId) : null;
    if (targetId && !target) {
      return false;
    }
    const startW = nearestBorderPoint(source, endWorld);
    if (!startW) {
      return false;
    }
    const endW = target ? nearestBorderPoint(target, startW) : { x: endWorld.x, y: endWorld.y };
    if (!endW) {
      return false;
    }
    const style = this.opts.getStyle();
    const data: ElementData = {
      type: "arrow",
      x: 0,
      y: 0,
      width: Math.abs(endW.x - startW.x),
      height: Math.abs(endW.y - startW.y),
      points: [{ ...startW }, { ...endW }],
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
      bindStart: target ? sourceId : undefined,
      bindEnd: target ? (targetId ?? undefined) : undefined,
      route: target ? true : undefined,
    };
    const el = this.dataToElement(data);
    if (!el) {
      return false;
    }
    this.addToTree(el);
    // L 形按绑定节点中心的相对方位重排（rebuildRoutePoints 自行推导方向）
    if (el instanceof Line && target) {
      this.rebuildRoutePoints(el);
    }
    this.frameCtrl.adopt(el);
    this.commitHistory();
    return true;
  }

  // ================= 选择命中 =================

  private hitTest(world: { x: number; y: number }, radius = 5, exclude?: UI | null): UI | null {
    // 逐元素像素级命中：线段/箭头/画笔按实际描边命中；
    // 空心图形内部透明区域不命中，可穿透选中下层元素。
    // hitRadius 扩大命中容差（细线也容易点中；橡皮按光标半径命中）
    // 性能：空间索引预筛出 bbox 邻近的少数候选（含描边外扩余量），
    // 再按原优先级（自顶向下）逐个 el.hit 收口——语义与全量扫描一致。
    const cands = this.hitCandidates(world.x, world.y, radius);
    for (let i = 0; i < cands.length; i++) {
      const el = cands[i];
      if (el === exclude) {
        continue; // 调用方指定的排除元素
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

  // ================= 橡皮擦（委托 EraserController） =================

  /** 当前画布缩放（世界 → 屏幕系数下限防御） */
  private zoomScale(): number {
    return Math.max(this.app.tree.zoomLayer?.scaleX ?? 1, 0.01);
  }

  /** 当前橡皮半径（px，屏幕像素） */
  get eraserRadiusPx(): number {
    return this.eraser.radiusPx;
  }

  /** 是否正在橡皮擦手势中（长按临时橡皮的松手还原需避让） */
  get isErasing(): boolean {
    return this.eraser.erasingNow;
  }

  /** 设置橡皮半径（px，屏幕像素）：同步光标圆圈，所见即所擦 */
  setEraserRadius(px: number) {
    this.eraser.setRadius(px);
  }

  /** 增减橡皮半径（[ ] 键 / 橡皮模式滚轮） */
  adjustEraserRadius(deltaPx: number) {
    const r = this.eraser.adjust(deltaPx);
    this.opts.onEraserRadiusChange?.(r);
  }

  // ================= 方向键微移 / 缩放适配 =================

  /**
   * 方向键微移选中元素：世界位移换算到各元素父级局部坐标（含旋转/缩放元素）；
   * 契约元素并入 points/path（freehand 移锚点），框架带动框内内容。
   */
  nudgeSelected(dxWorld: number, dyWorld: number): boolean {
    const list = this.selectedList.filter((el) => !el.locked && !this.isEditorInternal(el));
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
        this.frameCtrl.moveContents(el, dxWorld, dyWorld);
      }
    }
    this.updateBindings();
    this.commitHistory();
    this.opts.onMutated();
    return true;
  }

  /** 视口缩放/平移到指定世界 bbox（留 10% 边距，限幅在画布缩放范围内） */
  private zoomToFitBounds(b: { x: number; y: number; width: number; height: number }): boolean {
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
            height: Math.max(box.y + box.height, b.y + b.height) - Math.min(box.y, b.y),
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
            height: Math.max(box.y + box.height, b.y + b.height) - Math.min(box.y, b.y),
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
    // 联合包围盒判定：多选元素之间的空隙也属于选区（此前逐元素判定会让
    // 空隙按下把选择清空——空列表下编辑器的 simulateTarget 拖拽会崩溃，
    // 进而冻结整个画布）
    let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
    for (const el of this.selectedList) {
      const b = el.worldBoxBounds;
      if (!b) {
        continue;
      }
      box = box
        ? {
            minX: Math.min(box.minX, b.x),
            minY: Math.min(box.minY, b.y),
            maxX: Math.max(box.maxX, b.x + b.width),
            maxY: Math.max(box.maxY, b.y + b.height),
          }
        : { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height };
    }
    return box !== null && ax >= box.minX && ax <= box.maxX && ay >= box.minY && ay <= box.maxY;
  }

  /**
   * app 坐标点是否落在编辑框的可交互区域（缩放手柄/旋转手柄/边框线）上。
   * 命中时交给 editor 处理缩放/旋转，避免被"框内拖动"逻辑抢先。
   */
  private hitEditBox(ax: number, ay: number): boolean {
    const eb = this.editor.editBox as unknown as
      | {
          rect?: {
            getLayoutPoints?: (type?: string, relative?: string) => { x: number; y: number }[];
          };
          resizePoints?: UI[];
          rotatePoints?: UI[];
          resizeLines?: UI[];
        }
      | undefined;
    if (!eb) {
      return false;
    }
    // 缩放手柄 / 旋转手柄 / 边线手柄：世界包围盒 + 容差。
    // 跳过不可见手柄（visible=0/false）：禁用的手柄（如框架的 resizeable:false）
    // 只是隐藏，编辑器侧不再响应，若此处仍让路会形成“抓边无反应”的死区
    const points = [
      ...(eb.resizePoints ?? []),
      ...(eb.rotatePoints ?? []),
      ...(eb.resizeLines ?? []),
    ];
    for (const p of points) {
      if (!(p as unknown as { visible?: unknown }).visible) {
        continue;
      }
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

  /**
   * 组感知展开：列表含组成员时返回整组成员并集（保持传入成员在内），
   * 供 Alt+拖拽复制的移动单元计算共用。
   */
  private groupExpanded(list: UI[]): UI[] {
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

  // ================= Alt+拖拽复制（落点克隆） =================

  /**
   * Alt+拖拽复制挂靠：以 movers（编辑器选中集或手动拖动列表）为粒度做落点
   * 克隆快照。返回是否成功快照；false = 本手势不可复制（约束框架内禁用 /
   * 无可序列化元素），调用方据此停止逐帧重试。
   *
   * 维护者决策（BACKLOG P0-1）：约束开启的框架内禁用 Alt+拖拽复制——Alt 在
   * 约束拖动中保留「出框豁免」语义；框架外 Alt 无其他含义，用作复制修饰键。
   */
  private tryLatchAltCopy(movers: UI[]): boolean {
    if (!this.modKeys.alt || !movers.length) {
      return false;
    }
    const units = this.groupExpanded(this.expandMoversForSnap(movers)).filter((el) => !el.locked);
    if (!units.length || units.some((m) => !isFrameEl(m) && this.frameCtrl.constrainOf(m))) {
      return false;
    }
    const children = this.app.tree.children as UI[];
    const snap: { data: ElementData; z: number }[] = [];
    for (const el of units) {
      const d = this.elementToData(el);
      if (!d) {
        continue;
      }
      // 副本分配全新 id（id 置空）；剥离 frameId——快照是世界坐标，保留会走
      // 「相对坐标契约」被二次换算，提交时改由 adoptIntoFrame 按 bbox 重新
      // 归属；groupId 保留原值，提交时整组重映射，避免与原组联动串门
      snap.push({
        data: { ...d, id: undefined, frameId: undefined },
        z: Math.max(children.indexOf(el), 0),
      });
    }
    if (!snap.length) {
      return false;
    }
    this.altCopySnap = snap;
    return true;
  }

  /**
   * 移动单元补全：拖动框架时其归属内容元素随框架平移（moveFrameContents
   * 驱动，不在编辑器选中列表里），快照需覆盖它们才能整组还原。
   */
  private expandMoversForSnap(movers: UI[]): UI[] {
    const picked = new Set<UI>(movers);
    const fids = new Set<string>();
    for (const m of movers) {
      if (isFrameEl(m)) {
        const id = this.aiIdOf(m);
        if (id) {
          fids.add(id);
        }
      }
    }
    if (fids.size) {
      for (const el of this.app.tree.children as UI[]) {
        if (picked.has(el) || el.locked || isFrameEl(el)) {
          continue;
        }
        const fid = this.frameCtrl.idOf(el);
        if (fid && fids.has(fid)) {
          picked.add(el);
        }
      }
    }
    return [...picked];
  }

  /**
   * Alt+拖拽复制收尾（落点克隆）：DragEvent.END / 手动拖动结束时调用，
   * 无快照或未实际位移时为空操作。快照元素在拖动前原位重建——新 id、新组 id、
   * 尽量插回原 z 序、按 bbox 重新归属框架。留在原位的是克隆出的“原件”，
   * 被拖到落点的是原元素（保持选中，符合“副本跟随光标”的直觉）。
   */
  private commitAltCopy() {
    const snap = this.altCopySnap;
    const moved = this.altCopyMoved;
    this.altCopySnap = null;
    this.altCopyBlocked = false;
    this.altCopyMoved = false;
    if (!snap || !moved) {
      return;
    }
    // 组关系重映射：副本组与原组彻底脱离（同 groupId 会排列/删除/拖动联动）
    const gidMap = new Map<string, string>();
    for (const s of snap) {
      const g = s.data.groupId;
      if (g && !gidMap.has(g)) {
        gidMap.set(g, `grp-${this.nextElId++}`);
      }
    }
    let inserted = 0;
    const created: UI[] = [];
    for (const s of [...snap].sort((a, b) => a.z - b.z)) {
      const g = s.data.groupId;
      const d = g ? { ...s.data, groupId: gidMap.get(g) } : s.data;
      const el = this.dataToElement(d);
      if (!el) {
        continue;
      }
      // 尽量插回拖动前的层序（同批插入使序号偏移，越界由 splice 兜底追加）
      this.app.tree.add(el, s.z + inserted);
      created.push(el);
      inserted++;
    }
    if (!inserted) {
      return;
    }
    // 定向重新归属：克隆件落在原位置，仍完全包含于某框架则挂回归属。
    // 不全局 resolveFrameContents——避免既有归属成员被相对坐标换算二次位移
    for (const el of created) {
      this.frameCtrl.adopt(el);
    }
    this.commitHistory();
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
          const pts = (el as unknown as { __freehandPoints?: number[][] }).__freehandPoints;
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
        (el as unknown as { dashPattern?: number[] }).dashPattern = partial.strokeDash;
      }
      if (partial.opacity !== undefined) {
        el.opacity = partial.opacity;
      }
      if (partial.cornerRadius !== undefined && el instanceof Rect && !(el instanceof Image)) {
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
    const texts = this.selectedList.filter((el): el is Text => el instanceof Text && !el.locked);
    if (!texts.length) {
      return false;
    }
    const weightOf = (t: Text) =>
      typeof t.fontWeight === "number" ? t.fontWeight : t.fontWeight === "bold" ? 700 : 400;
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
      if (this.isEditorInternal(el) || el instanceof Text || el instanceof Image) {
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

  // ================= 框架域（委托 FrameController；门面保持公开 API 不变） =================

  /** 选中单个未锁定 rect → 转为框架 */
  toFrame(): boolean {
    return this.frameCtrl.toFrame();
  }

  /** 选中单个未锁定 frame → 转为普通矩形 */
  toRect(): boolean {
    return this.frameCtrl.toRect();
  }

  /** 翻转内容约束开关 */
  toggleFrameConstrain(): boolean {
    return this.frameCtrl.toggleConstrain();
  }

  /** 切换内容折叠 */
  toggleFrameCollapsed(): boolean {
    return this.frameCtrl.toggleCollapsed();
  }

  /** 聚焦/退出聚焦框架 */
  toggleFrameFocus(): boolean {
    return this.frameCtrl.toggleFocus();
  }

  /** 框架操作资格（右键菜单用） */
  frameActionState() {
    return this.frameCtrl.actionState();
  }

  /** 创建内容型框架（导入 MD/代码/文本用） */
  createContentFrame(
    x: number,
    y: number,
    info: {
      name?: string;
      contentType: "markdown" | "code" | "text";
      content: string;
    },
  ): boolean {
    return this.frameCtrl.createContent(x, y, info);
  }

  /**
   * 局部整理：只整理选中元素（手绘笔迹 → 标准图形/拉直），未选中的原样保留。
   * 元素 id 稳定（freehand → rect/ellipse/line/path 后保持），整理后恢复选中；
   * z-order 不变（loadElements 按数组顺序重建）；整轮改动合并为一步撤销。
   * 返回整理统计（空数组 = 没有需要整理的笔迹）。
   */
  beautifySelection(): { changed: number; stats: BeautifyStats } {
    const list = this.selectedList.filter((el) => !el.locked && !this.isEditorInternal(el));
    if (!list.length) {
      return { changed: 0, stats: [] };
    }
    // serialize 会为所有元素分配稳定 id，先序列化再取选中 id；
    // 内容归属元素先展开为世界坐标（相对坐标会让对齐/分布计算失真）
    const before = this.serialize();
    const ids = list.map((el) => this.aiIdOf(el)).filter((id): id is string => !!id);
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
    const frameIds = new Set(list.filter((el) => isFrameEl(el)).map((el) => this.aiIdOf(el)));
    const detached: { el: UI; fid: string }[] = [];
    for (const el of list) {
      const fid = this.frameCtrl.idOf(el);
      if (fid && !frameIds.has(fid)) {
        detached.push({ el, fid });
        this.frameCtrl.setId(el, undefined);
      }
    }
    this.clipboard = list
      .map((el) => this.elementToData(el))
      .filter((d): d is ElementData => d !== null);
    // 恢复临时解除的归属（仅影响序列化输出，不改变运行态归属）
    for (const { el, fid } of detached) {
      this.frameCtrl.setId(el, fid);
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
    this.clipboardBox = Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
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
      dx = this.lastPointer.x - (this.clipboardBox.minX + this.clipboardBox.maxX) / 2;
      dy = this.lastPointer.y - (this.clipboardBox.minY + this.clipboardBox.maxY) / 2;
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
    this.frameCtrl.resolveContents();
    this.frameCtrl.clampMembers(pasted);
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
          (p): p is { x: number; y: number } => typeof p === "object" && p !== null,
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
    const children = (this.app.tree.children as UI[]).filter((el) => !this.isEditorInternal(el));
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
  arrangeByIds(ids: string[], action: ArrangeAction): { done: number; skipped: number } {
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
    if (action === "front" || action === "back" || action === "forward" || action === "backward") {
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
  beautifyByIds(ids: string[]): { changed: number; stats: BeautifyStats; skipped: number } {
    const before = this.serialize();
    const byId = new Map(before.map((d) => [d.id, d]));
    const found = ids.filter((id) => byId.has(id));
    const skipped = found.filter((id) => byId.get(id)?.locked).length;
    const selIds = found.filter((id) => !byId.get(id)?.locked);
    if (!selIds.length) {
      return { changed: 0, stats: [], skipped };
    }
    const members = expandGroupMembers(before, selIds);
    const { elements, stats } = beautifyScene(expandFrameContents(before), [...members]);
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
  setRoughnessByIds(ids: string[], value: number): { changed: number; skipped: number } {
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
          return flipElements(els, axis, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
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
  private selectByBox(box: { x: number; y: number; width: number; height: number }): UI[] {
    const hits: UI[] = [];
    if (box.width < 3 || box.height < 3) {
      return hits; // 点击而非拖拽：视为取消选择
    }
    this.ensureSceneIndex();
    // 索引候选按 tree 子序正排后精判——保持原「自底向上推入」的顺序语义
    // （editor.list 首元素 = 选区底层，面板单值展示依赖）
    const cands = this.sceneIndex.queryBox({
      minX: box.x,
      minY: box.y,
      maxX: box.x + box.width,
      maxY: box.y + box.height,
    });
    for (const el of this.sortByZOrder(cands, true)) {
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
    this.ensureSceneIndex();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const cands = this.sceneIndex.queryBox({ minX, minY, maxX, maxY });
    for (const el of this.sortByZOrder(cands, true)) {
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
    // 感知版本自增：AI 增量画布感知据此判定「无变化」（见 ai/perception.ts）
    this.perceptionVersionN++;
    this.pushSnapshot(this.serialize());
  }

  /** 当前感知版本（每次内容变更 +1；视口移动/缩放不计入） */
  get perceptionVersion(): number {
    return this.perceptionVersionN;
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
          if (this.frameCtrl.idOf(other) === fid) {
            this.frameCtrl.setId(other, undefined);
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
    this.frameCtrl.adoptAndClamp(el);
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
    return list.find((el) => (el as unknown as { __aiId?: string }).__aiId === id) ?? null;
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
      (el as unknown as { dashPattern?: number[] }).dashPattern = patch.strokeDash;
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
    const els = (this.app.tree.children as UI[]).filter((el) => !this.isEditorInternal(el));
    if (els.length) {
      this.app.tree.clear();
    }
    this.editor.cancel();
    this.commitHistory();
  }

  get elementCount() {
    // 排除 editor 内部元素（多选模拟层），避免计数虚增
    return (this.app.tree.children as UI[]).filter((el) => !this.isEditorInternal(el)).length;
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
  private imageSize(url: string): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
      const img = new window.Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
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
    // 逐元素双向映射收在 scene-format；Board 仅注入三个无状态回调
    return sceneElementToData(el, {
      aiIdOf: (e) => this.aiIdOf(e),
      frameIdOf: (e) => this.frameCtrl.idOf(e),
      isEditorInternal: (e) => this.isEditorInternal(e),
    });
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
    this.frameCtrl.resetScaleSnap();
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
    this.frameCtrl.resolveContents(opts?.worldCoords);
    this.editor.cancel();
    this.updateGrid();
    // 场景整体重建（撤销/重做/载入）不经 commitHistory，感知版本单独自增
    this.perceptionVersionN++;
    // 批量重建显式置脏：不依赖 tree.clear/add 的逐个事件兜底
    this.markSceneSpatialDirty();
  }

  private dataToElement(d: ElementData): UI | null {
    return sceneDataToElement(d);
  }

  /** 元素入树（与原有 add 行为一致；内容子级随 Box 容器自动入树） */
  private addToTree(el: UI) {
    this.app.tree.add(el);
  }

  // ================= 导出 =================

  /** 导出画布为 SVG 文档字符串（矢量，可无损缩放；图片以 dataURL 内嵌） */
  exportSVG(): string {
    // 内容归属元素先展开为世界坐标（文件里存的是相对坐标，直接导出会错位）
    return elementsToSVG(expandFrameContents(this.serialize()), this.background);
  }

  // ================= 网格 =================

  /**
   * 应用网格设置（设置弹窗调用）：保存并重建网格线；吸附在绘制/移动时即时生效。
   */
  applyGrid(g: GridSettings) {
    this.grid = { ...g };
    this.updateGrid();
  }

  /** 公开：设置「绘制后自动切回选择工具」开关（设置弹窗/启动装载调用） */
  setAutoBackToSelect(v: boolean) {
    this.autoBackToSelect = v;
  }

  // ================= 取色器 =================

  /**
   * 进入取色模式：下一次画布点击采样该点渲染像素（所见即所得，含透明度合成），
   * Esc / 右键取消。重复调用返回同一个进行中的 Promise。
   * 实现：直接读 leafer 画布 backing store（app 坐标 × CSS→物理缩放），不经过
   * 元素命中——取的是"像素色"而非元素属性色。
   */
  pickColor(): Promise<string | null> {
    if (this.pickPromise) {
      return this.pickPromise;
    }
    this.pickPromise = new Promise<string | null>((resolve) => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.finishPick(null);
        }
      };
      this.pickState = { resolve, onKey };
      document.addEventListener("keydown", onKey, true);
      (this.app.canvas.view as HTMLElement).classList.add("picking-cursor");
    });
    return this.pickPromise;
  }

  /** 结束取色：清理光标与监听并兑现结果（hex 或 null=取消/失败） */
  private finishPick(hex: string | null) {
    const state = this.pickState;
    this.pickState = null;
    this.pickPromise = null;
    if (!state) {
      return;
    }
    document.removeEventListener("keydown", state.onKey, true);
    (this.app.canvas.view as HTMLElement).classList.remove("picking-cursor");
    state.resolve(hex);
  }

  /**
   * 采样 app 坐标处的渲染像素 → #rrggbb；画布不可读（污染）返回 null。
   * 注意：多层 App 的自身 view 是 div 容器（unrealCanvas），元素像素在
   * tree 层自己的画布上；tree 画布空区域为透明，需与画布背景色合成。
   */
  private samplePixelAt(ax: number, ay: number): string | null {
    const view = (this.app.tree as unknown as { canvas?: { view?: HTMLCanvasElement } }).canvas
      ?.view;
    if (!(view instanceof HTMLCanvasElement)) {
      return null;
    }
    try {
      const ctx = view.getContext("2d");
      if (!ctx || !view.width || !view.height) {
        return null;
      }
      const rect = view.getBoundingClientRect();
      const sx = view.width / Math.max(rect.width, 1);
      const sy = view.height / Math.max(rect.height, 1);
      const d = ctx.getImageData(Math.round(ax * sx), Math.round(ay * sy), 1, 1).data;
      // alpha 合成到画布背景色（透明像素 = 背景本身）
      const al = d[3] / 255;
      if (al <= 0) {
        return this.background;
      }
      const bg = parseHexColor(this.background);
      const h = (n: number) => n.toString(16).padStart(2, "0");
      const mix = (fg: number, base: number) => Math.round(fg * al + base * (1 - al));
      if (!bg) {
        return `#${h(d[0])}${h(d[1])}${h(d[2])}`;
      }
      return `#${h(mix(d[0], bg[0]))}${h(mix(d[1], bg[1]))}${h(mix(d[2], bg[2]))}`;
    } catch {
      // 画布被跨域图片污染等场景：getImageData 抛错
      return null;
    }
  }

  /** 数值对齐到网格（吸附关闭或网格尺寸非法时原样返回） */
  private snapGrid(v: number): number {
    if (!this.grid.snap || !this.grid.size || this.grid.size < 4) {
      return v;
    }
    return Math.round(v / this.grid.size) * this.grid.size;
  }

  // ================= 智能对齐参考线 =================

  /**
   * 收集对齐候选线（每手势一次）：其余元素（含锁定，排除编辑器内部层与
   * 移动框架的归属内容——它们随框移动，手势起点坐标会失效）包围盒的
   * 左/中/右 x 与上/中/下 y。世界基准（含缩放），阈值即屏幕恒定。
   */
  private collectAlignCandidates(moving: UI): { xs: number[]; ys: number[] } {
    const xs: number[] = [];
    const ys: number[] = [];
    const movingFrameId = isFrameEl(moving) ? this.aiIdOf(moving) : undefined;
    for (const el of this.app.tree.children as UI[]) {
      if (el === moving || this.isEditorInternal(el)) {
        continue;
      }
      // 拖动框架时其归属内容随框平移，手势起点的候选坐标会失真
      if (movingFrameId && this.frameCtrl.idOf(el) === movingFrameId) {
        continue;
      }
      const b = el.worldBoxBounds;
      if (!b || b.width <= 0 || b.height <= 0) {
        continue;
      }
      xs.push(b.x, b.x + b.width / 2, b.x + b.width);
      ys.push(b.y, b.y + b.height / 2, b.y + b.height);
    }
    return { xs, ys };
  }

  /** 单轴吸附：期望边值与候选线的最小距离 ≤ 阈值时返回修正量与参考线位置 */
  private snapAxis(edges: number[], candidates: number[]): { offset: number; line: number } | null {
    let best: { dist: number; offset: number; line: number } | null = null;
    for (const e of edges) {
      for (const c of candidates) {
        const d = Math.abs(c - e);
        if (d <= ALIGN_SNAP_PX && (!best || d < best.dist)) {
          best = { dist: d, offset: c - e, line: c };
        }
      }
    }
    return best ? { offset: best.offset, line: best.line } : null;
  }

  /**
   * 带迟滞的单轴吸附：命中即锁定该候选线，此后只认锁定线（偏离超过退出
   * 阈值才解锁重找）——否则指针在阈值边界抖动时参考线会反复出现/消失。
   */
  private snapAxisLocked(
    edges: number[],
    candidates: number[],
    axis: "x" | "y",
  ): { offset: number; line: number } | null {
    const lock = axis === "x" ? this.alignLockX : this.alignLockY;
    if (lock !== null) {
      let nearest = Infinity;
      let nearestEdge = edges[0] ?? lock;
      for (const e of edges) {
        if (Math.abs(lock - e) < nearest) {
          nearest = Math.abs(lock - e);
          nearestEdge = e;
        }
      }
      if (nearest <= ALIGN_HYST_PX) {
        return { offset: lock - nearestEdge, line: lock };
      }
      // 超出迟滞范围：解锁并继续走正常搜索
      if (axis === "x") {
        this.alignLockX = null;
      } else {
        this.alignLockY = null;
      }
    }
    const hit = this.snapAxis(edges, candidates);
    if (hit) {
      if (axis === "x") {
        this.alignLockX = hit.line;
      } else {
        this.alignLockY = hit.line;
      }
    }
    return hit;
  }

  // ================= 落框高亮 =================

  /**
   * 拖动中落框预判：移动集合（编辑器选中或手动拖动列表）的联合 bbox 完全
   * 落入某框架（含描边容差，与 adoptIntoFrame 同语义）时，sky 层高亮该
   * 框架——嵌套时取面积最小者。无命中/集合为空即还原。
   */
  private updateDropHighlight(movers: UI[]) {
    const units = movers.filter((m) => m && !m.locked);
    if (!units.length) {
      this.clearDropHighlight();
      return;
    }
    let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
    for (const m of units) {
      const b = m.worldBoxBounds;
      if (!b) {
        continue;
      }
      box = box
        ? {
            minX: Math.min(box.minX, b.x),
            minY: Math.min(box.minY, b.y),
            maxX: Math.max(box.maxX, b.x + b.width),
            maxY: Math.max(box.maxY, b.y + b.height),
          }
        : { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height };
    }
    if (!box) {
      this.clearDropHighlight();
      return;
    }
    const moverSet = new Set(units);
    let target: UI | null = null;
    let targetArea = Infinity;
    // 拖动中每帧调用：只在框架子集上判定，避免全树扫描
    for (const frame of this.frameElements()) {
      if (!isFrameEl(frame) || moverSet.has(frame)) {
        continue;
      }
      const fb = frame.worldBoxBounds;
      if (!fb) {
        continue;
      }
      // 完全包含判定：与 adoptIntoFrame 的 frameContaining 同语义（含描边容差）
      const sw = typeof frame.strokeWidth === "number" ? frame.strokeWidth : 0;
      const tol = sw / 2 + 1;
      if (
        box.minX >= fb.x - tol &&
        box.minY >= fb.y - tol &&
        box.maxX <= fb.x + fb.width + tol &&
        box.maxY <= fb.y + fb.height + tol
      ) {
        const area = fb.width * fb.height;
        if (area < targetArea) {
          targetArea = area;
          target = frame;
        }
      }
    }
    if (target === this.dropHighlightFrame) {
      return;
    }
    this.clearDropHighlight();
    if (!target) {
      return;
    }
    const b = target.worldBoxBounds;
    if (!b) {
      return;
    }
    const rect = new Rect({
      x: b.x - 3,
      y: b.y - 3,
      width: b.width + 6,
      height: b.height + 6,
      stroke: DROP_HIGHLIGHT_STROKE,
      strokeWidth: 2.5,
      fill: "rgba(242, 74, 160, 0.05)",
      dashPattern: undefined,
    });
    this.app.sky.add(rect);
    this.dropHighlightRect = rect;
    this.dropHighlightFrame = target;
  }

  /** 清除落框高亮（sky 层覆盖框，不动框架本体） */
  private clearDropHighlight() {
    if (this.dropHighlightRect) {
      this.dropHighlightRect.remove();
      this.dropHighlightRect = null;
    }
    this.dropHighlightFrame = null;
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
  async exportViewportImage(size = 1024): Promise<{ url: string; viewport: ViewportInfo } | null> {
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
