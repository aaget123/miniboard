import { describe, expect, it } from "vitest";
import { offsetElementData } from "./offset";

describe("offsetElementData", () => {
  it("零位移或空数据原样返回", () => {
    const d = { type: "rect" as const, x: 0, y: 0, width: 10, height: 10 };
    expect(offsetElementData(d, 0, 0)).toBe(d);
  });

  it("rect/ellipse/text/image 直接平移 x/y", () => {
    expect(
      offsetElementData({ type: "rect", x: 10, y: 20, width: 30, height: 40 }, 5, 7),
    ).toMatchObject({ x: 15, y: 27, width: 30, height: 40 });
    expect(
      offsetElementData({ type: "text", x: 1, y: 2, width: 10, height: 10, text: "hi" }, -1, 3),
    ).toMatchObject({ x: 0, y: 5, text: "hi" });
    expect(
      offsetElementData({ type: "ellipse", x: 0, y: 0, width: 5, height: 5 }, 2, 2),
    ).toMatchObject({ x: 2, y: 2 });
  });

  it("line/arrow 平移 points，x/y 保持原值（绝对坐标契约）", () => {
    const d = offsetElementData(
      {
        type: "line",
        x: 0,
        y: 0,
        width: 10,
        height: 5,
        points: [
          { x: 100, y: 200 },
          { x: 110, y: 205 },
        ],
      },
      12,
      34,
    );
    expect(d).toMatchObject({
      x: 0,
      y: 0,
      points: [
        { x: 112, y: 234 },
        { x: 122, y: 239 },
      ],
    });
    expect(
      offsetElementData(
        {
          type: "arrow",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          points: [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
          ],
        },
        1,
        1,
      ),
    ).toMatchObject({
      points: [
        { x: 2, y: 2 },
        { x: 3, y: 3 },
      ],
    });
  });

  it("path 平移 path 字符串，x/y 保持原值", () => {
    const d = offsetElementData(
      { type: "path", x: 0, y: 0, width: 36, height: 34, path: "M 100 82 L 110 92 Z" },
      50,
      60,
    );
    expect(d).toMatchObject({
      x: 0,
      y: 0,
      path: "M 150 142 L 160 152 Z",
    });
  });

  it("freehand 平移 x/y 与 penPoints 采样点", () => {
    const d = offsetElementData(
      {
        type: "freehand",
        x: 3,
        y: 4,
        width: 10,
        height: 10,
        path: "M 0 0 L 5 5",
        penPoints: [
          [10, 20],
          [12, 22],
        ],
        penSize: 2,
      },
      100,
      200,
    );
    expect(d).toMatchObject({
      x: 103,
      y: 204,
      penPoints: [
        [110, 220],
        [112, 222],
      ],
      path: "M 0 0 L 5 5",
    });
  });
});
