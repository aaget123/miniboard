import { describe, expect, it } from "vitest";
import { isSketchable, redrawRough, sketchifyData } from "./rough";
import type { ElementData } from "../types";

/** 构造标准图形元素 */
function shape(partial: Partial<ElementData> & { type: ElementData["type"] }): ElementData {
  return {
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    stroke: "#000000",
    strokeWidth: 2,
    ...partial,
  };
}

describe("isSketchable 类型判定", () => {
  it("标准几何可转换，已手绘/画笔/文本/图片/frame 不可转换", () => {
    expect(isSketchable(shape({ type: "rect" }))).toBe(true);
    expect(isSketchable(shape({ type: "ellipse" }))).toBe(true);
    expect(isSketchable(shape({ type: "line", points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }))).toBe(true);
    expect(isSketchable(shape({ type: "arrow", points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }))).toBe(true);
    // 已手绘：rough 元数据存在即跳过
    expect(isSketchable(shape({ type: "path", path: "M0 0 L1 1 Z", rough: { seed: 1 } }))).toBe(false);
    expect(isSketchable(shape({ type: "text", text: "hi" }))).toBe(false);
    expect(isSketchable(shape({ type: "freehand", penPoints: [[0, 0]] }))).toBe(false);
    expect(isSketchable(shape({ type: "image", url: "x" }))).toBe(false);
    expect(isSketchable(shape({ type: "frame" }))).toBe(false);
  });

  it("path 仅标准多边形（M/L/Z）可转换，曲线/画笔笔迹不可转换", () => {
    expect(isSketchable(shape({ type: "path", path: "M0 0 L50 0 L50 50 L0 50 Z" }))).toBe(true);
    // 未闭合（无 Z）不可转换
    expect(isSketchable(shape({ type: "path", path: "M0 0 L50 0 L50 50" }))).toBe(false);
    // 含曲线命令（画笔笔迹/自由曲线）不可转换
    expect(isSketchable(shape({ type: "path", path: "M0 0 C1 1 2 2 3 3 Z" }))).toBe(false);
    expect(isSketchable(shape({ type: "path", path: "M0 0 L1 1 Q2 2 3 3 Z" }))).toBe(false);
  });
});

describe("sketchifyData 手绘化", () => {
  it("矩形/椭圆/直线/多边形均输出可渲染 path 与 seed", () => {
    const cases: ElementData[] = [
      shape({ type: "rect" }),
      shape({ type: "ellipse" }),
      shape({ type: "line", points: [{ x: 0, y: 0 }, { x: 80, y: 40 }] }),
      shape({ type: "path", path: "M0 0 L50 0 L50 50 Z" }),
    ];
    for (const d of cases) {
      const out = sketchifyData(d);
      expect(out).not.toBeNull();
      expect(out!.path.length).toBeGreaterThan(10);
      expect(out!.seed).toBeGreaterThan(0);
    }
  });

  it("不可转换类型返回 null", () => {
    expect(sketchifyData(shape({ type: "text", text: "hi" }))).toBeNull();
    expect(sketchifyData(shape({ type: "freehand", penPoints: [[0, 0]] }))).toBeNull();
  });
});

describe("redrawRough 按 seed/粗糙度重绘", () => {
  it("同一 seed 不同 roughness：输出不同但均可渲染（形态确定可复现）", () => {
    const d = shape({ type: "rect" });
    const a = redrawRough(d, { seed: 42, original: "rect" }, 0.5);
    const b = redrawRough(d, { seed: 42, original: "rect" }, 2);
    const c = redrawRough(d, { seed: 42, original: "rect" }, 2);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.path).not.toBe(b!.path); // 粗糙度改变抖动幅度
    expect(b!.path).toBe(c!.path); // 同 seed + 同 roughness 完全复现
  });

  it("rect/ellipse 从元素当前 width/height 重绘", () => {
    const d = shape({ type: "rect", width: 200, height: 80 });
    const out = redrawRough(d, { seed: 7, original: "rect" }, 1);
    expect(out).not.toBeNull();
    const wide = redrawRough(shape({ type: "rect", width: 400, height: 80 }), { seed: 7, original: "rect" }, 1);
    expect(out!.path).not.toBe(wide!.path); // 尺寸变化 → 路径不同
  });

  it("多边形用 originalPath 重绘（手绘化后原 path 已丢失）", () => {
    const d = shape({
      type: "path",
      path: "M0 0 L50 0 L50 50 L0 50 Z", // 手绘化后的 path（不再含原始顶点）
    });
    const meta = {
      seed: 9,
      original: "path",
      originalPath: "M0 0 L100 0 L100 60 Z", // 原始三角形顶点
    };
    const out = redrawRough(d, meta, 1.2);
    expect(out).not.toBeNull();
    // 无 originalPath 时无法重绘（当前 path 已被手绘替换，顶点不可解析）
    expect(redrawRough(d, { seed: 9, original: "path" }, 1.2)).toBeNull();
  });

  it("line/arrow 用 points 重绘；点数不足返回 null", () => {
    const d = shape({ type: "arrow", points: [{ x: 0, y: 0 }, { x: 60, y: 30 }] });
    expect(redrawRough(d, { seed: 3, original: "arrow" }, 1)).not.toBeNull();
    expect(redrawRough(d, { seed: 3, original: "line" }, 1)).not.toBeNull();
    const noPts = shape({ type: "line" });
    expect(redrawRough(noPts, { seed: 3, original: "line" }, 1)).toBeNull();
  });

  it("未知 original 类型返回 null（数据损坏保护）", () => {
    const d = shape({ type: "rect" });
    expect(redrawRough(d, { seed: 1, original: "text" }, 1)).toBeNull();
  });

  it("seed 不同则抖动形态不同（改 seed 无接口，但保证 seed 语义正确）", () => {
    const d = shape({ type: "ellipse" });
    const a = redrawRough(d, { seed: 1, original: "ellipse" }, 1);
    const b = redrawRough(d, { seed: 2, original: "ellipse" }, 1);
    expect(a!.path).not.toBe(b!.path);
  });
});
