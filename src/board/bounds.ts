// 元素世界坐标包围盒工具：画布感知（ai/tools.ts）与排列对齐（arrange.ts）共用。
// 几何口径与 svg.ts 内容包围盒一致：含 rotation 四角；line/arrow 取 points 绝对坐标端点。

import type { ElementData } from "../types";
import { localToCanvas } from "./coords";

/** 世界坐标轴对齐包围盒（与元素 x/y 同基准；get_canvas 的 bounds/viewport 过滤用） */
export type AABB = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/**
 * 元素的世界坐标 AABB（含 rotation 四角；line/arrow 取 points 绝对坐标端点）。
 * 区域过滤与网格索引共用；与 svg.ts 内容包围盒的几何口径一致。
 */
export function elementBounds(e: ElementData): AABB {
  if ((e.type === "line" || e.type === "arrow") && e.points?.length) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of e.points) {
      const a = localToCanvas(e, p);
      minX = Math.min(minX, a.x);
      minY = Math.min(minY, a.y);
      maxX = Math.max(maxX, a.x);
      maxY = Math.max(maxY, a.y);
    }
    return { minX, minY, maxX, maxY };
  }
  const w = e.width ?? 0;
  const h = e.height ?? 0;
  const cx = w / 2;
  const cy = h / 2;
  const rad = ((e.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [lx, ly] of [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ] as const) {
    const dx = lx - cx;
    const dy = ly - cy;
    const px = e.x + dx * cos - dy * sin + cx;
    const py = e.y + dx * sin + dy * cos + cy;
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  return { minX, minY, maxX, maxY };
}

/** 多个元素的 AABB 并集（空列表返回全零；对齐/分布的基准） */
export function unionBounds(els: ElementData[]): AABB {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of els) {
    const b = elementBounds(el);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  if (!els.length) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  return { minX, minY, maxX, maxY };
}
