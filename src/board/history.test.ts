import { describe, expect, it } from "vitest";
import { History } from "./history";
import type { ElementData } from "../types";

function rect(id: string): ElementData {
  return { id, type: "rect", x: 0, y: 0, width: 10, height: 10 };
}

describe("History（快照式撤销栈）", () => {
  it("push/undo/redo 基本语义", () => {
    const h = new History();
    expect(h.canUndo).toBe(false);
    h.push([rect("a")]);
    h.push([rect("a"), rect("b")]);
    h.push([rect("a"), rect("b"), rect("c")]);
    expect(h.canUndo).toBe(true);
    const prev = h.undo();
    expect(prev?.length).toBe(2);
    expect(h.canRedo).toBe(true);
    const next = h.redo();
    expect(next?.length).toBe(3);
    // 栈顶再 redo 无效果
    expect(h.redo()).toBeNull();
    // 回到栈底后 undo 无效果
    h.undo();
    h.undo();
    expect(h.undo()).toBeNull();
    expect(h.canUndo).toBe(false);
  });

  it("push 裁剪 redo 分支", () => {
    const h = new History();
    h.push([rect("a")]);
    h.push([rect("b")]);
    h.undo();
    expect(h.canRedo).toBe(true);
    h.push([rect("c")]);
    // 新快照入栈后 redo 分支被裁剪
    expect(h.canRedo).toBe(false);
    expect(h.undo()?.[0]?.id).toBe("a");
  });

  it("深度限制：超出 limit 时丢弃最旧快照，index 保持指向栈顶", () => {
    const h = new History(3);
    for (let i = 0; i < 6; i++) {
      h.push([rect(`e${i}`)]);
    }
    // 只保留最近 3 代（e3/e4/e5）
    let hops = 0;
    while (h.canUndo) {
      h.undo();
      hops++;
    }
    expect(hops).toBe(2); // e5→e4→e3，e3 即最旧保留代
  });

  it("大规模快照（60 步 × 5000 元素）入栈与回退行为正常", () => {
    const h = new History();
    const big = (): ElementData[] =>
      Array.from({ length: 5000 }, (_, i) => ({
        id: `el-${i}`,
        type: "rect" as const,
        x: i % 97,
        y: i % 89,
        width: 20,
        height: 20,
      }));
    for (let step = 0; step < 60; step++) {
      const snap = big();
      snap[0].x = step; // 每代内容有差异
      h.push(snap);
    }
    expect(h.canRedo).toBe(false);
    const top = h.undo();
    expect(top?.length).toBe(5000);
    // 引用语义：返回的是存入的同一份数组（loadElements 按只读消费）
    expect(top?.[0].x).toBe(58);
  });

  it("clear 清空全部状态", () => {
    const h = new History();
    h.push([rect("a")]);
    h.clear();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBeNull();
  });
});
