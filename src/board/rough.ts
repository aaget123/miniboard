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

/** 解析 M/L/Z 多边形 path 为顶点序列（path 与元素同基准的局部坐标） */
function polygonVertices(path: string): [number, number][] {
  const verts: [number, number][] = [];
  const re = /([ML])\s+(-?[\d.]+)\s+(-?[\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    verts.push([parseFloat(m[2]), parseFloat(m[3])]);
  }
  return verts;
}

/**
 * 标准图形 → 手绘 path。返回新 path 与 seed；不可转换返回 null。
 * 输出 path 与输入 d 的 x/y 基准一致（转换后元素 x/y 保持不变）。
 */
export function sketchifyData(d: ElementData): {
  path: string;
  seed: number;
} | null {
  if (!isSketchable(d)) {
    return null;
  }
  const seed = 1 + Math.floor(Math.random() * 2147483646); // 1 ~ 2^31-1
  const generator = rough.generator();
  const options = {
    seed,
    roughness: 1,
    stroke: d.stroke ?? "#000000",
    strokeWidth: d.strokeWidth ?? 2,
    fill: d.fill && d.fill !== "none" ? d.fill : undefined,
  };
  let drawable;
  switch (d.type) {
    case "rect":
      drawable = generator.rectangle(0, 0, d.width, d.height, options);
      break;
    case "ellipse":
      // ellipse 以中心定位：元素局部坐标原点为 bbox 左上角
      drawable = generator.ellipse(d.width / 2, d.height / 2, d.width, d.height, options);
      break;
    case "line":
    case "arrow": {
      const pts = d.points ?? [];
      if (pts.length < 2) {
        return null;
      }
      drawable = generator.line(pts[0].x, pts[0].y, pts[1].x, pts[1].y, options);
      break;
    }
    case "path": {
      const verts = d.path ? polygonVertices(d.path) : [];
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
  return { path, seed };
}
