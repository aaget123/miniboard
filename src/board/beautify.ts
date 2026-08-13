import type { ElementData } from "../types";

/**
 * 本地整理引擎：纯数据变换（不动 leafer），当前只做一件事——
 * 把画笔手绘的弯弯扭扭路径拉直（近似直线 → 一条直线，折线/图形 → 直边折线）。
 * 不做颜色、尺寸、位置等任何“乱改”。
 */

export type BeautifyStats = { label: string; count: number }[];

/** 简化容差：手抖幅度小于该值（px）的弯曲都会被拉直 */
const TOLERANCE = 5;

/** 首尾距离小于该值（px）视为闭合路径（手绘圈/多边形），按环简化 */
const CLOSE_DIST = 12;

/** 解析画笔路径（M + 中点二次贝塞尔 Q + L），提取手绘采样点序列 */
function parsePenPath(path: string): number[][] {
  const pts: number[][] = [];
  const re = /([MLQ])\s+(-?[\d.]+)\s+(-?[\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    // Q 段第一对坐标是控制点，即原始手绘采样点；Q 的终点是中点，跳过
    pts.push([parseFloat(m[2]), parseFloat(m[3])]);
  }
  return pts;
}

/** 点到线段距离 */
function distToSegment(p: number[], a: number[], b: number[]): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  let t = len2 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t));
}

/** Douglas-Peucker 折线简化：去除容差内的抖动点 */
function simplify(pts: number[][], tolerance: number): number[][] {
  if (pts.length <= 2) {
    return pts;
  }
  const a = pts[0];
  const b = pts[pts.length - 1];
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment(pts[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > tolerance) {
    const left = simplify(pts.slice(0, idx + 1), tolerance);
    const right = simplify(pts.slice(idx), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

/** 闭合环简化：取环上最远两点（直径）切成两条链分别简化后合并 */
function simplifyRing(pts: number[][], tolerance: number): number[][] {
  const n = pts.length;
  let maxD = -1;
  let i0 = 0;
  let i1 = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      if (d > maxD) {
        maxD = d;
        i0 = i;
        i1 = j;
      }
    }
  }
  const chain1: number[][] = [];
  const chain2: number[][] = [];
  for (let k = i0; ; k = (k + 1) % n) {
    chain1.push(pts[k]);
    if (k === i1) {
      break;
    }
  }
  for (let k = i1; ; k = (k + 1) % n) {
    chain2.push(pts[k]);
    if (k === i0) {
      break;
    }
  }
  const s1 = simplify(chain1, tolerance);
  const s2 = simplify(chain2, tolerance);
  return s1.slice(0, -1).concat(s2.slice(0, -1));
}

/** 点列重建折线 path，closed 时末尾闭合 */
function pathOf(pts: number[][], closed = false): string {
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i][0]} ${pts[i][1]}`;
  }
  return closed ? d + " Z" : d;
}

/** 画笔规整：弯弯扭扭的笔迹拉直为直线段 */
function straightenPenPaths(
  els: ElementData[],
  stats: BeautifyStats,
): ElementData[] {
  let count = 0;
  for (const e of els) {
    if (e.type !== "path" || !e.path) {
      continue;
    }
    const pts = parsePenPath(e.path);
    if (pts.length < 3) {
      continue;
    }
    const first = pts[0];
    const last = pts[pts.length - 1];
    // 手绘圈/多边形首尾通常不闭合，但距离很近 → 按闭合环简化
    const closed =
      pts.length > 4 &&
      Math.hypot(last[0] - first[0], last[1] - first[1]) < CLOSE_DIST;
    const kept = closed ? simplifyRing(pts, TOLERANCE) : simplify(pts, TOLERANCE);
    if (kept.length < 2 || kept.length === pts.length) {
      continue; // 已经足够直，保留原样
    }
    e.path = pathOf(kept, closed);
    count++;
  }
  if (count) {
    stats.push({ label: "画笔拉直", count });
  }
  return els;
}

export function beautifyScene(elements: ElementData[]): {
  elements: ElementData[];
  stats: BeautifyStats;
} {
  const els = elements.map((e) => ({
    ...e,
    points: e.points?.map((p) => ({ ...p })),
    rotation: e.rotation,
  }));
  const stats: BeautifyStats = [];
  straightenPenPaths(els, stats);
  return { elements: els, stats: stats.filter((s) => s.count > 0) };
}
