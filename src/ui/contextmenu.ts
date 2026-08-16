// 右键上下文菜单：整理/手绘/复制/粘贴/剪切/删除/全选/置顶/置底/锁定/解锁
import { iconHTML, type IconName } from "./icons";

export type ContextMenuAction =
  | "beautify"
  | "sketchify"
  | "copy"
  | "paste"
  | "cut"
  | "delete"
  | "selectAll"
  | "toFront"
  | "toBack"
  | "lock"
  | "unlock"
  | "toFrame"
  | "toRect"
  | "toggleFrameConstrain";

export type ContextMenuState = {
  hasSelection: boolean;
  anyLocked: boolean;
  canPaste: boolean;
  /** 选中含手绘笔迹（✨ 整理项显隐） */
  hasFreehand: boolean;
  /** 选中含可手绘化的标准图形（✎ 手绘项显隐） */
  hasSketchable: boolean;
  /** 单选未锁定矩形（📦 转为框架项显隐） */
  canToFrame: boolean;
  /** 单选未锁定框架（↩ 转为矩形 / 内容约束项显隐） */
  canToRect: boolean;
  /** 单选框架的内容约束是否开启（内容约束项动态文案） */
  frameConstrainOn: boolean;
};

type MenuItem = {
  action?: ContextMenuAction;
  label?: string;
  icon?: IconName;
  shortcut?: string;
  divider?: boolean;
  enabled: (s: ContextMenuState) => boolean;
};

const ITEMS: MenuItem[] = [
  {
    action: "beautify",
    label: "整理",
    icon: "sparkle",
    enabled: (s) => s.hasSelection && s.hasFreehand,
  },
  {
    action: "sketchify",
    label: "手绘",
    icon: "scribble",
    enabled: (s) => s.hasSelection && s.hasSketchable,
  },
  { divider: true, enabled: (s) => s.hasFreehand || s.hasSketchable },
  {
    action: "copy",
    label: "复制",
    shortcut: "Ctrl+C",
    enabled: (s) => s.hasSelection,
  },
  {
    action: "paste",
    label: "粘贴",
    shortcut: "Ctrl+V",
    enabled: (s) => s.canPaste,
  },
  {
    action: "cut",
    label: "剪切",
    shortcut: "Ctrl+X",
    enabled: (s) => s.hasSelection,
  },
  {
    action: "delete",
    label: "删除",
    shortcut: "Del",
    enabled: (s) => s.hasSelection,
  },
  { divider: true, enabled: () => true },
  {
    action: "selectAll",
    label: "全选",
    shortcut: "Ctrl+A",
    enabled: () => true,
  },
  { divider: true, enabled: () => true },
  {
    action: "toFront",
    label: "置顶",
    shortcut: "",
    enabled: (s) => s.hasSelection,
  },
  {
    action: "toBack",
    label: "置底",
    shortcut: "",
    enabled: (s) => s.hasSelection,
  },
  { divider: true, enabled: () => true },
  {
    action: "lock",
    label: "锁定",
    shortcut: "",
    enabled: (s) => s.hasSelection && !s.anyLocked,
  },
  {
    action: "unlock",
    label: "解锁",
    shortcut: "",
    enabled: (s) => s.hasSelection && s.anyLocked,
  },
  { divider: true, enabled: (s) => s.canToFrame || s.canToRect },
  {
    action: "toFrame",
    label: "转为框架",
    icon: "frame",
    enabled: (s) => s.canToFrame,
  },
  {
    action: "toRect",
    label: "转为矩形",
    icon: "rect",
    enabled: (s) => s.canToRect,
  },
  {
    action: "toggleFrameConstrain",
    label: "开启内容约束",
    icon: "sliders",
    enabled: (s) => s.canToRect,
  },
];

