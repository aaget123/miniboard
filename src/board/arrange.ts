// 元素排列纯函数：对齐/分布/翻转/层序/组归一化。
// 只做几何计算、不触碰画布/历史——UI（SelectionBar）与 AI 工具（arrange_elements）共用，
// 由调用方负责应用与写快照。锁定元素过滤也在调用方完成（本模块假定输入均允许操作）。

import type { ElementData } from "../types";
import { elementBounds, unionBounds } from "./bounds";
import { offsetElementData } from "./offset";
import { mirrorPath } from "./path";

export type AlignMode = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";
export type DistributeMode = "horizontal" | "vertical";
export type FlipAxis = "h" | "v";
export type ReorderMode = "front" | "back" | "forward" | "backward";

/** arrange_elements 工具的动作枚举（对齐 6 + 分布 2 + 翻转 2 + 层序 4） */
export type ArrangeAction =
  | "align-left"
  | "align-centerX"
  | "align-right"
  | "align-top"
  | "align-centerY"
  | "align-bottom"
  | "distribute-h"
  | "distribute-v"
  | "flip-h"
  | "flip-v"
  | "front"
  | "back"
  | "forward"
  | "backward";

/** 对齐：以选区 AABB 为基准，把每个元素的包围盒边/中心对齐到基准边/中心 */
export function alignElements(els: ElementData[], mode: AlignMode): ElementData[] {
  if (els.length < 2) {
    return els;
  }
  const b = unionBounds(els);
  return els.map((el) => {
    const eb = elementBounds(el);
    let dx = 0;
    let dy = 0;
    switch (mode) {
      case "left":
        dx = b.minX - eb.minX;
        break;
      case "centerX":
        dx = (b.minX + b.maxX) / 2 - (eb.minX + eb.maxX) / 2;
        break;
      case "right":
        dx = b.maxX - eb.maxX;
        break;
      case "top":
        dy = b.minY - eb.minY;
        break;
      case "centerY":
        dy = (b.minY + b.maxY) / 2 - (eb.minY + eb.maxY) / 2;
        break;
      case "bottom":
        dy = b.maxY - eb.maxY;
        break;
    }
    return offsetElementData(el, dx, dy);
  });
}

/** 分布：按中心排序，首尾保持原位、中间元素按步长均分（少于 3 个元素无操作） */
export function distributeElements(els: ElementData[], mode: DistributeMode): ElementData[] {
  if (els.length < 3) {
    return els;
  }
  const center = (el: ElementData) => {
    const b = elementBounds(el);
    return mode === "horizontal" ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2;
  };
  const sorted = [...els].sort((a, b) => center(a) - center(b));
  const first = center(sorted[0]);
  const last = center(sorted[sorted.length - 1]);
  const step = (last - first) / (sorted.length - 1);
  return sorted.map((el, i) => {
    const d = first + step * i - center(el);
    return offsetElementData(el, mode === "horizontal" ? d : 0, mode === "vertical" ? d : 0);
  });
}

/**
 * 翻转：绕中心 (cx, cy) 镜像。
 * - rect/ellipse/text/image：平移 x/y（宽度翻转后坐标补偿）+ rotation 变号；
 * - line/arrow/path：points/path 为画布绝对坐标，直接镜像坐标点（x/y 保持 0 契约）；
 * - freehand：局部轮廓 path 绕局部中心镜像 + penPoints 绝对坐标镜像 + x/y 补偿。
 * rotation 变号：镜像反转旋转方向（所有类型适用）。
 */
