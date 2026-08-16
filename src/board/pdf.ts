// PDF 导出/导入支撑模块。
// 导出：最小 PDF 生成器（单页、单张 JPEG 图，DCTDecode 直通嵌入）——零依赖、
// 纯数据变换，可单测；图片化由调用方（storage）用浏览器 canvas 完成（中文文本
// 由浏览器渲染，无字体问题）。
// 导入：pdf.js 懒加载渲染 PDF 首页为位图（画布批注用），失败返回 null。

/** 画布内容位图化后的最长边上限（px）：超出按比例缩小，防 canvas 尺寸超限 */
export const PDF_EXPORT_MAX_SIDE = 6000;
/** PDF 导入首页的最长边上限（px） */
export const PDF_IMPORT_MAX_SIDE = 3000;

/** dataURL（data:image/jpeg;base64,...）→ 原始 JPEG 字节 */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/** 字符串 → Latin-1 字节（PDF 结构部分用 ASCII，中文不会出现） */
function strBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i) & 0xff;
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * 把一张 JPEG 图片包装成最小单页 PDF（页尺寸 = 图片像素尺寸）。
 * 结构：Catalog / Pages / Page / Image XObject（DCTDecode）/ Contents。
 * 返回完整 PDF 字节；图片与 PDF 本身均为纯二进制，偏移精确计算。
 */
export function jpegToPdf(
  jpegDataUrl: string,
  width: number,
  height: number,
): Uint8Array {
  const jpeg = dataUrlToBytes(jpegDataUrl);
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));

  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
    `/Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> ` +
    `/Contents 5 0 R >>`;
  objects[4] =
    `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} ` +
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
    `/Length ${jpeg.length} >>`;
  const content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ`;
  objects[5] = `<< /Length ${strBytes(content).length} >>`;

  // 组装：对象头 + 流数据 + xref 表 + trailer
  const parts: Uint8Array[] = [strBytes("%PDF-1.4\n")];
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = parts.reduce((n, p) => n + p.length, 0);
    parts.push(strBytes(`${i} 0 obj\n${objects[i]}\n`));
    if (i === 4) {
      parts.push(strBytes("stream\n"), jpeg, strBytes("\nendstream\n"));
    } else if (i === 5) {
      parts.push(strBytes("stream\n"), strBytes(content), strBytes("endstream\n"));
    }
    parts.push(strBytes("endobj\n"));
  }
  const xrefStart = parts.reduce((n, p) => n + p.length, 0);
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  parts.push(strBytes(xref));
  return concat(...parts);
}

/**
 * 渲染 PDF 首页为位图（懒加载 pdf.js）：解析失败/无页面时返回 null。
 * 输出 PNG dataURL 与像素尺寸；长边超出 maxSide 时等比缩小。
 */
export async function pdfFirstPageToImage(
  data: ArrayBuffer,
  maxSide = PDF_IMPORT_MAX_SIDE,
): Promise<{ dataURL: string; width: number; height: number } | null> {
  try {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).href;
    const doc = await pdfjs.getDocument({ data }).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(
      1,
      maxSide / Math.max(base.width, base.height),
    );
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    await page.render({ canvas, viewport: vp }).promise;
    return {
      dataURL: canvas.toDataURL("image/png"),
      width: canvas.width,
      height: canvas.height,
    };
  } catch {
    return null;
  }
}

/**
 * 把位图 dataURL（PNG 等）等比缩放到最长边 maxSide 内并转 JPEG dataURL：
 * PDF 导出用（超出 canvas 尺寸上限会导出失败/内存过大）。透明像素填白底
 * （JPEG 无透明度；导出 PNG 已带背景色时不受影响）。解码失败返回 null。
 */
export async function dataURLToJpeg(
  dataURL: string,
  maxSide: number,
): Promise<{ dataURL: string; width: number; height: number } | null> {
  try {
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => resolve(null);
      el.src = dataURL;
    });
    if (!img) {
      return null;
    }
    const scale = Math.min(
      1,
      maxSide / Math.max(img.naturalWidth, img.naturalHeight),
    );
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return { dataURL: canvas.toDataURL("image/jpeg", 0.9), width: w, height: h };
  } catch {
    return null;
  }
}
