import { getStroke } from "perfect-freehand";
import type { StrokeOptions } from "perfect-freehand";
import type { ArrowHead } from "../types";

/**
 * 压力敏感笔迹封装（perfect-freehand）：
 * 原始采样点 [x, y, pressure?] → 封闭轮廓 path（填充渲染，粗细随压力变化）。
 * 纯数据变换，不依赖 leafer。
 */

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 轮廓点列 → SVG path（中点二次贝塞尔 T 链平滑，官方推荐写法）。
 * 轮廓点 < 4 时返回 ""（无法成环，调用方按空处理）。
 */
function svgPathFromOutline(points: number[][], closed = true): string {
  const len = points.length;
  if (len < 4) {
    return "";
  }
  let a = points[0];
  let b = points[1];
  const c = points[2];
  let d = `M${r2(a[0])},${r2(a[1])} Q${r2(b[0])},${r2(b[1])} ${r2(
    (b[0] + c[0]) / 2,
  )},${r2((b[1] + c[1]) / 2)} T`;
  for (let i = 2, max = len - 1; i < max; i++) {
    a = points[i];
    b = points[i + 1];
    d += `${r2((a[0] + b[0]) / 2)},${r2((a[1] + b[1]) / 2)} `;
  }
  return closed ? `${d}Z` : d;
}

/** 将原始笔迹点列转为渲染轮廓 path；点太少返回空字符串 */
export function strokeOutlinePath(
  points: number[][],
  options: Partial<StrokeOptions> = {},
): string {
  if (!points.length) {
    return "";
  }
  const outline = getStroke(points, options);
  return svgPathFromOutline(outline);
}

/** 依据笔画粗细换算 perfect-freehand 的 size（直径）：视觉上接近原线宽的两倍，压力变化明显 */
export function penSizeOf(strokeWidth: number): number {
  return Math.max(4, Math.round(strokeWidth * 2));
}

// ================= 橡皮分段擦除 =================

/** 点 p 到线段 ab 的最短距离 */
function pointSegDist(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)) : 0;
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

/** 轨迹折线按 step 插值补密（保证快速拖动时擦除区间连续不漏段） */
function densifyTrail(trail: { x: number; y: number }[], step: number): { x: number; y: number }[] {
  if (trail.length < 2) {
    return trail;
  }
  const out = [trail[0]];
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1];
    const b = trail[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.floor(d / step);
    for (let j = 1; j <= n; j++) {
      out.push({
        x: a.x + ((b.x - a.x) * j) / (n + 1),
        y: a.y + ((b.y - a.y) * j) / (n + 1),
      });
    }
    out.push(b);
  }
  return out;
}

/**
 * 橡皮分段擦除：把笔迹采样点中与擦除轨迹（与 points 同一坐标空间）距离 <= radius
 * 的连续区间剔除，返回剩余连续段（每段保留 >= 2 点，孤点不成笔画直接丢弃）。
 * 轨迹自动插值补密，避免快速划过时中间漏擦。
 */
export function splitErasedPoints(
  points: number[][],
  trail: { x: number; y: number }[],
  radius: number,
): number[][][] {
  if (!points.length || !trail.length) {
    return points.length ? [points.map((p) => [...p])] : [];
  }
  const dense = densifyTrail(trail, 4);
  const erased = points.map((p) => {
    const pt = { x: p[0], y: p[1] };
    let min = Math.hypot(pt.x - dense[0].x, pt.y - dense[0].y);
    for (let i = 1; i < dense.length; i++) {
      min = Math.min(min, pointSegDist(pt, dense[i - 1], dense[i]));
    }
    return min <= radius;
  });
  const segs: number[][][] = [];
  let cur: number[][] = [];
  for (let i = 0; i < points.length; i++) {
    if (!erased[i]) {
      cur.push([...points[i]]);
    } else if (cur.length) {
      if (cur.length >= 2) {
        segs.push(cur);
      }
      cur = [];
    }
  }
  if (cur.length >= 2) {
    segs.push(cur);
  }
  return segs;
}

/**
 * 分段擦除的端点样式分配（纯函数）：首段继承起点箭头、末段继承终点箭头，
 * 中间段两端均无端点（单段时原样保留两端）。count 为分段数量。
 */
export function splitArrowHeads(
  count: number,
  startHead: ArrowHead | undefined,
  endHead: ArrowHead | undefined,
): { start: ArrowHead | undefined; end: ArrowHead | undefined }[] {
  if (count <= 0) {
    return [];
  }
  if (count === 1) {
    return [{ start: startHead, end: endHead }];
  }
  return Array.from({ length: count }, (_, i) => ({
    start: i === 0 ? startHead : undefined,
    end: i === count - 1 ? endHead : undefined,
  }));
}
