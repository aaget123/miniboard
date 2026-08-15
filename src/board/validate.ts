// AI 工具生成器输出校验：返回值必须满足 ElementData 契约，
// 非法数据在冒烟测试阶段拦截（拖拽管线的高频调用不做此校验）。

import type { ElementData } from "../types";

/** AI 自定义工具可生成的元素类型（图片需 url 数据源，交互类不走生成器，均不支持） */
const GENERATABLE_TYPES = new Set([
  "rect",
  "ellipse",
  "line",
  "arrow",
  "path",
  "text",
]);

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isColor(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** 校验单个元素数据，返回规范化后的数据或错误原因 */
export function validateElementData(
  raw: unknown,
): { ok: true; data: ElementData } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "生成器必须返回元素数据对象（ElementData）" };
  }
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string" || !GENERATABLE_TYPES.has(type)) {
    return {
      ok: false,
      error: `type 必须是 ${[...GENERATABLE_TYPES].join("/")} 之一（实际为 ${String(type)}）`,
    };
  }
  if (!isFiniteNum(obj.x) || !isFiniteNum(obj.y)) {
    return { ok: false, error: "缺少合法的 x/y 坐标（必须是有限数字）" };
  }
  // 外观字段：类型非法即报错；合法才透传
  for (const [field, name] of [
    ["stroke", "stroke 描边色"],
    ["fill", "fill 填充色"],
  ] as const) {
    if (obj[field] !== undefined && !isColor(obj[field])) {
      return { ok: false, error: `${name}必须是颜色字符串` };
    }
  }
  if (obj.fill === "none") {
    return {
      ok: false,
      error: '禁止 fill 传字符串 "none"（leafer 会渲染成黑色实心），无填充时省略 fill 字段',
    };
  }
  if (obj.strokeWidth !== undefined && !isFiniteNum(obj.strokeWidth)) {
    return { ok: false, error: "strokeWidth 必须是数字" };
  }
  if (obj.strokeWidth !== undefined && (obj.strokeWidth as number) < 0) {
    return { ok: false, error: "strokeWidth 不能为负数" };
  }
  if (obj.rotation !== undefined && !isFiniteNum(obj.rotation)) {
    return { ok: false, error: "rotation 必须是数字（角度）" };
  }

  const data: ElementData = {
    type: type as ElementData["type"],
    x: obj.x as number,
    y: obj.y as number,
    width: 0,
    height: 0,
  };
  if (obj.stroke !== undefined) data.stroke = obj.stroke as string;
  if (obj.fill !== undefined) data.fill = obj.fill as string;
  if (obj.strokeWidth !== undefined) data.strokeWidth = obj.strokeWidth as number;
  if (obj.rotation !== undefined) data.rotation = obj.rotation as number;

  if (type === "line" || type === "arrow") {
    const pts = obj.points;
    if (
      !Array.isArray(pts) ||
      pts.length < 2 ||
      !pts.every(
        (p) =>
          typeof p === "object" &&
          p !== null &&
          isFiniteNum((p as { x?: unknown }).x) &&
          isFiniteNum((p as { y?: unknown }).y),
      )
    ) {
      return { ok: false, error: "line/arrow 需要至少 2 个 points 点（[{x,y},...]）" };
    }
    // 数据契约：points 用画布绝对坐标，x/y 必须为 0（与 path 一致，避免双重偏移）
    if (obj.x !== 0 || obj.y !== 0) {
      return {
        ok: false,
        error: "line/arrow 元素 x/y 必须为 0（points 使用画布绝对坐标，非零 x/y 会叠加偏移）",
      };
    }
    data.points = (pts as { x: number; y: number }[]).map((p) => ({ x: p.x, y: p.y }));
    return { ok: true, data };
  }

  // rect/ellipse/path：宽高必须有限非负（path 的 path 字符串必填）
  if (obj.width !== undefined && (!isFiniteNum(obj.width) || (obj.width as number) < 0)) {
    return { ok: false, error: "width 必须是大于等于 0 的数字" };
  }
  if (obj.height !== undefined && (!isFiniteNum(obj.height) || (obj.height as number) < 0)) {
    return { ok: false, error: "height 必须是大于等于 0 的数字" };
  }
  data.width = obj.width !== undefined ? (obj.width as number) : 0;
  data.height = obj.height !== undefined ? (obj.height as number) : 0;

  if (type === "path") {
    if (typeof obj.path !== "string" || !obj.path.trim()) {
      return { ok: false, error: "path 元素需要 path 字符串（SVG 路径，画布绝对坐标）" };
    }
    // 数据契约：path 用画布绝对坐标，x/y 必须为 0（leafer Path 渲染 = (x,y) + path，
    // 同时设置非零 x/y 与绝对坐标 path 会双重偏移，如星星印章随机漂移问题）
    if (obj.x !== 0 || obj.y !== 0) {
      return {
        ok: false,
        error: "path 元素 x/y 必须为 0（path 字符串使用画布绝对坐标，非零 x/y 会叠加偏移）",
      };
    }
    data.path = obj.path;
  }
  if (type === "text") {
    if (typeof obj.text !== "string" || !obj.text) {
      return { ok: false, error: "text 元素需要 text 字符串" };
    }
    data.text = obj.text;
    if (obj.fontSize !== undefined) {
      if (!isFiniteNum(obj.fontSize) || (obj.fontSize as number) <= 0) {
        return { ok: false, error: "fontSize 必须是大于 0 的数字" };
      }
      data.fontSize = obj.fontSize as number;
    }
  }
  return { ok: true, data };
}

/** 校验生成器返回值（单元素或数组），返回规范化后的元素列表或错误原因 */
export function validateElementList(
  raw: unknown,
): { ok: true; data: ElementData[] } | { ok: false; error: string } {
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length) {
    return { ok: false, error: "生成器返回了空数组（至少需要 1 个元素）" };
  }
  if (list.length > 8) {
    return { ok: false, error: `单次生成元素过多（${list.length} 个，上限 8 个），请精简为必要的组合` };
  }
  const out: ElementData[] = [];
  for (let i = 0; i < list.length; i++) {
    const r = validateElementData(list[i]);
    if (!r.ok) {
      return { ok: false, error: `第 ${i + 1} 个元素：${r.error}` };
    }
    out.push(r.data);
  }
  return { ok: true, data: out };
}
