import type {
  CustomToolDef,
  CustomToolInput,
  ElementData,
  GeneratorContext,
  ToolDef,
  ToolKind,
} from "../types";

const LS_KEY = "miniboard:custom-tools";

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ================= 内置工具 =================

/** 内置 drag 工具的生成器（从 canvas 原有 switch 逻辑迁为数据，行为保持一致） */
const builtinGenerators: Record<string, (c: GeneratorContext) => ElementData> = {
  rect(c) {
    const { x0, y0, x1, y1, style } = c;
    return {
      type: "rect",
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
      fill: style.fillEnabled
        ? hexToRgba(style.fillColor || style.stroke, 0.15)
        : undefined,
    };
  },
  ellipse(c) {
    const { x0, y0, x1, y1, style } = c;
    return {
      type: "ellipse",
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
      fill: style.fillEnabled
        ? hexToRgba(style.fillColor || style.stroke, 0.15)
        : undefined,
    };
  },
  line(c) {
    const { x0, y0, x1, y1, style } = c;
    return {
      type: "line",
      x: 0,
      y: 0,
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
      points: [
        { x: x0, y: y0 },
        { x: x1, y: y1 },
      ],
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
    };
  },
  arrow(c) {
    const { x0, y0, x1, y1, style } = c;
    return {
      type: "arrow",
      x: 0,
      y: 0,
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
      points: [
        { x: x0, y: y0 },
        { x: x1, y: y1 },
      ],
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
    };
  },
};

/** 内置工具元数据（顺序即工具栏显示顺序；交互/笔迹工具保留 canvas 专有实现） */
const BUILTIN: ToolDef[] = [
  { id: "select", name: "选择", icon: "↖", title: "选择 (V)", shortcut: "v", kind: "interaction", source: "builtin" },
  { id: "hand", name: "画布移动", icon: "✋", title: "画布移动 (H)", shortcut: "h", kind: "interaction", source: "builtin" },
  { id: "marquee", name: "框选", icon: "⛶", title: "框选 (M)", shortcut: "m", kind: "interaction", group: "select", source: "builtin" },
  { id: "lasso", name: "套索选中", icon: "∿", title: "套索选中 (Q)", shortcut: "q", kind: "interaction", group: "select", source: "builtin" },
  { id: "pen", name: "画笔", icon: "✏", title: "画笔 (P)", shortcut: "p", kind: "freehand", source: "builtin" },
  { id: "eraser", name: "橡皮擦", icon: "⌫", title: "橡皮擦 (E)", shortcut: "e", kind: "interaction", source: "builtin" },
  { id: "line", name: "直线", icon: "╱", title: "直线 (L)", shortcut: "l", kind: "drag", source: "builtin" },
  { id: "arrow", name: "箭头", icon: "→", title: "箭头 (A)", shortcut: "a", kind: "drag", source: "builtin" },
  { id: "rect", name: "矩形", icon: "▭", title: "矩形 (R)", shortcut: "r", kind: "drag", group: "shape", source: "builtin" },
  { id: "ellipse", name: "椭圆", icon: "◯", title: "椭圆 (O)", shortcut: "o", kind: "drag", group: "shape", source: "builtin" },
  { id: "text", name: "文本", icon: "T", title: "文本 (T)", shortcut: "t", kind: "interaction", source: "builtin" },
];

// ================= 注册表 =================

/**
 * 统一功能注册表：内置工具（只读）+ AI 生成工具（localStorage 持久化）。
 * 工具栏渲染、快捷键映射、绘制分发均以注册表为准。
 */
export class ToolRegistry {
  private custom: CustomToolDef[] = [];
  private compiled = new Map<string, (c: GeneratorContext) => ElementData>();
  private generatorWarned = new Set<string>();
  private onChangeFn: () => void = () => {};

  constructor() {
    const { list, migrated } = this.load();
    this.custom = list;
    if (migrated) {
      // 旧数据补上分组标记后立即持久化，后续不再重复迁移
      this.save();
    }
  }

