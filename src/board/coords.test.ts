import { describe, expect, it } from "vitest";
import { canvasToLocal, localToCanvas, round1 } from "./coords";

describe("round1", () => {
  it("保留 1 位小数", () => {
    expect(round1(3.14159)).toBe(3.1);
    expect(round1(2.05)).toBe(2.1);
    expect(round1(-1.04)).toBe(-1);
    expect(round1(0)).toBe(0);
  });
});

describe("localToCanvas", () => {
  it("无旋转时叠加 x/y 偏移", () => {
    const box = { x: 10, y: 20, width: 100, height: 50 };
    expect(localToCanvas(box, { x: 0, y: 0 })).toEqual({ x: 10, y: 20 });
    expect(localToCanvas(box, { x: 100, y: 50 })).toEqual({ x: 110, y: 70 });
  });

  it("旋转 90°：左上角绕中心转到右下角方位", () => {
    const box = { x: 10, y: 20, width: 100, height: 50, rotation: 90 };
    const p = localToCanvas(box, { x: 0, y: 0 });
    expect(p.x).toBeCloseTo(85);
    expect(p.y).toBeCloseTo(-5);
  });

  it("与 canvasToLocal 互逆（含旋转 45°）", () => {
    const box = { x: 33, y: -17, width: 80, height: 40, rotation: 45 };
    for (const p of [
      { x: 0, y: 0 },
      { x: 80, y: 40 },
      { x: 12.5, y: -3.7 },
      { x: 40, y: 20 },
    ]) {
      const back = canvasToLocal(box, localToCanvas(box, p));
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });
});

describe("canvasToLocal", () => {
  it("无旋转时减去 x/y 偏移", () => {
    const box = { x: 10, y: 20, width: 100, height: 50 };
    expect(canvasToLocal(box, { x: 10, y: 20 })).toEqual({ x: 0, y: 0 });
    expect(canvasToLocal(box, { x: 110, y: 70 })).toEqual({ x: 100, y: 50 });
  });
});
