// 画布 SVG 矢量导出：把序列化元素数据转成独立 SVG 文档字符串。
// 与 PNG 导出的差异：输出矢量而非位图，可无损缩放与后续编辑；
// 图片元素以 dataURL 内嵌，导出文件自包含。纯数据变换（不依赖 leafer 实例）。
// 坐标基准：元素 x/y 为画布绝对坐标，path 等局部坐标经 translate/rotate 包装
// （与 leafer 渲染语义一致：rotation 绕元素包围盒中心旋转）。

import type { ElementData } from "../types";
import { localToCanvas } from "./coords";

/** 导出边距（与 PNG 导出一致） */
const PADDING = 24;

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 内容包围盒（含元素 rotation 的四角），空画布返回 null */
function contentBounds(elements: ElementData[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of elements) {
    const w = e.width ?? 0;
    const h = e.height ?? 0;
    // line/arrow 用 points 绝对坐标参与包围盒（元素包围盒不含线段端点外扩）
    if ((e.type === "line" || e.type === "arrow") && e.points?.length) {
      for (const p of e.points) {
        const a = localToCanvas(e, p);
        minX = Math.min(minX, a.x);
        minY = Math.min(minY, a.y);
        maxX = Math.max(maxX, a.x);
        maxY = Math.max(maxY, a.y);
      }
      continue;
    }
    const cx = w / 2;
    const cy = h / 2;
    const rad = ((e.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    for (const [lx, ly] of [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ] as const) {
      const dx = lx - cx;
      const dy = ly - cy;
      minX = Math.min(minX, e.x + dx * cos - dy * sin + cx);
      minY = Math.min(minY, e.y + dx * sin + dy * cos + cy);
      maxX = Math.max(maxX, e.x + dx * cos - dy * sin + cx);
      maxY = Math.max(maxY, e.y + dx * sin + dy * cos + cy);
    }
  }
  if (!Number.isFinite(minX)) {
    return null;
  }
  return { minX, minY, maxX, maxY };
}

/** translate + rotation 包装（与 leafer 元素渲染语义一致） */
function wrapTransform(e: ElementData): string {
  const t = `translate(${e.x} ${e.y})`;
  if (!e.rotation) {
    return t;
  }
  const cx = (e.width ?? 0) / 2;
  const cy = (e.height ?? 0) / 2;
  return `${t} rotate(${e.rotation} ${cx} ${cy})`;
}

/** 常见描边/填充属性（undefined 字段省略，避免输出多余属性） */
function paintAttrs(e: ElementData): string {
  const attrs: string[] = [];
  if (e.stroke) attrs.push(`stroke="${e.stroke}"`);
  if (e.strokeWidth != null) attrs.push(`stroke-width="${e.strokeWidth}"`);
  if (e.fill && e.fill !== "none") attrs.push(`fill="${e.fill}"`);
  return attrs.join(" ");
}

/** 单个元素 → SVG 片段（z 序由调用方保证） */
function elementToSvg(e: ElementData): string {
  switch (e.type) {
    case "rect":
    case "ellipse": {
      const w = e.width ?? 0;
      const h = e.height ?? 0;
      return `<g transform="${wrapTransform(e)}">${
        e.type === "rect"
          ? `<rect width="${w}" height="${h}" ${paintAttrs(e)}/>`
          : `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" ${paintAttrs(e)}/>`
      }</g>`;
    }
    case "line":
    case "arrow": {
      // points 为局部坐标，转画布绝对坐标（含 rotation），旋转后线方向已由端点表达
      const pts = (e.points ?? []).map((p) => localToCanvas(e, p));
      if (pts.length < 2) {
        return "";
      }
      const [a, b] = [pts[0], pts[pts.length - 1]];
      const marker = e.type === "arrow" ? ` marker-end="url(#mb-arrow)"` : "";
      const color = e.stroke ? ` style="color:${e.stroke}"` : "";
      const attrs = e.stroke ? ` stroke="${e.stroke}"` : "";
      const width = e.strokeWidth != null ? ` stroke-width="${e.strokeWidth}"` : "";
      return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"${attrs}${width}${marker}${color}/>`;
    }
    case "path":
      return `<g transform="${wrapTransform(e)}"><path d="${e.path ?? ""}" ${paintAttrs(e)}/></g>`;
    case "frame": {
      // 框架：虚线矩形 + 淡填充（与画布渲染风格一致）
      const w = e.width ?? 0;
      const h = e.height ?? 0;
      // 内容文本：与画布派生渲染同参数（内边距 16 / 字号 14 / 行高 1.6 倍），
      // 代码类型用等宽字体；fill 跟随描边色，缺省用深灰
      const pad = 16;
      const size = 14;
      const dy = Math.round(size * 1.6 * 10) / 10;
      const lines = (e.content ?? "").split("\n");
      let textSvg = "";
      if (e.content) {
        const tspans = lines
          .map((line, i) =>
            i === 0
              ? xmlEscape(line)
              : `<tspan x="${pad}" dy="${dy}">${xmlEscape(line)}</tspan>`,
          )
          .join("");
        const font =
          e.contentType === "code"
            ? "Consolas, 'Courier New', monospace"
            : "system-ui, -apple-system, sans-serif";
        const fill = e.stroke ? ` fill="${e.stroke}"` : ` fill="#4a5568"`;
        textSvg = `<text x="${pad}" y="${pad}" font-size="${size}" font-family="${font}" dominant-baseline="text-before-edge"${fill}>${tspans}</text>`;
      }
      return `<g transform="${wrapTransform(e)}"><rect width="${w}" height="${h}" ${paintAttrs(e)} stroke-dasharray="8 5"/>${textSvg}</g>`;
    }
    case "freehand": {
      // 笔迹渲染通道是 fill（轮廓），颜色走 stroke 字段
      const fill = e.stroke ? ` fill="${e.stroke}"` : "";
      return `<g transform="${wrapTransform(e)}"><path d="${e.path ?? ""}"${fill} stroke="none"/></g>`;
    }
    case "text": {
      const size = e.fontSize ?? 18;
      const fill = e.fill && e.fill !== "none" ? ` fill="${e.fill}"` : "";
      const lines = (e.text ?? "").split("\n");
      const tspans = lines
        .map((line, i) =>
          i === 0
            ? xmlEscape(line)
            : `<tspan x="0" dy="${size * 1.4}">${xmlEscape(line)}</tspan>`,
        )
        .join("");
      return `<g transform="${wrapTransform(e)}"><text font-size="${size}" font-family="system-ui, -apple-system, sans-serif" dominant-baseline="text-before-edge"${fill}>${tspans}</text></g>`;
    }
    case "image": {
      if (!e.url) {
        return "";
      }
      const w = e.width ?? 0;
      const h = e.height ?? 0;
      return `<g transform="${wrapTransform(e)}"><image href="${xmlEscape(e.url)}" width="${w}" height="${h}" preserveAspectRatio="none"/></g>`;
    }
  }
  return "";
}

/**
 * 序列化元素 → 完整 SVG 文档字符串（含背景与箭头定义）。
 * 空画布也返回有效 SVG（仅背景）。
 */
export function elementsToSVG(
  elements: ElementData[],
  background: string,
): string {
  const bounds = contentBounds(elements);
  const pad = PADDING;
  const minX = bounds ? Math.floor(bounds.minX - pad) : 0;
  const minY = bounds ? Math.floor(bounds.minY - pad) : 0;
  const width = bounds ? Math.ceil(bounds.maxX - bounds.minX + pad * 2) : 1;
  const height = bounds ? Math.ceil(bounds.maxY - bounds.minY + pad * 2) : 1;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}">`,
  );
  parts.push(
    `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${xmlEscape(background)}"/>`,
  );
  // 箭头定义：颜色跟随引用线的 currentColor
  parts.push(
    `<defs><marker id="mb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="currentColor"/></marker></defs>`,
  );
  for (const e of elements) {
    const frag = elementToSvg(e);
    if (frag) {
      parts.push(frag);
    }
  }
  parts.push("</svg>");
  return parts.join("\n");
}