  /** 注册表变化回调（用于工具栏刷新等） */
  setOnChange(fn: () => void) {
    this.onChangeFn = fn;
  }

  /** 全部工具（内置 + 自定义，按工具栏顺序） */
  list(): ToolDef[] {
    return [...BUILTIN, ...this.custom];
  }

  getTool(id: string): ToolDef | undefined {
    return this.list().find((t) => t.id === id);
  }

  getKind(id: string): ToolKind | undefined {
    return this.getTool(id)?.kind;
  }

  /**
   * 编译生成器源码并校验（语法 + 探针调用），成功缓存。
   * 兼容两种源码形态：函数表达式 `(ctx) => {...}`（AI 示例格式）与函数体 `{ ... return {...}; }`。
   * 编译失败抛错，调用方应捕获并向用户反馈具体原因。
   */
  compileGenerator(code: string): (c: GeneratorContext) => ElementData {
    const raw = new Function(
      "ctx",
      `"use strict"; return (${code});`,
    ) as (
      ctx: GeneratorContext,
    ) => ElementData | ((c: GeneratorContext) => ElementData);
    // 函数表达式格式：raw 返回的是函数本身，再调用一次取元素数据
    const fn = (ctx: GeneratorContext): ElementData => {
      const out = raw(ctx);
      return typeof out === "function"
        ? (out as (c: GeneratorContext) => ElementData)(ctx)
        : out;
    };
    // 探针调用：必须返回带合法 type 的元素数据对象
    const probe = fn({
      x0: 0,
      y0: 0,
      x1: 10,
      y1: 10,
      style: { stroke: "#000000", strokeWidth: 2, fillEnabled: false, fillColor: "#000000" },
    });
    if (!probe || typeof probe !== "object" || typeof probe.type !== "string") {
      throw new Error("生成器必须返回元素数据对象（ElementData）");
    }
    return fn;
  }

  /** 获取 drag 工具的可执行生成器（内置或自定义），不存在返回 null */
  getGenerator(id: string): ((c: GeneratorContext) => ElementData) | null {
    if (builtinGenerators[id]) {
      return builtinGenerators[id];
    }
    const cached = this.compiled.get(id);
    if (cached) {
      return cached;
    }
    const tool = this.custom.find((t) => t.id === id);
    if (!tool) {
      return null;
    }
    try {
      const fn = this.compileGenerator(tool.generator);
      this.compiled.set(id, fn);
      return fn;
    } catch (err) {
      // 损坏的生成器：按无生成器处理（工具仍可选中，但无法绘制），告警只报一次避免刷屏
      if (!this.generatorWarned.has(id)) {
        this.generatorWarned.add(id);
        console.error(`[registry] 生成器编译失败（tool=${id}）`, err);
      }
      return null;
    }
  }

  /** 新增自定义工具：校验后注册并持久化，返回新工具定义 */
  addCustom(input: CustomToolInput): CustomToolDef {
    const tool: CustomToolDef = {
      id: this.allocId(),
      name: input.name.trim(),
      icon: input.icon.trim(),
      title: "",
      shortcut: input.shortcut?.trim().toLowerCase() || undefined,
      kind: "drag",
      source: "custom",
      group: input.group, // 同类型工具归入同一分组（如形状类归入 shape 下拉）
      generator: input.generator,
      description: input.description,
      createdAt: Date.now(),
    };
    tool.title = this.titleOf(tool.name, tool.shortcut);
    this.validateInput(input);
    this.checkShortcutConflict(tool);
    this.custom.push(tool);
    this.save();
    this.onChangeFn();
    return tool;
  }

