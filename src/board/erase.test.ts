import { describe, expect, it } from "vitest";
import { splitArrowHeads, splitErasedPoints } from "./stroke";

/** 生成水平直线点列：0 到 (n-1)*step */
const line = (n: number, step = 10): number[][] =>
  Array.from({ length: n }, (_, i) => [i * step, 0]);

describe("splitErasedPoints（橡皮分段擦除）", () => {
  it("中间擦除：拆成两段", () => {
    const pts = line(11); // 0..100
    const segs = splitErasedPoints(pts, [{ x: 50, y: 0 }], 6);
    expect(segs.length).toBe(2);
    // 中点 50 被擦除：两段合计点数 = 总点数 - 1
    expect(segs[0].length + segs[1].length).toBe(pts.length - 1);
    // 左段以 40 结尾，右段从 60 开始
    expect(segs[0][segs[0].length - 1][0]).toBe(40);
    expect(segs[1][0][0]).toBe(60);
  });

  it("端点擦除：只剩一段", () => {
    const pts = line(11);
    const segs = splitErasedPoints(pts, [{ x: 0, y: 0 }], 6);
    expect(segs.length).toBe(1);
    expect(segs[0][0][0]).toBeGreaterThan(0);
    expect(segs[0].length).toBe(10);
  });

  it("全部擦除：无剩余段", () => {
    const pts = line(11);
    const segs = splitErasedPoints(
      pts,
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      6,
    );
    expect(segs).toEqual([]);
  });

  it("轨迹插值：两点间快速划过不漏擦", () => {
    const pts = line(11);
    // 轨迹两点相距 100，中间点靠插值覆盖（起点终点都在线外）
    const segs = splitErasedPoints(
      pts,
      [
        { x: -5, y: 0 },
        { x: 105, y: 0 },
      ],
      6,
    );
    expect(segs).toEqual([]);
  });

  it("半径外不擦除", () => {
    const pts = line(5); // 0..40
    const segs = splitErasedPoints(pts, [{ x: 50, y: 0 }], 6);
    expect(segs.length).toBe(1);
    expect(segs[0].length).toBe(5);
  });

  it("孤点段丢弃：擦除后只剩 1 点的段被舍弃", () => {
    const pts = line(6); // 0..50
    // 擦除 20 与 40：左侧剩 [0,10]，中间 [30] 孤点丢弃，右侧 [50] 孤点丢弃
    const segs = splitErasedPoints(
      pts,
      [
        { x: 20, y: 0 },
        { x: 40, y: 0 },
      ],
      6,
    );
    expect(segs.length).toBe(1);
    expect(segs[0].length).toBe(2);
  });

  it("压力维度保留", () => {
    const pts = [
      [0, 0, 0.5],
      [10, 0, 0.8],
      [20, 0, 1],
      [30, 0, 0.7],
    ];
    const segs = splitErasedPoints(pts, [{ x: 20, y: 0 }], 6);
    expect(segs.length).toBe(1);
    expect(segs[0][1]).toEqual([10, 0, 0.8]);
  });

  it("空输入：空点列/空轨迹安全返回", () => {
    expect(splitErasedPoints([], [{ x: 0, y: 0 }], 6)).toEqual([]);
    expect(splitErasedPoints(line(3), [], 6).length).toBe(1);
  });
});

describe("splitArrowHeads（分段擦除的端点样式分配）", () => {
  it("单段：两端原样保留", () => {
    expect(splitArrowHeads(1, "triangle", "dot")).toEqual([{ start: "triangle", end: "dot" }]);
  });

  it("多段：首段保起点、末段保终点、中间无端点", () => {
    const heads = splitArrowHeads(3, "triangle", "arrow");
    expect(heads[0]).toEqual({ start: "triangle", end: undefined });
    expect(heads[1]).toEqual({ start: undefined, end: undefined });
    expect(heads[2]).toEqual({ start: undefined, end: "arrow" });
  });

  it("两段与空输入边界", () => {
    const two = splitArrowHeads(2, "circle", undefined);
    expect(two[0].start).toBe("circle");
    expect(two[1].end).toBeUndefined();
    expect(two[0].end).toBeUndefined();
    expect(splitArrowHeads(0, "arrow", "arrow")).toEqual([]);
  });
});
