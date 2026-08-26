import type { ProjectStore } from "../storage";
import type { ProjectMeta } from "../types";
import { iconHTML } from "./icons";
import { showConfirm } from "./confirm";

/**
 * 项目管理弹窗（☰ 文件与工具 → 📁 项目）：
 * 前端页面直接管理项目——新建 / 切换 / 重命名 / 删除，
 * 与设置弹窗解耦（设置只管外观、AI 模型与系统提示词）。
 */
export class ProjectDialog {
  private mask!: HTMLElement;
  private listEl!: HTMLElement;
  private nameInput!: HTMLInputElement;
  /** 内联重命名中的项目 id（null = 无） */
  private renamingId: string | null = null;

  constructor(
    private projects: ProjectStore,
    /** 项目切换/重命名/删除/新建后通知宿主（刷新状态栏项目名等） */
    private onProjectChange?: () => void,
  ) {
    this.build();
  }

  open() {
    this.renamingId = null; // 关闭上次残留的重命名行
    this.renderList();
    this.mask.hidden = false;
  }

  // ---------- 构建 ----------

  private build() {
    this.mask = document.createElement("div");
    this.mask.className = "ai-modal-mask";
    this.mask.addEventListener("click", (e) => {
      if (e.target === this.mask) {
        this.mask.hidden = true;
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.mask.hidden) {
        this.mask.hidden = true;
      }
    });

    const modal = document.createElement("div");
    modal.className = "ai-modal settings-modal project-modal";
    this.mask.appendChild(modal);

    const title = document.createElement("h3");
    title.textContent = "项目";
    modal.appendChild(title);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "settings-close";
    closeBtn.title = "关闭";
    closeBtn.innerHTML = iconHTML("x", 14);
    closeBtn.addEventListener("click", () => {
      this.mask.hidden = true;
    });
    modal.appendChild(closeBtn);

    const hint = document.createElement("div");
    hint.className = "ai-modal-hint";
    hint.textContent = "新建 / 切换 / 重命名 / 删除项目，当前项目自动保存。";
    modal.appendChild(hint);

    this.listEl = document.createElement("div");
    this.listEl.className = "project-list";
    modal.appendChild(this.listEl);

    const createRow = document.createElement("div");
    createRow.className = "project-create";
    this.nameInput = document.createElement("input");
    this.nameInput.type = "text";
    this.nameInput.placeholder = "新项目名称";
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.createProject();
      }
    });
    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "tool-btn project-add";
    createBtn.textContent = "＋ 新建项目";
    createBtn.addEventListener("click", () => this.createProject());
    createRow.append(this.nameInput, createBtn);
    modal.appendChild(createRow);

    document.body.appendChild(this.mask);
    this.mask.hidden = true;
  }

  // ---------- 项目列表 ----------

  private renderList() {
    this.listEl.textContent = "";
    const list = this.projects.list();
    if (!list.length) {
      this.listEl.textContent = "（无项目）";
      return;
    }
    for (const p of list) {
      const active = p.id === this.projects.current?.id;
      const row = document.createElement("div");
      row.className = `project-row${active ? " active" : ""}`;

      if (this.renamingId === p.id) {
        row.appendChild(this.makeRenameRow(p));
        this.listEl.appendChild(row);
        continue;
      }

      const name = document.createElement("button");
      name.type = "button";
      name.className = "project-name";
      name.title = active ? "当前项目" : "点击切换到此项目";
      name.innerHTML = `${iconHTML("file", 12)} ${active ? `${p.name}（当前）` : p.name}`;
      name.addEventListener("click", () => this.switchTo(p.id));

      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "project-rename";
      rename.title = "重命名";
      rename.innerHTML = iconHTML("pencil", 13);
      rename.addEventListener("click", () => this.renameProject(p));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "project-del";
      del.title = "删除项目";
      del.innerHTML = iconHTML("trash", 13);
      del.addEventListener("click", () => this.removeProject(p.id));

      row.append(name, rename, del);
      this.listEl.appendChild(row);
    }
  }

  private async switchTo(id: string) {
    const ok = await this.projects.open(id);
    if (ok) {
      this.renderList();
      this.onProjectChange?.();
    }
  }

  private renameProject(p: ProjectMeta) {
    this.renamingId = p.id;
    this.renderList();
  }

  /** 重命名内联输入行：回车/确定提交，Esc/取消关闭（替代原生 prompt，Tauri WebView 不支持） */
  private makeRenameRow(p: ProjectMeta): HTMLElement {
    const box = document.createElement("div");
    box.className = "project-rename-row";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 40;
    input.placeholder = "新项目名称";
    input.value = p.name;
    input.select();
    const commit = async () => {
      const name = input.value.trim();
      this.renamingId = null;
      if (name && (await this.projects.rename(p.id, name))) {
        this.renderList();
        this.onProjectChange?.();
        return;
      }
      this.renderList();
    };
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "project-rename-op";
    ok.textContent = "确定";
    ok.addEventListener("click", () => void commit());
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "project-rename-op";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => {
      this.renamingId = null;
      this.renderList();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        void commit();
      } else if (e.key === "Escape") {
        this.renamingId = null;
        this.renderList();
      }
    });
    box.append(input, ok, cancel);
    // 渲染完成后聚焦并全选名称，方便直接输入新名称
    requestAnimationFrame(() => input.focus());
    return box;
  }

  private async removeProject(id: string) {
    const meta = this.projects.list().find((p) => p.id === id);
    if (!meta) {
      return;
    }
    // 应用内弹窗替代 window.confirm：WKWebView 等环境同步对话框静默失败
    const ok = await showConfirm({
      title: "删除项目",
      message: `确定删除项目「${meta.name}」？此操作不可恢复。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) {
      return;
    }
    await this.projects.remove(id);
    this.renderList();
    this.onProjectChange?.();
  }

  private async createProject() {
    const name = this.nameInput.value.trim();
    if (!name) {
      return;
    }
    await this.projects.create(name);
    this.nameInput.value = "";
    this.renderList();
    this.onProjectChange?.();
  }
}