  /** 修改自定义工具（内置工具不可改），返回更新后的定义；id 不存在返回 null */
  updateCustom(
    id: string,
    patch: Partial<CustomToolInput>,
  ): CustomToolDef | null {
    const tool = this.custom.find((t) => t.id === id);
    if (!tool) {
      return null;
    }
    const next: CustomToolInput = {
      name: patch.name ?? tool.name,
      icon: patch.icon ?? tool.icon,
      shortcut: patch.shortcut !== undefined ? patch.shortcut : tool.shortcut,
      generator: patch.generator ?? tool.generator,
      description:
        patch.description !== undefined ? patch.description : tool.description,
      group: patch.group !== undefined ? patch.group : tool.group,
    };
    this.validateInput(next);
    this.checkShortcutConflict({ ...tool, ...next }, id);
    tool.name = next.name.trim();
    tool.icon = next.icon.trim();
    tool.shortcut = next.shortcut?.trim().toLowerCase() || undefined;
    tool.title = this.titleOf(tool.name, tool.shortcut);
    tool.generator = next.generator;
    tool.description = next.description;
    tool.group = next.group;
    this.compiled.delete(id); // 生成器可能已变，清缓存
    this.save();
    this.onChangeFn();
    return tool;
  }

  /** 删除自定义工具（内置工具不可删），返回是否成功 */
  removeCustom(id: string): boolean {
    const i = this.custom.findIndex((t) => t.id === id);
    if (i < 0) {
      return false;
    }
    this.custom.splice(i, 1);
    this.compiled.delete(id);
    this.save();
    this.onChangeFn();
    return true;
  }

  // ---------- 内部 ----------

  private titleOf(name: string, shortcut?: string): string {
    return shortcut ? `${name} (${shortcut.toUpperCase()})` : `${name}（拖拽绘制）`;
  }

  private validateInput(input: CustomToolInput) {
    if (!input.name?.trim()) {
      throw new Error("工具名称不能为空");
    }
    if (!input.icon?.trim()) {
      throw new Error("工具图标不能为空（用一个字符或短符号）");
    }
    if (!input.generator?.trim()) {
      throw new Error("生成器代码不能为空");
    }
    if (input.group !== undefined && input.group !== "shape") {
      // AI 工具均为拖拽生成类，目前只允许归入形状分组；select 组为内置选中类工具专属
      throw new Error(`分组 ${String(input.group)} 不支持，自定义工具只能归入 shape（形状下拉）或省略`);
    }
    this.compileGenerator(input.generator); // 编译失败会抛错
  }

  private checkShortcutConflict(def: ToolDef, exceptId?: string) {
    if (!def.shortcut) {
      return;
    }
    if (def.shortcut === "k") {
      // k 已被 AI 助手面板开关占用（保留键）
      throw new Error("快捷键 k 已被保留（AI 助手开关），请换一个字母");
    }
    const clash = this.list().find(
      (t) => t.id !== exceptId && t.shortcut === def.shortcut,
    );
    if (clash) {
      throw new Error(`快捷键 ${def.shortcut} 已被工具「${clash.name}」占用`);
    }
  }

  private allocId(): string {
    let id: string;
    do {
      id = `tool-${Date.now().toString(36)}${Math.floor(Math.random() * 36).toString(36)}`;
    } while (this.getTool(id));
    return id;
  }

  /**
   * 从 localStorage 读取自定义工具；对旧数据（无分组标记）按名称关键词
   * 迁移分组：名称含形状特征词的工具归入 shape（形状下拉）。
   */
  private load(): { list: CustomToolDef[]; migrated: boolean } {
    let migrated = false;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) {
        return { list: [], migrated };
      }
      const parsed = JSON.parse(raw) as CustomToolDef[];
      if (!Array.isArray(parsed)) {
        return { list: [], migrated };
      }
      const list = parsed.filter(
        (t) =>
          t &&
          typeof t.id === "string" &&
          typeof t.generator === "string" &&
          typeof t.name === "string",
      );
      for (const t of list) {
        if (!t.group && /三角|星|圆|矩形|正方|长方|菱形|边形|心形|形状|形$/.test(t.name)) {
          t.group = "shape";
          migrated = true;
        }
      }
      return { list, migrated };
    } catch {
      return { list: [], migrated };
    }
  }

  private save() {
    localStorage.setItem(LS_KEY, JSON.stringify(this.custom));
  }
}
