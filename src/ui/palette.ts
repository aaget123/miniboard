import { iconHTML, isIconName } from "./icons";
import { SHORTCUT_ACTIONS, formatKeys } from "./shortcuts";
import type { ShortcutManager } from "./shortcuts";

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

/** 帮助弹窗数据源：工具列表（内置 + AI，与注册表同构） */
type ShortcutTool = {
  id: string;
  name: string;
  shortcut?: string;
  source?: string;
};

/**
 * 当前生效的快捷键清单（帮助弹窗每次打开时动态生成，配置/注册表变化后自动反映）。
 * 操作区在前（顺序同设置页），工具区在后（内置工具显示配置后的生效键，AI 工具显示注册表键）。
 */
export function getShortcutHelpRows(
  registry: { list(): ShortcutTool[] },
  shortcuts: ShortcutManager,
): { keys: string; desc: string }[] {
  const rows: { keys: string; desc: string }[] = [];
  for (const a of SHORTCUT_ACTIONS) {
    rows.push({ keys: formatKeys(shortcuts.getKeys(a.id)), desc: a.label });
  }
  for (const t of registry.list()) {
    rows.push({ keys: formatKeys(shortcuts.toolKeys(t)), desc: `工具：${t.name}` });
  }
  return rows;
}

let helpMask: HTMLElement | null = null;

/** 快捷键帮助弹窗（模块级单例；rows 每次打开时重新生成传入，反映最新配置） */
export function showShortcutHelp(rows: { keys: string; desc: string }[]) {
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

    document.body.appendChild(helpMask);
  }
  // 每次打开重建行内容（配置可能已变更）
  const modal = helpMask.firstElementChild as HTMLElement;
  modal.querySelectorAll(".shortcut-row").forEach((el) => el.remove());
  for (const s of rows) {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const keys = document.createElement("kbd");
    keys.textContent = s.keys;
    const desc = document.createElement("span");
    desc.textContent = s.desc;
    row.append(keys, desc);
    modal.appendChild(row);
  }
  helpMask.hidden = false;
}
