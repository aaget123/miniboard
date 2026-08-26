import { Ellipse, Image, Line, Path, Rect, Text } from "leafer-ui";
import type { UI } from "leafer-ui";
import type { IArrowStyle, IUI } from "@leafer-ui/interface";
import type { ArrowHead, ElementData } from "../types";

/**
 * leafer 元素级工具：箭头端点映射、类型判定、序列化辅助。
 * 纯函数（不持有 Board 状态），画布渲染与序列化共用。
 */

/**
 * 箭头端点：元素数据 → leafer 渲染值。
 * "none"/undefined → 无端点；"dot" → 小号实心圆（leafer 无独立圆点形状）。
 */
export function toLeaferArrow(head: ArrowHead | undefined): IArrowStyle | undefined {
  if (!head || head === "none") {
    return undefined;
  }
  if (head === "dot") {
    return { type: "circle", scale: 0.5 };
  }
  return head;
}

/**
 * 箭头端点：leafer 渲染值 → 元素数据（反向映射）。
 * 字符串形状直接透传（arrow/triangle/circle）；小号实心圆对象还原为 "dot"；
 * 其他形状/非法值按无端点处理（数据契约只允许 ArrowHead 五档）。
 */
export function arrowHeadOf(v: unknown): ArrowHead | undefined {
  if (typeof v === "string" && v !== "none") {
    if (v === "arrow" || v === "triangle" || v === "circle") {
      return v;
    }
    return undefined;
  }
  if (v && typeof v === "object") {
    const t = (v as { type?: unknown }).type;
    if (t === "circle") {
      return "dot"; // 小号实心圆（scale 0.5）= 圆点
    }
  }
  return undefined;
}

/** line/arrow 是否带任意端点（两端都无端点时序列化为 line） */
export function hasArrowHead(el: Line): boolean {
  return (
    (el.startArrow !== undefined && el.startArrow !== "none") ||
    (el.endArrow !== undefined && el.endArrow !== "none")
  );
}

/** frame 框架元素标记：普通型为 Rect，内容型为 Box 容器（Rect 渲染 + 子级渲染） */
export const FRAME_FLAG = "__isFrame";

/** 元素是否为 frame 框架（类型感知/序列化/框内跟随共用） */
export function isFrameEl(el: UI | IUI): boolean {
  return (el as unknown as Record<string, unknown>)[FRAME_FLAG] === true;
}

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function colorOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function numOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** 判断 leafer 元素是否为 freehand 笔迹（Path 渲染 + 采样点元数据） */
export function isFreehandEl(el: UI): boolean {
  return (el as unknown as { __freehandPoints?: unknown }).__freehandPoints !== undefined;
}

/**
 * 元素数据类型的轻量判定（与 elementToData 的类型分支一致，无序列化副作用）。
 * 供选中信息类型感知（左侧悬浮栏差异化显隐）与绑定判定复用。
 */
export function typeOf(el: UI): ElementData["type"] | null {
  // 注意：Image 继承自 Rect，必须先于 Rect 判断；框架是 Box（Group 子类），需在 Rect 之前
  if (el instanceof Image) {
    return "image";
  }
  if (isFrameEl(el)) {
    return "frame";
  }
  if (el instanceof Rect) {
    return "rect";
  }
  if (el instanceof Ellipse) {
    return "ellipse";
  }
  if (el instanceof Line) {
    // leafer 2.x 的 endArrow 默认值是字符串 "none"（truthy），需排除
    return el.endArrow && el.endArrow !== "none" ? "arrow" : "line";
  }
  if (el instanceof Path) {
    return isFreehandEl(el) ? "freehand" : "path";
  }
  if (el instanceof Text) {
    return "text";
  }
  return null;
}

/** 元素是否可应用手绘风格（对齐 rough.isSketchable：已手绘/画笔/文本/图片跳过） */
export function isSketchableEl(el: UI): boolean {
  const t = typeOf(el);
  if (t === "rect" || t === "ellipse" || t === "line" || t === "arrow") {
    return true;
  }
  if (t === "path") {
    const rough = (el as unknown as { __rough?: unknown }).__rough;
    const path = String((el as Path).path ?? "");
    // 标准多边形（beautify 输出的 M/L/Z）：仅含 M/L/Z 命令才可手绘化
    return !rough && /^[MLZ\s\d.-]+$/.test(path) && path.includes("Z");
  }
  return false;
}

/**
 * Line.points 的运行时形态：始终为对象数组（元素数据从 ElementData 透传，
 * leafer 类型声明含 number[] 兼容形态，统一断言避免联合类型困扰）。
 */
export function pointsOf(el: Line): { x: number; y: number }[] {
  return (el.points ?? []) as { x: number; y: number }[];
}

/** 恢复元素时把端点绑定 id 透传到实例（序列化/反序列化对称） */
export function bindingsToEl(el: UI, d: ElementData) {
  const t = el as unknown as Record<string, unknown>;
  if (d.bindStart) {
    t.__bindStart = d.bindStart;
  }
  if (d.bindEnd) {
    t.__bindEnd = d.bindEnd;
  }
}
