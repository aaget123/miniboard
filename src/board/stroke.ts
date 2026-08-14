import { getStroke } from "perfect-freehand";
import type { StrokeOptions } from "perfect-freehand";

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
  return closed ? d + "Z" : d;
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
