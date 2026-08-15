import { iconHTML, isIconName } from "./icons";

/** 命令面板条目：工具（绘制工具）或操作（文件/AI/主题等全局动作） */
export type PaletteCommand = {
  id: string;
  section: "工具" | "操作";
  title: string;
  /** 右侧快捷键提示（kbd 样式） */
  hint?: string;
  /** 图标：内置图标名（icons.ts）或 1-2 字符符号 */
  icon?: string;
  /** 附加搜索关键词（拼音/别名等） */
  keywords?: string;
  run: () => void;
};

/**
 * 命令面板（Ctrl+K）：居中搜索浮层，检索绘制工具与全局操作。
 * 支持 ↑/↓ 选择、Enter 执行、Esc 关闭；条目由宿主每次打开时动态提供（getCommands）。
 */
export class CommandPalette {
  private mask!: HTMLElement;
  private input!: HTMLInputElement;
  private resultsEl!: HTMLElement;
  /** 当前渲染的命令（与 items 一一对应，标题行不计入） */
  private current: PaletteCommand[] = [];
  private items: HTMLElement[] = [];
  private activeIndex = 0;

  constructor(private getCommands: () => PaletteCommand[]) {
    this.build();
  }

  toggle() {
    if (this.mask.hidden) {
      this.open();
    } else {
      this.close();
    }
  }

  open() {
    this.input.value = "";
    this.render("");
    this.mask.hidden = false;
    // 等 mask 显示后再聚焦（保证输入可用）
    requestAnimationFrame(() => this.input.focus());
  }

  close() {
    this.mask.hidden = true;
  }

  private build() {
    this.mask = document.createElement("div");
    this.mask.className = "palette-mask";
    this.mask.addEventListener("pointerdown", (e) => {
      if (e.target === this.mask) {
        this.close();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.mask.hidden) {
        this.close();
      }
    });

    const box = document.createElement("div");
    box.className = "palette";
    this.mask.appendChild(box);

    const searchRow = document.createElement("div");
    searchRow.className = "palette-search";
    const icon = document.createElement("span");
    icon.className = "palette-search-icon";
    icon.innerHTML = iconHTML("search", 14);
    this.input = document.createElement("input");
    this.input.spellcheck = false;
    this.input.placeholder = "搜索工具或操作…（↑↓ 选择，Enter 执行）";
    this.input.addEventListener("input", () => this.render(this.input.value));
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    searchRow.append(icon, this.input);
    box.appendChild(searchRow);

    this.resultsEl = document.createElement("div");
    this.resultsEl.className = "palette-results";
    box.appendChild(this.resultsEl);

    document.body.appendChild(this.mask);
    this.mask.hidden = true;
  }

  /** 按查询过滤并分组渲染（工具 / 操作），保留命令与按钮的一一对应 */
  private render(query: string) {
    const q = query.trim().toLowerCase();
    const cmds = this.getCommands().filter((c) => {
      if (!q) {
        return true;
      }
      return `${c.title} ${c.keywords ?? ""}`.toLowerCase().includes(q);
    });
    const sections: { name: string; items: PaletteCommand[] }[] = [];
    for (const sec of ["工具", "操作"] as const) {
      const items = cmds.filter((c) => c.section === sec);
      if (items.length) {
        sections.push({ name: sec, items });
      }
    }

    this.resultsEl.innerHTML = "";
    this.items = [];
    this.current = [];
    for (const s of sections) {
      const head = document.createElement("div");
      head.className = "palette-section";
      head.textContent = s.name;
      this.resultsEl.appendChild(head);
      for (const c of s.items) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "palette-item";
        const ic = document.createElement("span");
        ic.className = "palette-item-icon";
        if (c.icon && isIconName(c.icon)) {
          ic.innerHTML = iconHTML(c.icon, 14);
        } else if (c.icon) {
          ic.textContent = c.icon;
        }
        const title = document.createElement("span");
        title.className = "palette-item-title";
        title.textContent = c.title;
        item.append(ic, title);
        if (c.hint) {
          const hint = document.createElement("kbd");
          hint.className = "palette-item-hint";
          hint.textContent = c.hint;
          item.appendChild(hint);
        }
        item.addEventListener("click", () => this.run(c));
        item.addEventListener("mousemove", () => {
          this.setActive(this.items.indexOf(item));
        });
        this.resultsEl.appendChild(item);
        this.items.push(item);
        this.current.push(c);
      }
    }
    this.setActive(0);
  }

  private setActive(i: number) {
    if (!this.items.length) {
      return;
    }
    this.activeIndex = (i + this.items.length) % this.items.length;
    for (const [idx, el] of this.items.entries()) {
      el.classList.toggle("active", idx === this.activeIndex);
    }
    this.items[this.activeIndex].scrollIntoView({ block: "nearest" });
  }

  private run(c: PaletteCommand) {
    this.close();
    c.run();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.setActive(this.activeIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.setActive(this.activeIndex - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = this.current[this.activeIndex];
      if (c) {
        this.run(c);
      }
    }
  }
}

