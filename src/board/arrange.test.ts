import { describe, expect, it } from "vitest";
import {
  alignElements,
  distributeElements,
  expandGroupMembers,
  flipElements,
  reorderElements,
} from "./arrange";
import { elementBounds, unionBounds } from "./bounds";
import type { ElementData } from "../types";

function rect(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): ElementData {
  return { id, type: "rect", x, y, width: w, height: h };
}

describe("alignElements 对齐", () => {
  // 并集 AABB：x 0~600、y 0~250
  const els = [
    rect("a", 0, 0, 100, 100),
    rect("b", 200, 50, 100, 100),
    rect("c", 500, 150, 100, 100),
  ];

  it("left：全部对齐到并集左边界，相对 y 不变", () => {
    const out = alignElements(els, "left");
    const bs = out.map(elementBounds);
    expect(bs.map((b) => b.minX)).toEqual([0, 0, 0]);
    expect(out.map((e) => e.y)).toEqual([0, 50, 150]);
  });

  it("centerX：中心对齐到并集中线 x=300", () => {
    const out = alignElements(els, "centerX");
    const bs = out.map(elementBounds);
    const center = (b: { minX: number; maxX: number }) =>
      (b.minX + b.maxX) / 2;
    expect(center(bs[0])).toBeCloseTo(300, 6);
    expect(center(bs[1])).toBeCloseTo(300, 6);
    expect(center(bs[2])).toBeCloseTo(300, 6);
  });

  it("right：全部对齐到并集右边界（坐标补偿正确）", () => {
    const out = alignElements(els, "right");
    const bs = out.map(elementBounds);
    expect(bs.map((b) => b.maxX)).toEqual([600, 600, 600]);
    // 三个元素宽度均为 100，对齐到右边界 600 后 x 全部为 500
    expect(out.map((e) => e.x)).toEqual([500, 500, 500]);
  });

  it("top / centerY / bottom：垂直三模式", () => {
    const top = alignElements(els, "top");
    expect(top.map((e) => e.y)).toEqual([0, 0, 0]);
    const cy = alignElements(els, "centerY");
    const bs = cy.map(elementBounds);
    const center = (b: { minY: number; maxY: number }) =>
      (b.minY + b.maxY) / 2;
    expect(center(bs[0])).toBeCloseTo(125, 6);
    expect(center(bs[1])).toBeCloseTo(125, 6);
    expect(center(bs[2])).toBeCloseTo(125, 6);
    const bottom = alignElements(els, "bottom");
    const bs2 = bottom.map(elementBounds);
    expect(bs2.map((b) => b.maxY)).toEqual([250, 250, 250]);
  });

  it("旋转元素按含 rotation 的 AABB 参与对齐", () => {
    const a = rect("a", 0, 0, 100, 100);
    a.rotation = 45; // 旋转后 AABB 四角外扩，左边界为 -20.71
    const b = rect("b", 200, 0, 100, 100);
    const out = alignElements([a, b], "left");
    const bs = out.map(elementBounds);
    expect(bs[0].minX).toBeCloseTo(-20.710678118654755, 5);
    expect(bs[1].minX).toBeCloseTo(bs[0].minX, 5);
  });

  it("line/arrow 按 points 绝对坐标包围盒参与", () => {
    const line: ElementData = {
      id: "l",
      type: "line",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      points: [
        { x: 10, y: 10 },
        { x: 50, y: 40 },
      ],
    };
    const r = rect("r", 100, 0, 50, 50);
    const out = alignElements([line, r], "left");
    // 并集 minX = 10：line 已在左边界不动，rect 平移 -90
    expect(out[0].points).toEqual([
      { x: 10, y: 10 },
      { x: 50, y: 40 },
    ]);
    expect(out[1].x).toBe(10);
  });

  it("少于 2 个元素原样返回（no-op）", () => {
    const one = [rect("a", 0, 0, 10, 10)];
    expect(alignElements(one, "left")).toBe(one);
  });
});

