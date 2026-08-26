/**
 * 画布几何工具：命中测试 / 框选 / 套索用的纯几何函数。
 * 不依赖 leafer 实例（nearestBorderPoint 以结构化包围盒入参），可独立单测。
 */

/** 轴对齐矩形 */
export type Box = { x: number; y: number; width: number; height: number };

/** 点坐标 */
export type Pt = { x: number; y: number };

/** 带世界包围盒的元素最小结构（nearestBorderPoint 入参，避免依赖 leafer 类型） */
export type Bounded = {
  worldBoxBounds?: Box | null;
};

/** 两个轴对齐矩形是否相交 */
export function rectsIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** 点到线段的最短距离 */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 射线法判断点是否在多边形内（含边界） */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 目标元素包围盒边框上离给定世界点最近的点（世界坐标）。
 * 点在内部时取最近边上的投影（保证绑定端点始终落在边框上）。
 */
export function nearestBorderPoint(target: Bounded, world: Pt): Pt | null {
  const b = target.worldBoxBounds;
  if (!b) {
    return null;
  }
  if (world.x >= b.x && world.x <= b.x + b.width && world.y >= b.y && world.y <= b.y + b.height) {
    // 点在包围盒内部：取到四条边距离最小的边上的投影
    const dL = world.x - b.x;
    const dR = b.x + b.width - world.x;
    const dT = world.y - b.y;
    const dB = b.y + b.height - world.y;
    const m = Math.min(dL, dR, dT, dB);
    if (m === dL) {
      return { x: b.x, y: world.y };
    }
    if (m === dR) {
      return { x: b.x + b.width, y: world.y };
    }
    if (m === dT) {
      return { x: world.x, y: b.y };
    }
    return { x: world.x, y: b.y + b.height };
  }
  // 点在外部：clamp 到边框最近点
  return {
    x: Math.max(b.x, Math.min(world.x, b.x + b.width)),
    y: Math.max(b.y, Math.min(world.y, b.y + b.height)),
  };
}

/** 点是否在线段上（含端点，容差 0.5） */
export function pointOnSegment(p: Pt, a: Pt, b: Pt): boolean {
  const cross = (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
  if (Math.abs(cross) > 0.5) {
    return false;
  }
  return (
    Math.min(a.x, b.x) - 0.5 <= p.x &&
    p.x <= Math.max(a.x, b.x) + 0.5 &&
    Math.min(a.y, b.y) - 0.5 <= p.y &&
    p.y <= Math.max(a.y, b.y) + 0.5
  );
}

/** 两条线段是否相交（含共线/端点接触） */
export function segmentsIntersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
  if (Math.abs(d) < 1e-9) {
    // 平行或共线：任一端点落在另一线段上即相交
    return (
      pointOnSegment(a1, b1, b2) ||
      pointOnSegment(a2, b1, b2) ||
      pointOnSegment(b1, a1, a2) ||
      pointOnSegment(b2, a1, a2)
    );
  }
  const t = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d;
  const u = ((b1.x - a1.x) * (a2.y - a1.y) - (b1.y - a1.y) * (a2.x - a1.x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** 套索多边形与轴对齐矩形是否相交（顶点包含 + 边相交，覆盖包含/部分相交/包含于三种情形） */
export function polygonHitsBox(poly: Pt[], box: Box): boolean {
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
  // 矩形角点在套索内（套索完全包住矩形）
  for (const c of corners) {
    if (pointInPolygon(c, poly)) {
      return true;
    }
  }
  // 套索顶点在矩形内（矩形完全包住套索）
  for (const p of poly) {
    if (p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height) {
      return true;
    }
  }
  // 任一边与矩形任一边相交（部分相交）
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    for (let j = 0; j < 4; j++) {
      if (segmentsIntersect(p1, p2, corners[j], corners[(j + 1) % 4])) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 正交折线（L 形 / 直角路由）的中间路径点（不含首尾端点）：
 * - S/E 已共轴（某轴差 < 0.5）返回空，退化为直线；
 * - 单拐点 L 形——水平主导（|dx| ≥ |dy| 或 prefer="h"）拐点取 (e.x, s.y)
 *   （先横后纵），否则取 (s.x, e.y)（先纵后横）；连接器按绑定节点的
 *   中心相对方位传 prefer 覆盖默认主导判定。
 */
export function buildOrthoWaypoints(s: Pt, e: Pt, prefer?: "h" | "v"): Pt[] {
  const dx = Math.abs(e.x - s.x);
  const dy = Math.abs(e.y - s.y);
  if (dx < 0.5 || dy < 0.5) {
    return [];
  }
  const horizontalFirst = prefer ? prefer === "h" : dx >= dy;
  return horizontalFirst ? [{ x: e.x, y: s.y }] : [{ x: s.x, y: e.y }];
}