export class ContextMenu {
  private el: HTMLDivElement;
  private actionEls = new Map<ContextMenuAction, HTMLDivElement>();
  /** 菜单元素（含分隔线，open 时统一按条件显隐） */
  private menuEls: { item: MenuItem; el: HTMLElement }[] = [];
  private onActionFn: (action: ContextMenuAction) => void = () => {};

  constructor(container: HTMLElement) {
    this.el = document.createElement("div");
    this.el.id = "context-menu";
    this.el.style.display = "none";
    container.appendChild(this.el);

    for (const item of ITEMS) {
      if (item.divider) {
        const d = document.createElement("div");
        d.className = "ctx-divider";
        this.el.appendChild(d);
        this.menuEls.push({ item, el: d });
        continue;
      }
      const row = document.createElement("div");
      row.className = "ctx-item";
      row.dataset.action = item.action;
      if (item.icon) {
        const ic = document.createElement("span");
        ic.className = "ctx-icon";
        ic.innerHTML = iconHTML(item.icon, 14);
        row.appendChild(ic);
      }
      const label = document.createElement("span");
      label.className = "ctx-label";
      label.textContent = item.label ?? "";
      row.appendChild(label);
      if (item.shortcut) {
        const sc = document.createElement("span");
        sc.className = "ctx-shortcut";
        sc.textContent = item.shortcut;
        row.appendChild(sc);
      }
      this.el.appendChild(row);
      this.menuEls.push({ item, el: row });
      this.actionEls.set(item.action!, row);
    }

    this.el.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest(
        ".ctx-item",
      ) as HTMLElement | null;
      if (!row) {
        return;
      }
      const action = row.dataset.action as ContextMenuAction;
      if (!row.classList.contains("disabled")) {
        this.onActionFn(action);
      }
      this.close();
    });

    // 点击菜单外部 / 其它右键 / 失焦 / ESC 时关闭
    document.addEventListener(
      "mousedown",
      (e) => {
        if (!this.el.contains(e.target as Node)) {
          this.close();
        }
      },
      true,
    );
    document.addEventListener("contextmenu", () => this.close(), true);
    window.addEventListener("blur", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.close();
      }
    });
  }

  onAction(fn: (action: ContextMenuAction) => void) {
    this.onActionFn = fn;
  }

  open(clientX: number, clientY: number, state: ContextMenuState) {
    // 锁定/解锁互斥：全部未锁显示"锁定"，否则显示"解锁"
    const showLock = !state.anyLocked;
    for (const { item, el } of this.menuEls) {
      if (item.divider) {
        // 分隔线随相邻项显隐（整理/手绘均无资格时整段隐藏）
        el.style.display = item.enabled(state) ? "" : "none";
        continue;
      }
      if (item.action === "unlock" || item.action === "lock") {
        el.style.display = (item.action === "lock") === showLock ? "" : "none";
      } else if (
        item.action === "beautify" ||
        item.action === "sketchify" ||
        item.action === "toFrame" ||
        item.action === "toRect" ||
        item.action === "toggleFrameConstrain"
      ) {
        // 整理/手绘/框架操作：无资格时隐藏（与左侧选中栏显隐语义一致）
        el.style.display = item.enabled(state) ? "" : "none";
        // 内容约束项动态文案：跟随框架当前开关状态
        if (item.action === "toggleFrameConstrain") {
          const labelEl = el.querySelector(".ctx-label");
          if (labelEl) {
            labelEl.textContent = state.frameConstrainOn
              ? "关闭内容约束"
              : "开启内容约束";
          }
        }
        continue;
      }
      el.classList.toggle("disabled", !item.enabled(state));
    }
    this.el.style.display = "block";
    // 贴边修正：菜单不超出视口
    const rect = this.el.getBoundingClientRect();
    this.el.style.left = `${Math.min(clientX, window.innerWidth - rect.width - 8)}px`;
    this.el.style.top = `${Math.min(clientY, window.innerHeight - rect.height - 8)}px`;
  }

  get isOpen() {
    return this.el.style.display !== "none";
  }

  close() {
    this.el.style.display = "none";
  }
}