describe("distributeElements 分布", () => {
  it("horizontal：按中心排序，首尾保持、中间均分", () => {
    // 中心 x 25 / 325 / 525 → 首尾 25~525，步长 250，b 从 325 移到 275
    const els = [
      rect("a", 0, 0, 50, 50),
      rect("b", 300, 0, 50, 50),
      rect("c", 500, 0, 50, 50),
    ];
    const out = distributeElements(els, "horizontal");
    const centers = out.map((e) => e.x + (e.width ?? 0) / 2);
    expect(centers[0]).toBeCloseTo(25, 5);
    expect(centers[1]).toBeCloseTo(275, 5);
    expect(centers[2]).toBeCloseTo(525, 5);
  });

  it("vertical：y 轴均分", () => {
    // 中心 y 25 / 425 / 625 → 首尾 25~625，步长 300，b 从 425 移到 325
    const els = [
      rect("a", 0, 0, 50, 50),
      rect("b", 0, 400, 50, 50),
      rect("c", 0, 600, 50, 50),
    ];
    const out = distributeElements(els, "vertical");
    const centers = out.map((e) => e.y + (e.height ?? 0) / 2);
    expect(centers).toEqual([25, 325, 625]);
  });

  it("少于 3 个元素原样返回（no-op）", () => {
    const two = [rect("a", 0, 0, 10, 10), rect("b", 100, 0, 10, 10)];
    expect(distributeElements(two, "horizontal")).toBe(two);
  });
});

describe("flipElements 翻转", () => {
  it("rect：绕任意中心水平翻转（坐标补偿 + rotation 变号）", () => {
    const el = rect("a", 10, 20, 100, 50);
    el.rotation = 30;
    const out = flipElements([el], "h", 200, 0)[0];
    expect(out.x).toBe(2 * 200 - 10 - 100);
    expect(out.y).toBe(20); // 垂直轴不动
    expect(out.rotation).toBe(-30);
  });

  it("双元素绕并集中心镜像：左右/上下互换", () => {
    const els = [rect("a", 0, 0, 100, 50), rect("b", 200, 100, 100, 50)];
    const b = unionBounds(els);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const out = flipElements(els, "h", cx, cy);
    expect(out[0].x).toBeCloseTo(200, 5);
    expect(out[1].x).toBeCloseTo(0, 5);
    expect(out.map((e) => e.y)).toEqual([0, 100]); // y 不变
    const outV = flipElements(els, "v", cx, cy);
    expect(outV[0].y).toBeCloseTo(100, 5);
    expect(outV[1].y).toBeCloseTo(0, 5);
    expect(outV.map((e) => e.x)).toEqual([0, 200]); // x 不变
  });

  it("line/arrow：points 直接镜像，x/y 保持 0 契约", () => {
    const mk = (type: "line" | "arrow"): ElementData => ({
      id: type,
      type,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      points: [
        { x: 10, y: 10 },
        { x: 50, y: 30 },
      ],
    });
    const out = flipElements([mk("line")], "h", 30, 20)[0];
    expect(out.points).toEqual([
      { x: 50, y: 10 },
      { x: 10, y: 30 },
    ]);
    const outA = flipElements([mk("arrow")], "v", 30, 20)[0];
    expect(outA.points).toEqual([
      { x: 10, y: 30 },
      { x: 50, y: 10 },
    ]);
  });

  it("path：局部 path 数字镜像（含 A 命令 sweep 翻转与 rotation 变号）", () => {
    const path: ElementData = {
      id: "p",
      type: "path",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      path: "M 0 0 L 10 0 L 10 10 Z",
    };
    const out = flipElements([path], "h", 5, 5)[0];
    expect(out.path).toBe("M 10 0 L 0 0 L 0 10 Z");
    const arc: ElementData = {
      id: "a",
      type: "path",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      path: "M 0 0 A 5 5 30 0 1 10 10",
    };
    const outA = flipElements([arc], "h", 5, 5)[0];
    expect(outA.path).toBe("M 10 0 A 5 5 -30 0 0 0 10");
  });

  it("freehand：x/y 补偿 + 局部 path 绕 w/2 镜像 + penPoints 绝对镜像", () => {
    const fh: ElementData = {
      id: "f",
      type: "freehand",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      path: "M 0 0 L 100 0 L 100 100 Z",
      penPoints: [
        [10, 10],
        [90, 90],
      ],
    };
    const out = flipElements([fh], "h", 100, 50)[0];
    expect(out.x).toBe(100); // 2*100 - 0 - 100
    expect(out.path).toBe("M 100 0 L 0 0 L 0 100 Z");
    expect(out.penPoints).toEqual([
      [190, 10],
      [110, 90],
    ]);
  });

  it("text/image 与 rect 同规则（左上角补偿）", () => {
    const t: ElementData = { id: "t", type: "text", x: 10, y: 10, width: 80, height: 20, text: "hi" };
    const out = flipElements([t], "h", 100, 10)[0];
    expect(out.x).toBe(2 * 100 - 10 - 80);
    expect(out.y).toBe(10);
    const img: ElementData = { id: "i", type: "image", x: 0, y: 0, width: 50, height: 50, url: "x" };
    const outI = flipElements([img], "v", 0, 50)[0];
    expect(outI.y).toBe(2 * 50 - 0 - 50);
    expect(outI.x).toBe(0);
  });
});

