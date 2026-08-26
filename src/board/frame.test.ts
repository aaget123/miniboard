// frame 内容容器纯函数测试：autoSize 尺寸估算 / 换行规范化 / 折行 / 折叠高度 / 滚动上限 / 夹紧平移量 / SVG 内容导出 / 坐标契约往返
import { describe, expect, it } from "vitest";
import {
  FRAME_COLLAPSED_HEIGHT,
  clampShift,
  collapsedFrameHeight,
  contractFrameContents,
  expandFrameContents,
  frameContentSize,
  frameScrollMax,
  normalizeContent,
  wrapLine,
} from "./frame";
import type { ElementData } from "../types";
import { elementsToSVG } from "./svg";

describe("normalizeContent（换行符规范化）", () => {
  it("\\r\\n 与 \\r 统一为 \\n（避免 \\r 残留渲染为乱码）", () => {
    expect(normalizeContent("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("纯 \\n 内容原样保留", () => {
    expect(normalizeContent("a\nb\n\nc")).toBe("a\nb\n\nc");
  });

  it("空内容返回空串", () => {
    expect(normalizeContent("")).toBe("");
  });
});

describe("wrapLine（单行按可用宽度折行）", () => {
  it("空行保留行位", () => {
    expect(wrapLine("", 100, 0.55)).toEqual([""]);
  });

  it("短行不折行", () => {
    expect(wrapLine("ab", 100, 0.55)).toEqual(["ab"]);
  });

  it("宽度恰好填满不折行（边界）", () => {
    expect(wrapLine("aaaa", 2.2, 0.55)).toEqual(["aaaa"]);
  });

  it("超宽折成多段", () => {
    expect(wrapLine("aaaaaa", 3, 0.55)).toEqual(["aaaaa", "a"]);
  });

  it("全角字符按 1em 计宽", () => {
    expect(wrapLine("你好世界", 2.9, 0.55)).toEqual(["你好", "世界"]);
  });
});

describe("frameContentSize（autoSize 内容撑框估算）", () => {
  it("短内容不低于最小宽度，高度按行数折算", () => {
    const s = frameContentSize("hello", "markdown");
    expect(s.width).toBe(200); // FRAME_MIN_WIDTH
    expect(s.height).toBeCloseTo(14 * 1.6 + 32, 5); // 1 行 + 上下内边距
  });

  it("行数越多高度越高（含空行）", () => {
    const h1 = frameContentSize("a\nb\nc", "text").height;
    const h2 = frameContentSize("a\nb\nc\n\nd", "text").height;
    expect(h2).toBeGreaterThan(h1);
    expect(h1).toBeCloseTo(3 * 14 * 1.6 + 32, 5);
  });

  it("全角按 1em、半角按 0.55em 折算宽度", () => {
    const cn = frameContentSize("你好世界".repeat(20), "text");
    const en = frameContentSize("a".repeat(80), "text");
    expect(cn.width).toBeGreaterThan(en.width);
    expect(en.width).toBeCloseTo(80 * 0.55 * 14 + 32, 5);
  });

  it("code 类型按等宽 0.62em（同文本更宽）", () => {
    const s = "const x = 1;".repeat(30); // 超最小宽，避免被钳制
    const code = frameContentSize(s, "code");
    const text = frameContentSize(s, "text");
    expect(code.width).toBeGreaterThan(text.width);
    expect(code.width).toBeCloseTo(s.length * 0.62 * 14 + 32, 5);
  });

  it("空内容退化为最小尺寸", () => {
    const s = frameContentSize("", "markdown");
    expect(s.width).toBe(200);
    expect(s.height).toBeCloseTo(14 * 1.6 + 32, 5);
  });

  it("\\r\\n 换行符先规范化再计行数", () => {
    const s = frameContentSize("a\r\nb\r\nc", "text");
    expect(s.height).toBeCloseTo(3 * 14 * 1.6 + 32, 5);
  });
});

describe("collapsedFrameHeight（折叠高度）", () => {
  it("内容超高时折叠到上限高度", () => {
    const h = collapsedFrameHeight("a\n".repeat(100), "text");
    expect(h).toBe(FRAME_COLLAPSED_HEIGHT);
  });

  it("内容不足一屏时返回 null（无需折叠）", () => {
    const h = collapsedFrameHeight("a\nb", "text");
    expect(h).toBeNull();
  });
});

describe("frameScrollMax（滚动上限）", () => {
  it("内容超出框架高度时返回可滚动余量", () => {
    const content = "a\n".repeat(100); // 远超折叠上限
    const max = frameScrollMax(content, "text", FRAME_COLLAPSED_HEIGHT);
    expect(max).toBeGreaterThan(0);
    expect(max).toBeCloseTo(
      frameContentSize(content, "text").height - FRAME_COLLAPSED_HEIGHT,
      5,
    );
  });

  it("内容不超框时返回 0（不可滚动）", () => {
    expect(frameScrollMax("a\nb", "text", FRAME_COLLAPSED_HEIGHT)).toBe(0);
  });

  it("折叠上限恰好等于内容高度时余量为 0", () => {
    const content = "a\n".repeat(40);
    const h = frameContentSize(content, "text").height;
    expect(frameScrollMax(content, "text", h)).toBeCloseTo(0, 5);
  });
});

describe("clampShift（夹紧平移量）", () => {
  const fb = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  it("完全在框内不移动", () => {
    expect(
      clampShift({ minX: 10, minY: 10, maxX: 20, maxY: 20 }, fb),
    ).toEqual({ dx: 0, dy: 0 });
  });

  it("左/上越界补回框内", () => {
    expect(clampShift({ minX: -5, minY: 0, maxX: 10, maxY: 10 }, fb)).toEqual({
      dx: 5,
      dy: 0,
    });
    expect(clampShift({ minX: 0, minY: -8, maxX: 10, maxY: 10 }, fb)).toEqual({
      dx: 0,
      dy: 8,
    });
    expect(clampShift({ minX: -5, minY: -8, maxX: 10, maxY: 10 }, fb)).toEqual({
      dx: 5,
      dy: 8,
    });
  });

  it("右/下越界补回框内", () => {
    expect(
      clampShift({ minX: 90, minY: 90, maxX: 105, maxY: 105 }, fb),
    ).toEqual({ dx: -5, dy: -5 });
  });

  it("元素大于框架时仅最小越界修正（保证起点不丢）", () => {
    // 宽 110 > 框宽 100：仅修正左侧越界，右侧不管
    expect(clampShift({ minX: -10, minY: 0, maxX: 100, maxY: 20 }, fb)).toEqual({
      dx: 10,
      dy: 0,
    });
    // 左右均越界但宽超框：把最小边拉回框边即可
    expect(clampShift({ minX: -5, minY: 0, maxX: 120, maxY: 20 }, fb)).toEqual({
      dx: 5,
      dy: 0,
    });
    // 超大元素整体偏右下：只修正上越界
    expect(
      clampShift({ minX: 50, minY: -30, maxX: 300, maxY: 50 }, fb),
    ).toEqual({ dx: 0, dy: 30 });
  });
});

describe("elementsToSVG frame 内容导出", () => {
  const base = { x: 0, y: 0, width: 200, height: 100, stroke: "#4f8cff" };

  it("无内容框架只导出虚线矩形", () => {
    const svg = elementsToSVG([{ type: "frame", ...base }], "#1e1f22");
    expect(svg).toContain('stroke-dasharray="8 5"');
    expect(svg).not.toContain("<text");
  });

  it("带内容框架导出内嵌文本（多行 tspan）", () => {
    const svg = elementsToSVG(
      [
        {
          type: "frame",
          ...base,
          contentType: "markdown",
          content: "# 标题\n正文",
        },
      ],
      "#1e1f22",
    );
    expect(svg).toContain('<text x="16" y="16"');
    expect(svg).toContain("# 标题");
    expect(svg).toContain('<tspan x="16" dy="22.4">正文</tspan>');
  });

  it("code 类型用等宽字体", () => {
    const svg = elementsToSVG(
      [{ type: "frame", ...base, contentType: "code", content: "let x = 1" }],
      "#1e1f22",
    );
    expect(svg).toContain("Consolas");
  });

  it("内容特殊字符转义", () => {
    const svg = elementsToSVG(
      [{ type: "frame", ...base, contentType: "text", content: "a < b & c > d" }],
      "#1e1f22",
    );
    expect(svg).toContain("a &lt; b &amp; c &gt; d");
  });
});

describe("contractFrameContents / expandFrameContents（坐标契约往返）", () => {
  const frame: ElementData = {
    type: "frame",
    id: "f1",
    x: 100,
    y: 50,
    width: 400,
    height: 300,
    rotation: 30,
  };

  it("rect 内容：世界 → 相对 → 世界 完全还原（含旋转框架）", () => {
    const world: ElementData = {
      type: "rect",
      x: 200,
      y: 120,
      width: 80,
      height: 60,
      frameId: "f1",
    };
    const local = contractFrameContents([frame, world]);
    const rel = local[1];
    expect(rel.x).not.toBe(200); // 确实转成了相对坐标
    const back = expandFrameContents(local);
    expect(back[1].x).toBeCloseTo(200, 6);
    expect(back[1].y).toBeCloseTo(120, 6);
    expect(back[1].frameId).toBeUndefined(); // 展开清 frameId
  });

  it("line 内容：points 并入相对坐标，x/y 归零；往返还原", () => {
    const world: ElementData = {
      type: "line",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      points: [
        { x: 150, y: 80 },
        { x: 260, y: 140 },
      ],
      frameId: "f1",
    };
    const local = contractFrameContents([frame, world]);
    expect(local[1].x).toBe(0);
    expect(local[1].y).toBe(0);
    const back = expandFrameContents(local);
    expect(back[1].points![0].x).toBeCloseTo(150, 6);
    expect(back[1].points![0].y).toBeCloseTo(80, 6);
    expect(back[1].points![1].x).toBeCloseTo(260, 6);
    expect(back[1].points![1].y).toBeCloseTo(140, 6);
  });

  it("path 内容：path 数据整体换算，往返还原", () => {
    const world: ElementData = {
      type: "path",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      path: "M 150 80 L 260 140",
      frameId: "f1",
    };
    const local = contractFrameContents([frame, world]);
    expect(local[1].path).not.toBe(world.path);
    const back = expandFrameContents(local);
    // 往返后精确还原原始 path 数据
    expect(back[1].path).toBe("M 150 80 L 260 140");
  });

  it("框架不在场景中：按自由元素输出（清 frameId 保留世界坐标）", () => {
    const orphan: ElementData = {
      type: "rect",
      x: 42,
      y: 43,
      width: 10,
      height: 10,
      frameId: "missing",
    };
    const out = contractFrameContents([orphan]);
    expect(out[0].frameId).toBeUndefined();
    expect(out[0].x).toBe(42);
    const back = expandFrameContents([{ ...orphan }]);
    expect(back[0].frameId).toBeUndefined();
    expect(back[0].x).toBe(42);
  });

  it("无 frameId 的元素原样返回（引用不变）", () => {
    const free: ElementData = { type: "ellipse", x: 1, y: 2, width: 3, height: 4 };
    const out = contractFrameContents([free]);
    expect(out[0]).toBe(free);
  });
});
