// frame 内容容器纯函数：尺寸估算与夹紧平移（无 leafer 依赖，画布与单测共用）

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
