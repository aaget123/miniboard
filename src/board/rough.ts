import rough from "roughjs";
import type { ElementData } from "../types";

/**
 * 手绘风格渲染层（rough.js）：标准图形 → 手绘外观 path。
 * 纯数据变换：输出与输入同坐标基准（元素局部坐标，x/y 不变），
 * 抖动 seed 随元素保存，保证撤销/重载/导出后图形可复现。
 */

/** 可转换的图形类型（标准几何；画笔/文本/图片/已手绘跳过） */
export function isSketchable(d: ElementData): boolean {
  if (d.rough) {
    return false; // 已应用手绘风格
  }
  if (d.type === "rect" || d.type === "ellipse" || d.type === "line" || d.type === "arrow") {
    return true;
  }
  if (d.type === "path" && d.path) {
    // 标准多边形（beautify 输出的 M/L/Z）：仅含 M/L/Z 命令；画笔 M/L/Q、曲线含 C/A 均不可转换
    return /^[MLZ\s\d.\-]+$/.test(d.path) && d.path.includes("Z");
  }
  return false;
}

/** 解析 M/L/Z 多边形 path 为顶点序列（path 与元素同基准的局部坐标；beautify 输出 M0 0 无空格格式） */
function polygonVertices(path: string): [number, number][] {
  const verts: [number, number][] = [];
  const re = /([ML])\s*(-?[\d.]+)\s+(-?[\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    verts.push([parseFloat(m[2]), parseFloat(m[3])]);
  }
  return verts;
}

/** rough.js 绘制参数（颜色/线宽/抖动 seed/粗糙度） */
function roughOptions(
  d: ElementData,
  seed: number,
  roughness: number,
) {
  return {
    seed,
    roughness,
    stroke: d.stroke ?? "#000000",
    strokeWidth: d.strokeWidth ?? 2,
    fill: d.fill && d.fill !== "none" ? d.fill : undefined,
  };
}

/**
 * 按 seed/粗糙度重绘手绘 path（改粗糙度/还原复现用）：
 * 原几何从 meta 与元素当前数据重建（rect/ellipse 用原始宽高——若用当前宽高
 * 会把上次抖动的渲染范围当成几何尺寸，导致每次重绘逐次放大；
 * line/arrow 用原始 points，path 多边形用 meta.originalPath 记录的原始顶点 path）。
 * 返回新 path；不可重绘返回 null。
 */
export function redrawRough(
  d: ElementData,
  meta: {
    seed: number;
    original?: string;
    originalPath?: string;
    originalWidth?: number;
    originalHeight?: number;
    originalPoints?: { x: number; y: number }[];
  },
  roughness: number,
): { path: string } | null {
  const generator = rough.generator();
  const options = roughOptions(d, meta.seed, roughness);
  let drawable;
  const orig = meta.original ?? d.type;
  switch (orig) {
    case "rect": {
      const w = meta.originalWidth ?? d.width ?? 0;
      const h = meta.originalHeight ?? d.height ?? 0;
      drawable = generator.rectangle(0, 0, w, h, options);
      break;
    }
    case "ellipse": {
      // ellipse 以中心定位：元素局部坐标原点为 bbox 左上角
      const w = meta.originalWidth ?? d.width ?? 0;
      const h = meta.originalHeight ?? d.height ?? 0;
      drawable = generator.ellipse(w / 2, h / 2, w, h, options);
      break;
    }
    case "line":
    case "arrow": {
      const pts = meta.originalPoints ?? d.points ?? [];
      if (pts.length < 2) {
        return null;
      }
      drawable = generator.line(pts[0].x, pts[0].y, pts[1].x, pts[1].y, options);
      break;
    }
    case "path": {
      const verts = meta.originalPath ? polygonVertices(meta.originalPath) : [];
      if (verts.length < 3) {
        return null;
      }
      drawable = generator.polygon(verts, options);
      break;
    }
    default:
      return null;
  }
  // 多个 OpSet（描边 path + fillSketch/hachure 等）拼接为一个 path 元素
  const path = drawable.sets
    .map((set) => generator.opsToPath(set, 1))
    .filter(Boolean)
    .join(" ");
  if (!path) {
    return null;
  }
  return { path };
}

/**
 * 标准图形 → 手绘 path。返回新 path 与 seed；不可转换返回 null。
 * 输出 path 与输入 d 的 x/y 基准一致（转换后元素 x/y 保持不变）。
 * 粗糙度默认 1（可用 redrawRough 以同一 seed 调整）。
 * 同时返回原始几何参数（rect/ellipse 宽高、line/arrow 端点），供改粗糙度重绘时
 * 以原始尺寸为基准，避免手绘抖动撑大 bbox 后逐次放大。
 */
export function sketchifyData(d: ElementData): {
  path: string;
  seed: number;
  originalWidth?: number;
  originalHeight?: number;
  originalPoints?: { x: number; y: number }[];
} | null {
  if (!isSketchable(d)) {
    return null;
  }
  const seed = 1 + Math.floor(Math.random() * 2147483646); // 1 ~ 2^31-1
  const meta = {
    seed,
    original: d.type,
    // path 多边形需记录原始顶点 path：手绘化后原 path 被替换，改粗糙度时靠它重建几何
    originalPath: d.type === "path" ? d.path : undefined,
    originalWidth:
      d.type === "rect" || d.type === "ellipse" ? (d.width ?? 0) : undefined,
    originalHeight:
      d.type === "rect" || d.type === "ellipse" ? (d.height ?? 0) : undefined,
    originalPoints:
      d.type === "line" || d.type === "arrow" ? d.points : undefined,
  };
  const redrawn = redrawRough(d, meta, 1);
  return redrawn
    ? {
        ...redrawn,
        seed,
        originalWidth: meta.originalWidth,
        originalHeight: meta.originalHeight,
        originalPoints: meta.originalPoints,
      }
    : null;
}
