// 元素数据平移工具：粘贴/导入时把元素整体移动 (dx, dy)。
// 各类型的坐标语义不同，必须区分处理：
// - line/arrow/path：数据契约是"points/path 为画布绝对坐标 + x/y 置 0"（见 path.ts），
//   平移必须作用在 points/path 上，x/y 保持原值，否则 leafer 渲染 = (x, y) + 坐标 双重偏移；
// - freehand：x/y + 局部轮廓 path 自洽，平移 x/y 即可，但 penPoints 采样点是画布绝对坐标，
//   需同步平移（供整理识别/重绘使用）；
// - rect/ellipse/text/image：直接平移 x/y。

import type { ElementData } from "../types";
import { translatePath } from "./path";

/** 平移元素数据 (dx, dy)，返回新对象（零位移时原样返回） */
export function offsetElementData(
  d: ElementData,
  dx: number,
  dy: number,
): ElementData {
  if ((!dx && !dy) || !d) {
    return d;
  }
  if (d.type === "line" || d.type === "arrow") {
    return {
      ...d,
      points: (d.points ?? []).map((p) => ({ x: p.x + dx, y: p.y + dy })),
    };
  }
  if (d.type === "path") {
    return {
      ...d,
      path: translatePath(d.path ?? "", dx, dy),
    };
  }
  if (d.type === "freehand") {
    return {
      ...d,
      x: (d.x ?? 0) + dx,
      y: (d.y ?? 0) + dy,
      penPoints: d.penPoints?.map((p) => [p[0] + dx, p[1] + dy]),
    };
  }
  return { ...d, x: (d.x ?? 0) + dx, y: (d.y ?? 0) + dy };
}
