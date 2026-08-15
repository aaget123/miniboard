import type { ToolRegistry } from "../board/registry";
import type { CustomToolDef } from "../types";
import { iconHTML } from "./icons";
import { renderToolIcon } from "./toolbar";

/** 分组选项（与注册表校验一致：自定义工具只能归入 shape 或 ai） */
const GROUP_OPTIONS: { value: "ai" | "shape"; label: string }[] = [
  { value: "ai", label: "AI 工具▾（默认）" },
  { value: "shape", label: "形状▾" },
];

/**
 * AI 工具管理（内嵌组件）：管理 AI 生成的自定义工具——编辑名称/图标/快捷键/分组、删除。
 * 唯一入口：⚙ 设置 →「AI 工具」页签（内容直接构建到宿主容器，关闭/退出由设置弹窗统一管理）。
 * 生成器源码为只读展示（由 AI 在编辑模式维护），此处只管外观与归属。
 */
export class ToolManageDialog {
  private listEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private editorEl!: HTMLElement;
  private editorTitleEl!: HTMLElement;
  private editingId = "";
  private nameInput!: HTMLInputElement;
  private iconInput!: HTMLInputElement;
  private iconPreview!: HTMLElement;
  private shortcutInput!: HTMLInputElement;
  private groupSelect!: HTMLSelectElement;
  private generatorCodeEl!: HTMLElement;
  private statusEl!: HTMLElement;

  constructor(private registry: ToolRegistry, host: HTMLElement) {
    this.build(host);
  }

  /** 同步工具列表（宿主打开/切换页签时调用） */
  refresh() {
    this.renderList();
  }

  // ---------- 构建 ----------

  private build(root: HTMLElement) {
    // ---- 列表视图 ----
    this.listEl = document.createElement("div");
    this.listEl.className = "tm-list";
    root.appendChild(this.listEl);
    this.emptyEl = document.createElement("div");
    this.emptyEl.className = "tm-empty";
    this.emptyEl.textContent = "暂无 AI 生成的自定义工具（可在 AI 面板「编辑」模式中让 AI 添加）";
    root.appendChild(this.emptyEl);

    // ---- 编辑视图 ----
    this.editorEl = document.createElement("div");
    this.editorEl.className = "tm-editor";
    this.editorEl.hidden = true;
    root.appendChild(this.editorEl);

    this.editorTitleEl = document.createElement("h4");
    this.editorTitleEl.className = "settings-label";
    this.editorEl.appendChild(this.editorTitleEl);

    // 名称 + 图标（带实时预览）
    const nameLabel = document.createElement("label");
    nameLabel.className = "ai-modal-label";
    nameLabel.textContent = "名称";
    this.nameInput = document.createElement("input");
    this.nameInput.type = "text";
    this.nameInput.maxLength = 12;
    this.nameInput.placeholder = "工具名称，如 五角星";
    this.editorEl.append(nameLabel, this.nameInput);

    const iconRow = document.createElement("div");
    iconRow.className = "tm-icon-row";
    const iconLabel = document.createElement("label");
    iconLabel.className = "ai-modal-label";
    iconLabel.textContent = "图标（1-2 个字符）";
    this.iconInput = document.createElement("input");
    this.iconInput.type = "text";
    this.iconInput.maxLength = 2;
    this.iconInput.placeholder = "★";
    this.iconInput.addEventListener("input", () => {
      renderToolIcon(this.iconPreview, this.iconInput.value.trim());
      this.setStatus("", "");
    });
    this.iconPreview = document.createElement("span");
    this.iconPreview.className = "tm-icon-preview";
    iconRow.append(iconLabel, this.iconInput, this.iconPreview);
    this.editorEl.appendChild(iconRow);

    // 快捷键 + 分组
    const metaRow = document.createElement("div");
    metaRow.className = "tm-meta-row";
    const scLabel = document.createElement("label");
    scLabel.className = "ai-modal-label";
    scLabel.textContent = "快捷键（单字母，可空）";
    this.shortcutInput = document.createElement("input");
    this.shortcutInput.type = "text";
    this.shortcutInput.maxLength = 1;
    this.shortcutInput.placeholder = "如 s";
    this.shortcutInput.addEventListener("input", () => {
      this.shortcutInput.value = this.shortcutInput.value.toLowerCase().replace(/[^a-z0-9]/g, "");
      this.setStatus("", "");
    });
    const scWrap = document.createElement("div");
    scWrap.className = "tm-field";
    scWrap.append(scLabel, this.shortcutInput);
    const grpLabel = document.createElement("label");
    grpLabel.className = "ai-modal-label";
    grpLabel.textContent = "分组";
    this.groupSelect = document.createElement("select");
    for (const opt of GROUP_OPTIONS) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      this.groupSelect.appendChild(o);
    }
    const grpWrap = document.createElement("div");
    grpWrap.className = "tm-field";
    grpWrap.append(grpLabel, this.groupSelect);
    metaRow.append(scWrap, grpWrap);
    this.editorEl.appendChild(metaRow);

