import { beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../board/registry";
import {
  computeToolbarNodes,
  groupLabel,
  saveCustomGroups,
  saveGroupOrderPref,
  saveGroupOverrides,
  type ToolbarLayoutNode,
} from "./toolbar";

/** localStorage mock（Node 测试环境无 localStorage） */
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

/** 节点简写：平铺工具 = id，分组按钮 = [组名] */
function nodeLabel(n: ToolbarLayoutNode): string {
  if (n.kind === "tool") {
    return n.id;
  }
  if (n.kind === "group") {
    return `[${n.group}]`;
  }
  return n.kind; // style / fill 固定节点
}

function groupTools(nodes: ToolbarLayoutNode[], group: string): string[] {
  const g = nodes.find(
    (n) => n.kind === "group" && n.group === group,
  );
  return g && g.kind === "group" ? g.tools.map((t) => t.id) : [];
}

describe("computeToolbarNodes 分组顺序", () => {
  const registry = new ToolRegistry();

  it("默认布局：无分组工具平铺，分组按钮插在第一个组员前", () => {
    const nodes = computeToolbarNodes(registry, null);
    expect(nodes.map(nodeLabel)).toEqual([
      "[select]",
      "hand",
      "pen",
      "eraser",
      "line",
      "arrow",
      "[shape]",
      "text",
    ]);
    // 选择组收纳 选择/框选/套索；形状组收纳 矩形/椭圆/框架
    expect(groupTools(nodes, "select")).toEqual([
      "select",
      "marquee",
      "lasso",
    ]);
    expect(groupTools(nodes, "shape")).toEqual(["rect", "ellipse", "frame"]);
  });

  it("拖动分组头后：组按钮按偏好顺序提前输出（形状移到最前）", () => {
    saveGroupOrderPref(["shape", "select", "ai"]);
    const nodes = computeToolbarNodes(registry, null);
    expect(nodes.map(nodeLabel)).toEqual([
      "[shape]",
      "[select]",
      "hand",
      "pen",
      "eraser",
      "line",
      "arrow",
      "text",
    ]);
  });

  it("偏好含空组（暂无 AI 工具）不生成按钮、不崩溃", () => {
    saveGroupOrderPref(["ai", "select", "shape"]);
    const nodes = computeToolbarNodes(registry, null);
    expect(nodes.map(nodeLabel)).toEqual([
      "[select]",
      "hand",
      "pen",
      "eraser",
      "line",
      "arrow",
      "[shape]",
      "text",
    ]);
  });

  it("自定义布局：未勾选的分组工具收进对应下拉，组按钮按偏好顺序排在末尾", () => {
    saveGroupOrderPref(["ai", "shape", "select"]);
    const nodes = computeToolbarNodes(registry, ["hand", "pen", "text"]);
    expect(nodes.map(nodeLabel)).toEqual([
      "hand",
      "pen",
      "text",
      "[shape]",
      "[select]",
    ]);
  });

  it("有 AI 工具时：ai 组按钮按偏好位置输出", () => {
    const reg = new ToolRegistry();
    reg.addCustom({
      name: "测试星",
      icon: "★",
      generator:
        "(ctx) => ({ type: 'rect', x: ctx.x0, y: ctx.y0, width: 10, height: 10, stroke: '#000000' })",
    });
    saveGroupOrderPref(["ai", "select", "shape"]);
    const nodes = computeToolbarNodes(reg, null);
    expect(nodes.map(nodeLabel)).toEqual([
      "[ai]",
      "[select]",
      "hand",
      "pen",
      "eraser",
      "line",
      "arrow",
      "[shape]",
      "text",
    ]);
    const ai = groupTools(nodes, "ai");
    expect(ai).toHaveLength(1);
    expect(reg.getTool(ai[0])?.name).toBe("测试星");
  });

  it("分组标记插入序列：该位置输出完整分组按钮（不拆开），组内工具收进下拉", () => {
    saveGroupOrderPref(null);
    const nodes = computeToolbarNodes(registry, ["hand", "g:select", "pen"]);
    expect(nodes.map(nodeLabel)).toEqual([
      "hand",
      "[select]",
      "pen",
      "[shape]",
    ]);
    // 选择组按钮完整收纳 选择/框选/套索（未被拆开平铺）
    expect(groupTools(nodes, "select")).toEqual([
      "select",
      "marquee",
      "lasso",
    ]);
  });

  it("分组标记 + 组内部分工具已平铺：组按钮只收纳未平铺工具", () => {
    const nodes = computeToolbarNodes(registry, ["marquee", "g:select", "hand"]);
    expect(nodes.map(nodeLabel)).toEqual([
      "marquee",
      "[select]",
      "hand",
      "[shape]",
    ]);
    expect(groupTools(nodes, "select")).toEqual(["select", "lasso"]);
  });

  it("组内工具全部平铺时：序列中的分组标记不再生成按钮", () => {
    const nodes = computeToolbarNodes(registry, [
      "select",
      "marquee",
      "lasso",
      "g:select",
      "hand",
    ]);
    expect(nodes.map(nodeLabel)).toEqual([
      "select",
      "marquee",
      "lasso",
      "hand",
      "[shape]",
    ]);
  });

  it("自定义分组：空组也生成顶栏按钮（可拖入工具归组）", () => {
    saveGroupOrderPref(null);
    saveCustomGroups([{ id: "cg-abc", name: "常用" }]);
    const nodes = computeToolbarNodes(registry, null);
    expect(nodes.map(nodeLabel)).toEqual([
      "[select]",
      "hand",
      "pen",
      "eraser",
      "line",
      "arrow",
      "[shape]",
      "text",
      "[cg-abc]",
    ]);
    expect(groupTools(nodes, "cg-abc")).toEqual([]);
  });

  it("自定义分组 + 归属覆盖：工具移入自定义组，原组按钮不再收纳它", () => {
    saveCustomGroups([{ id: "cg-abc", name: "常用" }]);
    saveGroupOverrides({ pen: "cg-abc" });
    const nodes = computeToolbarNodes(registry, null);
    // pen 归入自定义组：不再平铺，被 [cg-abc] 按钮收纳；组顺序 = 注册表顺序
    expect(nodes.map(nodeLabel)).toEqual([
      "[select]",
      "hand",
      "[cg-abc]",
      "eraser",
      "line",
      "arrow",
      "[shape]",
      "text",
    ]);
    expect(groupTools(nodes, "cg-abc")).toEqual(["pen"]);
    expect(groupTools(nodes, "shape")).toEqual(["rect", "ellipse", "frame"]);
  });

  it("自定义分组按钮在序列中：组名用自定义名称，组内收纳覆盖工具", () => {
    saveGroupOrderPref(null);
    saveCustomGroups([{ id: "cg-abc", name: "常用" }]);
    saveGroupOverrides({ eraser: "cg-abc" });
    const nodes = computeToolbarNodes(registry, ["hand", "g:cg-abc"]);
    // 序列中 [cg-abc] 收纳 eraser；未出现在序列中的组按偏好顺序追加末尾
    expect(nodes.map(nodeLabel)).toEqual([
      "hand",
      "[cg-abc]",
      "[select]",
      "[shape]",
    ]);
    expect(groupTools(nodes, "cg-abc")).toEqual(["eraser"]);
    expect(groupLabel("cg-abc", [{ id: "cg-abc", name: "常用" }])).toBe(
      "常用",
    );
    expect(groupLabel("cg-xyz", [])).toBe("cg-xyz"); // 未知组回退 id
  });
});