export function flipElements(
  els: ElementData[],
  axis: FlipAxis,
  cx: number,
  cy: number,
): ElementData[] {
  return els.map((el) => {
    const rot = el.rotation ?? 0;
    if (el.type === "line" || el.type === "arrow") {
      return {
        ...el,
        points: (el.points ?? []).map((p) => ({
          x: axis === "h" ? 2 * cx - p.x : p.x,
          y: axis === "v" ? 2 * cy - p.y : p.y,
        })),
        rotation: -rot,
      };
    }
    if (el.type === "path") {
      return {
        ...el,
        path: mirrorPath(el.path ?? "", axis, axis === "h" ? cx : cy),
        rotation: -rot,
      };
    }
    if (el.type === "freehand") {
      const w = el.width ?? 0;
      const h = el.height ?? 0;
      return {
        ...el,
        x: axis === "h" ? 2 * cx - (el.x ?? 0) - w : (el.x ?? 0),
        y: axis === "v" ? 2 * cy - (el.y ?? 0) - h : (el.y ?? 0),
        path: mirrorPath(el.path ?? "", axis, axis === "h" ? w / 2 : h / 2),
        penPoints: el.penPoints?.map((p) => [
          axis === "h" ? 2 * cx - p[0] : p[0],
          axis === "v" ? 2 * cy - p[1] : p[1],
          ...p.slice(2),
        ]),
        rotation: -rot,
      };
    }
    // rect/ellipse/text/image：左上角补偿 = 2*center - x - 尺寸
    return {
      ...el,
      x: axis === "h" ? 2 * cx - (el.x ?? 0) - (el.width ?? 0) : (el.x ?? 0),
      y: axis === "v" ? 2 * cy - (el.y ?? 0) - (el.height ?? 0) : (el.y ?? 0),
      rotation: -rot,
    };
  });
}

/**
 * 层序：按选中 id 集合重排数组（序列化顺序 = tree.children 顺序，children[0] 在最底层）。
 * front/back 保持选中元素相对顺序；forward/backward 与相邻非选中元素交换（块整体移动一层）。
 */
export function reorderElements<T extends { id?: string }>(
  list: T[],
  ids: string[],
  getId: (el: T) => string,
  mode: ReorderMode,
): T[] {
  const set = new Set(ids);
  if (mode === "front") {
    return [
      ...list.filter((el) => !set.has(getId(el))),
      ...list.filter((el) => set.has(getId(el))),
    ];
  }
  if (mode === "back") {
    return [
      ...list.filter((el) => set.has(getId(el))),
      ...list.filter((el) => !set.has(getId(el))),
    ];
  }
  const out = [...list];
  if (mode === "forward") {
    // 上移一层：从后往前，选中元素与后一个非选中交换（保证块内顺序稳定）
    for (let i = out.length - 2; i >= 0; i--) {
      if (set.has(getId(out[i])) && !set.has(getId(out[i + 1]))) {
        [out[i], out[i + 1]] = [out[i + 1], out[i]];
      }
    }
  } else {
    // 下移一层：从前往后，选中元素与前一个非选中交换
    for (let i = 1; i < out.length; i++) {
      if (!set.has(getId(out[i - 1])) && set.has(getId(out[i]))) {
        [out[i - 1], out[i]] = [out[i], out[i - 1]];
      }
    }
  }
  return out;
}

/**
 * 组感知归一化：任一成员被选中时，把整组所有成员并入参与集合。
 * 锁定元素由调用方过滤（本模块假定输入均允许操作）。
 */
export function expandGroupMembers(elements: ElementData[], selectedIds: string[]): Set<string> {
  const sel = new Set(selectedIds);
  // 一次遍历建索引：id → 组 id、组 id → 成员列表（避免逐 id 查找的 O(n²)）
  const groupOf = new Map<string, string>();
  const groups = new Map<string, string[]>();
  for (const el of elements) {
    if (!el.id) {
      continue;
    }
    if (el.groupId) {
      groupOf.set(el.id, el.groupId);
      const arr = groups.get(el.groupId);
      if (arr) {
        arr.push(el.id);
      } else {
        groups.set(el.groupId, [el.id]);
      }
    }
  }
  for (const id of selectedIds) {
    const g = groupOf.get(id);
    if (g) {
      for (const m of groups.get(g) ?? []) {
        sel.add(m);
      }
    }
  }
  return sel;
}
