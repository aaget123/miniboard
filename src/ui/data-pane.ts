import { isDesktop } from "../storage";

/** 数据目录回调：读取当前目录 + 变更（Rust 侧创建/迁移/授权） */
export type DataDirHandlers = {
  getDir: () => string | null;
  change: (newDir: string) => Promise<void>;
};

/**
 * 「数据」页签控制器：存储位置展示与更改（桌面端目录选择 → Rust 迁移，
 * 浏览器环境提示 localStorage）。页签 DOM（区块/路径行/状态行）由控制器自建。
 */
export class DataDirPaneController {
  private dirEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private handlers: DataDirHandlers | null = null;

  /** container 为「数据」页签容器 */
  constructor(container: HTMLElement) {
    const section = document.createElement("section");
    section.className = "settings-section";
    const label = document.createElement("h4");
    label.className = "settings-label";
    label.textContent = "数据存储";
    section.appendChild(label);
    const hint = document.createElement("p");
    hint.className = "settings-hint";
    hint.textContent = "项目画布与 AI 自定义工具均存储于此目录；更改后旧数据自动迁移到新目录。";
    section.appendChild(hint);
    const row = document.createElement("div");
    row.className = "data-dir-row";
    this.dirEl = document.createElement("code");
    this.dirEl.className = "data-dir-path";
    row.appendChild(this.dirEl);
    const changeBtn = document.createElement("button");
    changeBtn.type = "button";
    changeBtn.className = "data-dir-btn";
    changeBtn.textContent = "更改目录…";
    changeBtn.addEventListener("click", () => void this.chooseDataDir());
    row.appendChild(changeBtn);
    section.appendChild(row);
    this.statusEl = document.createElement("p");
    this.statusEl.className = "settings-hint data-dir-status";
    section.appendChild(this.statusEl);
    container.appendChild(section);
  }

  /** 回调注入（main.ts：storage.getDataDir + Rust set_data_dir + 重载） */
  setHandlers(handlers: DataDirHandlers) {
    this.handlers = handlers;
    this.refresh();
  }

  /** 刷新数据目录展示（打开设置弹窗与目录变更成功后调用） */
  refresh() {
    const dir = this.handlers?.getDir() ?? null;
    if (dir) {
      this.dirEl.textContent = dir;
      this.dirEl.title = dir;
    } else {
      this.dirEl.textContent = "浏览器环境：数据保存在 localStorage（不可更改目录）";
    }
  }

  /** 更改数据目录：系统目录选择器 → Rust set_data_dir（创建/迁移/授权） → 成功提示 */
  private async chooseDataDir() {
    if (!isDesktop() || !this.handlers) {
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, title: "选择数据存储目录" });
    if (typeof picked !== "string" || !picked) {
      return;
    }
    const cur = this.handlers.getDir();
    // 选择同一目录时无需迁移
    if (cur && cur.replace(/[\\/]+$/, "") === picked.replace(/[\\/]+$/, "")) {
      return;
    }
    this.statusEl.textContent = "正在迁移数据…";
    try {
      await this.handlers.change(picked);
      this.refresh();
      this.statusEl.textContent = "迁移完成，数据已保存到新目录";
    } catch (err) {
      this.statusEl.textContent = `迁移失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
