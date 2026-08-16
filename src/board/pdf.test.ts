import { describe, expect, it } from "vitest";
import { jpegToPdf } from "./pdf";

// 1x1 像素 JPEG（最小合法 JPEG，编码后固定字节）
const JPEG_1PX =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

describe("jpegToPdf", () => {
  it("生成以 %PDF 开头、%%EOF 结尾的文档", () => {
    const bytes = jpegToPdf(JPEG_1PX, 100, 200);
    const head = new TextDecoder("latin1").decode(bytes.slice(0, 8));
    const tail = new TextDecoder("latin1").decode(bytes.slice(-5));
    expect(head).toBe("%PDF-1.4");
    expect(tail).toBe("%%EOF");
  });

  it("页面尺寸写入 MediaBox", () => {
    const bytes = jpegToPdf(JPEG_1PX, 321, 654);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("/MediaBox [0 0 321 654]");
    expect(text).toContain("/Width 321");
    expect(text).toContain("/Height 654");
  });

  it("嵌入 JPEG 原始字节（DCTDecode）", () => {
    const bytes = jpegToPdf(JPEG_1PX, 1, 1);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("/Filter /DCTDecode");
    // JPEG 标志（SOI）
    const start = text.indexOf("stream\n") + "stream\n".length;
    expect(text.slice(start, start + 4)).toContain("\u00ff\u00d8\u00ff\u00e0");
  });

  it("xref 偏移精确指向各对象起点", () => {
    const bytes = jpegToPdf(JPEG_1PX, 64, 64);
    const text = new TextDecoder("latin1").decode(bytes);
    const xrefIdx = text.indexOf("xref\n");
    const lines = text.slice(xrefIdx).split("\n");
    // 行 0：xref / 行 1：0 6 / 行 2：对象 0 条目 / 行 3..7：对象 1..5 条目
    const entries: number[] = [];
    for (let i = 3; i <= 7; i++) {
      entries.push(parseInt(lines[i].slice(0, 10), 10));
    }
    for (const [i, offset] of entries.entries()) {
      expect(text.slice(offset, offset + 8)).toBe(`${i + 1} 0 obj\n`);
    }
  });

  it("startxref 指向 xref 表起点", () => {
    const bytes = jpegToPdf(JPEG_1PX, 8, 8);
    const text = new TextDecoder("latin1").decode(bytes);
    const startxref = parseInt(text.split("startxref\n")[1], 10);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
  });
});
