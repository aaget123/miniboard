import { describe, expect, it } from "vitest";
import { translatePath } from "./path";

describe("translatePath", () => {
  it("零位移或空串原样返回", () => {
    const p = "M 0 0 L 10 10 Z";
    expect(translatePath(p, 0, 0)).toBe(p);
    expect(translatePath("", 5, 5)).toBe("");
    expect(translatePath("", 0, 0)).toBe("");
  });

  it("平移 M/L 绝对坐标", () => {
    expect(translatePath("M 0 0 L 10 10 Z", 5, 3)).toBe("M 5 3 L 15 13 Z");
  });

  it("H 只平移 x，V 只平移 y", () => {
    expect(translatePath("M 0 0 H 10 V 10 H 0", 2, 4)).toBe("M 2 4 H 12 V 14 H 2");
  });

  it("C 六参数全部坐标对平移", () => {
    expect(translatePath("C 1 2 3 4 5 6", 10, 20)).toBe("C 11 22 13 24 15 26");
  });

  it("A 命令仅平移末尾 x/y，椭圆参数不动", () => {
    expect(translatePath("A 5 5 0 0 1 10 10", 1, 2)).toBe("A 5 5 0 0 1 11 12");
  });

  it("相对命令（小写）不平移", () => {
    const p = "m 0 0 l 5 5 c 1 1 2 2 3 3 z";
    expect(translatePath(p, 10, 20)).toBe(p);
  });

  it("混合绝对/相对命令，浮点坐标保留 2 位小数", () => {
    const out = translatePath("M 0.5 0.5 L 10.333 20.666 m 1 1 l 2 2", 1.25, 2.5);
    expect(out).toBe("M 1.75 3 L 11.58 23.17 m 1 1 l 2 2");
  });

  it("负数坐标平移", () => {
    expect(translatePath("M -5 -5 L 5 5", 3, -2)).toBe("M -2 -7 L 8 3");
  });
});
