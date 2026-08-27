import { Line, Path, Rect } from "leafer-ui";
import type { App, UI } from "leafer-ui";
import type { ArrowHead } from "../types";
import { arrowHeadOf, isFreehandEl, pointsOf } from "./element-utils";
import { penSizeOf, splitArrowHeads, splitErasedPoints, strokeOutlinePath } from "./stroke";
import { distToSegment } from "./geometry";

/**
 * 橡皮擦控制器：从 Board 拆出的独立交互模块。
 * 分段擦除（freehand/线性元素按橡皮轨迹裁区间，剩余拆独立元素）+ 整删类
 * 圆心触及判定 + 待删预览（rAF 合帧）+ 半径调节与光标圆圈。
 * 坐标基准：对外接口均为 app/世界坐标，内部按元素局部单位做缩放补偿。
 */

// 橡皮默认半径（px，屏幕像素）：分段擦除命中与光标圆圈共用
const ERASER_DEFAULT = 10;
// 橡皮半径可调范围（屏幕像素）
const ERASER_MIN = 2;
const ERASER_MAX = 80;

/** 橡皮圆圈光标（SVG data URI）：直径 = 2×半径，双圈描边保证深浅主题下均可见 */
export function eraserCursorURL(radius: number): string {
  const d = radius * 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}" viewBox="0 0 ${d} ${d}">` +
    `<circle cx="${radius}" cy="${radius}" r="${radius - 2}" fill="rgba(127,127,127,0.15)" stroke="#fff" stroke-width="2"/>` +
    `<circle cx="${radius}" cy="${radius}" r="${radius - 2}" fill="none" stroke="#333" stroke-width="1"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${radius} ${radius}, crosshair`;
}

/** 分段擦除快照：一次手势内同一原始笔迹/线段的段集合（root 承载第一段，parts 为拆出的其余段） */
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

export type EraserDeps = {
  app: App;
  /** 全树子元素（几何兜底扫描 / 分段扫描） */
  treeChildren: () => UI[];
  /** 拆出的分段元素入树 */
  addToTree: (el: UI) => void;
  /** 擦除命中元素后取消编辑器选择 */
  editorCancel: () => void;
  /** 空间索引加速的命中检测（Board 提供） */
  hitTest: (world: { x: number; y: number }, radius: number, exclude?: UI | null) => UI | null;
  /** 当前画布缩放（世界 → 屏幕系数下限防御） */
  zoomScale: () => number;
  /** editor 内部元素判定（模拟层不参与命中） */
  isEditorInternal: (el: UI) => boolean;
  /** 拆出段的框架/分组归属继承（FrameController 提供） */
  inheritOwnership: (part: UI, root: UI) => void;
  /** 当前工具判定（预览渲染与光标应用仅在橡皮模式生效） */
  isToolEraser: () => boolean;
};

export class EraserController {
  /** 当前橡皮半径（px，屏幕像素） */
  private radius = ERASER_DEFAULT;
  /** 是否处于橡皮擦手势中 */
  private erasing = false;
  /** 本手势是否发生过擦除（决定松手是否提交历史） */
  private deleted = false;
  /** 手势内上一采样点（4px 步进节流） */
  private lastPt = { x: 0, y: 0 };
  /** 手势轨迹（app 坐标）：分段擦除按轨迹剔除笔迹区间 */
  private trail: { x: number; y: number }[] = [];
  /** 分段擦除快照：本手势已拆分的笔迹元素 → 原始点列（元素局部坐标） */
  private snap = new Map<UI, EraseSnap>();
  // 待删预览（sky 层红色虚线框）：rAF 合帧状态
  private preview: Rect | null = null;
  private previewPending: { x: number; y: number } | null = null;
  private previewRaf = 0;

  constructor(private readonly deps: EraserDeps) {}

  get radiusPx(): number {
    return this.radius;
  }

