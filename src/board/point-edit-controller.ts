import type { Line } from "leafer-ui";
import type { App, UI } from "leafer-ui";
import { Rect } from "leafer-ui";
import { distToSegment, nearestBorderPoint } from "./geometry";
import { pointsOf } from "./element-utils";

/**
 * 线性元素点编辑控制器：从 Board 拆出的独立交互模块。
 * 双击 line/arrow 进入——sky 层点手柄拖动改形、双击线段加点、Shift 锁 45° 角、
 * 端点靠近形状吸附绑定（__bindStart/__bindEnd，被绑元素移动时端点跟随）。
 */

// 点手柄尺寸（sky 层，不随缩放变化）
const POINT_HANDLE_SIZE = 10;
// 端点吸附绑定的屏幕距离阈值（px），按画布缩放换算世界距离保证手感恒定
const SNAP_BIND_PX = 10;

export type PointEditDeps = {
  /** leafer App（手柄画在 sky 层；读 zoomLayer 缩放换算吸附距离） */
  app: App;
  /** 进入点编辑前取消编辑器选择 */
  editorCancel: () => void;
  /** 进入点编辑前取消图片裁剪 */
  cancelCrop: () => void;
  /** 元素稳定 id（吸附绑定时写入被绑元素引用） */
  aiIdOf: (el: UI) => string | undefined;
  /** 退出点编辑时的约束兜底：把元素 bbox 拉回约束框架 */
  clampConstrained: (el: Line) => void;
  /** 正交折线路由重建（route 线端点拖动后 L 形重排） */
  rebuildRoute: (el: Line) => void;
  /** 变更入历史（加点等一次性操作） */
  scheduleHistory: () => void;
};

export class PointEditController {
  /** 当前编辑中的线性元素（null = 未在点编辑） */
  private current: Line | null = null;
  private handles: Rect[] = [];
  /** 拖动中的手柄下标（null = 未拖动） */
  private dragging: number | null = null;
  /** 拖动开始时两端是否原带绑定（松手即解绑） */
  private unbindStart = false;
  private unbindEnd = false;

  constructor(private readonly deps: PointEditDeps) {}

  /** 是否处于点编辑状态 */
  get editing(): boolean {
    return this.current !== null;
  }

  /** 当前编辑中的元素（供调用方做相等比较） */
  get activeEl(): Line | null {
    return this.current;
  }

  /** 拖动中的手柄下标 */
  get draggingIndex(): number | null {
    return this.dragging;
  }

  /**
   * 进入点编辑：锁定元素不可进入。已编辑其他元素时先退出当前。
   */
  enter(el: Line): boolean {
    if (el.locked) {
      return false;
    }
    if (this.current === el) {
      return true;
    }
    this.exit();
    this.deps.cancelCrop();
    this.deps.editorCancel();
    this.current = el;
    this.buildHandles();
    return true;
  }

  /** 退出点编辑：清除手柄与拖动状态（ESC/点击空白/切换工具时调用）；收尾约束兜底 */
  exit() {
    if (this.current) {
      // 点编辑可能把端点拖出约束框架：以整元素 bbox 兜底拉回
      this.deps.clampConstrained(this.current);
    }
    this.dragging = null;
    this.unbindStart = false;
    this.unbindEnd = false;
    this.current = null;
    this.clearHandles();
  }

