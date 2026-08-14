import type { Board } from "../board/canvas";
import {
  allocProfileId,
  isConfigReady,
  loadProfiles,
  saveProfiles,
} from "../ai/config";
import { testConnection } from "../ai/client";
import type { AiConfig, AiProfile, AiProfileStore } from "../ai/types";
import { ProjectStore } from "../storage";
import type { ProjectMeta } from "../types";

// ---------- 画布网格 ----------

const GRID_KEY = "miniboard:grid";

/** 画布网格设置：间距（px）/ 是否显示 / 绘制与移动时是否吸附 */
export type GridSettings = {
  size: number;
  show: boolean;
  snap: boolean;
};

const DEFAULT_GRID: GridSettings = { size: 20, show: false, snap: false };

/** 读取网格设置（localStorage，数据损坏/缺失时回退默认值） */
export function loadGrid(): GridSettings {
  try {
    const raw = localStorage.getItem(GRID_KEY);
    if (!raw) {
      return { ...DEFAULT_GRID };
    }
    const g = JSON.parse(raw) as Partial<GridSettings>;
    return {
      size:
        typeof g.size === "number" && g.size >= 4 && g.size <= 100
          ? Math.round(g.size)
          : DEFAULT_GRID.size,
      show: g.show === true,
      snap: g.snap === true,
    };
  } catch {
    return { ...DEFAULT_GRID };
  }
}

export function saveGrid(g: GridSettings) {
  try {
    localStorage.setItem(GRID_KEY, JSON.stringify(g));
  } catch {
    // localStorage 不可用时仅本次会话生效
  }
}

// ---------- 主题 ----------

const THEME_KEY = "miniboard:theme";

export type Theme = "dark" | "light";

/** 主题画布背景色（主题切换/导出截图共用） */
const THEME_BG: Record<Theme, string> = { dark: "#1e1f22", light: "#f4f5f7" };

export function loadTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** 应用主题：body 类切换 CSS 变量 + 同步画布背景色 */
export function applyTheme(theme: Theme, board: Board) {
  document.body.classList.toggle("theme-light", theme === "light");
  board.setBackground(THEME_BG[theme]);
}

// ---------- 设置弹窗 ----------

/**
 * 设置弹窗（☰ 文件与工具 → ⚙ 设置）：
 * - 主题：深色/浅色切换，即时生效并持久化（画布背景/导出/截图跟随）
 * - 画布网格：间距/显示/吸附，即时生效并持久化（绘制与移动时吸附到网格）
 * - AI 模型配置：注册多个配置（名称/地址/Key/模型/多模态），点选激活使用，
 *   支持编辑/删除/新建与连接测试（复用 /models 探测）
 */
export class SettingsDialog {
  private mask!: HTMLElement;
  private store: AiProfileStore = { activeId: "", profiles: [] };
  /** 表单当前编辑的配置 id；空字符串表示"新建配置" */
  private editingId = "";
  private listEl!: HTMLElement;
  private themeBtns = new Map<Theme, HTMLButtonElement>();
  private form!: {
    name: HTMLInputElement;
    base: HTMLInputElement;
    key: HTMLInputElement;
    model: HTMLInputElement;
    vision: HTMLInputElement;
  };
  private formTitleEl!: HTMLElement;
  private testBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private modelListEl!: HTMLElement;
  private deleteBtn!: HTMLButtonElement;
  private gridForm!: {
    size: HTMLInputElement;
    show: HTMLInputElement;
    snap: HTMLInputElement;
  };
  private projectListEl!: HTMLElement;
  private projectNameInput!: HTMLInputElement;

  constructor(
    private board: Board,
    private projects: ProjectStore,
    /** 项目切换/重命名/删除后通知宿主（刷新状态栏项目名等） */
    private onProjectChange?: () => void,
  ) {
    this.build();
  }

