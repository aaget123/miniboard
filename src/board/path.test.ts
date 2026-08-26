import { describe, expect, it } from "vitest";
import { mirrorPath, scalePath, translatePath } from "./path";

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

describe("mirrorPath", () => {
  it("空串原样返回", () => {
    expect(mirrorPath("", "h", 5)).toBe("");
  });

  it("水平镜像：x → 2*center - x，y 不变", () => {
    expect(mirrorPath("M 0 0 L 10 0 L 10 10 Z", "h", 5)).toBe("M 10 0 L 0 0 L 0 10 Z");
  });

  it("垂直镜像：y → 2*center - y，x 不变", () => {
    expect(mirrorPath("M 0 0 L 10 0 L 10 10 Z", "v", 5)).toBe("M 0 10 L 10 10 L 10 0 Z");
  });

  it("H 只镜像 x、V 只镜像 y", () => {
    expect(mirrorPath("M 0 0 H 10 V 10 H 0", "h", 5)).toBe("M 10 0 H 0 V 10 H 10");
    expect(mirrorPath("M 0 0 H 10 V 10 H 0", "v", 5)).toBe("M 0 10 H 10 V 0 H 0");
  });

  it("A 命令：rx/ry/large-arc 不变，rotation 变号、sweep 翻转、末尾 x/y 镜像", () => {
    expect(mirrorPath("A 5 5 30 0 1 10 10", "h", 5)).toBe("A 5 5 -30 0 0 0 10");
  });

  it("相对命令（小写）不镜像", () => {
    const p = "m 0 0 l 5 5 c 1 1 2 2 3 3";
    expect(mirrorPath(p, "h", 5)).toBe(p);
  });

  it("C/Q 成对坐标逐个镜像", () => {
    expect(mirrorPath("C 1 2 3 4 5 6", "h", 3)).toBe("C 5 2 3 4 1 6");
    expect(mirrorPath("Q 1 2 3 4", "v", 3)).toBe("Q 1 4 3 2");
  });

  it("浮点坐标保留 2 位小数", () => {
    expect(mirrorPath("M 0.5 0.5 L 10.333 20.666", "h", 5)).toBe("M 9.5 0.5 L -0.33 20.67");
  });
});

describe("scalePath", () => {
  it("单位缩放或空串原样返回", () => {
    const p = "M 0 0 L 10 10 Z";
    expect(scalePath(p, 1, 1, 5, 5)).toBe(p);
    expect(scalePath("", 2, 2, 5, 5)).toBe("");
  });

  it("以 (ox, oy) 为中心缩放 M/L 绝对坐标", () => {
    expect(scalePath("M 0 0 L 10 10 Z", 2, 0.5, 0, 0)).toBe("M 0 0 L 20 5 Z");
    expect(scalePath("M 10 10 L 20 20", 2, 2, 10, 10)).toBe("M 10 10 L 30 30");
  });

  it("H 只缩放 x、V 只缩放 y", () => {
    expect(scalePath("M 0 0 H 10 V 10 H 0", 2, 3, 0, 0)).toBe("M 0 0 H 20 V 30 H 0");
  });

  it("C 六参数全部坐标对缩放", () => {
    expect(scalePath("C 1 2 3 4 5 6", 2, 3, 1, 2)).toBe("C 1 2 5 8 9 14");
  });

  it("A 命令：rx/ry 随轴缩放、rotation/large-arc 不变、末尾 x/y 缩放", () => {
    expect(scalePath("A 5 5 30 0 1 10 10", 2, 3, 0, 0)).toBe("A 10 15 30 0 1 20 30");
  });

  it("负缩放翻转 A 命令 sweep 标志", () => {
    expect(scalePath("A 5 5 0 0 1 10 10", -1, 1, 0, 0)).toBe("A -5 5 0 0 0 -10 10");
  });

  it("相对命令（小写）不缩放", () => {
    const p = "m 0 0 l 5 5 c 1 1 2 2 3 3";
    expect(scalePath(p, 2, 2, 0, 0)).toBe(p);
  });

  it("浮点坐标保留 2 位小数", () => {
    expect(scalePath("M 0.5 0.5 L 10.333 20.666", 2.5, 2, 0, 0)).toBe("M 1.25 1 L 25.83 41.33");
  });
});
