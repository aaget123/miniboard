// 快捷键配置中心：内置操作 + 内置工具的键位可自定义（localStorage 持久化）。
// 组合串规范（匹配与存储共用）：小写 key + 修饰符，按 ctrl/meta/shift/alt 顺序加 "+" 连接，
// 例如 "ctrl+shift+z"、"k"、"delete"、"ctrl+="；符号键 "+" 转义为 "plus"（避免与分隔符混淆）。
// ctrl 与 meta（Cmd）归一为 ctrl，与原实现"Ctrl 或 Cmd 等效"的行为保持一致。
// AI 自定义工具的快捷键仍由注册表维护（⚙ 设置 →「AI 工具」页签编辑），本模块只读引用。

export type ShortcutAction = {
  id: string;
  label: string;
  defaultKeys: string[];
};

/** 可自定义的内置操作清单（顺序即设置页显示顺序） */
export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: "save", label: "保存文件", defaultKeys: ["ctrl+s"] },
  { id: "open", label: "打开文件", defaultKeys: ["ctrl+o"] },
  { id: "undo", label: "撤销", defaultKeys: ["ctrl+z"] },
  { id: "redo", label: "重做", defaultKeys: ["ctrl+shift+z", "ctrl+y"] },
  { id: "copy", label: "复制", defaultKeys: ["ctrl+c"] },
  { id: "cut", label: "剪切", defaultKeys: ["ctrl+x"] },
  { id: "paste", label: "粘贴", defaultKeys: ["ctrl+v"] },
  { id: "selectAll", label: "全选", defaultKeys: ["ctrl+a"] },
  { id: "delete", label: "删除选中", defaultKeys: ["delete", "backspace"] },
  { id: "duplicate", label: "重复选中", defaultKeys: ["ctrl+d"] },
  { id: "escape", label: "逐层退出", defaultKeys: ["escape"] },
  { id: "palette", label: "命令面板", defaultKeys: ["ctrl+k"] },
  { id: "aiPanel", label: "AI 助手面板", defaultKeys: ["k"] },
  { id: "zoomIn", label: "放大", defaultKeys: ["ctrl+=", "ctrl+plus"] },
  { id: "zoomOut", label: "缩小", defaultKeys: ["ctrl+-"] },
  { id: "zoomReset", label: "重置缩放", defaultKeys: ["ctrl+0"] },
];

const LS_KEY = "miniboard:shortcuts";

/** 事件（或等价结构）→ 规范化组合串；纯修饰键按下时返回空串（表示忽略） */
export function comboFromEvent(e: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): string {
  const k = e.key;
  if (k === "Control" || k === "Shift" || k === "Alt" || k === "Meta") {
    return "";
  }
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) {
    parts.push("ctrl");
  }
  // 符号键的 key 已编码 shift 语义（如 Ctrl+Shift+= 的 key 是 "+"），不再单计 shift
  const isSymbol = k.length === 1 && !/[a-z0-9]/i.test(k);
  if (e.shiftKey && !isSymbol) {
    parts.push("shift");
  }
  if (e.altKey) {
    parts.push("alt");
  }
  parts.push(normKey(k));
  return parts.join("+");
}

/** key 规范化：小写 + "+" 转义为 "plus" */
export function normKey(key: string): string {
  const lower = key.toLowerCase();
  return lower === "+" ? "plus" : lower;
}

/** 组合串 → 展示文本（"ctrl+shift+z" → "Ctrl+Shift+Z"） */
export function formatCombo(combo: string): string {
  return combo
    .split("+")
    .map((p) => {
      switch (p) {
        case "ctrl":
          return "Ctrl";
        case "shift":
          return "Shift";
        case "alt":
          return "Alt";
        case "escape":
          return "Esc";
        case "backspace":
          return "Backspace";
        case "delete":
          return "Delete";
        case "plus":
          return "+";
        default:
          return p.length === 1 ? p.toUpperCase() : p;
      }
    })
    .join("+");
}

/** 组合串列表 → 展示文本（多个键用 " / " 连接） */
export function formatKeys(keys: string[]): string {
  return keys.map(formatCombo).join(" / ");
}

type RegistryLike = {
  list(): { id: string; name: string; shortcut?: string; source?: string }[];
};

/**
 * 快捷键配置管理：读取/保存用户配置，构建生效键位映射（工具 + 操作）。
 * 优先级：用户显式配置 > 默认值；操作 > 工具（与原硬编码判断顺序一致）。
 */
