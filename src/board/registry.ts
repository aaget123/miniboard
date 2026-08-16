import type {
  CustomToolDef,
  CustomToolInput,
  ElementData,
  GeneratorContext,
  ToolDef,
  ToolKind,
} from "../types";
import { validateElementList } from "./validate";

const LS_KEY = "miniboard:custom-tools";

/** 自定义工具持久化适配器（桌面端文件 / 浏览器 localStorage） */
export interface ToolStorage {
  /** 读取已有工具列表；无数据返回 null（读取失败同样返回 null） */
  read(): CustomToolDef[] | null;
  /** 持久化工具列表 */
  write(list: CustomToolDef[]): void;
}

/** 默认浏览器实现：localStorage（兼容测试与浏览器环境） */
const localStorageStorage: ToolStorage = {
  read() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? (JSON.parse(raw) as CustomToolDef[]) : null;
    } catch {
      return null;
    }
  },
  write(list) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(list));
    } catch {
      // 存储不可用时静默失败（不阻断绘制流程）
    }
  },
};

/** AI 自定义工具允许的行为类别（其余 kind 为内置工具专属） */
export const CUSTOM_KINDS = ["drag", "click"] as const;

/**
 * 生成器静态危险扫描：AI 工具只允许纯 JavaScript 数学计算，
 * 拒绝循环/越权 API（冒烟测试第一道防线，同步执行）。
 */