  get erasingNow(): boolean {
    return this.erasing;
  }

  /** 设置橡皮半径（px，屏幕像素）：同步光标圆圈，所见即所擦 */
  setRadius(px: number) {
    this.radius = Math.min(ERASER_MAX, Math.max(ERASER_MIN, Math.round(px)));
    this.applyCursor();
  }

  /** 增减橡皮半径（[ ] 键 / 橡皮模式滚轮），返回新半径 */
  adjust(deltaPx: number): number {
    this.setRadius(this.radius + deltaPx);
    return this.radius;
  }

  /** 橡皮模式下应用圆圈光标（半径变化时调用；非橡皮模式由 setTool 管理光标） */
  applyCursor() {
    if (this.deps.isToolEraser()) {
      (this.deps.app.canvas.view as HTMLElement).style.cursor = eraserCursorURL(this.radius);
    }
  }

  /** 切离橡皮/工具切换时的状态复位（手势中切换工具兜底） */
  deactivate() {
    this.erasing = false;
    this.clearPreview();
  }

  /** 按下：开始擦除手势并立即擦除落点 */
  beginStroke(ax: number, ay: number) {
    this.erasing = true;
    this.deleted = false;
    this.trail = [{ x: ax, y: ay }];
    this.snap = new Map();
    this.lastPt = { x: ax, y: ay };
    this.eraseAt(ax, ay);
  }

  /** 拖动：待删预览实时跟随；步进 ≥4px 才采样轨迹并执行擦除（事件密集防抖） */
  moveStroke(ax: number, ay: number) {
    this.updatePreview(ax, ay);
    if (Math.hypot(ax - this.lastPt.x, ay - this.lastPt.y) >= 4) {
      this.lastPt = { x: ax, y: ay };
      this.trail.push({ x: ax, y: ay });
      this.eraseAt(ax, ay);
    }
  }

  /** 悬停（未按下）：待删预览给用户反悔预期 */
  hover(ax: number, ay: number) {
    this.updatePreview(ax, ay);
  }

  /**
   * 松手：结束手势并复位轨迹/快照/预览。返回本手势是否发生过擦除，
   * 调用方据此提交撤销历史。
   */
  endStroke(): boolean {
    this.erasing = false;
    this.trail = [];
    this.snap = new Map();
    this.clearPreview();
    return this.deleted;
  }

  /** 当前画布缩放（世界 → 屏幕系数下限防御） */
  private zoomScale(): number {
    return this.deps.zoomScale();
  }

  /** 橡皮半径换算到指定元素的局部单位（防御画布缩放与元素缩放） */
  private localRadius(el: UI): number {
    return this.radius / this.zoomScale() / Math.max(el.scaleX ?? 1, 0.01);
  }