  open() {
    this.store = loadProfiles();
    this.editingId = this.store.activeId;
    this.renderList();
    this.loadForm(this.editingId);
    // 画布网格表单与当前设置同步（每次打开弹窗刷新，外部改动不丢失）
    const g = loadGrid();
    this.gridForm.size.value = String(g.size);
    this.gridForm.show.checked = g.show;
    this.gridForm.snap.checked = g.snap;
    this.renderProjects();
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
    modal.className = "ai-modal settings-modal";
    this.mask.appendChild(modal);

    const title = document.createElement("h3");
    title.textContent = "设置";
    modal.appendChild(title);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "settings-close";
    closeBtn.title = "关闭";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => {
      this.mask.hidden = true;
    });
    modal.appendChild(closeBtn);

    // ---- 项目 ----
    const projectSection = document.createElement("section");
    projectSection.className = "settings-section";
    const projectLabel = document.createElement("h4");
    projectLabel.className = "settings-label";
    projectLabel.textContent = "项目";
    projectSection.appendChild(projectLabel);

    this.projectListEl = document.createElement("div");
    this.projectListEl.className = "project-list";
    projectSection.appendChild(this.projectListEl);

    const createRow = document.createElement("div");
    createRow.className = "project-create";
    this.projectNameInput = document.createElement("input");
    this.projectNameInput.type = "text";
    this.projectNameInput.placeholder = "新项目名称";
    this.projectNameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.createProject();
      }
    });
    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "tool-btn project-add";
    createBtn.textContent = "＋ 新建项目";
    createBtn.addEventListener("click", () => this.createProject());
    createRow.append(this.projectNameInput, createBtn);
    projectSection.appendChild(createRow);
    modal.appendChild(projectSection);

    // ---- 主题 ----
    const themeSection = document.createElement("section");
    themeSection.className = "settings-section";
    const themeLabel = document.createElement("h4");
    themeLabel.className = "settings-label";
    themeLabel.textContent = "主题";
    themeSection.appendChild(themeLabel);
    const themeOptions = document.createElement("div");
    themeOptions.className = "theme-options";
    for (const t of ["dark", "light"] as Theme[]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "theme-option";
      btn.textContent = t === "dark" ? "🌙 深色" : "☀️ 浅色";
      btn.addEventListener("click", () => this.setTheme(t));
      this.themeBtns.set(t, btn);
      themeOptions.appendChild(btn);
    }
    themeSection.appendChild(themeOptions);
    modal.appendChild(themeSection);

    // ---- 画布网格 ----
    const gridSection = document.createElement("section");
    gridSection.className = "settings-section";
    const gridLabel = document.createElement("h4");
    gridLabel.className = "settings-label";
    gridLabel.textContent = "画布网格";
    gridSection.appendChild(gridLabel);
    const sizeLabel = document.createElement("label");
    sizeLabel.className = "ai-modal-label";
    sizeLabel.textContent = "网格间距（px，4-100）";
    const sizeInput = document.createElement("input");
    sizeInput.type = "number";
    sizeInput.min = "4";
    sizeInput.max = "100";
    sizeInput.step = "1";
    const showRow = document.createElement("label");
    showRow.className = "ai-modal-row";
    const showBox = document.createElement("input");
    showBox.type = "checkbox";
    showRow.append(document.createTextNode("显示网格"), showBox);
    const snapRow = document.createElement("label");
    snapRow.className = "ai-modal-row";
    const snapBox = document.createElement("input");
    snapBox.type = "checkbox";
    snapRow.append(
      document.createTextNode("绘制 / 移动时吸附到网格（多选移动不吸附，保持相对位置）"),
      snapBox,
    );
    // 任一改动即时应用到画布并持久化（网格线随缩放/平移重建）
    const applyGridSettings = () => {
      const g: GridSettings = {
        size: Math.min(
          100,
          Math.max(4, Math.round(Number(sizeInput.value) || DEFAULT_GRID.size)),
        ),
        show: showBox.checked,
        snap: snapBox.checked,
      };
      sizeInput.value = String(g.size);
      saveGrid(g);
      this.board.applyGrid(g);
    };
    sizeInput.addEventListener("change", applyGridSettings);
    showBox.addEventListener("change", applyGridSettings);
    snapBox.addEventListener("change", applyGridSettings);
    gridSection.append(sizeLabel, sizeInput, showRow, snapRow);
    modal.appendChild(gridSection);
    this.gridForm = { size: sizeInput, show: showBox, snap: snapBox };

    // ---- AI 模型配置 ----
    const aiSection = document.createElement("section");
    aiSection.className = "settings-section";
    const aiLabel = document.createElement("h4");
    aiLabel.className = "settings-label";
    aiLabel.textContent = "AI 模型配置";
    aiSection.appendChild(aiLabel);

    this.listEl = document.createElement("div");
    this.listEl.className = "profile-list";
    aiSection.appendChild(this.listEl);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "tool-btn profile-add";
    addBtn.textContent = "＋ 新建配置";
    addBtn.addEventListener("click", () => this.startNew());
    aiSection.appendChild(addBtn);

    this.formTitleEl = document.createElement("h4");
    this.formTitleEl.className = "settings-label settings-form-title";
    aiSection.appendChild(this.formTitleEl);

    const formEl = document.createElement("div");
    formEl.className = "settings-form";

    const fields: {
      key: "base" | "key" | "model";
      label: string;
      placeholder: string;
      password?: boolean;
    }[] = [
      {
        key: "base",
        label: "接口地址 baseURL",
        placeholder: "https://api.deepseek.com/v1",
      },
      {
        key: "key",
        label: "API Key",
        placeholder: "sk-…",
        password: true,
      },
      {
        key: "model",
        label: "模型名称",
        placeholder: "deepseek-chat",
      },
    ];
    const inputs = new Map<string, HTMLInputElement>();
    const nameInput = document.createElement("input");
    const makeField = (
      labelText: string,
      input: HTMLInputElement,
      placeholder: string,
      password = false,
    ) => {
      const label = document.createElement("label");
      label.className = "ai-modal-label";
      label.textContent = labelText;
      input.type = password ? "password" : "text";
      input.placeholder = placeholder;
      formEl.appendChild(label);
      formEl.appendChild(input);
    };
    makeField("配置名称", nameInput, "如：DeepSeek 官方");
    for (const f of fields) {
      const input = document.createElement("input");
      makeField(f.label, input, f.placeholder, f.password);
      inputs.set(f.key, input);
    }

    // 多模态开关：视觉模型开启后，交流模式发送消息时附带画布截图
    const visionRow = document.createElement("label");
    visionRow.className = "ai-modal-row";
    const visionBox = document.createElement("input");
    visionBox.type = "checkbox";
    visionRow.append(
      document.createTextNode("多模态（模型支持视觉时开启）"),
      visionBox,
    );
    formEl.appendChild(visionRow);

    // 测试连接：验证 Key 并拉取模型列表（/models 不可用时自动降级最小请求）
    this.testBtn = document.createElement("button");
    this.testBtn.type = "button";
    this.testBtn.className = "tool-btn ai-test-btn";
    this.testBtn.textContent = "测试连接";
    this.statusEl = document.createElement("div");
    this.statusEl.className = "ai-modal-status";
    this.modelListEl = document.createElement("div");
    this.modelListEl.className = "ai-model-list";
    this.modelListEl.hidden = true;
    this.testBtn.addEventListener("click", () => this.runTest());
    formEl.append(this.testBtn, this.statusEl, this.modelListEl);

    const actions = document.createElement("div");
    actions.className = "ai-modal-actions";
    this.deleteBtn = document.createElement("button");
    this.deleteBtn.type = "button";
    this.deleteBtn.className = "tool-btn settings-del";
    this.deleteBtn.textContent = "删除此配置";
    this.deleteBtn.addEventListener("click", () => this.deleteEditing());
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "tool-btn ai-modal-save";
    saveBtn.textContent = "保存配置";
    saveBtn.addEventListener("click", () => this.saveForm());
    actions.append(this.deleteBtn, saveBtn);
    formEl.appendChild(actions);
    aiSection.appendChild(formEl);
    modal.appendChild(aiSection);

    this.form = {
      name: nameInput,
      base: inputs.get("base")!,
      key: inputs.get("key")!,
      model: inputs.get("model")!,
      vision: visionBox,
    };

    document.body.appendChild(this.mask);
    this.mask.hidden = true;
    this.syncTheme();
  }

  // ---------- 主题 ----------

  private setTheme(t: Theme) {
    applyTheme(t, this.board);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      // localStorage 不可用时仅本次会话生效
    }
    this.syncTheme();
  }

  private syncTheme() {
    for (const [t, btn] of this.themeBtns) {
      btn.classList.toggle("active", t === loadTheme());
    }
  }

  // ---------- 配置列表 ----------

  private renderList() {
    this.listEl.innerHTML = "";
    if (!this.store.profiles.length) {
      const empty = document.createElement("div");
      empty.className = "profile-empty";
      empty.textContent = "暂无配置，点击下方「新建配置」注册模型";
      this.listEl.appendChild(empty);
      return;
    }
    for (const p of this.store.profiles) {
      const row = document.createElement("div");
      row.className =
        "profile-item" + (p.id === this.store.activeId ? " active" : "");
      row.title = "点击选用此配置并载入编辑";
      row.addEventListener("click", () => this.selectProfile(p.id));
      const radio = document.createElement("span");
      radio.className = "profile-radio";
      radio.textContent = p.id === this.store.activeId ? "●" : "○";
      const info = document.createElement("div");
      info.className = "profile-info";
      const name = document.createElement("div");
      name.className = "profile-name";
      name.textContent = p.name;
      const meta = document.createElement("div");
      meta.className = "profile-meta";
      meta.textContent = `${p.model || "未填模型"} · ${p.baseURL || "未填地址"}`;
      info.append(name, meta);
      row.append(radio, info);
      this.listEl.appendChild(row);
    }
  }

  private selectProfile(id: string) {
    this.store.activeId = id;
    saveProfiles(this.store);
    this.renderList();
    this.loadForm(id);
  }

  private startNew() {
    this.loadForm("");
    this.form.name.focus();
  }

  private deleteEditing() {
    if (!this.editingId) {
      return;
    }
    const p = this.store.profiles.find((x) => x.id === this.editingId);
    if (!p) {
      return;
    }
    if (!window.confirm(`删除配置「${p.name}」？`)) {
      return;
    }
    this.store.profiles = this.store.profiles.filter(
      (x) => x.id !== this.editingId,
    );
    if (this.store.activeId === this.editingId) {
      this.store.activeId = this.store.profiles[0]?.id ?? "";
    }
    saveProfiles(this.store);
    this.renderList();
    this.loadForm(this.store.activeId);
  }

  // ---------- 编辑表单 ----------

  private loadForm(id: string) {
    this.editingId = id;
    const p = this.store.profiles.find((x) => x.id === id);
    if (p) {
      this.form.name.value = p.name;
      this.form.base.value = p.baseURL;
      this.form.key.value = p.apiKey;
      this.form.model.value = p.model;
      this.form.vision.checked = p.multimodal === true;
      this.formTitleEl.textContent = `编辑配置：${p.name}`;
      this.deleteBtn.disabled = false;
    } else {
      this.form.name.value = "";
      this.form.base.value = "";
      this.form.key.value = "";
      this.form.model.value = "";
      this.form.vision.checked = false;
      this.formTitleEl.textContent = "新建配置";
      this.deleteBtn.disabled = true;
    }
    this.setStatus("", "");
    this.modelListEl.hidden = true;
  }

  /** 读取表单当前值（含 id/name，供保存与测试共用） */
  private readForm(): AiProfile {
    return {
      id: this.editingId,
      name: this.form.name.value.trim() || "未命名配置",
      baseURL: this.form.base.value.trim(),
      apiKey: this.form.key.value.trim(),
      model: this.form.model.value.trim(),
      multimodal: this.form.vision.checked,
    };
  }

  private saveForm() {
    const draft = this.readForm();
    if (!isConfigReady(draft)) {
      this.setStatus("请完整填写 baseURL、API Key 与模型名称", "error");
      return;
    }
    const existing = this.store.profiles.find((x) => x.id === draft.id);
    if (existing) {
      Object.assign(existing, draft);
    } else {
      const profile: AiProfile = { ...draft, id: allocProfileId(this.store.profiles) };
      this.store.profiles.push(profile);
    }
    this.store.activeId =
      existing?.id ?? this.store.profiles[this.store.profiles.length - 1].id;
    saveProfiles(this.store);
    this.renderList();
    this.setStatus("已保存", "ok");
  }

  private async runTest() {
    const cfg: AiConfig = this.readForm();
    if (!isConfigReady(cfg)) {
      this.setStatus("请先完整填写 baseURL、API Key 与模型名称", "error");
      return;
    }
    this.testBtn.disabled = true;
    this.setStatus("测试中…", "");
    this.modelListEl.hidden = true;
    try {
      const res = await testConnection(cfg);
      this.setStatus(res.message, res.ok ? "ok" : "error");
      if (res.ok && res.models.length) {
        const modelInput = this.form.model;
        if (res.models.length === 1 && !modelInput.value.trim()) {
          modelInput.value = res.models[0];
        }
        this.modelListEl.innerHTML = "";
        const shown = res.models.slice(0, 30);
        for (const id of shown) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "ai-model-chip";
          chip.textContent = id;
          chip.addEventListener("click", () => {
            modelInput.value = id;
          });
          this.modelListEl.appendChild(chip);
        }
        if (res.models.length > shown.length) {
          const more = document.createElement("span");
          more.className = "ai-model-more";
          more.textContent = `…共 ${res.models.length} 个`;
          this.modelListEl.appendChild(more);
        }
        this.modelListEl.hidden = false;
      }
    } catch (err) {
      this.setStatus(
        `连接失败：${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      this.testBtn.disabled = false;
    }
  }

  private setStatus(text: string, cls: "" | "ok" | "error") {
    this.statusEl.textContent = text;
    this.statusEl.className = cls
      ? `ai-modal-status ${cls}`
      : "ai-modal-status";
  }

  // ---------- 项目 ----------

  private renderProjects() {
    this.projectListEl.textContent = "";
    const list = this.projects.list();
    if (!list.length) {
      this.projectListEl.textContent = "（无项目）";
      return;
    }
    for (const p of list) {
      const active = p.id === this.projects.current?.id;
      const row = document.createElement("div");
      row.className = `project-row${active ? " active" : ""}`;

      const name = document.createElement("button");
      name.type = "button";
      name.className = "project-name";
      name.title = active ? "当前项目" : "点击切换到此项目";
      name.textContent = active ? `📄 ${p.name}（当前）` : `📄 ${p.name}`;
      name.addEventListener("click", () => this.switchTo(p.id));

      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "project-rename";
      rename.title = "重命名";
      rename.textContent = "✎";
      rename.addEventListener("click", () => this.renameProject(p));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "project-del";
      del.title = "删除项目";
      del.textContent = "🗑";
      del.addEventListener("click", () => this.removeProject(p.id));

      row.append(name, rename, del);
      this.projectListEl.appendChild(row);
    }
  }

  private async switchTo(id: string) {
    const ok = await this.projects.open(id);
    if (ok) {
      this.renderProjects();
      this.onProjectChange?.();
    }
  }

  private async renameProject(p: ProjectMeta) {
    const name = window.prompt("新项目名称", p.name);
    if (name === null) {
      return;
    }
    if (await this.projects.rename(p.id, name)) {
      this.renderProjects();
      this.onProjectChange?.();
    }
  }

  private async removeProject(id: string) {
    const meta = this.projects.list().find((p) => p.id === id);
    if (!meta) {
      return;
    }
    if (!window.confirm(`确定删除项目「${meta.name}」？此操作不可恢复。`)) {
      return;
    }
    await this.projects.remove(id);
    this.renderProjects();
    this.onProjectChange?.();
  }

  private async createProject() {
    const name = this.projectNameInput.value.trim();
    if (!name) {
      return;
    }
    await this.projects.create(name);
    this.projectNameInput.value = "";
    this.renderProjects();
    this.onProjectChange?.();
  }
}
