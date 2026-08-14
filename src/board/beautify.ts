import type { ElementData } from "../types";

/**
 * 本地整理引擎：纯数据变换（不动 leafer）。
 * 手绘路径 → 形状识别 → 完善为标准图形：
 * - 闭合且近似圆/椭圆 → 标准 Ellipse（长短轴接近时输出正圆）
 * - 闭合且近似矩形（可带旋转） → 标准 Rect
 * - 闭合且近似三角形/四边形/五边形等 → 标准多边形 Path
 * - 近似直线 → 标准 Line
 * - 其余 → 折线拉直（Douglas-Peucker 简化）
 * 只整理画笔手绘（M/L/Q）路径；保留描边颜色/粗细/填充与稳定 id。
 */

export type BeautifyStats = { label: string; count: number }[];

/** 简化容差：手抖幅度小于该值（px）的弯曲都会被拉直 */
const TOLERANCE = 5;

/** 首尾距离小于该值（px）视为闭合路径（手绘圈/多边形） */
const CLOSE_DIST = 12;

/** 闭合路径参与形状识别的最少采样点数（太少不判形） */
const MIN_PTS = 10;

/** 椭圆拟合残差阈值：点到拟合椭圆的归一化距离平均值（0 = 完美椭圆） */
const ELLIPSE_RESIDUAL = 0.18;

/** 矩形拟合残差阈值：点到四条边的平均距离 / 最长边
 * 可适度放宽：hasCorners 角点验证已把椭圆/圆（8+ 伪顶点）挡在门外，
 * 此处只需容纳手绘矩形的轻度平行四边形歪斜（实测 0.04~0.06） */
const RECT_RESIDUAL_RATIO = 0.06;

/** 多边形顶点提取容差（px）：简化后保留的顶点数 3~7 视为多边形 */
const POLY_TOL = 14;

/** 多边形拟合残差阈值：采样点到顶点多边形边界的平均距离 / 外接半径 */
const POLY_RESIDUAL_RATIO = 0.08;

/** "正圆"判定：长短轴比在此区间内时输出等半径圆 */
const CIRCLE_RATIO_MIN = 0.85;
const CIRCLE_RATIO_MAX = 1.18;

/** 数值保留 1 位小数（与序列化一致） */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** 路径是否只含画笔命令（M/L/Q）；含 A/C/S/T/Z 的路径视为已完成的标准图形，不整理 */
function isPenPath(path: string): boolean {
  return /^[MLQ\s\d.\-]+$/.test(path);
}

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

// ================= 形状识别与标准图形生成 =================

/** 点集主方向（弧度）：协方差矩阵主特征向量方向，范围 [-π/2, π/2] */
function pcaAngle(pts: number[][]): number {
  const n = pts.length;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p[0];
    my += p[1];
  }
  mx /= n;
  my /= n;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const p of pts) {
    const dx = p[0] - mx;
    const dy = p[1] - my;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  return 0.5 * Math.atan2(2 * xy, xx - yy);
}

/** 绕点 (cx, cy) 旋转 θ 后的主轴坐标系坐标 */
function rotatePts(
  pts: number[][],
  cosA: number,
  sinA: number,
  cx: number,
  cy: number,
): number[][] {
  return pts.map((p) => {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    return [dx * cosA + dy * sinA, -dx * sinA + dy * cosA];
  });
}

/** 主轴坐标系点 (x, y) 逆旋转回画布坐标 */
function unrotate(
  x: number,
  y: number,
  cosA: number,
  sinA: number,
  cx: number,
  cy: number,
): [number, number] {
  return [cx + x * cosA - y * sinA, cy + x * sinA + y * cosA];
}

/** 椭圆拟合残差：各点到拟合椭圆的归一化距离平均值（0 = 完美椭圆） */
function ellipseResidual(rpts: number[][], rx: number, ry: number): number {
  let sum = 0;
  for (const p of rpts) {
    sum += Math.abs((p[0] / rx) ** 2 + (p[1] / ry) ** 2 - 1);
  }
  return sum / rpts.length;
}

