import { beforeEach, describe, expect, it } from "vitest";
import {
  ShortcutManager,
  comboFromEvent,
  formatCombo,
  formatKeys,
  normKey,
} from "./shortcuts";
import { ToolRegistry } from "../board/registry";

/** localStorage mock（Node 测试环境无 localStorage，与 toolbar.test 一致） */
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

describe("comboFromEvent", () => {
  it("裸字母键不携带修饰符", () => {
    expect(comboFromEvent({ key: "k" })).toBe("k");
    expect(comboFromEvent({ key: "K" })).toBe("k");
  });

  it("Ctrl/Shift/Alt 组合按固定顺序拼接", () => {
    expect(comboFromEvent({ key: "Z", ctrlKey: true, shiftKey: true })).toBe(
      "ctrl+shift+z",
    );
    expect(comboFromEvent({ key: "s", ctrlKey: true })).toBe("ctrl+s");
  });

  it("meta 与 ctrl 归一（Cmd 等效 Ctrl）", () => {
    expect(comboFromEvent({ key: "s", metaKey: true })).toBe("ctrl+s");
  });

  it("符号键不再单计 shift（Ctrl+Shift+= 的 key 是 +）", () => {
    expect(comboFromEvent({ key: "+", ctrlKey: true, shiftKey: true })).toBe(
      "ctrl+plus",
    );
    expect(comboFromEvent({ key: "=", ctrlKey: true })).toBe("ctrl+=");
    expect(comboFromEvent({ key: "-", ctrlKey: true })).toBe("ctrl+-");
  });

  it("纯修饰键返回空串（忽略）", () => {
    expect(comboFromEvent({ key: "Control" })).toBe("");
    expect(comboFromEvent({ key: "Shift" })).toBe("");
  });

  it("功能键原样小写", () => {
    expect(comboFromEvent({ key: "Delete" })).toBe("delete");
    expect(comboFromEvent({ key: "Backspace" })).toBe("backspace");
    expect(comboFromEvent({ key: "Escape" })).toBe("escape");
  });
});

describe("normKey / formatCombo / formatKeys", () => {
  it("+ 键转义为 plus，展示时还原", () => {
    expect(normKey("+")).toBe("plus");
    expect(formatCombo("ctrl+plus")).toBe("Ctrl++");
    expect(formatCombo("ctrl+=")).toBe("Ctrl+=");
    expect(formatCombo("ctrl+shift+z")).toBe("Ctrl+Shift+Z");
    expect(formatCombo("escape")).toBe("Esc");
    expect(formatCombo("delete")).toBe("Delete");
  });

  it("formatKeys 多键用斜杠连接", () => {
    expect(formatKeys(["ctrl+z", "ctrl+y"])).toBe("Ctrl+Z / Ctrl+Y");
  });
});

describe("ShortcutManager", () => {
  it("未配置时返回默认键位", () => {
    const sm = new ShortcutManager();
    expect(sm.getKeys("undo")).toEqual(["ctrl+z"]);
    expect(sm.getKeys("redo")).toEqual(["ctrl+shift+z", "ctrl+y"]);
    expect(sm.getKeys("aiPanel")).toEqual(["k"]);
  });

  it("自定义键位持久化并可恢复默认", () => {
    const sm = new ShortcutManager();
    let changed = 0;
    sm.setOnChange(() => changed++);
    sm.setKeys("aiPanel", ["ctrl+q"]);
    expect(changed).toBe(1);
    expect(sm.getKeys("aiPanel")).toEqual(["ctrl+q"]);
    // 重新实例化仍生效（localStorage 持久化）
    expect(new ShortcutManager().getKeys("aiPanel")).toEqual(["ctrl+q"]);
    sm.setKeys("aiPanel", []);
    expect(sm.getKeys("aiPanel")).toEqual(["k"]);
  });

  it("isDefault：设为默认值等同未自定义", () => {
    const sm = new ShortcutManager();
    expect(sm.isDefault("save")).toBe(true);
    sm.setKeys("save", ["ctrl+s"]);
    expect(sm.isDefault("save")).toBe(true);
    sm.setKeys("save", ["ctrl+w"]);
    expect(sm.isDefault("save")).toBe(false);
  });

  it("allBindings：操作优先于工具，AI 工具键来自注册表", () => {
    const sm = new ShortcutManager();
    const registry = new ToolRegistry();
    const bindings = sm.allBindings(registry);
    expect(bindings.v).toBe("tool:select");
    expect(bindings.p).toBe("tool:pen");
    expect(bindings.k).toBe("aiPanel"); // 操作覆盖工具同名键
    expect(bindings["ctrl+s"]).toBe("save");
    expect(bindings.delete).toBe("delete");
    expect(bindings.backspace).toBe("delete");
    expect(bindings["ctrl+plus"]).toBe("zoomIn");
  });

  it("内置工具键可被用户配置覆盖", () => {
    const sm = new ShortcutManager();
    const registry = new ToolRegistry();
    sm.setKeys("tool:select", ["s"]);
    const bindings = sm.allBindings(registry);
    expect(bindings.s).toBe("tool:select");
    expect(bindings.v).toBeUndefined();
  });

  it("findConflict 报告占用者并支持排除自身", () => {
    const sm = new ShortcutManager();
    const registry = new ToolRegistry();
    expect(sm.findConflict("ctrl+s", "tool:x", registry)?.label).toBe(
      "操作「保存文件」",
    );
    expect(sm.findConflict("v", "tool:x", registry)?.label).toContain("选择");
    expect(sm.findConflict("ctrl+s", "save", registry)).toBeNull();
    expect(sm.findConflict("q", "tool:lasso", registry)).toBeNull();
  });

  it("restoreDefault 清掉被挤占操作的自定义键", () => {
    const sm = new ShortcutManager();
    sm.setKeys("save", ["ctrl+w"]);
    sm.restoreDefault("save");
    expect(sm.getKeys("save")).toEqual(["ctrl+s"]);
  });

  it("损坏的持久化数据回退为默认", () => {
    store.set("miniboard:shortcuts", "{bad json");
    const sm = new ShortcutManager();
    expect(sm.getKeys("save")).toEqual(["ctrl+s"]);
  });
});