  /**
   * 橡皮命中解析（预览与实际擦除共用同一判定，保证所见即所删）：
   * - 笔迹/线性元素走分段：先按"触及本体"小容差判定，未中再按完整橡皮半径判定
   *   （扫过细线/笔迹附近也能分段）；
   * - 其余元素整条删除：仅当圆心触及元素本体（容差取橡皮半径与 12px 的较小者，
   *   且按缩放补偿为世界单位）——大半径蹭边不再误删整块图形。
   */
  private resolveTarget(ax: number, ay: number): { el: UI; segment: boolean } | null {
    const zoom = this.zoomScale();
    const solidTol = Math.min(this.radius, 12) / zoom;
    const solid = this.deps.hitTest({ x: ax, y: ay }, solidTol);
    if (solid && !solid.locked) {
      if (isFreehandEl(solid)) {
        return { el: solid, segment: true };
      }
      if (solid instanceof Line && pointsOf(solid).length >= 2) {
        return { el: solid, segment: true };
      }
      return { el: solid, segment: false };
    }
    const seg = this.deps.hitTest({ x: ax, y: ay }, this.radius / zoom);
    if (!seg || seg.locked) {
      // 几何兜底：leafer 对细线中段的元素级命中不稳定（端点处才可靠），
      // 改为直接计算指针到各线段的距离（≤ 橡皮半径即命中），保证沿中段扫过也能分段
      for (let i = this.deps.treeChildren().length - 1; i >= 0; i--) {
        const el = this.deps.treeChildren()[i];
        if (this.deps.isEditorInternal(el) || el.locked || !(el instanceof Line)) {
          continue;
        }
        const pts = pointsOf(el);
        if (pts.length < 2) {
          continue;
        }
        const lp = el.getInnerPoint({ x: ax, y: ay });
        const r = this.localRadius(el);
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
    const target = this.resolveTarget(ax, ay);
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
    this.deps.editorCancel();
    this.deleted = true;
  }

  /**
   * 笔迹分段擦除：橡皮轨迹换算到笔迹局部坐标，从快照的原始点列中剔除
   * 被轨迹覆盖（距离 <= 橡皮半径）的点，剩余连续段各自重生成轮廓——
   * 第一段留在原元素（保 id），其余段拆成新元素；全擦完则整条删除。
   * 同一手势内反复经过同一笔迹时按快照幂等重算（已拆段共享快照，不会重复拆）。
   */
  private eraseFreehandAt(el: Path) {
    let snap = this.snap.get(el);
    if (!snap) {
      const t = el as unknown as { __freehandPoints?: number[][] };
      const pts = t.__freehandPoints;
      if (!pts || pts.length < 2) {
        // 元数据缺失或单点笔迹：无法分段，整条删除
        el.remove();
        this.deps.editorCancel();
        this.deleted = true;
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
      this.snap.set(el, snap);
    }
    const root = snap.root as Path;
    // 橡皮半径：屏幕像素 → 笔迹局部单位（防御画布缩放与元素缩放）
    const radius = this.localRadius(root);
    // 轨迹：app 坐标 → 笔迹局部坐标（getInnerPoint 按完整世界矩阵一步逆变换，
    // 不能先转画布坐标再转局部，否则 tree 有平移/缩放时基准错位）
    const trail = this.trail.map((p) => root.getInnerPoint(p));
    const segs = splitErasedPoints(snap.points, trail, radius);
    if (segs.length === 0) {
      // 整条擦除：移除根元素与已拆出的所有段
      root.remove();
      for (const part of snap.parts) {
        this.snap.delete(part);
        part.remove();
      }
      this.snap.delete(el);
      this.deps.editorCancel();
      this.deleted = true;
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
        this.snap.set(part, snap);
      }
    }
    while (snap.parts.length > segs.length - 1) {
      const extra = snap.parts.pop();
      if (extra) {
        this.snap.delete(extra);
        extra.remove();
      }
    }
    this.deleted = true;
  }

  /** 把一段保留点列应用到笔迹元素：重算轮廓并同步采样点元数据 */
  private applyFreehandSeg(el: Path, seg: number[][], size: number) {
    const path = strokeOutlinePath(seg, { size });
    if (path) {
      el.path = path;
    }
    (el as unknown as { __freehandPoints?: number[][] }).__freehandPoints = seg.map((p) => [...p]);
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
    this.deps.inheritOwnership(part, root);
    const gid = (root as unknown as { __groupId?: string }).__groupId;
    if (gid) {
      (part as unknown as { __groupId?: string }).__groupId = gid;
    }
    this.deps.addToTree(part);
    return part;
  }

  /**
   * 线性元素（line/arrow/polyline）分段擦除：与笔迹同一算法——首段留在原元素
   * （保 id 与起点绑定/箭头），其余段拆成新线元素；端点样式按首末段分配，
   * 中间段两端无端点；框架/分组归属随段继承。全擦完则整条删除。
   */
  private eraseLineAt(el: Line) {
    let snap = this.snap.get(el);
    if (!snap) {
      const pts = pointsOf(el);
      if (pts.length < 2) {
        el.remove();
        this.deps.editorCancel();
        this.deleted = true;
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
      this.snap.set(el, snap);
    }
    const root = snap.root as Line;
    // 橡皮半径：屏幕像素 → 元素局部单位（同 freehand 的缩放补偿）
    const radius = this.localRadius(root);
    const trail = this.trail.map((p) => root.getInnerPoint(p));
    const segs = splitErasedPoints(snap.points, trail, radius);
    if (segs.length === 0) {
      root.remove();
      for (const part of snap.parts) {
        this.snap.delete(part);
        part.remove();
      }
      this.snap.delete(el);
      this.deps.editorCancel();
      this.deleted = true;
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
        this.snap.set(part, snap);
      }
    }
    while (snap.parts.length > segs.length - 1) {
      const extra = snap.parts.pop();
      if (extra) {
        this.snap.delete(extra);
        extra.remove();
      }
    }
    this.deleted = true;
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
    this.deps.inheritOwnership(part, root);
    const gid = (root as unknown as { __groupId?: string }).__groupId;
    if (gid) {
      (part as unknown as { __groupId?: string }).__groupId = gid;
    }
    this.deps.addToTree(part);
    return part;
  }

  /**
   * 待删预览入口（rAF 合帧：拖拽高频移动时每帧至多重算一次命中）。
   * 实际渲染见 renderPreviewAt：
   * - 整删类元素：红色虚线框包住整个目标；
   * - 笔迹/线性等分段类元素：只高亮橡皮邻域内将被裁掉的区段
   *   （整条包围盒对长曲线毫无信息量，误导"全部要被删"）。
   */
  private updatePreview(ax: number, ay: number) {
    this.previewPending = { x: ax, y: ay };
    if (this.previewRaf) {
      return;
    }
    this.previewRaf = requestAnimationFrame(() => {
      this.previewRaf = 0;
      const p = this.previewPending;
      if (p) {
        this.renderPreviewAt(p.x, p.y);
      }
    });
  }

  private renderPreviewAt(ax: number, ay: number) {
    if (!this.deps.isToolEraser()) {
      return;
    }
    const target = this.resolveTarget(ax, ay);
    if (!target) {
      this.clearPreview();
      return;
    }
    let b = target.el.worldBoxBounds;
    if (target.segment) {
      const el = target.el;
      const pts = this.segmentPointsOf(el);
      const lp = el.getInnerPoint({ x: ax, y: ay });
      const r = this.localRadius(el) * 1.4;
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
        this.clearPreview();
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
      this.clearPreview();
      return;
    }
    if (!this.preview) {
      this.preview = new Rect({
        stroke: "#ff4d4f",
        strokeWidth: 1.5,
        dashPattern: [5, 4],
        fill: "rgba(255, 77, 79, 0.05)",
      });
      this.deps.app.sky.add(this.preview);
    }
    this.preview.x = b.x - 3;
    this.preview.y = b.y - 3;
    this.preview.width = b.width + 6;
    this.preview.height = b.height + 6;
  }

  /** 分段类元素的局部采样点列（freehand 笔迹 / 线性元素）；非分段类返回 null */
  private segmentPointsOf(el: UI): number[][] | null {
    if (isFreehandEl(el)) {
      return (el as unknown as { __freehandPoints?: number[][] }).__freehandPoints ?? null;
    }
    if (el instanceof Line) {
      return pointsOf(el).map((p) => [p.x, p.y]);
    }
    return null;
  }

  /** 清除待删预览（sky 层残留框；工具切离时由 Board 兜底调用） */
  clearPreview() {
    if (this.previewRaf) {
      cancelAnimationFrame(this.previewRaf);
      this.previewRaf = 0;
    }
    this.previewPending = null;
    if (this.preview) {
      this.preview.remove();
      this.preview = null;
    }
  }
}
