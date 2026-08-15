import type { ToolRegistry } from "../board/registry";
import type { ToolDef, ToolGroup } from "../types";
import { iconHTML, isIconName, type IconName } from "./icons";

export const SWATCHES = [
  "#e03131",
  "#e8590c",
  "#f08c00",
  "#fab005",
  "#40c057",
  "#12b886",
  "#1098ad",
  "#1c7ed6",
  "#4f8cff",
  "#7048e8",
  "#9c36b5",
  "#e64980",
  "#ffffff",
  "#adb5bd",
  "#495057",
  "#000000",
];

export type ToolbarHandlers = {
  onTool: (tool: string) => void;
  /** 填充开关（常驻顶部：未选中时设置新绘制图形的默认填充） */
  onFillChange: (enabled: boolean) => void;
  /** 打开共享样式浮层（顶栏默认样式入口；anchor 为按钮位置） */
  onStyle?: (anchor: DOMRect) => void;
  /** 打开 AI 工具管理（“AI 工具▾”下拉底部入口） */
  onManageTools?: () => void;
};

// ---------- 工具栏布局偏好（自定义工具栏） ----------

const TOOLBAR_KEY = "miniboard:toolbar";

/** 分组顺序偏好存储键：三个分组按钮在顶栏中的显示顺序 */
const GROUP_ORDER_KEY = "miniboard:toolbar-groups";

const ALL_GROUPS: ToolGroup[] = ["select", "shape", "ai"];

// ---------- 自定义分组（用户自建）与工具归属覆盖 ----------

/** 自定义分组定义：id 作为 ToolGroup 值（"cg-xxx"），name 为顶栏/设置页显示名 */
export type CustomGroupDef = { id: string; name: string };

const CUSTOM_GROUPS_KEY = "miniboard:toolbar-custom-groups";

/** 读取自定义分组定义；数据损坏/缺失时返回空数组 */
export function loadCustomGroups(): CustomGroupDef[] {
  try {
    const raw = localStorage.getItem(CUSTOM_GROUPS_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (d): d is CustomGroupDef =>
        !!d && typeof d.id === "string" && typeof d.name === "string",
    );
  } catch {
    return [];
  }
}

/** 保存自定义分组定义（空数组 = 清除）；localStorage 不可用时仅本次会话生效 */
export function saveCustomGroups(defs: CustomGroupDef[]) {
  try {
    if (defs.length) {
      localStorage.setItem(CUSTOM_GROUPS_KEY, JSON.stringify(defs));
    } else {
      localStorage.removeItem(CUSTOM_GROUPS_KEY);
    }
  } catch {
    // 忽略：仅本次会话生效
  }
}

/** 工具归属覆盖存储键：toolId → 分组 id（拖到自定义分组头时写入；内置组清除） */
const GROUP_OVERRIDES_KEY = "miniboard:tool-group-overrides";

