import { describe, expect, it } from "vitest";
import { describeFreehandShape } from "./beautify";
import type { ElementData } from "../types";

/** 构造 freehand 测试元素：penPoints 为相对元素原点的采样点 */
function freehand(penPoints: number[][]): ElementData {
  return {
    type: "freehand",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    penPoints,
  };
}

/**
 * 真实感手绘圆：非均匀角度 + 径向抖动（确定性，模拟手抖），末点回到起点。
 * 注意：完美均匀圆周会退化简化成正多边形（误判），必须带扰动。
 */
function wobblyCircle(r: number, n: number, amp: number): number[][] {
  const pts = Array.from({ length: n - 1 }, (_, i) => {
    const a = (i / (n - 1)) * Math.PI * 2 + 0.6 * Math.sin(i * 1.3);
    const rr = r + amp * Math.sin(i * 2.5);
    return [rr * Math.cos(a), rr * Math.sin(a)];
  });
  pts.push(pts[0]);
  return pts;
}

/** 真实感手绘椭圆（长轴 rx、短轴 ry + 抖动），末点回到起点 */
function wobblyEllipse(rx: number, ry: number, n: number, amp: number): number[][] {
  const pts = Array.from({ length: n - 1 }, (_, i) => {
    const a = (i / (n - 1)) * Math.PI * 2 + 0.6 * Math.sin(i * 1.3);
    return [
      (rx + amp * Math.sin(i * 2.1)) * Math.cos(a),
      (ry + amp * Math.sin(i * 2.1)) * Math.sin(a),
    ];
  });
  pts.push(pts[0]);
  return pts;
}

/**
 * 真实感手绘矩形：四边等量对称采样（含角点）+ 微抖动。
 * 四边采样须对称：采样不均会使质心偏离中心，PCA 主轴偏转导致矩形判定失败。
 */
function wobblyRect(w: number, h: number, nPer: number): number[][] {
  const pts: number[][] = [];
  const j = (i: number) => 0.8 * Math.sin(i * 1.7);
  for (let i = 0; i < nPer; i++) pts.push([(i / (nPer - 1)) * w + j(i), j(i + 10)]);
  for (let i = 0; i < nPer; i++) pts.push([w + j(i + 3), (i / (nPer - 1)) * h + j(i + 7)]);
  for (let i = 0; i < nPer; i++) pts.push([w - (i / (nPer - 1)) * w + j(i + 5), h + j(i + 2)]);
  for (let i = 0; i < nPer; i++) pts.push([j(i + 9), h - (i / (nPer - 1)) * h + j(i + 4)]);
  return pts;
}

describe("describeFreehandShape", () => {
  it("采样点不足 3 个时无法识别", () => {
    expect(
      describeFreehandShape(
        freehand([
          [0, 0],
          [10, 10],
        ]),
      ),
    ).toBeNull();
  });

  it("识别闭合的圆形（含 x/y 偏移）", () => {
    const e = freehand(wobblyCircle(50, 32, 4));
    e.x = 100;
    e.y = 50;
    expect(describeFreehandShape(e)).toBe("手绘的圆形");
  });

  it("识别闭合的椭圆（长短轴比超出正圆区间）", () => {
    const e = freehand(wobblyEllipse(100, 60, 32, 3));
    expect(describeFreehandShape(e)).toBe("手绘的椭圆");
  });

  it("识别闭合的矩形", () => {
    const e = freehand(wobblyRect(120, 80, 5));
    expect(describeFreehandShape(e)).toBe("手绘的矩形");
  });

  it("开放笔迹简化后仅剩两点 → 近似直线", () => {
    const e = freehand([
      [0, 0],
      [50, 2],
      [100, 1],
    ]);
    expect(describeFreehandShape(e)).toBe("近似直线的手绘笔迹");
  });

  it("杂乱开放笔迹无法识别", () => {
    const e = freehand([
      [0, 0],
      [30, 8],
      [55, 25],
      [40, 60],
      [10, 70],
      [-15, 45],
      [-20, 15],
    ]);
    expect(describeFreehandShape(e)).toBeNull();
  });

  it("闭合但采样点太少不判形（走开放简化路径）", () => {
    // 5 点闭合三角形：闭合但不满足 MIN_PTS，简化后保留 3 顶点
    const e = freehand([
      [0, 0],
      [60, 0],
      [30, 40],
      [28, 42],
      [0, 0],
    ]);
    expect(describeFreehandShape(e)).toBeNull();
  });
});