/** 矩形拟合残差：各点到最近一条边的平均距离（矩形内外的点都计算） */
function rectResidual(rpts: number[][], w: number, h: number): number {
  let sum = 0;
  for (const p of rpts) {
    // 到左右边 / 上下边距离取近者：| |x| - w/2 | 是到左右边的距离
    sum += Math.min(
      Math.abs(Math.abs(p[0]) - w / 2),
      Math.abs(Math.abs(p[1]) - h / 2),
    );
  }
  return sum / rpts.length;
}

/** 多边形拟合残差：各采样点到多边形边界（顶点依次连线）的平均距离 */
function polygonResidual(pts: number[][], verts: number[][]): number {
  const n = verts.length;
  let sum = 0;
  for (const p of pts) {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const d = distToSegment(p, verts[i], verts[(i + 1) % n]);
      if (d < best) {
        best = d;
      }
    }
    sum += best;
  }
  return sum / pts.length;
}

/** 顶点处夹角（度）：以 b 为顶点的折线角 a-b-c */
function vertexAngle(a: number[], b: number[], c: number[]): number {
  const v1x = a[0] - b[0];
  const v1y = a[1] - b[1];
  const v2x = c[0] - b[0];
  const v2y = c[1] - b[1];
  const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1;
  const dot = v1x * v2x + v1y * v2y;
  return Math.acos(Math.max(-1, Math.min(1, dot / m))) * (180 / Math.PI);
}

/** 删除近似共线的伪顶点（如直径切链法把某条边从中点切开产生的中间点） */
function dedupCollinear(verts: number[][]): number[][] {
  if (verts.length <= 3) {
    return verts;
  }
  const out: number[][] = [];
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const a = verts[(i - 1 + n) % n];
    const b = verts[i];
    const c = verts[(i + 1) % n];
    if (distToSegment(b, a, c) < POLY_TOL / 2) {
      continue; // b 近似落在 a-c 连线上，不是真实角点
    }
    out.push(b);
  }
  return out;
}

/** 多边形顶点序列生成标准 path 元素（顶点为画布坐标，归一化到 bbox 起点） */
function polygonOf(vertices: number[][], e: ElementData): ElementData {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of vertices) {
    minX = Math.min(minX, v[0]);
    maxX = Math.max(maxX, v[0]);
    minY = Math.min(minY, v[1]);
    maxY = Math.max(maxY, v[1]);
  }
  const rel = vertices.map((v) => [round1(v[0] - minX), round1(v[1] - minY)]);
  let d = `M ${rel[0][0]} ${rel[0][1]}`;
  for (let i = 1; i < rel.length; i++) {
    d += ` L ${rel[i][0]} ${rel[i][1]}`;
  }
  d += " Z";
  return {
    type: "path",
    id: e.id,
    x: round1(minX),
    y: round1(minY),
    width: round1(maxX - minX),
    height: round1(maxY - minY),
    path: d,
    stroke: e.stroke,
    strokeWidth: e.strokeWidth,
    fill: e.fill,
  };
}

/** 多边形边数标签 */
function polyLabel(n: number): string {
  if (n === 3) {
    return "三角形";
  }
  if (n === 4) {
    return "四边形";
  }
  if (n === 5) {
    return "五边形";
  }
  return `${n} 边形`;
}

/**
 * 闭合路径形状识别：返回能"完善"成的标准元素，无法识别返回 null（走拉直）。
 * @param e 原 path 元素
 * @param cpts 画布坐标采样点（parsePenPath 结果已叠加 e.x/e.y）
 */