/** 读取工具归属覆盖；数据损坏/缺失时返回空对象 */
export function loadGroupOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(GROUP_OVERRIDES_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** 保存工具归属覆盖（空对象 = 清除） */
export function saveGroupOverrides(o: Record<string, string>) {
  try {
    if (Object.keys(o).length) {
      localStorage.setItem(GROUP_OVERRIDES_KEY, JSON.stringify(o));
    } else {
      localStorage.removeItem(GROUP_OVERRIDES_KEY);
    }
  } catch {
    // 忽略：仅本次会话生效
  }
}

/** 加号入组记录存储键：groupId → 从平铺区加入该组的工具 id 列表（删除组时恢复平铺） */
const GROUP_JOIN_KEY = "miniboard:tool-group-joins";

/** 读取加号入组记录；数据损坏/缺失时返回空对象 */
export function loadGroupJoins(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(GROUP_JOIN_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const out: Record<string, string[]> = {};
    for (const [g, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        out[g] = v.filter((x): x is string => typeof x === "string");
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** 保存加号入组记录（空对象 = 清除） */
export function saveGroupJoins(o: Record<string, string[]>) {
  try {
    if (Object.keys(o).length) {
      localStorage.setItem(GROUP_JOIN_KEY, JSON.stringify(o));
    } else {
      localStorage.removeItem(GROUP_JOIN_KEY);
    }
  } catch {
    // 忽略：仅本次会话生效
  }
}

/** 工具实际归属分组：覆盖值优先，其次注册表默认（undefined = 未分组） */
export function effectiveGroup(
  t: ToolDef,
  overrides: Record<string, string>,
): ToolGroup | undefined {
  const o = overrides[t.id];
  return o ? (o as ToolGroup) : t.group;
}

/**
 * 读取工具栏布局偏好：平铺在顶栏的工具 id 数组（顺序即显示顺序）。
 * 返回 null 表示使用默认布局（未自定义过：无分组工具全部平铺、分组工具进下拉）。
 */
export function loadToolbarPref(): string[] | null {
  try {
    const raw = localStorage.getItem(TOOLBAR_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { visible?: unknown };
    if (!Array.isArray(parsed.visible)) {
      return null;
    }
    const list = parsed.visible.filter(
      (v): v is string => typeof v === "string",
    );
    return list.length ? list : null;
  } catch {
    return null;
  }
}

/** 保存工具栏布局偏好（null = 恢复默认布局）；localStorage 不可用时仅本次会话生效 */
export function saveToolbarPref(visible: string[] | null) {
  try {
    if (visible) {
      localStorage.setItem(TOOLBAR_KEY, JSON.stringify({ visible }));
    } else {
      localStorage.removeItem(TOOLBAR_KEY);
    }
  } catch {
    // 忽略：仅本次会话生效
  }
}

/**
 * 读取分组顺序偏好（三个分组按钮在顶栏中的显示顺序，null = 默认）。
 * 仅保留合法分组并去重；数据损坏/缺失时返回 null。
 */
export function loadGroupOrderPref(): ToolGroup[] | null {
  try {
    const raw = localStorage.getItem(GROUP_ORDER_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const seen = new Set<ToolGroup>();
    const list: ToolGroup[] = [];
    for (const v of parsed) {
      // 内置组或自定义组（"cg-*"）均接受，其余过滤
      const g =
        ALL_GROUPS.find((x) => x === v) ??
        (typeof v === "string" && v.startsWith("cg-") ? (v as ToolGroup) : undefined);
      if (g && !seen.has(g)) {
        seen.add(g);
        list.push(g);
      }
    }
    return list.length ? list : null;
  } catch {
    return null;
  }
}

/** 保存分组顺序偏好（null = 恢复默认顺序）；localStorage 不可用时仅本次会话生效 */
export function saveGroupOrderPref(order: ToolGroup[] | null) {
  try {
    if (order) {
      localStorage.setItem(GROUP_ORDER_KEY, JSON.stringify(order));
    } else {
      localStorage.removeItem(GROUP_ORDER_KEY);
    }
  } catch {
    // 忽略：仅本次会话生效
  }
}

/** 注册表首次出现顺序（分组默认顺序；pref 未包含的组按此追加到末尾） */
function defaultGroupOrder(
  tools: ToolDef[],
  overrides: Record<string, string> = {},
): ToolGroup[] {
  const order: ToolGroup[] = [];
  const seen = new Set<ToolGroup>();
  for (const t of tools) {
    const g = effectiveGroup(t, overrides);
    if (g && !seen.has(g)) {
      seen.add(g);
      order.push(g);
    }
  }
  return order;
}

/** 最终分组顺序：pref 优先，缺失的组按注册表顺序补到末尾，extra（自定义组）最后 */
function resolveGroupOrder(
  tools: ToolDef[],
  extra: string[] = [],
  overrides: Record<string, string> = {},
): ToolGroup[] {
  const order = loadGroupOrderPref() ?? [];
  for (const g of defaultGroupOrder(tools, overrides)) {
    if (!order.includes(g)) {
      order.push(g);
    }
  }
  for (const g of extra) {
    if (!order.includes(g)) {
      order.push(g);
    }
  }
  return order;
}

function makeButton(
  icon: string,
  title: string,
  onClick: () => void,
  cls = "tool-btn",
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = cls;
  btn.title = title;
  renderToolIcon(btn, icon);
  btn.addEventListener("click", onClick);
  return btn;
}

/**
 * 统一渲染工具图标：内置工具为 SVG 图标名（icons.ts），
 * AI 自定义工具为字符符号（1-2 字符白名单校验后按文本渲染，跟随主题色）。
 */
export function renderToolIcon(el: HTMLElement, icon: string) {
  if (isIconName(icon)) {
    el.innerHTML = iconHTML(icon);
  } else {
    el.textContent = icon;
  }
}

/** 填充开关图标（真实顶栏按钮与设置预览共用，保证预览 1:1） */
export const FILL_ICON_HTML =
  `<svg class="fill-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">` +
  `<rect x="3.5" y="3.5" width="17" height="17" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/>` +
  `<path class="fill-half" d="M3.5 14h17v6.5H3.5z" fill="currentColor" opacity="0.35"/>` +
  `</svg>`;

// ---------- 顶栏布局计算（真实顶栏与设置预览共用） ----------

/** 顶栏按钮序列节点：平铺工具 / 分组下拉按钮 / 常驻样式 / 常驻填充 */
export type ToolbarLayoutNode =
  | { kind: "tool"; id: string }
  | { kind: "group"; group: ToolGroup; tools: ToolDef[] }
  | { kind: "style" }
  | { kind: "fill" };

/** 平铺序列中的分组标记前缀："g:select" 表示顶栏该位置有一个完整分组按钮（不拆开） */
export const GROUP_MARKER_PREFIX = "g:";
export function groupMarker(g: string): string {
  return GROUP_MARKER_PREFIX + g;
}
export function isGroupMarker(id: string): boolean {
  return id.startsWith(GROUP_MARKER_PREFIX);
}
export function markerGroup(id: string): string {
  return id.slice(GROUP_MARKER_PREFIX.length);
}

/**
 * 计算顶栏按钮序列（不含溢出折叠），真实顶栏与设置「工具栏」页签预览共用，
 * 保证任何勾选/排序组合下所见即所得。
 * - visible 为 null：默认布局——无分组工具按注册表顺序平铺，分组按钮插在第一个组员前；
 *   组按钮之间按分组顺序偏好排列（偏好中靠前的组可提前输出到更前位置）；
 * - visible 为数组：自定义布局——按顺序输出；元素可为工具 id（平铺工具）或
 *   分组标记（"g:select"，该位置输出一个完整分组按钮，收纳组内未平铺工具，不拆开）；
 *   有未平铺工具但未出现在序列中的组 → 组按钮按分组顺序偏好追加到末尾；
 *   未勾选的无分组工具直接隐藏。
 * - overrides：工具归属覆盖（自定义分组）；customGroups 为自定义分组定义（尾部补序）。
 */
export function computeToolbarNodes(
  registry: ToolRegistry,
  visible: string[] | null,
  overrides: Record<string, string> = loadGroupOverrides(),
  customGroups: CustomGroupDef[] = loadCustomGroups(),
): ToolbarLayoutNode[] {
  const nodes: ToolbarLayoutNode[] = [];
  const tools = registry.list();
  const extra = customGroups.map((d) => d.id);
  if (!visible) {
    // 默认布局：无分组工具平铺，分组按钮插在第一个组员位置；
    // 组间顺序按偏好（pref 中靠前的组即使组员位置靠后也提前输出）
    const groupTools = new Map<ToolGroup, ToolDef[]>();
    for (const t of tools) {
      const g = effectiveGroup(t, overrides);
      if (g) {
        const arr = groupTools.get(g) ?? [];
        arr.push(t);
        groupTools.set(g, arr);
      }
    }
    const order = resolveGroupOrder(tools, extra, overrides);
    const inserted = new Set<ToolGroup>();
    for (const t of tools) {
      const g = effectiveGroup(t, overrides);
      if (g) {
        if (!inserted.has(g)) {
          // 遇到第一个组员：把偏好顺序中排到当前组为止的未插入组按钮全部输出
          for (const og of order) {
            if (inserted.has(og)) {
              continue;
            }
            const arr = groupTools.get(og);
            if (!arr?.length) {
              continue; // 空组（如暂无 AI 工具）不生成按钮
            }
            nodes.push({ kind: "group", group: og, tools: arr });
            inserted.add(og);
            if (og === g) {
              break;
            }
          }
        }
      } else {
        nodes.push({ kind: "tool", id: t.id });
      }
    }
    // 空自定义组也输出按钮（顶栏占位，收纳后自动填充）
    for (const og of order) {
      if (inserted.has(og)) {
        continue;
      }
      if (customGroups.some((d) => d.id === og)) {
        nodes.push({ kind: "group", group: og, tools: [] });
        inserted.add(og);
      }
    }
  } else {
    const pinned = new Set(visible);
    for (const id of visible) {
      if (isGroupMarker(id)) {
        // 分组标记：该位置输出完整分组按钮，收纳组内未平铺工具（不拆开）
        const g = markerGroup(id) as ToolGroup;
        const arr = tools.filter(
          (t) => effectiveGroup(t, overrides) === g && !pinned.has(t.id),
        );
        if (arr.length || customGroups.some((d) => d.id === g)) {
          nodes.push({ kind: "group", group: g, tools: arr });
        }
      } else if (registry.getTool(id)) {
        nodes.push({ kind: "tool", id });
      }
    }
    // 有未平铺工具但未出现在序列中的组 → 组按钮追加到末尾（按分组顺序偏好）
    const used = new Set(
      visible.filter(isGroupMarker).map((m) => markerGroup(m)),
    );
    const groupTools = new Map<ToolGroup, ToolDef[]>();
    for (const t of tools) {
      const g = effectiveGroup(t, overrides);
      if (!g || pinned.has(t.id)) {
        continue;
      }
      const arr = groupTools.get(g) ?? [];
      arr.push(t);
      groupTools.set(g, arr);
    }
    for (const g of resolveGroupOrder(tools, extra, overrides)) {
      if (used.has(g)) {
        continue;
      }
      const arr = groupTools.get(g);
      if (arr?.length) {
        nodes.push({ kind: "group", group: g, tools: arr });
      }
    }
    // 空自定义组按钮：未平铺且未出现在序列中时也输出（保持顶栏可见，可收纳工具）
    for (const g of resolveGroupOrder(tools, extra, overrides)) {
      if (used.has(g) || groupTools.get(g)?.length) {
        continue;
      }
      if (customGroups.some((d) => d.id === g)) {
        nodes.push({ kind: "group", group: g, tools: [] });
      }
    }
  }
  return nodes;
}

/**
 * 溢出折叠：宽度检测容器内容超宽时，工具容器末尾的平铺按钮逐个移入「更多▾」菜单。
 * 真实顶栏与设置预览共用同一算法（scope 为宽度检测容器，groupEl 为工具按钮容器）。
 */
export function foldIntoMore(
  scope: HTMLElement,
  groupEl: HTMLElement,
  moreBtn: HTMLElement,
  moreMenu: HTMLElement,
  toolButtons: Map<string, HTMLButtonElement>,
  moreItems: Map<string, HTMLButtonElement>,
  activeToolId: string,
) {
  moreBtn.style.display = "none";
  let guard = 0;
  while (scope.scrollWidth > scope.clientWidth + 2 && guard++ < 40) {
    const el = lastPinnedToolEl(groupEl);
    if (!el) {
      break;
    }
    const id = (el as HTMLButtonElement).dataset.tool;
    el.remove();
    if (!id) {
      break;
    }
    toolButtons.delete(id);
    const btn = el as HTMLButtonElement;
    btn.classList.toggle("active", id === activeToolId);
    moreItems.set(id, btn);
    moreMenu.appendChild(btn);
    if (groupEl.lastElementChild !== moreBtn) {
      groupEl.appendChild(moreBtn);
    }
    moreBtn.style.display = "";
  }
}

/** 工具容器内最后一个平铺按钮（排除分组按钮与更多按钮） */
function lastPinnedToolEl(groupEl: HTMLElement): HTMLElement | null {
  for (let i = groupEl.children.length - 1; i >= 0; i--) {
    const el = groupEl.children[i] as HTMLElement;
    if (
      el.classList.contains("tool-btn") &&
      !el.classList.contains("group-btn")
    ) {
      return el;
    }
  }
  return null;
}

/** 分组元数据：下拉按钮默认图标（图标名）与标题 */
const GROUP_META: Record<ToolGroup, { label: string; defaultIcon: IconName }> = {
  shape: { label: "形状", defaultIcon: "shapes" },
  select: { label: "选择", defaultIcon: "select" },
  ai: { label: "AI 工具", defaultIcon: "sparkle" },
};

/** 分组显示名：内置查表，自定义组查定义，兜底用分组 id */
export function groupLabel(
  g: string,
  customGroups: CustomGroupDef[] = loadCustomGroups(),
): string {
  return (
    GROUP_META[g as ToolGroup]?.label ??
    customGroups.find((d) => d.id === g)?.name ??
    g
  );
}

/** 一个分组拆分按钮的 UI 状态：主按钮（直接使用）+ 箭头按钮（展开菜单） */
type GroupUI = {
  group: ToolGroup;
  /** 容器：主按钮 + 箭头按钮（保留 tool-btn/group-btn 类，供溢出折叠与激活态识别） */
  btn: HTMLDivElement;
  /** 主按钮：点击直接激活组内当前工具（currentId，未指定时第一个） */
  main: HTMLButtonElement;
  iconEl: HTMLElement;
  menu: HTMLDivElement;
  items: Map<string, HTMLButtonElement>;
  tools: ToolDef[];
  /** 主按钮当前使用的工具 id（用户在菜单中最后选中的；初始 undefined = 组内第一个） */
  currentId?: string;
  inserted: boolean;
};

/**
 * 顶部悬浮工具栏：只保留核心绘制工具（同类型工具收进分组下拉）+ 填充开关。
 * - 分组按钮为拆分式：点击主按钮直接使用组内当前工具（选择组默认“选择”，
 *   形状组默认“矩形”，AI 组默认第一个 AI 工具），点击右侧箭头展开菜单切换；
 *   “选择”组收纳选择/框选/套索，“形状”组收纳矩形/椭圆与 AI 形状类工具，
 *   “AI 工具”组收纳 AI 生成的其他自定义工具（管理入口在下拉底部，或 ⚙ 设置 →「AI 工具」页签）；
 * - 画布移动/画笔/橡皮擦/直线/箭头/文本为高频工具直接平铺顶栏；
 * - 撤销/重做/缩放 → 右下角状态栏；整理/手绘/颜色/粗细 → 选中时左侧悬浮栏；
 * - 文件/AI/清空 → 右侧圆形悬浮栏。
 */
export class Toolbar {
  private toolButtons = new Map<string, HTMLButtonElement>();
  private toolGroup: HTMLDivElement;
  /** 当前激活工具（refresh 重渲染时保留） */
  private activeToolId = "select";
  /** 布局偏好：平铺顶栏的工具 id 顺序；null = 默认布局（无分组工具全部平铺） */
  private visiblePref: string[] | null = loadToolbarPref();
  private handlers: ToolbarHandlers;
  private fillBtn!: HTMLButtonElement;
  private styleBtn!: HTMLButtonElement;
  private groups = new Map<ToolGroup, GroupUI>();
  // 更多▾（顶栏溢出折叠）：宽度不足时末尾平铺工具自动收进此处
  private moreBtn!: HTMLButtonElement;
  private moreMenu!: HTMLDivElement;
  private moreItems = new Map<string, HTMLButtonElement>();
  /** 自定义分组定义（设置页新建/删除/重命名后经 setCustomGroups 同步） */
  private customGroups: CustomGroupDef[] = loadCustomGroups();

  constructor(
    container: HTMLElement,
    private registry: ToolRegistry,
    handlers: ToolbarHandlers,
  ) {
    this.handlers = handlers;
    this.toolGroup = document.createElement("div");
    this.toolGroup.className = "tool-group";
    this.rebuildGroups();
    this.buildMoreMenu();
    this.renderTools();

    this.fillBtn = document.createElement("button");
    this.fillBtn.className = "tool-btn fill-toggle";
    this.fillBtn.title = "填充开/关（新绘制图形默认填充；选中元素时作用于选中）";
    // 填充图标（Excalidraw 风格：空心方块 + 下半实心；激活时下半不透明）
    this.fillBtn.innerHTML = FILL_ICON_HTML;
    this.fillBtn.addEventListener("click", () => {
      const next = !this.fillBtn.classList.contains("active");
      this.fillBtn.classList.toggle("active", next);
      handlers.onFillChange(next);
    });

    // 默认样式入口（常驻顶栏）：描边色圆点 + 打开共享样式浮层
    this.styleBtn = document.createElement("button");
    this.styleBtn.className = "tool-btn style-toggle";
    this.styleBtn.title =
      "样式：描边/填充颜色与粗细（选中元素时作用于选中，未选中时设为新绘制图形的默认样式）";
    this.styleBtn.innerHTML =
      iconHTML("sliders", 15) + `<span class="style-dot"></span>`;
    this.styleBtn.addEventListener("click", () => {
      this.handlers.onStyle?.(this.styleBtn.getBoundingClientRect());
    });

    container.append(this.toolGroup, this.styleBtn, this.fillBtn);
    this.setTool("select");

    // 窗口尺寸变化：防抖重建并重算溢出折叠（renderTools 末尾执行宽度检测）
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => this.renderTools(), 150);
    });
  }

  /** 重建全部分组按钮（内置 + 自定义）：自定义组增删后调用，旧菜单 DOM 一并清理 */
  private rebuildGroups() {
    for (const ui of this.groups.values()) {
      ui.menu.remove();
    }
    this.groups.clear();
    for (const g of ["shape", "select", "ai"] as const) {
      this.groups.set(g, this.buildGroupUI(g));
    }
    for (const d of this.customGroups) {
      this.groups.set(d.id as ToolGroup, this.buildGroupUI(d.id as ToolGroup));
    }
  }

  /** 同步自定义分组定义（设置页新建/删除/重命名后调用），并重渲染顶栏 */
  setCustomGroups(defs: CustomGroupDef[]) {
    this.customGroups = defs;
    this.rebuildGroups();
    this.renderTools();
  }

  /** 构建一个分组拆分按钮：主按钮 + 箭头按钮 + 弹出菜单（fixed 定位，点击外部关闭） */
  private buildGroupUI(group: ToolGroup): GroupUI {
    const meta = GROUP_META[group];
    const label = meta?.label ?? groupLabel(group, this.customGroups);
    const icon = meta?.defaultIcon ?? "folder";
    const btn = document.createElement("div");
    btn.className = "tool-btn group-btn split-btn";
    btn.title = `${label}工具`;

    // 主按钮：点击直接使用组内当前工具（默认第一个），不展开菜单
    const main = document.createElement("button");
    main.type = "button";
    main.className = "group-main";
    const iconEl = document.createElement("span");
    iconEl.className = "group-icon";
    iconEl.innerHTML = iconHTML(icon, 15);
    main.appendChild(iconEl);

    // 箭头按钮：点击展开/收起菜单
    const caretBtn = document.createElement("button");
    caretBtn.type = "button";
    caretBtn.className = "group-caret-btn";
    caretBtn.title = `${label}：展开选择同组工具`;
    const caret = document.createElement("span");
    caret.className = "group-caret";
    caret.innerHTML = iconHTML("caret", 11);
    caretBtn.appendChild(caret);

    btn.append(main, caretBtn);

    const menu = document.createElement("div");
    menu.className = "group-menu";
    menu.hidden = true;
    document.body.appendChild(menu);

    main.addEventListener("click", () => {
      const id = ui.currentId ?? ui.tools[0]?.id;
      if (id) {
        this.handlers.onTool(id);
      }
    });
    caretBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      btn.classList.toggle("open", !menu.hidden);
      if (!menu.hidden) {
        const r = btn.getBoundingClientRect();
        menu.style.left = `${r.left}px`;
        menu.style.top = `${r.bottom + 6}px`;
      }
    });
    // 点击菜单外部关闭（主按钮/箭头按钮均在容器内，不触发关闭）
    document.addEventListener("pointerdown", (e) => {
      if (menu.hidden) {
        return;
      }
      if (!menu.contains(e.target as Node) && !btn.contains(e.target as Node)) {
        menu.hidden = true;
        btn.classList.remove("open");
      }
    });

    const ui: GroupUI = {
      group,
      btn,
      main,
      iconEl,
      menu,
      items: new Map(),
      tools: [],
      inserted: false,
    };
    return ui;
  }

  /** 按注册表与布局偏好渲染工具按钮（同类型工具收进分组下拉），保留当前激活态 */
  private renderTools() {
    this.toolGroup.innerHTML = "";
    this.toolButtons.clear();
    // 重建时清空溢出折叠状态（按钮重新渲染，更多▾ 菜单同步清空）
    this.moreItems.clear();
    this.moreMenu.innerHTML = "";
    for (const ui of this.groups.values()) {
      ui.tools = [];
      ui.inserted = false;
    }
    // 按钮序列由共享布局计算生成（设置「工具栏」页签预览用同一逻辑，所见即所得）
    // overrides 每次重渲染时读取，自定义分组归属变化即时生效
    const nodes = computeToolbarNodes(
      this.registry,
      this.visiblePref,
      loadGroupOverrides(),
      this.customGroups,
    );
    for (const node of nodes) {
      if (node.kind === "tool") {
        const t = this.registry.getTool(node.id);
        if (!t) {
          continue; // 工具已被删除：跳过，保留其余布局
        }
        const btn = makeButton(t.icon, t.title, () => this.handlers.onTool(t.id));
        btn.dataset.tool = t.id; // 溢出折叠时识别工具 id
        btn.classList.toggle("active", t.id === this.activeToolId);
        this.toolGroup.appendChild(btn);
        this.toolButtons.set(t.id, btn);
      } else if (node.kind === "group") {
        const ui = this.groups.get(node.group);
        if (!ui) {
          continue; // 未知分组（注册表已校验，正常不会发生）
        }
        ui.tools = node.tools;
        if (!ui.inserted) {
          this.toolGroup.appendChild(ui.btn);
          ui.inserted = true;
        }
      }
    }
    // 重建各分组下拉菜单项
    for (const ui of this.groups.values()) {
      ui.menu.innerHTML = "";
      ui.items.clear();
      ui.btn.title = ui.tools.length
        ? `${groupLabel(ui.group, this.customGroups)}：${ui.tools.map((t) => t.name).join(" / ")}`
        : `${groupLabel(ui.group, this.customGroups)}工具`;
      // 当前工具被删除（AI 工具移除等）时回退到组内第一个
      if (ui.currentId && !ui.tools.some((t) => t.id === ui.currentId)) {
        ui.currentId = undefined;
      }
      // 主按钮提示与图标：当前直接使用的工具 + 箭头切换说明
      const cur = ui.currentId
        ? ui.tools.find((t) => t.id === ui.currentId)
        : ui.tools[0];
      ui.main.title = cur
        ? `${groupLabel(ui.group, this.customGroups)}：${cur.name}（点击直接使用，右侧箭头展开选择）`
        : `${groupLabel(ui.group, this.customGroups)}工具`;
      if (cur) {
        renderToolIcon(ui.iconEl, cur.icon);
      }
      for (const t of ui.tools) {
        const item = makeButton("", t.title, () => {
          this.handlers.onTool(t.id);
          ui.menu.hidden = true;
          ui.btn.classList.remove("open");
        });
        item.classList.add("group-item");
        item.classList.toggle("active", t.id === this.activeToolId);
        const icon = document.createElement("span");
        icon.className = "group-item-icon";
        renderToolIcon(icon, t.icon);
        const name = document.createElement("span");
        name.className = "group-item-name";
        name.textContent = t.name;
        // AI 生成工具带徽标（与内置工具区分）
        if (t.source === "custom") {
          name.classList.add("custom-badge");
        }
        item.append(icon, name);
        // 快捷键右对齐展示（与右键菜单风格一致）
        if (t.shortcut) {
          const sc = document.createElement("span");
          sc.className = "group-item-sc";
          sc.textContent = t.shortcut.toUpperCase();
          item.appendChild(sc);
        }
        ui.menu.appendChild(item);
        ui.items.set(t.id, item);
      }
      // AI 分组为空时隐藏按钮；非空时底部提供管理入口（跳转设置 → AI 工具页签）
      ui.btn.style.display = ui.tools.length ? "" : "none";
      if (ui.group === "ai" && ui.tools.length) {
        const sep = document.createElement("div");
        sep.className = "group-menu-sep";
        const manage = document.createElement("button");
        manage.type = "button";
        manage.className = "tool-btn group-item group-item-manage";
        const micon = document.createElement("span");
        micon.className = "group-item-icon";
        micon.innerHTML = iconHTML("settings", 13);
        const mname = document.createElement("span");
        mname.className = "group-item-name";
        mname.textContent = "管理 AI 工具";
        manage.append(micon, mname);
        manage.addEventListener("click", () => {
          ui.menu.hidden = true;
          ui.btn.classList.remove("open");
          this.handlers.onManageTools?.();
        });
        ui.menu.append(sep, manage);
      }
    }
    // 更多▾ 常驻工具组末尾，随后执行溢出折叠检测
    this.toolGroup.appendChild(this.moreBtn);
    this.applyOverflow();
  }

  /** 注册表变化（AI 添加/修改/删除工具）后重渲染工具区；激活工具被删则回退选择工具 */
  refresh() {
    if (!this.registry.getTool(this.activeToolId)) {
      this.activeToolId = "select";
      this.handlers.onTool("select");
    }
    this.renderTools();
  }

  /** 应用自定义布局（设置弹窗「工具栏」页签调用）：勾选 + 排序后保存并重渲染 */
  setVisible(visible: string[] | null) {
    this.visiblePref = visible;
    saveToolbarPref(visible);
    if (!this.registry.getTool(this.activeToolId)) {
      this.activeToolId = "select";
      this.handlers.onTool("select");
    }
    this.renderTools();
  }

  /** 构建“更多▾”溢出折叠菜单：顶栏宽度不足时末尾平铺工具自动收进此处 */
  private buildMoreMenu() {
    this.moreBtn = document.createElement("button");
    this.moreBtn.className = "tool-btn group-btn more-btn";
    this.moreBtn.title = "更多工具（顶栏放不下时自动收纳）";
    const icon = document.createElement("span");
    icon.className = "group-icon";
    icon.innerHTML = iconHTML("menu", 15);
    const caret = document.createElement("span");
    caret.className = "group-caret";
    caret.innerHTML = iconHTML("caret", 11);
    this.moreBtn.append(icon, caret);
    this.moreBtn.style.display = "none";
    this.moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.moreMenu.hidden = !this.moreMenu.hidden;
      this.moreBtn.classList.toggle("open", !this.moreMenu.hidden);
      if (!this.moreMenu.hidden) {
        const r = this.moreBtn.getBoundingClientRect();
        this.moreMenu.style.left = `${r.left}px`;
        this.moreMenu.style.top = `${r.bottom + 6}px`;
      }
    });
    this.moreMenu = document.createElement("div");
    this.moreMenu.className = "group-menu";
    this.moreMenu.hidden = true;
    document.body.appendChild(this.moreMenu);
    // 点击菜单项后收起（按钮自身的 click 已触发工具切换）
    this.moreMenu.addEventListener("click", () => {
      this.moreMenu.hidden = true;
      this.moreBtn.classList.remove("open");
    });
    // 点击菜单外部关闭
    document.addEventListener("pointerdown", (e) => {
      if (this.moreMenu.hidden) {
        return;
      }
      if (!this.moreMenu.contains(e.target as Node) && e.target !== this.moreBtn) {
        this.moreMenu.hidden = true;
        this.moreBtn.classList.remove("open");
      }
    });
    this.toolGroup.appendChild(this.moreBtn);
  }

  /** 顶栏宽度自适应：#toolbar 内容超宽时，末尾平铺工具自动折叠进“更多▾” */
  private applyOverflow() {
    const bar = this.toolGroup.parentElement;
    if (!bar) {
      return;
    }
    // #toolbar 设置了 max-width，内容放不下时 scrollWidth > clientWidth
    foldIntoMore(
      bar,
      this.toolGroup,
      this.moreBtn,
      this.moreMenu,
      this.toolButtons,
      this.moreItems,
      this.activeToolId,
    );
  }

  /** 同步顶栏样式按钮的描边色圆点（main.ts 默认样式变化时调用） */
  setStyleColor(color: string) {
    const dot = this.styleBtn.querySelector<HTMLElement>(".style-dot");
    if (dot) {
      dot.style.background = color;
    }
  }

  /** 关闭全部分组下拉菜单（main.ts 互斥管理/Escape 兜底调用） */
  closeMenus() {
    for (const ui of this.groups.values()) {
      ui.menu.hidden = true;
      ui.btn.classList.remove("open");
    }
    this.moreMenu.hidden = true;
    this.moreBtn.classList.remove("open");
  }

  setTool(tool: string) {
    this.activeToolId = tool;
    for (const [t, btn] of this.toolButtons) {
      btn.classList.toggle("active", t === tool);
    }
    // 分组拆分按钮：激活组内工具时记录为主按钮当前工具、显示其图标并高亮；
    // 未激活组内工具时主按钮回显组内第一个工具（点击仍使用它）
    for (const ui of this.groups.values()) {
      const g = ui.tools.find((t) => t.id === tool);
      ui.btn.classList.toggle("active", !!g);
      if (g) {
        ui.currentId = g.id;
        renderToolIcon(ui.iconEl, g.icon);
        ui.main.title = `${groupLabel(ui.group, this.customGroups)}：${g.name}（点击直接使用，右侧箭头展开选择）`;
      } else if (ui.tools.length) {
        const first = ui.tools[0];
        renderToolIcon(ui.iconEl, first.icon);
        ui.main.title = `${groupLabel(ui.group, this.customGroups)}：${first.name}（点击直接使用，右侧箭头展开选择）`;
      }
      for (const [t, item] of ui.items) {
        item.classList.toggle("active", t === tool);
      }
    }
    // 溢出折叠进“更多▾”的工具保持激活态
    for (const [t, btn] of this.moreItems) {
      btn.classList.toggle("active", t === tool);
    }
  }

  setFill(enabled: boolean) {
    this.fillBtn.classList.toggle("active", enabled);
  }
}