describe("reorderElements 层序", () => {
  const list = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const getId = (el: { id: string }) => el.id;

  it("front：选中块移动到末尾，保持相对顺序", () => {
    const out = reorderElements(list, ["b", "d"], getId, "front");
    expect(out.map((el) => el.id)).toEqual(["a", "c", "e", "b", "d"]);
  });

  it("back：选中块移动到开头，保持相对顺序", () => {
    const out = reorderElements(list, ["b", "d"], getId, "back");
    expect(out.map((el) => el.id)).toEqual(["b", "d", "a", "c", "e"]);
  });

  it("forward：整块上移一层（与后一个非选中交换）", () => {
    const out = reorderElements(list, ["b", "d"], getId, "forward");
    expect(out.map((el) => el.id)).toEqual(["a", "c", "b", "e", "d"]);
  });

  it("backward：整块下移一层", () => {
    const out = reorderElements(list, ["b", "d"], getId, "backward");
    expect(out.map((el) => el.id)).toEqual(["b", "a", "d", "c", "e"]);
  });

  it("已在目标层时顺序不变", () => {
    expect(reorderElements(list, ["a", "b"], getId, "back").map((el) => el.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(reorderElements(list, ["d", "e"], getId, "front").map((el) => el.id)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("expandGroupMembers 组归一化", () => {
  const els: ElementData[] = [
    rect("a", 0, 0, 10, 10),
    rect("b", 100, 0, 10, 10),
    rect("c", 200, 0, 10, 10),
    rect("d", 300, 0, 10, 10),
  ];
  els[0].groupId = "g1";
  els[2].groupId = "g1";
  els[1].groupId = "g2";

  it("选中组内任一成员时整组并入", () => {
    expect([...expandGroupMembers(els, ["a"])].sort()).toEqual(["a", "c"]);
    expect([...expandGroupMembers(els, ["c"])].sort()).toEqual(["a", "c"]);
  });

  it("非组成员不受影响", () => {
    expect([...expandGroupMembers(els, ["b"])]).toEqual(["b"]);
    expect([...expandGroupMembers(els, ["d"])]).toEqual(["d"]);
  });

  it("选中多个组的成员时全部展开，未选中组不展开", () => {
    expect([...expandGroupMembers(els, ["a", "b"])].sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("无组成员时原样返回", () => {
    expect([...expandGroupMembers(els, ["d"])]).toEqual(["d"]);
  });
});
