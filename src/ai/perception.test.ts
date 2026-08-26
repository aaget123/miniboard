import { describe, expect, it } from "vitest";
import { diffElementSnapshots, fingerprintElement, hasChanges } from "./perception";
import type { ElementData } from "../types";

function rect(id: string, x: number, y: number, extra?: Partial<ElementData>): ElementData {
  return { id, type: "rect", x, y, width: 100, height: 80, ...extra };
}

describe("fingerprintElement", () => {
  it("相同数据指纹一致（键序无关）", () => {
    const a = fingerprintElement({ id: "e1", type: "rect", x: 10, y: 20, width: 10, height: 10 });
    const b = fingerprintElement({ type: "rect", y: 20, x: 10, id: "e1", width: 10, height: 10 });
    expect(a).toBe(b);
  });

  it("浮点微抖动（<0.05）不改变指纹，跨过舍入边界则改变", () => {
    const base = rect("e1", 100, 100);
    const jitter = rect("e1", 100.03, 100);
    const moved = rect("e1", 100.2, 100);
    expect(fingerprintElement(jitter)).toBe(fingerprintElement(base));
    expect(fingerprintElement(moved)).not.toBe(fingerprintElement(base));
  });

  it("样式 / 文字变更能检出", () => {
    const a = rect("e1", 0, 0, { stroke: "#ff0000" });
    const b = rect("e1", 0, 0, { stroke: "#00ff00" });
    expect(fingerprintElement(a)).not.toBe(fingerprintElement(b));
    const t1: ElementData = {
      id: "t",
      type: "text",
      x: 0,
      y: 0,
      width: 40,
      height: 20,
      text: "旧",
    };
    const t2: ElementData = {
      id: "t",
      type: "text",
      x: 0,
      y: 0,
      width: 40,
      height: 20,
      text: "新",
    };
    expect(fingerprintElement(t1)).not.toBe(fingerprintElement(t2));
  });
});

describe("diffElementSnapshots", () => {
  it("空 → 空为无变更", () => {
    const diff = diffElementSnapshots([], []);
    expect(diff.added).toHaveLength(0);
    expect(diff.updated).toHaveLength(0);
    expect(diff.removedIds).toHaveLength(0);
    expect(hasChanges(diff)).toBe(false);
  });

  it("识别新增 / 更新 / 删除", () => {
    const prev = [rect("a", 0, 0), rect("b", 200, 0), rect("c", 400, 0)];
    const next = [
      rect("a", 50, 0), // 更新（位移）
      rect("b", 200, 0), // 未变
      rect("d", 600, 0), // 新增
      rect("e", 800, 0), // 新增
    ];
    const diff = diffElementSnapshots(prev, next);
    expect(diff.updated.map((e) => e.id)).toEqual(["a"]);
    expect(diff.added.map((e) => e.id)).toEqual(["d", "e"]);
    expect(diff.removedIds).toEqual(["c"]);
    expect(hasChanges(diff)).toBe(true);
  });

  it("完全相同的快照无变更", () => {
    const prev = [
      rect("a", 1.234, 2.345),
      {
        id: "l",
        type: "line" as const,
        points: [
          { x: 0, y: 0 },
          { x: 9.876, y: 5 },
        ],
      } as ElementData,
    ];
    const next = structuredClone(prev);
    const diff = diffElementSnapshots(prev, next);
    expect(hasChanges(diff)).toBe(false);
  });

  it("无 id 元素防御性跳过", () => {
    const orphan: ElementData = { type: "rect", x: 0, y: 0, width: 10, height: 10 };
    const diff = diffElementSnapshots([orphan], [orphan]);
    expect(hasChanges(diff)).toBe(false);
  });
});