export class ShortcutManager {
  private config: Record<string, string[]> = {};
  private onChangeFn: () => void = () => {};

  constructor() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const [id, keys] of Object.entries(parsed)) {
          if (Array.isArray(keys)) {
            this.config[id] = keys
              .filter((k): k is string => typeof k === "string")
              .map((k) => k.trim().toLowerCase())
              .filter(Boolean);
          }
        }
      }
    } catch {
      this.config = {};
    }
  }

  /** 配置变化回调（main.ts 重建 keymap / 刷新帮助用） */
  setOnChange(fn: () => void) {
    this.onChangeFn = fn;
  }

  /** 某操作的生效键位（用户配置优先，否则默认值） */
  getKeys(id: string): string[] {
    const custom = this.config[id];
    if (custom && custom.length) {
      return [...custom];
    }
    const def = SHORTCUT_ACTIONS.find((a) => a.id === id)?.defaultKeys;
    return def ? [...def] : [];
  }

  /** 工具的生效键位：用户配置（tool:<id>）优先，否则用注册表 shortcut（内置工具默认键来自 BUILTIN） */
  toolKeys(tool: { id: string; shortcut?: string }): string[] {
    const custom = this.config[`tool:${tool.id}`];
    if (custom && custom.length) {
      return [...custom];
    }
    return tool.shortcut ? [tool.shortcut.trim().toLowerCase()] : [];
  }

  /** 是否为默认键位（未自定义） */
  isDefault(id: string): boolean {
    const custom = this.config[id];
    const def = SHORTCUT_ACTIONS.find((a) => a.id === id)?.defaultKeys;
    if (!custom) {
      return true;
    }
    if (custom.length !== (def?.length ?? 0)) {
      return false;
    }
    return custom.every((k, i) => k === def![i]);
  }

  /** 设置键位（空数组 = 恢复默认）；返回是否发生变化 */
  setKeys(id: string, keys: string[]): boolean {
    const cleaned = keys
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    if (id.startsWith("tool:")) {
      // 工具默认键由注册表维护（配置层不存默认值），仅写入非空自定义键
      if (cleaned.length) {
        this.config[id] = cleaned;
      } else {
        delete this.config[id];
      }
    } else {
      const def = SHORTCUT_ACTIONS.find((a) => a.id === id)?.defaultKeys;
      const sameAsDefault =
        !def || (cleaned.length === def.length && cleaned.every((k, i) => k === def[i]));
      if (sameAsDefault) {
        delete this.config[id];
      } else if (cleaned.length) {
        this.config[id] = cleaned;
      } else {
        delete this.config[id];
      }
    }
    this.save();
    this.onChangeFn();
    return true;
  }

  /** 恢复全部默认 */
  resetAll() {
    this.config = {};
    this.save();
    this.onChangeFn();
  }

  /**
   * 全量生效映射：组合串 → 动作 id（"tool:xxx" 或操作 id）。
   * 构建顺序：工具（配置优先，否则注册表 shortcut）→ 操作（覆盖，操作优先）。
   */
  allBindings(registry: RegistryLike): Record<string, string> {
    const map: Record<string, string> = {};
    for (const t of registry.list()) {
      for (const k of this.toolKeys(t)) {
        map[k] = `tool:${t.id}`;
      }
    }
    for (const a of SHORTCUT_ACTIONS) {
      for (const k of this.getKeys(a.id)) {
        map[k] = a.id;
      }
    }
    return map;
  }

  /** 冲突检测：组合串是否已被其他操作/工具占用（exceptId 排除自身） */
  findConflict(
    combo: string,
    exceptId: string,
    registry: RegistryLike,
  ): { id: string; label: string } | null {
    const bindings = this.allBindings(registry);
    const owner = bindings[combo];
    if (!owner || owner === exceptId) {
      return null;
    }
    if (owner.startsWith("tool:")) {
      const tool = registry.list().find((t) => `tool:${t.id}` === owner);
      return { id: owner, label: tool ? `工具「${tool.name}」` : owner };
    }
    const action = SHORTCUT_ACTIONS.find((a) => a.id === owner);
    return { id: owner, label: action ? `操作「${action.label}」` : owner };
  }

  /** 冲突项恢复默认键（覆盖冲突时被挤占的操作/内置工具使用；AI 工具不在此列） */
  restoreDefault(id: string) {
    delete this.config[id];
    this.save();
    this.onChangeFn();
  }

  private save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.config));
    } catch {
      // 存储不可用时静默失败（快捷键退化为默认值）
    }
  }
}