function perfectClosedShape(
  e: ElementData,
  cpts: number[][],
): { el: ElementData; label: string } | null {
  const n = cpts.length;
  let cx = 0;
  let cy = 0;
  for (const p of cpts) {
    cx += p[0];
    cy += p[1];
  }
  cx /= n;
  cy /= n;
  const theta = pcaAngle(cpts);
  const cosA = Math.cos(theta);
  const sinA = Math.sin(theta);
  const rpts = rotatePts(cpts, cosA, sinA, cx, cy);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of rpts) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (w < 4 || h < 4) {
    return null; // 尺寸太小（如已经接近一个点），不判形
  }
  const style = {
    id: e.id,
    stroke: e.stroke,
    strokeWidth: e.strokeWidth,
    fill: e.fill,
  };
  const [ccx, ccy] = unrotate(
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    cosA,
    sinA,
    cx,
    cy,
  );
  const rotDeg = Math.abs(theta * (180 / Math.PI)) < 0.5 ? 0 : round1(theta * (180 / Math.PI));

  // 判定顺序：矩形 → 多边形 → 椭圆
  // （正多边形的顶点落在外接圆上，椭圆残差与圆接近，必须先识别角点）

  // 先做一次顶点提取：矩形/多边形必须有明显角点，圆滑形状（椭圆/圆）直接排除
  // （真矩形简化后为 4 个角点；椭圆等圆滑形状会得到 8+ 个"伪角点"）
  const vertices = dedupCollinear(simplifyRing(cpts, POLY_TOL));
  const hasCorners = vertices.length >= 3 && vertices.length <= 5;

  // 1) 矩形（允许旋转）
  if (hasCorners && rectResidual(rpts, w, h) / Math.max(w, h) < RECT_RESIDUAL_RATIO) {
    return {
      el: {
        type: "rect",
        ...style,
        x: round1(ccx - w / 2),
        y: round1(ccy - h / 2),
        width: round1(w),
        height: round1(h),
        rotation: rotDeg,
      },
      label: "完善为矩形",
    };
  }

  // 2) 多边形（三角形/四边形/五边形等，顶点 3~7）
  // 残差验证区分多边形与圆：手绘圆简化出的"伪顶点"拟合残差明显更大
  // 锐角验证排除圆滑形状：椭圆/圆简化出的顶点含钝角（长轴端附近 > 140°），真多边形全部锐角
  // 内角一致性：正多边形各内角近似相等（五边形 108° 等），圆/椭圆伪顶点内角波动大（可达 ±40°）
  let allSharp = true;
  let angSum = 0;
  const angles: number[] = [];
  for (let i = 0; i < vertices.length && allSharp; i++) {
    const ang = vertexAngle(
      vertices[(i - 1 + vertices.length) % vertices.length],
      vertices[i],
      vertices[(i + 1) % vertices.length],
    );
    angles.push(ang);
    angSum += ang;
    allSharp = ang < 140;
  }
  const angMean = angSum / angles.length;
  const angDev = Math.max(...angles.map((a) => Math.abs(a - angMean)));
  if (
    allSharp &&
    angDev < 22 &&
    vertices.length >= 3 &&
    vertices.length <= 7
  ) {
    let vx = 0;
    let vy = 0;
    for (const v of vertices) {
      vx += v[0];
      vy += v[1];
    }
    vx /= vertices.length;
    vy /= vertices.length;
    let radius = 0;
    for (const v of vertices) {
      radius = Math.max(radius, Math.hypot(v[0] - vx, v[1] - vy));
    }
    if (radius > 0 && polygonResidual(cpts, vertices) / radius < POLY_RESIDUAL_RATIO) {
      return {
        el: polygonOf(vertices, e),
        label: `完善为${polyLabel(vertices.length)}`,
      };
    }
  }

  // 3) 椭圆 / 正圆
  // 半轴用二阶矩估计（bbox 半轴受采样密度影响，矩估计更稳）
  let sx2 = 0;
  let sy2 = 0;
  for (const p of rpts) {
    sx2 += p[0] * p[0];
    sy2 += p[1] * p[1];
  }
  const rx = Math.sqrt((2 * sx2) / n);
  const ry = Math.sqrt((2 * sy2) / n);
  if (rx >= 2 && ry >= 2 && ellipseResidual(rpts, rx, ry) < ELLIPSE_RESIDUAL) {
    const ratio = rx / ry;
    const isCircle =
      ratio >= CIRCLE_RATIO_MIN && ratio <= CIRCLE_RATIO_MAX;
    const r = (rx + ry) / 2;
    return {
      el: {
        type: "ellipse",
        ...style,
        x: round1(ccx - (isCircle ? r : rx)),
        y: round1(ccy - (isCircle ? r : ry)),
        width: round1((isCircle ? r : rx) * 2),
        height: round1((isCircle ? r : ry) * 2),
        rotation: isCircle ? 0 : rotDeg,
      },
      label: isCircle ? "完善为圆形" : "完善为椭圆",
    };
  }

  return null;
}

