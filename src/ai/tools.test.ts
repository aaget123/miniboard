import { describe, expect, it, vi } from "vitest";
import { describeCanvas, parseLeaferJSON } from "./tools";
import type { Board } from "../board/canvas";
import type { ElementData } from "../types";

// tools.ts 值导入了 canvas.ts 的 TEXT_FONT_SIZE（会连带加载 leafer DOM 依赖），
// 此处仅 mock 该常量，describeCanvas 本身不依赖画布实例的实际实现
vi.mock("../board/canvas", () => ({
  TEXT_FONT_SIZE: 16,
}));

/** 构造最小 Board mock：describeCanvas 仅用到 serialize/backgroundColor/viewport */
function mockBoard(elements: ElementData[], background = "#ffffff"): Board {
  return {
    serialize: () => elements,
    backgroundColor: background,
    viewport: {
      view: { width: 1200, height: 800 },
      minX: 0,
      minY: 0,
      maxX: 1200,
      maxY: 800,
      center: { x: 600, y: 400 },
      scale: 1,
    },
  } as unknown as Board;
}

function rect(x: number, y: number, w: number, h: number): ElementData {
  return { type: "rect", x, y, width: w, height: h };
}

describe("describeCanvas 单模态画面感知", () => {
  it("空画布：摘要明确标注画布是空的", () => {
    const out = describeCanvas(mockBoard([]));
    expect(out).toContain("画布是空的");
  });

  it("元素按内容包围盒九宫格映射 region 标签（左中/中心/右中）", () => {
    const els = [rect(0, 0, 100, 100), rect(400, 0, 100, 100), rect(800, 0, 100, 100)];
    const out = describeCanvas(mockBoard(els));
    const json = out.slice(out.indexOf("\n") + 1);
    const data = JSON.parse(json) as { region: string }[];
    expect(data.map((d) => d.region)).toEqual(["左中", "中心", "右中"]);
  });

  it("摘要输出空间分布统计与 region 语义说明", () => {
    const els = [
      rect(0, 0, 100, 100), // 中心 (50,50) → 左中
      rect(400, 0, 100, 100), // 中心 (450,50) → 中心
      rect(800, 0, 100, 100), // 中心 (850,50) → 右中
    ];
    const out = describeCanvas(mockBoard(els));
    expect(out).toContain("空间分布：左中 1 个、中心 1 个、右中 1 个");
    expect(out).toContain("region 字段表示其中心在内容包围盒 3×3 均分中的位置");
  });

  it("包围盒退化为点（单个元素）时归入中心", () => {
    const out = describeCanvas(mockBoard([rect(10, 20, 50, 30)]));
    const json = out.slice(out.indexOf("\n") + 1);
    const data = JSON.parse(json) as { region: string }[];
    expect(data[0].region).toBe("中心");
  });

  it("对角线分布：左上角与右下角区域标签正确", () => {
    const els = [rect(0, 0, 50, 50), rect(900, 500, 50, 50)];
    const out = describeCanvas(mockBoard(els));
    const json = out.slice(out.indexOf("\n") + 1);
    const data = JSON.parse(json) as { region: string }[];
    // 包围盒 x 0~950（w=950），y 0~550（h=550）；A 中心 (25,25) → 左上，B 中心 (925,525) → 右下
    expect(data.map((d) => d.region)).toEqual(["左上", "右下"]);
    expect(out).toContain("空间分布：左上 1 个、右下 1 个");
  });

  it("带 intent 的元素输出意图字段，且摘要说明其来源是 AI 自报", () => {
    const els = [
      { ...rect(0, 0, 100, 100), intent: "流程起点" },
      rect(400, 0, 100, 100),
    ];
    const out = describeCanvas(mockBoard(els));
    const json = out.slice(out.indexOf("\n") + 1);
    const data = JSON.parse(json) as { intent?: string }[];
    expect(data[0].intent).toBe("流程起点");
    expect(data[1].intent).toBeUndefined(); // 无 intent 的元素不输出该字段
    expect(out).toContain("部分元素带 intent 字段：AI 创建时自报的创建意图");
  });

  it("全部元素无 intent 时摘要不出现意图说明", () => {
    const out = describeCanvas(mockBoard([rect(0, 0, 100, 100)]));
    expect(out).not.toContain("intent");
  });
});

describe("parseLeaferJSON intent 透传", () => {
  it("rect 元素保留自报 intent", () => {
    const r = parseLeaferJSON([
      { type: "rect", x: 10, y: 20, width: 100, height: 50, intent: "标题" },
    ]);
    expect(r[0].data?.intent).toBe("标题");
  });

  it("line/arrow 元素保留自报 intent", () => {
    const r = parseLeaferJSON([
      {
        type: "arrow",
        x: 0,
        y: 0,
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
        intent: "指向下一步",
      },
    ]);
    expect(r[0].data?.intent).toBe("指向下一步");
  });

  it("intent 非字符串时忽略（非法值不进入数据）", () => {
    const r = parseLeaferJSON([
      { type: "rect", x: 0, y: 0, intent: 123 },
    ]);
    expect(r[0].data?.intent).toBeUndefined();
  });
});
