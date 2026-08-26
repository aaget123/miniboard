import { describe, expect, it } from "vitest";
import { parseProjectIndex, parseScene, resolveActiveIndex } from "./storage-core";
import type { ProjectIndex } from "./storage-core";

const meta = (id: string, name = `项目-${id}`) => ({
  id,
  name,
  createdAt: 1700000000000,
  updatedAt: 1700000000001,
});

const validIndexJson = JSON.stringify({
  activeId: "p1",
  projects: [meta("p1"), meta("p2")],
});

describe("parseProjectIndex", () => {
  it("解析合法索引并保留字段", () => {
    const idx = parseProjectIndex(validIndexJson);
    expect(idx).not.toBeNull();
    expect(idx!.activeId).toBe("p1");
    expect(idx!.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(idx!.projects[0].name).toBe("项目-p1");
    expect(idx!.projects[0].createdAt).toBe(1700000000000);
  });

  it("空文本 / 非法 JSON / 缺 projects 数组 → null（走首次初始化迁移）", () => {
    expect(parseProjectIndex(null)).toBeNull();
    expect(parseProjectIndex("")).toBeNull();
    expect(parseProjectIndex("{oops")).toBeNull();
    expect(parseProjectIndex(JSON.stringify({ activeId: "p1" }))).toBeNull();
    expect(parseProjectIndex(JSON.stringify({ projects: "nope" }))).toBeNull();
  });

  it("单个条目缺 id/name 时丢弃该条目、保留合法条目", () => {
    const text = JSON.stringify({
      activeId: "ok",
      projects: [meta("ok"), { name: "无id" }, null, { id: "", name: "空id" }, meta("ok2")],
    });
    const idx = parseProjectIndex(text);
    expect(idx!.projects.map((p) => p.id)).toEqual(["ok", "ok2"]);
  });

  it("时间戳缺失或非数字时补当前时间", () => {
    const before = Date.now();
    const idx = parseProjectIndex(
      JSON.stringify({ activeId: "a", projects: [{ id: "a", name: "n" }] }),
    );
    expect(idx!.projects[0].createdAt).toBeGreaterThanOrEqual(before);
    expect(idx!.projects[0].updatedAt).toBeGreaterThanOrEqual(before);

    const bad = parseProjectIndex(
      JSON.stringify({
        activeId: "a",
        projects: [{ id: "a", name: "n", createdAt: "x", updatedAt: null }],
      }),
    );
    expect(bad!.projects[0].createdAt).toBeGreaterThanOrEqual(before);
    expect(bad!.projects[0].updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("activeId 缺失按空串处理（由 resolveActiveIndex 决定回退）", () => {
    const idx = parseProjectIndex(JSON.stringify({ projects: [meta("p1")] }));
    expect(idx!.activeId).toBe("");
    expect(resolveActiveIndex(idx!).activeId).toBe("p1");
  });
});

describe("resolveActiveIndex", () => {
  const base: ProjectIndex = { activeId: "p1", projects: [meta("p1"), meta("p2")] };

  it("激活项目在列表中：原样返回", () => {
    expect(resolveActiveIndex(base)).toBe(base);
  });

  it("激活项目不在列表中：回退第一个项目", () => {
    const fixed = resolveActiveIndex({ ...base, activeId: "gone" });
    expect(fixed.activeId).toBe("p1");
    // 不修改传入对象
    expect(base.activeId).toBe("p1");
  });

  it("列表为空：原样返回", () => {
    const empty: ProjectIndex = { activeId: "x", projects: [] };
    expect(resolveActiveIndex(empty)).toBe(empty);
  });
});

describe("parseScene", () => {
  const scene = {
    app: "miniboard",
    version: 1,
    background: "#1e1f22",
    elements: [{ type: "rect", x: 0, y: 0, width: 10, height: 10 }],
  };

  it("解析合法场景文件", () => {
    const parsed = parseScene(JSON.stringify(scene));
    expect(parsed).not.toBeNull();
    expect(parsed!.elements).toHaveLength(1);
  });

  it("拒绝非 miniboard / 缺元素数组 / 非法 JSON / 空输入", () => {
    expect(parseScene(null)).toBeNull();
    expect(parseScene("")).toBeNull();
    expect(parseScene("nope{")).toBeNull();
    expect(parseScene(JSON.stringify({ ...scene, app: "other" }))).toBeNull();
    expect(parseScene(JSON.stringify({ ...scene, elements: undefined }))).toBeNull();
  });
});
