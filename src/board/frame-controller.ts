import { Ellipse, Line, Path, Rect, Text } from "leafer-ui";
import type { App, Box, IUI, UI } from "leafer-ui";
import { isFrameEl } from "./element-utils";
import { hexToRgba } from "./element-utils";
import { FRAME_COLLAPSED_HEIGHT, clampShift, frameContentSize, frameScrollMax } from "./frame";
import { elementBounds } from "./bounds";
import { offsetElementData } from "./offset";
import { rotatePoint, transformPath } from "./path";
import type { BoardStyle, ElementData } from "../types";

/**
 * 框架控制器：从 Board 拆出的独立域模块。
 * 职责：内容归属注册表（__frameId）、归属判定与坐标还原、框架 ⇄ 矩形互转、
 * 内容跟随（移动/旋转/幂等快照缩放）、内容约束夹紧、内容框架折叠/滚动/聚焦、
 * 内容型框架创建。序列化层的 frame 字段映射留在 scene-format（阶段三）。
 */

// 框架默认填充：框架一律带填充（内部可命中走增量拖动管线，也便于视觉识别
// 为容器）；转换/载入时 fill 缺失则补此色
export const FRAME_DEFAULT_FILL = "rgba(79, 140, 255, 0.08)";
// 框架名称标签：字号 / 与框架上沿的间距 / 颜色（子级 Text，hit:false 点击穿透）
export const FRAME_NAME_LABEL_SIZE = 11;
export const FRAME_NAME_LABEL_GAP = 5;
export const FRAME_NAME_LABEL_COLOR = "#8a8f98";
// 内容约束的归属阈值：元素与 constrain 框架的包围盒重叠面积占比下限
const CONSTRAINT_ADOPT_RATIO = 0.6;

/** 框架缩放手势的内容元素快照（单选缩放框架时框内内容跟随的幂等重算基准） */
export interface FrameContentSnap {
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
  kx: number;
  ky: number;
  items: FrameContentSnap[];
}

export type FrameDeps = {
  app: App;
  /** 当前框架元素列表（Board 空间索引同批维护；域内所有扫描只走此列表） */
  frameList: () => UI[];
  /** 全树子元素（内容跟随按 frameId 匹配） */
  treeChildren: () => UI[];
  /** 编辑器选中列表（内容快照/旋转跳过选中成员防双重变换） */
  selectedList: () => UI[];
  /** 元素稳定 id（归属注册表的键） */
  aiIdOf: (el: UI) => string;
  /** 契约元素归一化（line/arrow/path 位移并入 points/path） */
  normalizeContract: (el: UI) => void;
  /** 默认字号（内容 Text 快照兜底） */
  defaultFontSize: () => number;
  /** 视口缩放上下限（聚焦框架用） */
  zoomRange: { min: number; max: number };
  /** 聚焦/退出聚焦后重建网格线 */
  updateGrid: () => void;
  /** 提交撤销历史 */
  commitHistory: () => void;
  /** 元素变更回调（自动保存等） */
  onMutated: () => void;
  /** 编辑器选中目标（toRect/createContent 后重选） */
  editorTarget: (el: UI | undefined) => void;
  /** 约束夹紧默认成员（未传 list 时取编辑器选中集） */
  editorList: () => UI[];
  /** 默认样式（内容框架创建用） */
  getStyle: () => BoardStyle;
  /** 元素入树 */
  addToTree: (el: UI) => void;
  /** 元素数据 → leafer 实例（内容框架创建用） */
  dataToElement: (d: ElementData) => UI | null;
  /** 绘制约束框架（画笔/生成器夹紧的归属目标） */
  drawingFrame: () => UI | null;
};

export class FrameController {
  /** 框架缩放手势的内容快照（幂等重算基准；手势结束清空） */
  private scaleSnap: FrameScaleSnap | null = null;
  /** 框架聚焦状态：保存聚焦前视口，再次聚焦/退出时恢复（会话级，不序列化） */
  private focus: {
    id: string;
    view: { x: number; y: number; sx: number; sy: number };
  } | null = null;

  constructor(private readonly deps: FrameDeps) {}

  /** 清空缩放手势快照（DragEvent.END / ZoomEvent.END / 载入场景时调用） */
  resetScaleSnap() {
    this.scaleSnap = null;
  }

  // ================= 归属注册表 =================

