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

/** 分组元数据：下拉按钮默认图标（图标名）与标题 */
const GROUP_META: Record<ToolGroup, { label: string; defaultIcon: IconName }> = {
  shape: { label: "形状", defaultIcon: "shapes" },
  select: { label: "选择", defaultIcon: "select" },
  ai: { label: "AI 工具", defaultIcon: "sparkle" },
};

/** 一个分组下拉的 UI 状态 */
type GroupUI = {
  group: ToolGroup;
  btn: HTMLButtonElement;
  iconEl: HTMLElement;
  menu: HTMLDivElement;
  items: Map<string, HTMLButtonElement>;
  tools: ToolDef[];
  inserted: boolean;
};

/**
 * 顶部悬浮工具栏：只保留核心绘制工具（同类型工具收进分组下拉）+ 填充开关。
 * - “形状▾”收纳矩形/椭圆等基础形状与 AI 生成的形状类工具；
 * - “选择▾”收纳框选/套索等选中类工具；
 * - “AI 工具▾”收纳 AI 生成的其他自定义工具（未归入形状组的全部收进，避免平铺顶栏）；
 *   管理自定义工具请前往 ⚙ 设置 →「AI 工具」页签；
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

  constructor(
    container: HTMLElement,
    private registry: ToolRegistry,
    handlers: ToolbarHandlers,
  ) {
    this.handlers = handlers;
    this.toolGroup = document.createElement("div");
    this.toolGroup.className = "tool-group";
    for (const g of ["shape", "select", "ai"] as const) {
      this.groups.set(g, this.buildGroupUI(g));
    }
    this.buildMoreMenu();
    this.renderTools();

    this.fillBtn = document.createElement("button");
    this.fillBtn.className = "tool-btn fill-toggle";
    this.fillBtn.title = "填充开/关（新绘制图形默认填充；选中元素时作用于选中）";
    // 填充图标（Excalidraw 风格：空心方块 + 下半实心；激活时下半不透明）
    this.fillBtn.innerHTML =
      `<svg class="fill-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">` +
      `<rect x="3.5" y="3.5" width="17" height="17" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/>` +
      `<path class="fill-half" d="M3.5 14h17v6.5H3.5z" fill="currentColor" opacity="0.35"/>` +
      `</svg>`;
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

  /** 构建一个分组下拉：按钮 + 弹出菜单（fixed 定位，点击外部关闭） */
  private buildGroupUI(group: ToolGroup): GroupUI {
    const meta = GROUP_META[group];
    const btn = document.createElement("button");
    btn.className = "tool-btn group-btn";
    btn.title = `${meta.label}工具（点击展开）`;
    const iconEl = document.createElement("span");
    iconEl.className = "group-icon";
    iconEl.innerHTML = iconHTML(meta.defaultIcon, 15);
    const caret = document.createElement("span");
    caret.className = "group-caret";
    caret.innerHTML = iconHTML("caret", 11);
    btn.append(iconEl, caret);

    const menu = document.createElement("div");
    menu.className = "group-menu";
    menu.hidden = true;
    document.body.appendChild(menu);

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      btn.classList.toggle("open", !menu.hidden);
      if (!menu.hidden) {
        const r = btn.getBoundingClientRect();
        menu.style.left = `${r.left}px`;
        menu.style.top = `${r.bottom + 6}px`;
      }
    });
    // 点击菜单外部关闭
    document.addEventListener("pointerdown", (e) => {
      if (menu.hidden) {
        return;
      }
      if (!menu.contains(e.target as Node) && e.target !== btn) {
        menu.hidden = true;
        btn.classList.remove("open");
      }
    });

    return { group, btn, iconEl, menu, items: new Map(), tools: [], inserted: false };
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
    const pref = this.visiblePref;
    const tools = this.registry.list();
    if (!pref) {
      // 默认布局：无分组工具按注册表顺序平铺；分组工具进下拉，组按钮插在第一个组员位置
      for (const t of tools) {
        if (t.group) {
          const ui = this.groups.get(t.group);
          if (!ui) {
            continue; // 未知分组（注册表已校验，正常不会发生）
          }
          ui.tools.push(t);
          if (!ui.inserted) {
            this.toolGroup.appendChild(ui.btn);
            ui.inserted = true;
          }
          continue;
        }
        const btn = makeButton(t.icon, t.title, () => this.handlers.onTool(t.id));
        btn.dataset.tool = t.id; // 溢出折叠时识别工具 id
        btn.classList.toggle("active", t.id === this.activeToolId);
        this.toolGroup.appendChild(btn);
        this.toolButtons.set(t.id, btn);
      }
    } else {
      // 自定义布局：按偏好顺序平铺勾选工具；未勾选的分组工具进下拉（组按钮在末尾）；未勾选的无分组工具隐藏
      const pinned = new Set(pref);
      for (const id of pref) {
        const t = this.registry.getTool(id);
        if (!t) {
          continue; // 工具已被删除：跳过，保留其余布局
        }
        const btn = makeButton(t.icon, t.title, () => this.handlers.onTool(t.id));
        btn.dataset.tool = t.id; // 溢出折叠时识别工具 id
        btn.classList.toggle("active", t.id === this.activeToolId);
        this.toolGroup.appendChild(btn);
        this.toolButtons.set(t.id, btn);
      }
      for (const t of tools) {
        if (!t.group || pinned.has(t.id)) {
          continue;
        }
        const ui = this.groups.get(t.group);
        if (!ui) {
          continue;
        }
        ui.tools.push(t);
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
        ? `${GROUP_META[ui.group].label}：${ui.tools.map((t) => t.name).join(" / ")}`
        : `${GROUP_META[ui.group].label}（点击展开）`;
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
    this.moreBtn.style.display = "none";
    const bar = this.toolGroup.parentElement;
    if (!bar) {
      return;
    }
    let guard = 0;
    // #toolbar 设置了 max-width，内容放不下时 scrollWidth > clientWidth
    while (bar.scrollWidth > bar.clientWidth + 2 && guard++ < 40) {
      const el = this.lastPinnedEl();
      if (!el) {
        break;
      }
      const id = (el as HTMLButtonElement).dataset.tool;
      el.remove();
      if (!id) {
        break;
      }
      this.toolButtons.delete(id);
      const btn = el as HTMLButtonElement;
      btn.classList.toggle("active", id === this.activeToolId);
      this.moreItems.set(id, btn);
      this.moreMenu.appendChild(btn);
      if (this.toolGroup.lastElementChild !== this.moreBtn) {
        this.toolGroup.appendChild(this.moreBtn);
      }
      this.moreBtn.style.display = "";
    }
  }

  /** 工具组内最后一个平铺按钮（排除分组按钮与更多按钮） */
  private lastPinnedEl(): HTMLElement | null {
    for (let i = this.toolGroup.children.length - 1; i >= 0; i--) {
      const el = this.toolGroup.children[i] as HTMLElement;
      if (
        el !== this.moreBtn &&
        el.classList.contains("tool-btn") &&
        !el.classList.contains("group-btn")
      ) {
        return el;
      }
    }
    return null;
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
    // 分组下拉：激活组内工具时按钮显示该工具图标并高亮
    for (const ui of this.groups.values()) {
      const g = ui.tools.find((t) => t.id === tool);
      ui.btn.classList.toggle("active", !!g);
      if (g) {
        renderToolIcon(ui.iconEl, g.icon);
      } else if (ui.tools.length) {
        renderToolIcon(ui.iconEl, ui.tools[0].icon);
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