const FORBIDDEN_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bwhile\s*\(/i, label: "while 循环" },
  { pattern: /for\s*\(\s*;\s*;/i, label: "无限 for 循环" },
  { pattern: /\beval\s*\(/i, label: "eval" },
  { pattern: /new\s+Function/i, label: "new Function" },
  { pattern: /\bdocument\b/i, label: "document（DOM API）" },
  { pattern: /\bwindow\b/i, label: "window" },
  { pattern: /\bfetch\s*\(/i, label: "fetch（网络请求）" },
  { pattern: /XMLHttpRequest/i, label: "XMLHttpRequest" },
  { pattern: /\blocalStorage\b/i, label: "localStorage" },
  { pattern: /\bsessionStorage\b/i, label: "sessionStorage" },
  { pattern: /\bsetTimeout\s*\(/i, label: "setTimeout" },
  { pattern: /\bsetInterval\s*\(/i, label: "setInterval" },
  { pattern: /\bimport\s*\(/i, label: "动态 import" },
  { pattern: /\bWorker\s*\(/i, label: "Worker" },
  { pattern: /\bWebSocket\b/i, label: "WebSocket" },
];

/**
 * 扫描生成器源码，返回违规项列表（空数组 = 通过）。
 * kind 为 "click" 时额外拒绝随机函数：点击即生成固定大小元素，
 * 随机尺寸/随机位置会让印章每次点击大小位置漂移，行为不可预期。
 */
export function scanGeneratorSource(code: string, kind?: string): string[] {
  const hits: string[] = [];
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      hits.push(label);
    }
  }
  if (kind === "click" && /\bMath\.random\s*\(|\brandom\s*\(/i.test(code)) {
    hits.push("随机函数（点击类工具必须固定大小、以点击点为中心，禁止随机）");
  }
  return hits;
}

/**
 * AI 工具图标白名单：只允许 1-2 个字符的中文/字母/数字/常见符号，
 * 拒绝彩色 emoji 与超长符号，保证工具栏图标风格统一（字符按 currentColor 渲染）。
 */
const ICON_PATTERN = /^[\u4e00-\u9fff\w▭◯△▲▽▼◇◆□■○●★☆✦✧→←↑↓↔╱╲∥∣✚＋＊※♥♠♦♣⚡]{1,2}$/;

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ================= 内置工具 =================

/** 内置 drag 工具的生成器（从 canvas 原有 switch 逻辑迁为数据，行为保持一致） */
const builtinGenerators: Record<
  string,
  (c: GeneratorContext) => ElementData | ElementData[]
> = {
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
  frame(c) {
    const { x0, y0, x1, y1, style } = c;
    return {
      type: "frame",
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
      // 框架淡填充固定 10% 透明度（区别于普通图形的 15%，突出容器感）
      fill: hexToRgba(style.fillColor || style.stroke, 0.1),
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

/** 内置工具元数据（顺序即工具栏显示顺序；交互/笔迹工具保留 canvas 专有实现）
 * icon 为 src/ui/icons.ts 的图标名（SVG 渲染），与 AI 工具字符图标区分
 * 选中类工具（选择/框选/套索）归入 select 组：顶栏显示为拆分按钮，
 * 点击主按钮直接使用当前选择工具（默认“选择”），右侧箭头展开切换框选/套索；
 * 画布移动保持平铺（高频且不与选中类工具互相替代） */
const BUILTIN: ToolDef[] = [
  { id: "select", name: "选择", icon: "select", title: "选择 (V)", shortcut: "v", kind: "interaction", group: "select", source: "builtin" },
  { id: "hand", name: "画布移动", icon: "hand", title: "画布移动 (H)", shortcut: "h", kind: "interaction", source: "builtin" },
  { id: "marquee", name: "框选", icon: "marquee", title: "框选 (M)", shortcut: "m", kind: "interaction", group: "select", source: "builtin" },
  { id: "lasso", name: "套索选中", icon: "lasso", title: "套索选中 (Q)", shortcut: "q", kind: "interaction", group: "select", source: "builtin" },
  { id: "pen", name: "画笔", icon: "pen", title: "画笔 (P)", shortcut: "p", kind: "freehand", source: "builtin" },
  { id: "eraser", name: "橡皮擦", icon: "eraser", title: "橡皮擦 (E)", shortcut: "e", kind: "interaction", source: "builtin" },
  { id: "line", name: "直线", icon: "line", title: "直线 (L)", shortcut: "l", kind: "drag", source: "builtin" },
  { id: "arrow", name: "箭头", icon: "arrow", title: "箭头 (A)", shortcut: "a", kind: "drag", source: "builtin" },
  { id: "rect", name: "矩形", icon: "rect", title: "矩形 (R)", shortcut: "r", kind: "drag", group: "shape", source: "builtin" },
  { id: "ellipse", name: "椭圆", icon: "ellipse", title: "椭圆 (O)", shortcut: "o", kind: "drag", group: "shape", source: "builtin" },
  { id: "frame", name: "框架", icon: "frame", title: "框架 (F)", shortcut: "f", kind: "drag", group: "shape", source: "builtin" },
  { id: "text", name: "文本", icon: "text", title: "文本 (T)", shortcut: "t", kind: "interaction", source: "builtin" },
];

// ================= 注册表 =================

/**
 * 统一功能注册表：内置工具（只读）+ AI 生成工具（自定义持久化适配器注入）。
 * 工具栏渲染、快捷键映射、绘制分发均以注册表为准。
 */
export class ToolRegistry {
  private custom: CustomToolDef[] = [];
  private compiled = new Map<
    string,
    (c: GeneratorContext) => ElementData | ElementData[]
  >();
  private generatorWarned = new Set<string>();
  private onChangeFn: () => void = () => {};

  constructor(private storage: ToolStorage = localStorageStorage) {
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
   * 返回值可为单个元素数据或元素数据数组（组合工具）。编译失败抛错，调用方应捕获并向用户反馈具体原因。
   */
  compileGenerator(
    code: string,
  ): (c: GeneratorContext) => ElementData | ElementData[] {
    const raw = new Function(
      "ctx",
      `"use strict"; return (${code});`,
    ) as (
      ctx: GeneratorContext,
    ) => ElementData | ElementData[] | ((c: GeneratorContext) => ElementData | ElementData[]);
    // 函数表达式格式：raw 返回的是函数本身，再调用一次取元素数据
    const fn = (ctx: GeneratorContext): ElementData | ElementData[] => {
      const out = raw(ctx);
      return typeof out === "function"
        ? (out as (c: GeneratorContext) => ElementData | ElementData[])(ctx)
        : out;
    };
    // 探针调用：必须返回带合法 type 的元素数据对象（单个或数组）
    const probe = fn({
      x0: 0,
      y0: 0,
      x1: 10,
      y1: 10,
      style: { stroke: "#000000", strokeWidth: 2, fillEnabled: false, fillColor: "#000000" },
    });
    const checked = validateElementList(probe);
    if (!checked.ok) {
      throw new Error(`生成器返回值不合法：${checked.error}`);
    }
    return fn;
  }

  /** 获取 drag/click 工具的可执行生成器（内置或自定义），不存在返回 null */
  getGenerator(
    id: string,
  ): ((c: GeneratorContext) => ElementData | ElementData[]) | null {
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

  /**
   * 冒烟测试：在隔离 Worker 中执行生成器（语法检查 + 探针调用 + 超时熔断），
   * 再对返回值做 schema 强校验。AI 添加/修改工具前调用，返回可用的元素数据或错误原因。
   */
  async smokeTest(
    generator: string,
    kind?: string,
  ): Promise<
    | { ok: true; elements: ElementData[] }
    | { ok: false; error: string }
  > {
    // 第一道防线：静态危险扫描（同步，秒拒明显越权/循环代码；click 类额外拒绝随机函数）
    const hits = scanGeneratorSource(generator, kind);
    if (hits.length) {
      return {
        ok: false,
        error: `生成器包含不允许的代码：${hits.join("、")}。工具生成器只能使用纯 JavaScript 数学计算（ctx 参数 + 常量），不能操作页面、网络或进行循环${kind === "click" ? "；点击类工具需固定大小并以点击点为中心" : ""}`,
      };
    }
    // 第二道防线：Worker 隔离执行（语法错误/运行时异常/死循环均被拦截，超时熔断）
    const ctx = {
      x0: 0,
      y0: 0,
      x1: 120,
      y1: 90,
      style: {
        stroke: "#4f8cff",
        strokeWidth: 2,
        fillEnabled: false,
        fillColor: "#4f8cff",
      },
    };
    const workerSrc = `
      const code = ${JSON.stringify(generator)};
      const ctx = ${JSON.stringify(ctx)};
      let out = null;
      let errMsg = null;
      try {
        const raw = new Function("ctx", '"use strict"; return (' + code + ');');
        const res = raw(ctx);
        out = typeof res === "function" ? res(ctx) : res;
      } catch (err) {
        errMsg = String((err && err.message) || err);
      }
      if (errMsg) {
        postMessage({ error: errMsg });
      } else {
        try {
          postMessage({ ok: true, data: JSON.parse(JSON.stringify(out)) });
        } catch {
          postMessage({ error: "生成器返回值无法序列化（必须返回纯数据对象）" });
        }
      }
    `;
    const blob = new Blob([workerSrc], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const run = new Promise<{ ok?: boolean; error?: string; data?: unknown }>(
      (resolve, reject) => {
        const worker = new Worker(url);
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error("timeout"));
        }, 1500);
        worker.onmessage = (e: MessageEvent) => {
          clearTimeout(timer);
          worker.terminate();
          resolve(e.data as { ok?: boolean; error?: string; data?: unknown });
        };
        worker.onerror = () => {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error("worker"));
        };
      },
    );
    try {
      const res = await run;
      if (!res.ok) {
        return { ok: false, error: res.error ?? "未知执行错误" };
      }
      const checked = validateElementList(res.data);
      if (!checked.ok) {
        return { ok: false, error: checked.error };
      }
      return { ok: true, elements: checked.data };
    } catch {
      return {
        ok: false,
        error: "生成器执行超时或运行异常（疑似死循环/非法代码），请简化逻辑后重试",
      };
    } finally {
      URL.revokeObjectURL(url);
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
      kind: input.kind ?? "drag",
      source: "custom",
      // 分组：AI 明确归 shape 时进“形状”下拉；未指定一律进“AI 工具”下拉（避免平铺顶栏）
      group: input.group ?? "ai",
      generator: input.generator,
      description: input.description,
      createdAt: Date.now(),
    };
    tool.title = this.titleOf(tool.name, tool.shortcut, tool.kind);
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
      kind: patch.kind !== undefined ? patch.kind : tool.kind,
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
    tool.kind = next.kind ?? "drag";
    tool.title = this.titleOf(tool.name, tool.shortcut, tool.kind);
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

  private titleOf(
    name: string,
    shortcut: string | undefined,
    kind: "drag" | "click",
  ): string {
    if (shortcut) {
      return `${name} (${shortcut.toUpperCase()})`;
    }
    return kind === "click" ? `${name}（点击生成）` : `${name}（拖拽绘制）`;
  }

  private validateInput(input: CustomToolInput) {
    if (!input.name?.trim()) {
      throw new Error("工具名称不能为空");
    }
    if (!input.icon?.trim()) {
      throw new Error("工具图标不能为空（1-2 个字符，如 ★、星）");
    }
    if (!ICON_PATTERN.test(input.icon.trim())) {
      throw new Error("工具图标只支持 1-2 个字符的中文/字母/数字/常见符号（如 ★、▭、箭头），不能使用 emoji 或长文本");
    }
    if (!input.generator?.trim()) {
      throw new Error("生成器代码不能为空");
    }
    if (input.kind !== undefined && !(CUSTOM_KINDS as readonly string[]).includes(input.kind)) {
      throw new Error(`行为类别 ${String(input.kind)} 不支持，自定义工具只能是 drag（拖拽生成）或 click（点击生成）`);
    }
    if (input.group !== undefined && input.group !== "shape" && input.group !== "ai") {
      // select 组为内置选中类工具专属；shape 收形状类，其余默认 ai（AI 工具下拉）
      throw new Error(`分组 ${String(input.group)} 不支持，自定义工具只能归入 shape（形状）或 ai（AI 工具）`);
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
   * 从持久化适配器读取自定义工具；对旧数据（无分组标记）按名称关键词
   * 迁移分组：名称含形状特征词的工具归入 shape（形状下拉）。
   */
  private load(): { list: CustomToolDef[]; migrated: boolean } {
    let migrated = false;
    try {
      const parsed = this.storage.read();
      if (!parsed) {
        return { list: [], migrated };
      }
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
        if (!t.group) {
          // 旧数据迁移：形状关键词归入 shape，其余 AI 工具归入 ai（不再平铺顶栏）
          t.group = /三角|星|圆|矩形|正方|长方|菱形|边形|心形|形状|形$/.test(t.name)
            ? "shape"
            : "ai";
          migrated = true;
        }
        // 图标白名单回退：旧数据/损坏数据不合法时替换为默认符号（不拦截加载）
        if (typeof t.icon !== "string" || !ICON_PATTERN.test(t.icon)) {
          t.icon = "✧";
          migrated = true;
        }
      }
      return { list, migrated };
    } catch {
      return { list: [], migrated };
    }
  }

  private save() {
    this.storage.write(this.custom);
  }
}
