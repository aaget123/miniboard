import { describe, expect, it } from "vitest";
import { validateElementData, validateElementList } from "./validate";
import { scanGeneratorSource } from "./registry";

describe("validateElementData", () => {
  it("接受合法矩形（宽高省略时补 0）", () => {
    const r = validateElementData({ type: "rect", x: 10, y: 20, width: 100, height: 50 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toMatchObject({ type: "rect", x: 10, y: 20, width: 100, height: 50 });
    }
  });

  it("拒绝 fill 为 none", () => {
    const r = validateElementData({
      type: "rect",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fill: "none",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("none");
    }
  });

  it("拒绝非法 type / 缺坐标 / 负宽高", () => {
    expect(validateElementData({ type: "circle", x: 0, y: 0 }).ok).toBe(false);
    expect(validateElementData({ type: "rect", x: 0 }).ok).toBe(false);
    const neg = validateElementData({ type: "rect", x: 0, y: 0, width: -5, height: 10 });
    expect(neg.ok).toBe(false);
    if (!neg.ok) {
      expect(neg.error).toContain("width");
    }
  });

  it("line/arrow 需要至少 2 个 points 点", () => {
    expect(validateElementData({ type: "line", x: 0, y: 0, points: [{ x: 1, y: 1 }] }).ok).toBe(
      false,
    );
    expect(
      validateElementData({
        type: "arrow",
        x: 0,
        y: 0,
        points: [
          { x: 1, y: 1 },
          { x: 5, y: 5 },
        ],
      }).ok,
    ).toBe(true);
  });

  it("path 需要 path 字符串，text 需要 text 字符串", () => {
    expect(validateElementData({ type: "path", x: 0, y: 0, width: 10, height: 10 }).ok).toBe(false);
    expect(
      validateElementData({
        type: "path",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        path: "M 0 0 L 10 10",
      }).ok,
    ).toBe(true);
    expect(validateElementData({ type: "text", x: 0, y: 0 }).ok).toBe(false);
    expect(validateElementData({ type: "text", x: 0, y: 0, text: "你好" }).ok).toBe(true);
  });

  it("path/line/arrow 的 x/y 必须为 0（绝对坐标契约，非零会双重偏移）", () => {
    const pathBad = validateElementData({ type: "path", x: 10, y: 20, path: "M 0 0 L 10 10" });
    expect(pathBad.ok).toBe(false);
    if (!pathBad.ok) {
      expect(pathBad.error).toContain("x/y 必须为 0");
    }
    const lineBad = validateElementData({
      type: "line",
      x: 5,
      y: 0,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
    });
    expect(lineBad.ok).toBe(false);
    if (!lineBad.ok) {
      expect(lineBad.error).toContain("x/y 必须为 0");
    }
    expect(validateElementData({ type: "path", x: 0, y: 0, path: "M 0 0 L 10 10" }).ok).toBe(true);
  });

  it("strokeWidth 负数/NaN 被拒绝", () => {
    expect(
      validateElementData({ type: "rect", x: 0, y: 0, width: 10, height: 10, strokeWidth: -1 }).ok,
    ).toBe(false);
    expect(
      validateElementData({
        type: "rect",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        strokeWidth: Number.NaN,
      }).ok,
    ).toBe(false);
  });

  it("text 元素校验文本排版扩展字段", () => {
    const r = validateElementData({
      type: "text",
      x: 0,
      y: 0,
      text: "你好",
      textAlign: "right",
      fontFamily: "宋体",
      fontWeight: 700,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toMatchObject({
        textAlign: "right",
        fontFamily: "宋体",
        fontWeight: 700,
      });
    }
    // 旧数据 normal/bold 字符串归一化为数字档位
    const old = validateElementData({
      type: "text",
      x: 0,
      y: 0,
      text: "x",
      fontWeight: "bold",
    });
    expect(old.ok).toBe(true);
    if (old.ok) {
      expect(old.data.fontWeight).toBe(700);
    }
    expect(validateElementData({ type: "text", x: 0, y: 0, text: "x", fontWeight: 950 }).ok).toBe(
      false,
    );
    expect(
      validateElementData({ type: "text", x: 0, y: 0, text: "x", fontWeight: "heavy" }).ok,
    ).toBe(false);
  });

  it("frame 接受合法内容框架并透传扩展字段", () => {
    const r = validateElementData({
      type: "frame",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      name: "README.md",
      contentType: "markdown",
      content: "# 标题",
      autoSize: true,
      constrain: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toMatchObject({
        name: "README.md",
        contentType: "markdown",
        content: "# 标题",
        autoSize: true,
        constrain: false,
      });
    }
  });

  it("frame 拒绝非法 contentType / 缺 content / 非布尔开关 / 非字符串 name", () => {
    expect(
      validateElementData({
        type: "frame",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        contentType: "pdf",
        content: "x",
      }).ok,
    ).toBe(false);
    expect(
      validateElementData({ type: "frame", x: 0, y: 0, width: 10, height: 10, contentType: "code" })
        .ok,
    ).toBe(false);
    expect(
      validateElementData({ type: "frame", x: 0, y: 0, width: 10, height: 10, content: 123 }).ok,
    ).toBe(false);
    expect(
      validateElementData({
        type: "frame",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        content: "x",
        autoSize: "yes",
      }).ok,
    ).toBe(false);
    expect(
      validateElementData({
        type: "frame",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        content: "x",
        constrain: 1,
      }).ok,
    ).toBe(false);
    expect(
      validateElementData({
        type: "frame",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        content: "x",
        name: 5,
      }).ok,
    ).toBe(false);
  });

  it("frame 旧数据（无扩展字段）通过且不注入默认值", () => {
    const r = validateElementData({ type: "frame", x: 0, y: 0, width: 100, height: 60 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.content).toBeUndefined();
      expect(r.data.contentType).toBeUndefined();
      expect(r.data.autoSize).toBeUndefined();
      expect(r.data.constrain).toBeUndefined();
      expect(r.data.name).toBeUndefined();
    }
  });
});

describe("validateElementList", () => {
  it("单元素对象自动包装为列表", () => {
    const r = validateElementList({ type: "rect", x: 0, y: 0, width: 10, height: 10 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toHaveLength(1);
    }
  });

  it("接受组合工具数组，拒绝空数组与超上限", () => {
    const ok = validateElementList([
      { type: "text", x: 0, y: 0, text: "标题" },
      {
        type: "line",
        x: 0,
        y: 0,
        points: [
          { x: 0, y: 5 },
          { x: 50, y: 5 },
        ],
      },
    ]);
    expect(ok.ok).toBe(true);
    expect(validateElementList([]).ok).toBe(false);
    expect(
      validateElementList(Array.from({ length: 9 }, () => ({ type: "rect", x: 0, y: 0 }))).ok,
    ).toBe(false);
  });

  it("数组内某个元素非法时给出序号", () => {
    const r = validateElementList([
      { type: "rect", x: 0, y: 0, width: 10, height: 10 },
      { type: "line", x: 0, y: 0 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("第 2 个元素");
    }
  });
});

describe("scanGeneratorSource", () => {
  it("纯数学计算通过", () => {
    const code = `(ctx) => { const { x0, y0, x1, y1, style } = ctx; return { type: "rect", x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), stroke: style.stroke }; }`;
    expect(scanGeneratorSource(code)).toEqual([]);
  });

  it("拒绝 while 循环 / fetch / DOM 访问", () => {
    expect(scanGeneratorSource(`(ctx) => { while (true) {} }`)).toContain("while 循环");
    expect(scanGeneratorSource(`(ctx) => { return fetch("https://x") }`)).toContain(
      "fetch（网络请求）",
    );
    expect(scanGeneratorSource(`(ctx) => { document.body.style }`)).toContain(
      "document（DOM API）",
    );
    expect(scanGeneratorSource(`(ctx) => { eval("1+1") }`)).toContain("eval");
  });

  it("click 类工具拒绝随机函数（drag 类允许）", () => {
    const randomCode = `(ctx) => { const r = 10 + Math.random() * 30; return { type: "rect", x: ctx.x0 - r, y: ctx.y0 - r, width: r * 2, height: r * 2 }; }`;
    expect(scanGeneratorSource(randomCode, "click")).toContain(
      "随机函数（点击类工具必须固定大小、以点击点为中心，禁止随机）",
    );
    expect(scanGeneratorSource(randomCode, "drag")).toEqual([]);
    expect(scanGeneratorSource(randomCode)).toEqual([]);
    // 固定尺寸、以点击点为中心的 click 生成器通过
    const fixedCode = `(ctx) => ({ type: "rect", x: ctx.x0 - 20, y: ctx.y0 - 20, width: 40, height: 40, stroke: ctx.style.stroke })`;
    expect(scanGeneratorSource(fixedCode, "click")).toEqual([]);
  });
});