// ================= 整理主流程 =================

/** 统计合并：同一标签的改动合并计数 */
function mergeStats(stats: BeautifyStats, label: string) {
  const hit = stats.find((s) => s.label === label);
  if (hit) {
    hit.count++;
  } else {
    stats.push({ label, count: 1 });
  }
}

/** 画笔规整：形状识别完善 + 弯弯扭扭笔迹拉直 */
function straightenPenPaths(
  els: ElementData[],
  stats: BeautifyStats,
): ElementData[] {
  for (let i = 0; i < els.length; i++) {
    const e = els[i];
    if (e.type !== "path" || !e.path || e.locked) {
      continue;
    }
    if (!isPenPath(e.path)) {
      continue; // 已完成的标准图形（含 A/C/S/T/Z 命令）不动
    }
    const pts = parsePenPath(e.path);
    if (pts.length < 3) {
      continue;
    }
    // 画布坐标采样点：path 数据是元素局部坐标，叠加元素位置
    const ox = e.x ?? 0;
    const oy = e.y ?? 0;
    const cpts = pts.map((p) => [p[0] + ox, p[1] + oy]);
    const first = cpts[0];
    const last = cpts[cpts.length - 1];
    // 手绘圈/多边形首尾通常不闭合，但距离很近 → 按闭合处理
    // 阈值随图形尺寸放宽：大图形收笔缝隙也大（如三角形边长 190px 时约 16px）
    let diag = 0;
    if (cpts.length >= 2) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of cpts) {
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]);
        maxY = Math.max(maxY, p[1]);
      }
      diag = Math.hypot(maxX - minX, maxY - minY);
    }
    const closeDist = Math.max(CLOSE_DIST, diag * 0.09);
    const closed =
      cpts.length > 4 &&
      Math.hypot(last[0] - first[0], last[1] - first[1]) < closeDist;

    if (closed && cpts.length >= MIN_PTS) {
      const fitted = perfectClosedShape(e, cpts);
      if (fitted) {
        els[i] = fitted.el;
        mergeStats(stats, fitted.label);
        continue;
      }
    }

    // 识别失败或非闭合 → 拉直（局部坐标重建 path）
    const kept = closed ? simplifyRing(pts, TOLERANCE) : simplify(pts, TOLERANCE);
    if (kept.length < 2 || kept.length === pts.length) {
      continue; // 已经足够直，保留原样
    }
    if (!closed && kept.length === 2) {
      // 近似直线 → 标准 Line（points 用画布坐标端点，x/y 归零由 leafer 自动计算包围盒）
      els[i] = {
        type: "line",
        id: e.id,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        points: [
          { x: round1(first[0]), y: round1(first[1]) },
          { x: round1(last[0]), y: round1(last[1]) },
        ],
        stroke: e.stroke,
        strokeWidth: e.strokeWidth,
      };
      mergeStats(stats, "完善为直线");
      continue;
    }
    e.path = pathOf(kept, closed);
    mergeStats(stats, "画笔拉直");
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
  return { elements: els, stats };
}