  /** 读元素的内容归属框架 id（__frameId 实例标记，与序列化字段 frameId 对应） */
  idOf(el: UI): string | undefined {
    return (el as unknown as { __frameId?: string }).__frameId;
  }

  /** 写元素的内容归属框架 id（undefined = 自由元素） */
  setId(el: UI, fid: string | undefined) {
    (el as unknown as { __frameId?: string }).__frameId = fid;
  }

  /** 按稳定 id 找框架元素 */
  byId(id: string): UI | null {
    for (const el of this.deps.frameList()) {
      if (isFrameEl(el) && this.deps.aiIdOf(el) === id) {
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
  containing(el: UI): UI | null {
    const eb = el.worldBoxBounds;
    if (!eb) {
      return null;
    }
    const sw = typeof el.strokeWidth === "number" ? el.strokeWidth : 0;
    const tol = sw / 2 + 1;
    // 拖动中每帧调用（归属同步）：只在框架子集上判定，避免全树扫描
    for (const frame of this.deps.frameList()) {
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
  adopt(el: UI) {
    if (isFrameEl(el) || this.idOf(el)) {
      return;
    }
    const frame = this.containing(el);
    if (frame) {
      this.setId(el, this.deps.aiIdOf(frame));
    }
  }

  /** 新元素接入框体系：完全落入框架即归属；落在约束框架内即夹紧入框 */
  adoptAndClamp(el: UI) {
    this.adopt(el);
    this.clampMembers([el]);
  }

  /**
   * 内容元素坐标换算（相对 → 世界）：运行时元素始终以世界坐标渲染（兄弟元素），
   * 加载/粘贴带 frameId 的数据时按框架位置/旋转还原；框架不存在则解除归属。
   */
  toWorld(el: UI) {
    const fid = this.idOf(el);
    if (!fid) {
      return;
    }
    const frame = this.byId(fid);
    if (!frame) {
      this.setId(el, undefined);
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
        (p): p is { x: number; y: number } => typeof p === "object" && p !== null,
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
  resolveContents(worldCoords?: boolean) {
    for (const el of this.deps.app.tree.children as UI[]) {
      if (this.idOf(el)) {
        if (!worldCoords) {
          this.toWorld(el);
        }
      } else if (!isFrameEl(el)) {
        this.adopt(el);
      }
    }
  }

  // ================= 内容跟随（移动 / 旋转 / 幂等快照缩放） =================

  /**
   * frame 框架移动：归属于该框架的内容元素（frameId 显式归属）跟随位移。
   * 与组联动的语义差异：仅框架驱动框内内容（反向不成立，内容移动不带动框架）；
   * 其他框架与锁定元素不跟随（嵌套框架由各层自行驱动其内容）；
   * 内容 Text 是 Box 真子级，随父级自动移动。
   */
  moveContents(frame: UI, dx: number, dy: number) {
    const fid = this.deps.aiIdOf(frame);
    for (const el of this.deps.treeChildren()) {
      if (el === frame || el.locked || isFrameEl(el)) {
        continue;
      }
      if (this.idOf(el) !== fid) {
        continue;
      }
      el.moveWorld(dx, dy);
      this.deps.normalizeContract(el);
    }
  }

  /**
   * 框架旋转：归属于该框架的内容元素绕旋转中心同步旋转（位置绕 worldOrigin
   * 转 rotation 度；x/y 元素叠加自身角度，契约元素逐点旋转并入 points/path）。
   * 坐标基准：元素 x/y、points 为 tree 局部坐标，worldOrigin 为世界坐标，
   * 画布缩放/平移后两者不一致，逐点经 getWorldPoint/getLocalPoint 换算。
   */
  rotateContents(frame: UI, worldOrigin: { x: number; y: number }, rotation: number) {
    const fid = this.deps.aiIdOf(frame);
    if (!rotation) {
      return;
    }
    for (const el of this.deps.treeChildren()) {
      if (el === frame || el.locked || isFrameEl(el)) {
        continue;
      }
      if (this.idOf(el) !== fid) {
        continue;
      }
      if (this.deps.selectedList().includes(el)) {
        continue;
      }
      this.deps.normalizeContract(el);
      // rotPoint：inner → 世界绕旋转中心转 → 父级局部 → 转回 inner（契约元素
      // points/path 为 inner 坐标；元素自身带 rotation 时 inner≠local，必须
      // 两步换算）；anchorPoint：锚点（inner 原点）世界位置旋转后转回父级
      // 局部即新 x/y——x/y 元素的 x/y 就是父级局部锚点，不能用
      // getInnerPointByLocal（那会把锚点换算成 inner 值写回 x/y，产生偏移）
      const rotPoint = (p: { x: number; y: number }) =>
        el.getInnerPointByLocal(
          el.getLocalPoint(rotatePoint(el.getWorldPoint(p), rotation, worldOrigin)),
        );
      const anchorPoint = () =>
        el.getLocalPoint(rotatePoint(el.getWorldPoint({ x: 0, y: 0 }), rotation, worldOrigin));
      if (el instanceof Line) {
        const pts = (el.points ?? []).filter(
          (p): p is { x: number; y: number } => typeof p === "object" && p !== null,
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
  scaleContents(frame: UI, worldOrigin: { x: number; y: number }, scaleX: number, scaleY: number) {
    if (scaleX === 1 && scaleY === 1) {
      return;
    }
    const fid = this.deps.aiIdOf(frame);
    // 手势快照：一次缩放拖动会高频触发 SCALE（事件比例是相对当前状态的增量），
    // 若每次都就地增量缩放内容，每步都经过 transformPath 的两位小数舍入，误差沿
    // T 命令链累积放大（freehand 轮廓直线段被舍成波浪，多次缩放后肉眼可见）。
    // 改为手势第一次触发时快照内容原始状态，之后每次都用“快照 × 累计比例”幂等
    // 重算：舍入只发生一次、误差不跨步累积，多次缩放后轮廓仍保持笔直。
    if (!this.scaleSnap || this.scaleSnap.frameId !== fid) {
      this.scaleSnap = {
        frameId: fid,
        kx: 1,
        ky: 1,
        items: this.snapshotContents(frame, fid),
      };
    }
    const snap = this.scaleSnap;
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
          el.getInnerPointByLocal(el.getLocalPoint({ x: tx(w.x), y: ty(w.y) })),
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
        t.__freehandPoints = item.penPoints!.map((pt) => [pt[0] * kx, pt[1] * ky, ...pt.slice(2)]);
      } else if (item.kind === "path") {
        // 普通 path 绝对坐标：快照已是世界坐标，绕缩放中心映射后转回 inner
        el.path = transformPath(item.path as string, (p) =>
          el.getInnerPointByLocal(el.getLocalPoint({ x: tx(p.x), y: ty(p.y) })),
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
  private snapshotContents(frame: UI, fid: string): FrameContentSnap[] {
    const items: FrameContentSnap[] = [];
    for (const el of this.deps.treeChildren()) {
      if (el === frame || el.locked || isFrameEl(el)) {
        continue;
      }
      // 归属于该框架的内容才跟随（frameId 显式匹配，不再靠 bbox 猜测）
      if (this.idOf(el) !== fid) {
        continue;
      }
      // 多选缩放时选中的兄弟元素已由编辑器变换，跳过避免双重变换
      if (this.deps.selectedList().includes(el)) {
        continue;
      }
      // 契约元素（line/arrow/path）位移并入 points/path，避免双重偏移
      this.deps.normalizeContract(el);
      const t = el as unknown as { __freehandPoints?: number[][] };
      if (el instanceof Line) {
        // 画布内 line 的 points 均为对象数组（扁平 number[] 仅存在于类型定义中）
        const pts = (el.points ?? []).filter(
          (p): p is { x: number; y: number } => typeof p === "object" && p !== null,
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
            path: transformPath(el.path as string, (p) => el.getWorldPoint(p)),
          });
        }
      } else if (el instanceof Text) {
        items.push({
          el,
          kind: "text",
          worldAnchor: el.getWorldPoint({ x: 0, y: 0 }),
          fontSize: el.fontSize ?? this.deps.defaultFontSize(),
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

  // ================= 互转 / 折叠 / 聚焦 / 约束 =================

  /** 选中单个未锁定 rect → 转为框架（虚线描边 + 容器标记），返回是否成功 */
  toFrame(): boolean {
    const list = this.deps.selectedList().filter((el) => !el.locked);
    if (list.length !== 1 || !(list[0] instanceof Rect) || isFrameEl(list[0])) {
      return false;
    }
    const el = list[0];
    const meta = el as unknown as Record<string, unknown>;
    meta.__isFrame = true;
    (el as unknown as { dashPattern?: number[] }).dashPattern = [8, 5];
    // 框架一律带填充：内部可命中走增量拖动管线，也强化容器视觉。
    // 旧矩形无填充时补默认色
    if (el.fill === undefined || el.fill === "none") {
      el.fill = FRAME_DEFAULT_FILL;
    }
    // 抓边=移动（见 dataToElementInner 的说明）；转换后的矩形同样生效
    (el as unknown as { editConfig?: { resizeable?: boolean; rotateable?: boolean } }).editConfig =
      { resizeable: false, rotateable: false };
    // 转换前已画在框内的元素补挂归属（此前只有绘制/导入时才会自动归属）
    const fid = this.deps.aiIdOf(el);
    for (const other of this.deps.app.tree.children as UI[]) {
      if (other === el || isFrameEl(other) || this.idOf(other)) {
        continue;
      }
      if (this.containing(other) === el) {
        this.setId(other, fid);
      }
    }
    this.deps.commitHistory();
    this.deps.onMutated();
    return true;
  }

  /** 选中单个未锁定 frame → 转为普通矩形（内容子元素一并移除），返回是否成功 */
  toRect(): boolean {
    const list = this.deps.selectedList().filter((el) => !el.locked);
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
    const fid = this.deps.aiIdOf(el);
    for (const other of this.deps.app.tree.children as UI[]) {
      if (this.idOf(other) === fid) {
        this.setId(other, undefined);
      }
    }
    el.destroy();
    if (parent && index >= 0) {
      parent.add(rect, index);
    }
    this.deps.editorTarget(rect);
    this.deps.commitHistory();
    this.deps.onMutated();
    return true;
  }

  /** 选中单个未锁定 frame：翻转内容约束开关（开启后框内绘制/拖动夹紧），返回是否成功 */
  toggleConstrain(): boolean {
    const list = this.deps.selectedList().filter((el) => !el.locked);
    if (list.length !== 1 || !isFrameEl(list[0])) {
      return false;
    }
    const meta = list[0] as unknown as Record<string, unknown>;
    meta.__frameConstrain = meta.__frameConstrain !== true;
    // 约束状态可视化：实线描边 = 约束开启，虚线 = 普通框
    this.applyConstrainVisual(list[0]);
    this.deps.commitHistory();
    this.deps.onMutated();
    return true;
  }

  /**
   * 选中元素框架操作资格（右键菜单用）：单选未锁定 rect/frame 时给出转换资格，
   * frame 额外给出内容约束/折叠开关状态与聚焦状态。
   */
  actionState(): {
    canToFrame: boolean;
    canToRect: boolean;
    constrainOn: boolean;
    canCollapse: boolean;
    collapsedOn: boolean;
    canFocus: boolean;
    focusOn: boolean;
  } {
    const list = this.deps.selectedList().filter((el) => !el.locked);
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
        focusOn = this.focus?.id === this.deps.aiIdOf(el);
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
   * actionState），此处按当前状态反转。返回是否成功。
   */
  toggleCollapsed(): boolean {
    const list = this.deps.selectedList().filter((el) => !el.locked);
    if (list.length !== 1 || !isFrameEl(list[0])) {
      return false;
    }
    const el = list[0] as Box;
    const meta = el as unknown as Record<string, unknown>;
    const content = typeof meta.__frameContent === "string" ? meta.__frameContent : "";
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
    this.deps.commitHistory();
    this.deps.onMutated();
    return true;
  }

  /**
   * 折叠框架内容滚动：滚轮向下（deltaY > 0）内容上移查看后文。
   * leafer 的 scrollY 正值让子级向下平移，因此用负值区间
   * [-max, 0] 表示内容向上滚动（0 = 顶部，-max = 底部），
   * 渲染管线按 overflow: "scroll" 平移子级并在框内裁剪。
   */
  scrollContent(el: Box, deltaY: number) {
    const meta = el as unknown as Record<string, unknown>;
    const content = typeof meta.__frameContent === "string" ? meta.__frameContent : "";
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
  scrollableAt(p: { x: number; y: number }): Box | null {
    for (const el of this.deps.frameList()) {
      if (!isFrameEl(el)) {
        continue;
      }
      const meta = el as unknown as Record<string, unknown>;
      if (meta.__frameCollapsed !== true) {
        continue;
      }
      const b = el.worldBoxBounds;
      if (b && p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height) {
        return el as Box;
      }
    }
    return null;
  }

  /**
   * 聚焦框架：视口缩放/平移到框架充满视口（留边距），保存聚焦前视口供退出恢复；
   * 折叠/展开状态均适用。已在聚焦且传入同一框架时退出恢复。
   */
  toggleFocus(): boolean {
    const list = this.deps.selectedList().filter((el) => !el.locked);
    if (list.length !== 1 || !isFrameEl(list[0])) {
      return false;
    }
    const el = list[0];
    const id = this.deps.aiIdOf(el);
    const layer = this.deps.app.tree.zoomLayer;
    if (!layer) {
      return false;
    }
    if (this.focus?.id === id) {
      // 退出聚焦：恢复聚焦前视口
      const v = this.focus.view;
      layer.x = v.x;
      layer.y = v.y;
      layer.scaleX = v.sx;
      layer.scaleY = v.sy;
      this.focus = null;
      this.deps.updateGrid();
      return true;
    }
    const b = el.worldBoxBounds;
    if (!b) {
      return false;
    }
    const view = this.deps.app.canvas.view as HTMLElement;
    const vw = this.deps.app.width ?? view.clientWidth;
    const vh = this.deps.app.height ?? view.clientHeight;
    // 目标缩放：框架占视口 85%（留边距），限制在画布缩放范围内
    const target = Math.min(
      this.deps.zoomRange.max,
      Math.max(this.deps.zoomRange.min, Math.min(vw / b.width, vh / b.height) * 0.85),
    );
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    this.focus = {
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
    this.deps.updateGrid();
    return true;
  }

  /**
   * 创建内容型框架（导入 MD/代码/文本用）：autoSize 按内容撑尺寸，
   * 新框架立即选中，返回是否成功。
   */
  createContent(
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
    const style = this.deps.getStyle();
    const el = this.deps.dataToElement({
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
    this.deps.addToTree(el);
    this.deps.editorTarget(el);
    this.deps.commitHistory();
    this.deps.onMutated();
    return true;
  }

  // ---------- 约束夹紧 ----------

  /** 点钳制到约束框架内：出框坐标压回框架边界（画笔逐点夹紧用） */
  clampPoint(px: number, py: number): { x: number; y: number } {
    const frame = this.deps.drawingFrame();
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
  constrainAt(x: number, y: number): UI | null {
    for (const el of this.deps.frameList()) {
      if (!isFrameEl(el) || (el as unknown as Record<string, unknown>).__frameConstrain !== true) {
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
  constrainOf(el: UI | IUI): { minX: number; minY: number; maxX: number; maxY: number } | null {
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
    // 拖动中每帧调用（beforeMove 夹紧）：只在框架子集上判定
    for (const other of this.deps.frameList()) {
      if (other === el || !isFrameEl(other)) {
        continue;
      }
      if ((other as unknown as Record<string, unknown>).__frameConstrain !== true) {
        continue;
      }
      const fb = other.worldBoxBounds;
      if (!fb) {
        continue;
      }
      const ix = Math.min(eb.x + eb.width, fb.x + fb.width) - Math.max(eb.x, fb.x);
      const iy = Math.min(eb.y + eb.height, fb.y + fb.height) - Math.max(eb.y, fb.y);
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
  clampMembers(list?: UI[]) {
    const movers = list ?? this.deps.editorList();
    for (const el of movers) {
      if (!el || isFrameEl(el) || el.locked) {
        continue;
      }
      const fb = this.constrainOf(el);
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

  /** 约束状态可视化：开启约束的框架描边转实线（虚线 = 普通框），一眼区分 */
  applyConstrainVisual(el: UI) {
    const on = (el as unknown as Record<string, unknown>).__frameConstrain === true;
    (el as unknown as { dashPattern?: number[] }).dashPattern = on ? undefined : [8, 5];
  }

  /**
   * 生成器结果整体平移夹紧到约束框架内（联合 bbox 完全包含；
   * 元素大于框架时仅最小越界修正，保证绘制起点不丢）。
   */
  clampListToFrame(list: ElementData[], frame: UI): ElementData[] {
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
}
