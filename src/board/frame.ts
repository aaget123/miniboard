// frame 内容容器纯函数：尺寸估算与夹紧平移（无 leafer 依赖，画布与单测共用）

import { rotatePoint, transformPath } from "./path";
import type { ElementData } from "../types";

/** 内容内边距（px） */
export const FRAME_PADDING = 16;
/** 内容字号（px） */
export const FRAME_CONTENT_SIZE = 14;
/** 行高倍数（传给 leafer 时须用 percent 单位，数值直接传会被当作像素导致重叠） */
export const FRAME_LINE_HEIGHT = 1.6;
/** 代码内容等宽字体栈 */
export const FRAME_CODE_FONT = "Consolas, 'Courier New', monospace";
/** autoSize 最小宽度（px） */
export const FRAME_MIN_WIDTH = 200;
/** 折叠后内容区最大高度（含内边距，px）：超出裁剪 + 滚轮滚动查看 */
export const FRAME_COLLAPSED_HEIGHT = 480;
/** 内容文字缺省色（未指定描边时） */
export const FRAME_CONTENT_COLOR = "#4a5568";

/** 内容规范化：统一换行符（\r\n/\r → \n），避免 \r 残留渲染为乱码 */
export function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * 单行按可用宽度折行（字符宽度近似：半角 0.55em / 等宽 0.62em / 全角 1em）。
 * 返回折行后的片段列表（空行返回 [""] 保留行位）。
 */
export function wrapLine(
  line: string,
  availWidth: number,
  charW: number,
): string[] {
  if (!line) {
    return [""];
  }
  const out: string[] = [];
  let cur = "";
  let w = 0;
  for (const ch of line) {
    const cw = ch.charCodeAt(0) > 0xff ? 1 : charW;
    if (w + cw > availWidth && cur) {
      out.push(cur);
      cur = ch;
      w = cw;
    } else {
      cur += ch;
      w += cw;
    }
  }
  if (cur) {
    out.push(cur);
  }
  return out;
}

/**
 * frame 内容尺寸估算：按行最长与字符宽度近似（半角 0.55em / 等宽 0.62em / 全角 1em），
 * 长行按可用宽度折行后计入高度，供 autoSize 模式按内容撑框；
 * 阶段 1 为近似值，精确排版留待富文本阶段。
 */
export function frameContentSize(
  content: string,
  type: string | undefined,
): { width: number; height: number } {
  const text = normalizeContent(content);
  const lines = text.split("\n");
  const charW = type === "code" ? 0.62 : 0.55;
  let maxLen = 0;
  for (const line of lines) {
    let len = 0;
    for (const ch of line) {
      len += ch.charCodeAt(0) > 0xff ? 1 : charW;
    }
    maxLen = Math.max(maxLen, len);
  }
  const width = Math.max(
    FRAME_MIN_WIDTH,
    maxLen * FRAME_CONTENT_SIZE + FRAME_PADDING * 2,
  );
  const avail = width - FRAME_PADDING * 2;
  let totalLines = 0;
  for (const line of lines) {
    totalLines += wrapLine(line, avail, charW).length;
  }
  const height = Math.max(
    1,
    totalLines * FRAME_CONTENT_SIZE * FRAME_LINE_HEIGHT + FRAME_PADDING * 2,
  );
  return { width, height };
}

/**
 * 内容框架折叠后的高度：autoSize 估算高度与折叠上限取小（内容不足一屏时
 * 折叠不生效，保持全部展示）；返回 null 表示内容未超限无需折叠。
 */
export function collapsedFrameHeight(
  content: string,
  type: string | undefined,
): number | null {
  const h = frameContentSize(content, type).height;
  return h > FRAME_COLLAPSED_HEIGHT ? FRAME_COLLAPSED_HEIGHT : null;
}

/**
 * 折叠状态下的最大滚动偏移：内容高度超出框架高度的部分。
 * 框架未折叠或内容不超高时返回 0（不可滚动）。
 */
