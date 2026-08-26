import type { ToolRegistry } from "../board/registry";
import type { CustomToolDef } from "../types";
import { downloadText } from "../storage";
import { iconHTML } from "./icons";
import { renderToolIcon } from "./toolbar";
import { showConfirm } from "./confirm";

/** 分组选项（与注册表校验一致：自定义工具只能归入 shape 或 ai） */
const GROUP_OPTIONS: { value: "ai" | "shape"; label: string }[] = [
  { value: "ai", label: "AI 工具▾（默认）" },
  { value: "shape", label: "形状▾" },
];

/**
 * AI 工具管理（内嵌组件）：管理 AI 生成的自定义工具——编辑名称/图标/快捷键/分组/
 * 生成器源码、删除、导入/导出。唯一入口：⚙ 设置 →「AI 工具」页签（内容直接构建到
 * 宿主容器，关闭/退出由设置弹窗统一管理）。
 * - 源码可编辑：生成器变更保存前强制过冒烟测试（与 AI 修改工具同一管线）；
 * - 导入强制过冒烟测试：不信任来源文件，未通过的一律拒绝。
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
  private generatorInput!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;
  /** 导入/导出反馈行 + 隐藏文件选择器（列表视图） */
  private ioStatusEl!: HTMLElement;
  private importInput!: HTMLInputElement;
  /** 使用统计：列表排序方式（会话级） */
  private sortMode: "default" | "used" | "recent" | "name" = "default";

  constructor(
    private registry: ToolRegistry,
    host: HTMLElement,
  ) {
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
    this.emptyEl.textContent =
      "暂无 AI 生成的自定义工具（可在 AI 面板「编辑」模式中让 AI 添加，或从文件导入）";
    root.appendChild(this.emptyEl);

    // ---- 导入 / 导出（custom-tools.json 开放格式；导入强制过冒烟测试）----
    const ioRow = document.createElement("div");
    ioRow.className = "tm-io-row";
    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "tool-btn tm-io-btn";
    importBtn.innerHTML = `${iconHTML("upload", 13)} 导入`;
    importBtn.title = "从 custom-tools.json 导入（每个工具强制过冒烟测试）";
    importBtn.addEventListener("click", () => this.importInput.click());
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "tool-btn tm-io-btn";
    exportBtn.innerHTML = `${iconHTML("download", 13)} 导出`;
    exportBtn.title = "导出全部自定义工具为 custom-tools.json";
    exportBtn.addEventListener("click", () => this.exportTools());
    ioRow.append(importBtn, exportBtn);
    root.appendChild(ioRow);
    this.ioStatusEl = document.createElement("div");
    this.ioStatusEl.className = "ai-modal-status";
    root.appendChild(this.ioStatusEl);
    // JSON 读取走 FileReader（浏览器 / Tauri WebView 通用），无需插件对话框
    this.importInput = document.createElement("input");
    this.importInput.type = "file";
    this.importInput.accept = ".json,application/json";
    this.importInput.hidden = true;
    this.importInput.addEventListener("change", () => {
      void this.importTools(this.importInput.files?.[0]);
      this.importInput.value = "";
    });
    root.appendChild(this.importInput);

    // ---- 使用统计工具行：排序 + 清理未使用（插到列表上方） ----
    const statRow = document.createElement("div");
    statRow.className = "tm-toolbar";
    const sortSelect = document.createElement("select");
    sortSelect.className = "tm-sort-select";
    sortSelect.title = "列表排序";
    for (const opt of [
      { value: "default", label: "默认排序" },
      { value: "used", label: "最常用" },
      { value: "recent", label: "最近使用" },
      { value: "name", label: "按名称" },
    ] as const) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      sortSelect.appendChild(o);
    }
    sortSelect.value = this.sortMode;
    sortSelect.addEventListener("change", () => {
      this.sortMode = sortSelect.value as typeof this.sortMode;
      this.renderList();
    });
    const cleanupBtn = document.createElement("button");
    cleanupBtn.type = "button";
    cleanupBtn.className = "tool-btn tm-io-btn tm-cleanup-btn";
    cleanupBtn.innerHTML = `${iconHTML("trash", 13)} 清理未使用`;
    cleanupBtn.title = "删除从未使用过的自定义工具";
    cleanupBtn.addEventListener("click", () => this.cleanupUnused());
    statRow.append(sortSelect, cleanupBtn);
    root.insertBefore(statRow, this.listEl);

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

    // 生成器源码（可编辑：变更保存时强制过冒烟测试，与 AI 修改工具同一管线）
    const genLabel = document.createElement("label");
    genLabel.className = "ai-modal-label";
    genLabel.textContent = "生成器源码（修改后保存会先运行冒烟测试）";
    this.generatorInput = document.createElement("textarea");
    this.generatorInput.className = "tm-generator tm-generator-edit";
    this.generatorInput.spellcheck = false;
    this.generatorInput.rows = 6;
    this.editorEl.append(genLabel, this.generatorInput);

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
    const tools = this.registry.list().filter((t): t is CustomToolDef => t.source === "custom");
    // 使用统计排序：默认保持创建顺序（注册表顺序）
    if (this.sortMode === "used") {
      tools.sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0));
    } else if (this.sortMode === "recent") {
      tools.sort((a, b) => (b.lastUsedAt ?? b.createdAt ?? 0) - (a.lastUsedAt ?? a.createdAt ?? 0));
    } else if (this.sortMode === "name") {
      tools.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    }
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
      if ((t.useCount ?? 0) > 0) {
        const u = document.createElement("span");
        u.className = "tm-badge";
        u.title = `已使用 ${t.useCount} 次`;
        u.textContent = `×${t.useCount}`;
        badges.appendChild(u);
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
    this.generatorInput.value = t.generator;
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
    const current = this.registry.getTool(this.editingId);
    if (current?.source !== "custom") {
      this.setStatus("工具不存在或已被删除", "error");
      return;
    }
    void this.saveEditAsync(name, icon, shortcut, group);
  }

  /** 源码有变更时先跑冒烟测试（危险扫描 + Worker 隔离执行 + 返回值强校验）再提交 */
  private async saveEditAsync(
    name: string,
    icon: string,
    shortcut: string | undefined,
    group: "ai" | "shape",
  ) {
    const generator = this.generatorInput.value.trim();
    const current = this.registry.getTool(this.editingId) as CustomToolDef | undefined;
    if (current && generator !== current.generator) {
      this.setStatus("正在运行冒烟测试…", "");
      const smoke = await this.registry.smokeTest(generator, current.kind);
      if (!smoke.ok) {
        this.setStatus(`冒烟测试未通过：${smoke.error}`, "error");
        return;
      }
    }
    try {
      this.registry.updateCustom(this.editingId, { name, icon, shortcut, group, generator });
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

  // ---------- 导入 / 导出 ----------

  /** 导出全部自定义工具（与持久化 custom-tools.json 同构的裸数组，开放格式） */
  private exportTools() {
    const tools = this.registry.list().filter((t): t is CustomToolDef => t.source === "custom");
    if (!tools.length) {
      this.setIoStatus("暂无可导出的自定义工具", "error");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(JSON.stringify(tools, null, 2), `miniboard-custom-tools-${stamp}.json`);
    this.setIoStatus(`已导出 ${tools.length} 个工具`, "ok");
  }

  /**
   * 导入工具：逐个强制过冒烟测试（危险代码扫描 → Worker 隔离执行 → 返回值
   * 强校验），未通过或与本地冲突（快捷键占用等）的工具跳过并在结果中说明。
   * id 一律重新分配，避免与本地工具冲突；分组仅保留 shape，其余归入 ai
   * （导入文件里的自定义分组 id 在本机未必存在）。
   */
  private async importTools(file: File | undefined) {
    if (!file) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      this.setIoStatus("导入失败：不是合法的 JSON 文件", "error");
      return;
    }
    // 兼容裸数组（与持久化文件同格式）与 { tools: [...] } 包装
    const list = Array.isArray(parsed) ? parsed : (parsed as { tools?: unknown } | null)?.tools;
    if (!Array.isArray(list) || !list.length) {
      this.setIoStatus("导入失败：文件中没有工具数据", "error");
      return;
    }
    this.setIoStatus(`正在导入 ${list.length} 个工具（冒烟测试中）…`, "");
    let okCount = 0;
    const failures: string[] = [];
    for (const raw of list) {
      const t = (raw ?? {}) as Partial<CustomToolDef>;
      const name = typeof t.name === "string" ? t.name.trim() : "";
      try {
        if (!name || typeof t.generator !== "string" || !t.generator.trim()) {
          throw new Error("缺少名称或生成器源码");
        }
        const smoke = await this.registry.smokeTest(t.generator, t.kind);
        if (!smoke.ok) {
          throw new Error(smoke.error);
        }
        this.registry.addCustom({
          name,
          icon: typeof t.icon === "string" && t.icon.trim() ? t.icon : name.slice(0, 1),
          shortcut: typeof t.shortcut === "string" ? t.shortcut : undefined,
          kind: t.kind === "click" ? "click" : "drag",
          generator: t.generator,
          description: typeof t.description === "string" ? t.description : undefined,
          group: t.group === "shape" ? "shape" : "ai",
        });
        okCount++;
      } catch (err) {
        failures.push(
          `${name || "未命名工具"}：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const lines: string[] = [];
    if (okCount) {
      lines.push(`成功导入 ${okCount} 个工具`);
    }
    if (failures.length) {
      lines.push(`跳过 ${failures.length} 个：${failures.join("；")}`);
    }
    this.setIoStatus(
      lines.join("；") || "没有可导入的工具",
      failures.length ? "error" : okCount ? "ok" : "",
    );
    if (this.editingId) {
      // 正在编辑的工具可能被导入的同名操作影响，回到列表视图最稳妥
      this.showList();
    } else {
      this.renderList();
    }
  }

  /** 清理从未使用过的自定义工具（useCount 为空即视为未使用），应用内确认后删除 */
  private cleanupUnused() {
    const unused = this.registry
      .list()
      .filter((t): t is CustomToolDef => t.source === "custom")
      .filter((t) => !t.useCount);
    if (!unused.length) {
      this.setIoStatus("没有从未使用过的自定义工具", "");
      return;
    }
    void showConfirm({
      title: "清理未使用工具",
      message: `确定删除 ${unused.length} 个从未使用过的自定义工具？此操作不可恢复。`,
      confirmLabel: "删除",
      danger: true,
    }).then((ok) => {
      if (!ok) {
        return;
      }
      let removed = 0;
      for (const t of unused) {
        if (this.registry.removeCustom(t.id)) {
          removed++;
        }
      }
      this.setIoStatus(`已清理 ${removed} 个未使用工具`, "ok");
      if (unused.some((t) => t.id === this.editingId)) {
        this.editingId = "";
        this.showList();
      } else {
        this.renderList();
      }
    });
  }

  private setIoStatus(text: string, cls: "" | "ok" | "error") {
    this.ioStatusEl.textContent = text;
    this.ioStatusEl.className = cls ? `ai-modal-status ${cls}` : "ai-modal-status";
  }

  private setStatus(text: string, cls: "" | "ok" | "error") {
    this.statusEl.textContent = text;
    this.statusEl.className = cls ? `ai-modal-status ${cls}` : "ai-modal-status";
  }
}
