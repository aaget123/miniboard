import type { ToolRegistry } from "../board/registry";
import type { ToolDef, ToolGroup } from "../types";

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
};

function makeButton(
  icon: string,
  title: string,
  onClick: () => void,
  cls = "tool-btn",
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = cls;
  btn.title = title;
  btn.textContent = icon;
  btn.addEventListener("click", onClick);
  return btn;
}

/** 分组元数据：下拉按钮默认图标与标题 */
const GROUP_META: Record<ToolGroup, { label: string; defaultIcon: string }> = {
  shape: { label: "形状", defaultIcon: "▭" },
  select: { label: "选择", defaultIcon: "⛶" },
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
 * - 撤销/重做/缩放 → 右下角状态栏；整理/手绘/颜色/粗细 → 选中时左侧悬浮栏；
 * - 文件/AI/清空 → 右侧圆形悬浮栏。
 */
export class Toolbar {
  private toolButtons = new Map<string, HTMLButtonElement>();
  private toolGroup: HTMLDivElement;
  /** 当前激活工具（refresh 重渲染时保留） */
  private activeToolId = "select";
  private handlers: ToolbarHandlers;
  private fillBtn!: HTMLButtonElement;
  private groups = new Map<ToolGroup, GroupUI>();

  constructor(
    container: HTMLElement,
    private registry: ToolRegistry,
    handlers: ToolbarHandlers,
  ) {
    this.handlers = handlers;
    this.toolGroup = document.createElement("div");
    this.toolGroup.className = "tool-group";
    for (const g of ["shape", "select"] as const) {
      this.groups.set(g, this.buildGroupUI(g));
    }
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

    container.append(this.toolGroup, this.fillBtn);
    this.setTool("select");
  }

  /** 构建一个分组下拉：按钮 + 弹出菜单（fixed 定位，点击外部关闭） */
  private buildGroupUI(group: ToolGroup): GroupUI {
    const meta = GROUP_META[group];
    const btn = document.createElement("button");
    btn.className = "tool-btn group-btn";
    btn.title = `${meta.label}工具（点击展开）`;
    const iconEl = document.createElement("span");
    iconEl.className = "group-icon";
    iconEl.textContent = meta.defaultIcon;
    const caret = document.createElement("span");
    caret.className = "group-caret";
    caret.textContent = "▾";
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

  /** 按注册表渲染工具按钮（同类型工具收进分组下拉），保留当前激活态 */
  private renderTools() {
    this.toolGroup.innerHTML = "";
    this.toolButtons.clear();
    for (const ui of this.groups.values()) {
      ui.tools = [];
      ui.inserted = false;
    }
    for (const t of this.registry.list()) {
      if (t.group) {
        const ui = this.groups.get(t.group);
        if (!ui) {
          continue; // 未知分组（注册表已校验，正常不会发生）
        }
        ui.tools.push(t);
        if (!ui.inserted) {
          // 在原分组工具位置插入下拉按钮（保持工具顺序）
          this.toolGroup.appendChild(ui.btn);
          ui.inserted = true;
        }
        continue;
      }
      const btn = makeButton(t.icon, t.title, () => this.handlers.onTool(t.id));
      btn.classList.toggle("active", t.id === this.activeToolId);
      this.toolGroup.appendChild(btn);
      this.toolButtons.set(t.id, btn);
    }
    // 重建各分组下拉菜单项
    for (const ui of this.groups.values()) {
      ui.menu.innerHTML = "";
      ui.items.clear();
      ui.btn.title = `${GROUP_META[ui.group].label}：${ui.tools.map((t) => t.name).join(" / ")}`;
      for (const t of ui.tools) {
        const item = makeButton(`${t.icon} ${t.name}`, t.title, () => {
          this.handlers.onTool(t.id);
          ui.menu.hidden = true;
          ui.btn.classList.remove("open");
        });
        item.classList.add("group-item");
        item.classList.toggle("active", t.id === this.activeToolId);
        ui.menu.appendChild(item);
        ui.items.set(t.id, item);
      }
      // 分组为空时隐藏按钮
      ui.btn.style.display = ui.tools.length ? "" : "none";
    }
  }

  /** 注册表变化（AI 添加/修改/删除工具）后重渲染工具区；激活工具被删则回退选择工具 */
  refresh() {
    if (!this.registry.getTool(this.activeToolId)) {
      this.activeToolId = "select";
      this.handlers.onTool("select");
    }
    this.renderTools();
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
        ui.iconEl.textContent = g.icon;
      } else if (ui.tools.length) {
        ui.iconEl.textContent = ui.tools[0].icon;
      }
      for (const [t, item] of ui.items) {
        item.classList.toggle("active", t === tool);
      }
    }
  }

  setFill(enabled: boolean) {
    this.fillBtn.classList.toggle("active", enabled);
  }
}
