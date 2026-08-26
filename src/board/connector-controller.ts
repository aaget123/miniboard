import { Line, Rect } from "leafer-ui";
import type { App, UI } from "leafer-ui";

/**
 * 连接器控制器：从 Board 拆出的独立交互模块（crop-controller 同款 deps 注入模板）。
 * 选中单个可连接节点时，在其包围盒四边中点外侧显示锚点圆点；从锚点拖出画
 * 临时连线，落到目标节点上松手即创建绑定箭头（route 正交路由 + bindStart/
 * bindEnd），落到空白处创建普通直线延伸的箭头。
 */

const ANCHOR_OUTSET = 14;
const ANCHOR_SIZE = 9;
const CONNECTOR_STROKE = "#4f8cff";

export type Side = "n" | "e" | "s" | "w";

export type ConnectorDeps = {
  /** leafer App（锚点与临时连线画在 sky 层） */
  app: App;
  /** 锚点是否允许显示（select 工具、无内联编辑、无裁剪/点编辑激活） */
  allowed: () => boolean;
  /** 当前选中元素列表 */
  selectedList: () => UI[];
  /** 元素是否可作为连线端点（形状/文本/框架/图片，排除线类与笔迹） */
  isConnectable: (el: UI) => boolean;
  /** app 坐标命中测试（排除指定元素），返回顶层命中元素 */
  findTargetAt: (ax: number, ay: number, exclude: UI) => UI | null;
  /** 元素稳定 id */
  aiIdOf: (el: UI) => string;
  /** 创建箭头：targetId 为空表示落到空白（普通箭头），否则建 route 绑定连线 */
  createArrow: (
    sourceId: string,
    targetId: string | null,
    endWorld: { x: number; y: number },
    prefer: "h" | "v",
  ) => boolean;
};

type Pt = { x: number; y: number };

export class ConnectorController {
  private source: UI | null = null;
  private anchors: Rect[] = [];
  private draft: Line | null = null;
  private activeSide: Side | null = null;
  private lastKey = "";

  constructor(private readonly deps: ConnectorDeps) {}

  /** 是否正在从锚点拖出连线 */
  get dragging(): boolean {
    return this.draft !== null;
  }

  /**
   * 按当前选中状态显示 / 隐藏边缘锚点（选中变化、工具切换、缩放平移后调用）。
   * 状态未变化时跳过重建，可高频安全调用。
   */
  refresh() {
    const list = this.deps.allowed() ? this.deps.selectedList() : [];
    const el = list.length === 1 && this.deps.isConnectable(list[0]) ? list[0] : null;
    if (!el) {
      this.cancel();
      return;
    }
    const b = el.worldBoxBounds;
    if (!b) {
      this.cancel();
      return;
    }
    const key = `${this.deps.aiIdOf(el)}:${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`;
    if (key === this.lastKey && this.anchors.length) {
      this.source = el;
      return;
    }
    this.cancel();
    this.source = el;
    this.lastKey = key;
    const pos: Record<Side, Pt> = anchorPositions(b);
    for (const side of ["n", "e", "s", "w"] as Side[]) {
      const p = pos[side];
      const dot = new Rect({
        x: p.x - ANCHOR_SIZE / 2,
        y: p.y - ANCHOR_SIZE / 2,
        width: ANCHOR_SIZE,
        height: ANCHOR_SIZE,
        fill: "#ffffff",
        stroke: CONNECTOR_STROKE,
        strokeWidth: 1.2,
      });
      (dot as unknown as Record<string, unknown>).__side = side;
      this.anchors.push(dot);
      this.deps.app.sky.add(dot);
    }
  }

  /** 隐藏锚点并取消未完成的拖出（任何非锚点按下时调用） */
  cancel() {
    for (const a of this.anchors) {
      a.remove();
    }
    this.anchors = [];
    this.source = null;
    this.lastKey = "";
    if (this.draft) {
      this.draft.remove();
      this.draft = null;
      this.activeSide = null;
    }
  }

  /** 命中锚点圆点（app 坐标，容差 3px）；命中返回所在边 */
  hitAnchor(ax: number, ay: number): Side | null {
    for (const a of this.anchors) {
      const b = a.worldBoxBounds;
      if (
        b &&
        ax >= b.x - 3 &&
        ax <= b.x + b.width + 3 &&
        ay >= b.y - 3 &&
        ay <= b.y + b.height + 3
      ) {
        return (a as unknown as { __side?: Side }).__side ?? null;
      }
    }
    return null;
  }

  /** 从指定边锚点开始拖出：创建 sky 层临时连线 */
  beginDrag(side: Side): boolean {
    const src = this.source;
    const b = src?.worldBoxBounds;
    if (!src || !b) {
      return false;
    }
    this.activeSide = side;
    const start = anchorPositions(b)[side];
    this.draft = new Line({
      points: [{ ...start }, { ...start }],
      stroke: CONNECTOR_STROKE,
      strokeWidth: 1.5,
      dashPattern: [4, 4],
    });
    this.deps.app.sky.add(this.draft);
    return true;
  }

  /** 拖出中：临时连线终点跟随指针（app 坐标） */
  updateDrag(ax: number, ay: number) {
    if (!this.draft) {
      return;
    }
    const pts = this.draft.points as Pt[];
    pts[pts.length - 1] = { x: ax, y: ay };
    this.draft.points = [...pts];
  }

  /**
   * 松手：命中目标元素 → 创建 route 绑定箭头；落在空白 → 创建普通箭头。
   * 返回是否处理了本次抬起（处于拖出状态）。
   */
  finishDrag(ax: number, ay: number): boolean {
    if (!this.draft || !this.source) {
      return false;
    }
    const src = this.source;
    const side = this.activeSide ?? "e";
    this.cancel();
    const target = this.deps.findTargetAt(ax, ay, src);
    this.deps.createArrow(
      this.deps.aiIdOf(src),
      target ? this.deps.aiIdOf(target) : null,
      { x: ax, y: ay },
      side === "e" || side === "w" ? "h" : "v",
    );
    this.refresh();
    return true;
  }
}

/** 四边中点锚点位置（世界坐标，向外偏移避开编辑框边线手柄） */
function anchorPositions(b: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Record<Side, Pt> {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return {
    n: { x: cx, y: b.y - ANCHOR_OUTSET },
    e: { x: b.x + b.width + ANCHOR_OUTSET, y: cy },
    s: { x: cx, y: b.y + b.height + ANCHOR_OUTSET },
    w: { x: b.x - ANCHOR_OUTSET, y: cy },
  };
}