// ---------- 快捷键帮助 ----------

/** 快捷键清单（帮助弹窗与 README 共用来源） */
export const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: "Ctrl+S / Ctrl+O", desc: "保存 / 打开文件" },
  { keys: "Ctrl+Z / Ctrl+Shift+Z · Ctrl+Y", desc: "撤销 / 重做" },
  { keys: "Ctrl+C / Ctrl+X / Ctrl+V", desc: "复制 / 剪切 / 粘贴" },
  { keys: "Ctrl+A", desc: "全选" },
  { keys: "Delete / Backspace", desc: "删除选中" },
  { keys: "Ctrl+= / Ctrl+- / Ctrl+0", desc: "放大 / 缩小 / 重置缩放" },
  { keys: "Ctrl+K", desc: "命令面板（搜索工具与操作）" },
  { keys: "K", desc: "AI 助手面板开关" },
  { keys: "V H M Q P E L A R O T", desc: "选择 / 画布移动 / 框选 / 套索 / 画笔 / 橡皮擦 / 直线 / 箭头 / 矩形 / 椭圆 / 文本" },
  { keys: "Esc", desc: "逐层退出（点编辑 → 裁剪 → 取消编辑 → 收起浮层）" },
];

let helpMask: HTMLElement | null = null;

/** 快捷键帮助弹窗（模块级单例，多次打开复用） */
export function showShortcutHelp() {
  if (!helpMask) {
    helpMask = document.createElement("div");
    helpMask.className = "ai-modal-mask";
    helpMask.addEventListener("click", (e) => {
      if (e.target === helpMask) {
        helpMask!.hidden = true;
      }
    });
    // Esc 关闭（仅当弹窗可见时生效，与命令面板的 Esc 监听互不干扰）
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && helpMask && !helpMask.hidden) {
        helpMask.hidden = true;
      }
    });

    const modal = document.createElement("div");
    modal.className = "ai-modal settings-modal shortcut-help";
    helpMask.appendChild(modal);

    const title = document.createElement("h3");
    title.textContent = "快捷键";
    modal.appendChild(title);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "settings-close";
    closeBtn.title = "关闭";
    closeBtn.innerHTML = iconHTML("x", 14);
    closeBtn.addEventListener("click", () => {
      helpMask!.hidden = true;
    });
    modal.appendChild(closeBtn);

    for (const s of SHORTCUTS) {
      const row = document.createElement("div");
      row.className = "shortcut-row";
      const keys = document.createElement("kbd");
      keys.textContent = s.keys;
      const desc = document.createElement("span");
      desc.textContent = s.desc;
      row.append(keys, desc);
      modal.appendChild(row);
    }

    document.body.appendChild(helpMask);
  }
  helpMask.hidden = false;
}