    // 生成器源码（只读）
    const genLabel = document.createElement("label");
    genLabel.className = "ai-modal-label";
    genLabel.textContent = "生成器源码（只读，由 AI 维护）";
    this.generatorCodeEl = document.createElement("pre");
    this.generatorCodeEl.className = "tm-generator";
    this.editorEl.append(genLabel, this.generatorCodeEl);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "ai-modal-status";
    this.editorEl.appendChild(this.statusEl);

    const actions = document.createElement("div");
    actions.className = "ai-modal-actions";
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "tool-btn";
    backBtn.textContent = "← 返回列表";
    backBtn.addEventListener("click", () => this.showList());
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "tool-btn ai-modal-save";
    saveBtn.textContent = "保存修改";
    saveBtn.addEventListener("click", () => this.saveEdit());
    actions.append(backBtn, saveBtn);
    this.editorEl.appendChild(actions);
  }

  // ---------- 列表 ----------

  private showList() {
    this.editorEl.hidden = true;
    this.renderList();
  }

  private renderList() {
    this.listEl.innerHTML = "";
    const tools = this.registry
      .list()
      .filter((t): t is CustomToolDef => t.source === "custom");
    this.emptyEl.hidden = tools.length > 0;
    this.listEl.hidden = tools.length === 0;
    for (const t of tools) {
      const row = document.createElement("div");
      row.className = "tm-row";

      const icon = document.createElement("span");
      icon.className = "tm-row-icon";
      renderToolIcon(icon, t.icon);

      const info = document.createElement("div");
      info.className = "tm-row-info";
      const name = document.createElement("div");
      name.className = "tm-row-name";
      name.textContent = t.name;
      const badges = document.createElement("div");
      badges.className = "tm-row-badges";
      const kind = document.createElement("span");
      kind.className = "tm-badge kind";
      kind.textContent = t.kind === "click" ? "点击生成" : "拖拽生成";
      badges.appendChild(kind);
      if (t.group) {
        const g = document.createElement("span");
        g.className = "tm-badge";
        g.textContent = t.group === "shape" ? "形状▾" : "AI 工具▾";
        badges.appendChild(g);
      }
      if (t.shortcut) {
        const s = document.createElement("span");
        s.className = "tm-badge key";
        s.textContent = t.shortcut.toUpperCase();
        badges.appendChild(s);
      }
      info.append(name, badges);

      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "tool-btn tm-row-btn";
      edit.title = "编辑名称/图标/快捷键/分组";
      edit.innerHTML = iconHTML("pencil", 13);
      edit.addEventListener("click", () => this.openEditor(t));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "tool-btn tm-row-btn tm-row-del";
      del.title = "删除工具";
      del.innerHTML = iconHTML("trash", 13);
      del.addEventListener("click", () => this.removeTool(t));

      row.append(icon, info, edit, del);
      this.listEl.appendChild(row);
    }
  }

  // ---------- 编辑 ----------

  private openEditor(t: CustomToolDef) {
    this.editingId = t.id;
    this.editorTitleEl.textContent = `编辑工具：${t.name}`;
    this.nameInput.value = t.name;
    this.iconInput.value = t.icon;
    renderToolIcon(this.iconPreview, t.icon);
    this.shortcutInput.value = t.shortcut ?? "";
    this.groupSelect.value = t.group === "shape" ? "shape" : "ai";
    this.generatorCodeEl.textContent = t.generator;
    this.setStatus("", "");
    this.listEl.hidden = true;
    this.emptyEl.hidden = true;
    this.editorEl.hidden = false;
  }

  private saveEdit() {
    const name = this.nameInput.value.trim();
    const icon = this.iconInput.value.trim();
    const shortcut = this.shortcutInput.value.trim() || undefined;
    const group = this.groupSelect.value === "shape" ? "shape" : "ai";
    if (!name || !icon) {
      this.setStatus("名称与图标不能为空", "error");
      return;
    }
    try {
      this.registry.updateCustom(this.editingId, { name, icon, shortcut, group });
      this.setStatus("已保存，工具栏已刷新", "ok");
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : String(err), "error");
    }
  }

  private removeTool(t: CustomToolDef) {
    if (!window.confirm(`确定删除工具「${t.name}」？此操作不可恢复。`)) {
      return;
    }
    this.registry.removeCustom(t.id);
    if (this.editingId === t.id) {
      this.editingId = "";
      this.showList();
    } else {
      this.renderList();
    }
  }

  private setStatus(text: string, cls: "" | "ok" | "error") {
    this.statusEl.textContent = text;
    this.statusEl.className = cls
      ? `ai-modal-status ${cls}`
      : "ai-modal-status";
  }
}