  /** 按当前 points 重建点手柄（sky 层，元素局部坐标 → 世界坐标摆放；缩放/平移后调用） */
  buildHandles() {
    this.clearHandles();
    const el = this.current;
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
      this.handles.push(h);
      this.deps.app.sky.add(h);
    }
  }

  /** 命中的手柄索引（app 坐标），未命中返回 -1 */
  hitHandle(ax: number, ay: number): number {
    for (let i = 0; i < this.handles.length; i++) {
      const b = this.handles[i].worldBoxBounds;
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

  /**
   * 开始拖动手柄：记录下标与「原带绑定」标记——拖走后松手即解除该端绑定。
   * 处于拖动中重复调用安全。
   */
  beginDrag(idx: number) {
    if (idx < 0) {
      return;
    }
    this.dragging = idx;
    const el = this.current;
    if (el) {
      const t = el as unknown as { __bindStart?: string; __bindEnd?: string };
      const pts = pointsOf(el);
      this.unbindStart = idx === 0 && !!t.__bindStart;
      this.unbindEnd = idx === pts.length - 1 && !!t.__bindEnd;
    }
  }

  /**
   * 拖动中的点跟随指针（世界坐标 → 元素局部，Shift 锁 45° 角；端点吸附绑定）。
   * 调用方负责每帧节流后的历史调度。
   */
  moveDragging(appX: number, appY: number, shiftKey: boolean | undefined) {
    const el = this.current;
    const idx = this.dragging;
    if (!el || idx === null) {
      return;
    }
    const pts = [...pointsOf(el)];
    if (idx < 0 || idx >= pts.length) {
      return;
    }
    let p = el.getLocalPoint({ x: appX, y: appY });
    if (shiftKey) {
      // 45° 锁角：以相邻点为基准（首点取后一点，其余取前一点）
      const ref = pts[idx > 0 ? idx - 1 : Math.min(1, pts.length - 1)];
      const angle =
        Math.round(Math.atan2(p.y - ref.y, p.x - ref.x) / (Math.PI / 4)) * (Math.PI / 4);
      const dist = Math.hypot(p.x - ref.x, p.y - ref.y);
      p = { x: ref.x + dist * Math.cos(angle), y: ref.y + dist * Math.sin(angle) };
    }
    // 端点靠近形状包围盒边框时吸附并绑定
    const snapped = this.snapEndpoint(pts, idx, p);
    if (snapped) {
      p = snapped;
    }
    pts[idx] = p;
    el.points = pts;
    // 正交折线：端点拖动实时重建 L 形中间路径（中点被拖动时同样按新几何重排）
    if ((el as unknown as { __isRoute?: boolean }).__isRoute === true) {
      this.deps.rebuildRoute(el);
    }
    this.buildHandles();
  }

  /**
   * 结束拖动：拖动过且端原带绑定则解除该端绑定。返回本次抬起是否为拖动结束，
   * 调用方据此短路后续流程。
   */
  finishDrag(): boolean {
    if (this.dragging === null) {
      return false;
    }
    this.dragging = null;
    if ((this.unbindStart || this.unbindEnd) && this.current) {
      const t = this.current as unknown as {
        __bindStart?: string;
        __bindEnd?: string;
      };
      if (this.unbindStart) {
        delete t.__bindStart;
      }
      if (this.unbindEnd) {
        delete t.__bindEnd;
      }
    }
    this.unbindStart = false;
    this.unbindEnd = false;
    return true;
  }

  /** 双击线段插入新点（app 坐标，命中线段容差 10 局部单位） */
  addPointAt(ax: number, ay: number) {
    const el = this.current;
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
    this.buildHandles();
    this.deps.scheduleHistory();
  }

  private clearHandles() {
    for (const h of this.handles) {
      h.remove();
    }
    this.handles = [];
  }

  /**
   * 端点吸附绑定：拖动端点靠近形状包围盒边框时吸附到最近点并记录绑定 id
   * （被绑元素移动时端点自动跟随）。返回吸附后的局部坐标；未吸附返回 null。
   */
  private snapEndpoint(
    pts: { x: number; y: number }[],
    idx: number,
    local: { x: number; y: number },
  ): { x: number; y: number } | null {
    const el = this.current;
    if (!el) {
      return null;
    }
    // 屏幕距离换算世界距离（缩放后吸附手感恒定）
    const snap = SNAP_BIND_PX / Math.max(this.deps.app.tree.zoomLayer?.scaleX ?? 1, 0.01);
    const world = el.getWorldPoint(local);
    let best: UI | null = null;
    let bestD = snap;
    for (const other of this.deps.app.tree.children as UI[]) {
      if (other === el || (other as unknown as { skipJSON?: boolean }).skipJSON || other.locked) {
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
      t.__bindStart = this.deps.aiIdOf(best);
    } else if (idx === pts.length - 1) {
      t.__bindEnd = this.deps.aiIdOf(best);
    }
    return el.getLocalPoint(anchor);
  }
}