export function frameScrollMax(
  content: string,
  type: string | undefined,
  boxHeight: number,
): number {
  const h = frameContentSize(content, type).height;
  return Math.max(0, h - boxHeight);
}

/** bbox 平移量计算：把 box 完全平移进容器框内（box 大于容器时仅最小越界修正） */
export function clampShift(
  box: { minX: number; minY: number; maxX: number; maxY: number },
  fb: { minX: number; minY: number; maxX: number; maxY: number },
): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  if (box.maxX - box.minX <= fb.maxX - fb.minX) {
    if (box.minX < fb.minX) {
      dx = fb.minX - box.minX;
    } else if (box.maxX > fb.maxX) {
      dx = fb.maxX - box.maxX;
    }
  } else if (box.minX < fb.minX) {
    dx = fb.minX - box.minX;
  }
  if (box.maxY - box.minY <= fb.maxY - fb.minY) {
    if (box.minY < fb.minY) {
      dy = fb.minY - box.minY;
    } else if (box.maxY > fb.maxY) {
      dy = fb.maxY - box.maxY;
    }
  } else if (box.minY < fb.minY) {
    dy = fb.minY - box.minY;
  }
  return { dx, dy };
}

/**
 * 序列化坐标换算（世界 → 相对）：带 frameId 的元素转相对框架原点/旋转的坐标
 * （数据契约：内容存“框架 id + 相对位置”，框架移动/旋转后相对坐标不变）。
 * 框架不在同一场景（数据异常）时按自由元素输出（清 frameId 保留世界坐标）。
 */
export function contractFrameContents(data: ElementData[]): ElementData[] {
  const frames = new Map<string, ElementData>();
  for (const d of data) {
    if (d.type === "frame" && d.id) {
      frames.set(d.id, d);
    }
  }
  return data.map((d) => {
    if (!d.frameId) {
      return d;
    }
    const f = frames.get(d.frameId);
    if (!f) {
      return { ...d, frameId: undefined };
    }
    const fx = f.x ?? 0;
    const fy = f.y ?? 0;
    const rot = f.rotation ?? 0;
    const toLocal = (p: { x: number; y: number }) =>
      rotatePoint({ x: p.x - fx, y: p.y - fy }, -rot);
    if (d.type === "line" || d.type === "arrow") {
      return {
        ...d,
        x: 0,
        y: 0,
        points: (d.points ?? []).map(toLocal),
      };
    }
    if (d.type === "path") {
      return {
        ...d,
        x: 0,
        y: 0,
        path: transformPath(d.path ?? "", toLocal),
      };
    }
    const p = toLocal({ x: d.x, y: d.y });
    return { ...d, x: p.x, y: p.y };
  });
}

/**
 * 导出/整理坐标还原（相对 → 世界）：SVG 导出与整理计算前把带 frameId 的
 * 内容展开为画布世界坐标（清 frameId），保证输出位置正确。
 */
export function expandFrameContents(data: ElementData[]): ElementData[] {
  const frames = new Map<string, ElementData>();
  for (const d of data) {
    if (d.type === "frame" && d.id) {
      frames.set(d.id, d);
    }
  }
  return data.map((d) => {
    if (!d.frameId) {
      return d;
    }
    const f = frames.get(d.frameId);
    if (!f) {
      return { ...d, frameId: undefined };
    }
    const fx = f.x ?? 0;
    const fy = f.y ?? 0;
    const rot = f.rotation ?? 0;
    const toWorld = (p: { x: number; y: number }) => {
      const q = rotatePoint(p, rot);
      return { x: q.x + fx, y: q.y + fy };
    };
    if (d.type === "line" || d.type === "arrow") {
      return {
        ...d,
        x: 0,
        y: 0,
        points: (d.points ?? []).map(toWorld),
        frameId: undefined,
      };
    }
    if (d.type === "path") {
      return {
        ...d,
        x: 0,
        y: 0,
        path: transformPath(d.path ?? "", toWorld),
        frameId: undefined,
      };
    }
    const p = toWorld({ x: d.x, y: d.y });
    return { ...d, x: p.x, y: p.y, frameId: undefined };
  });
}
