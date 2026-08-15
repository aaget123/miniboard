import type { Board } from "../board/canvas";
import {
  allocProfileId,
  isConfigReady,
  loadProfiles,
  saveProfiles,
} from "../ai/config";
import { testConnection } from "../ai/client";
import {
  loadSystemPrompt,
  resetSystemPrompt,
  saveSystemPrompt,
} from "../ai/prompts";
import type { AiConfig, AiMode, AiProfile, AiProfileStore } from "../ai/types";
import type { ToolRegistry } from "../board/registry";
import { ToolManageDialog } from "./toolmanage";
import { iconHTML } from "./icons";
import { loadToolbarPref, renderToolIcon, saveToolbarPref } from "./toolbar";

// ---------- 画布网格 ----------

const GRID_KEY = "miniboard:grid";

/** 画布网格设置：间距（px）/ 是否显示 / 绘制与移动时是否吸附 */
export type GridSettings = {
  size: number;
  show: boolean;
  snap: boolean;
};

const DEFAULT_GRID: GridSettings = { size: 20, show: false, snap: false };

/** 工具分组中文标签（工具栏页签列表徽章用） */
const GROUP_LABEL: Record<string, string> = {
  shape: "形状",
  select: "选择",
  ai: "AI 工具",
};

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

/** 主题偏好：深色/浅色/跟随系统（跟随系统时按 prefers-color-scheme 解析实际主题） */
export type ThemePref = "dark" | "light" | "system";

export type Theme = "dark" | "light";

/** 主题画布背景色（主题切换/导出截图共用） */
const THEME_BG: Record<Theme, string> = { dark: "#1e1f22", light: "#f4f5f7" };

/** 读取主题偏好（localStorage，旧数据只有 dark/light，缺失时默认跟随系统） */
export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "dark" || v === "light" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

/** 按偏好解析实际主题（system 跟随系统配色） */
export function resolveTheme(pref: ThemePref): Theme {
  if (pref !== "system") {
    return pref;
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/** 兼容旧接口：读取偏好并解析为实际主题（默认跟随系统） */
export function loadTheme(): Theme {
  return resolveTheme(loadThemePref());
}

/** 应用主题：body 类切换 CSS 变量 + 同步画布背景色 */
export function applyTheme(theme: Theme, board: Board) {
  document.body.classList.toggle("theme-light", theme === "light");
  board.setBackground(THEME_BG[theme]);
}

/** 按偏好应用主题（含系统跟随），返回实际生效的主题 */
export function applyThemePref(pref: ThemePref, board: Board): Theme {
  const theme = resolveTheme(pref);
  applyTheme(theme, board);
  return theme;
}

/** 保存主题偏好（命令面板切换主题共用） */
export function saveThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // localStorage 不可用时仅本次会话生效
  }
}

/** 系统主题变化监听：偏好为 system 时自动切换实际主题 */
export function watchSystemTheme(board: Board) {
  window
    .matchMedia("(prefers-color-scheme: light)")
    .addEventListener("change", () => {
      if (loadThemePref() === "system") {
        applyThemePref("system", board);
      }
    });
}

// ---------- 设置弹窗 ----------

/**
 * 设置弹窗（☰ 文件与工具 → ⚙ 设置）：页签式分区，三类设置互不干扰。
 * - 外观：主题（深色/浅色，画布背景/导出/截图跟随）+ 画布网格（间距/显示/吸附）
 * - AI 模型：注册多个配置（名称/地址/Key/模型/多模态），点选激活使用，
 *   支持编辑/删除/新建与连接测试（复用 /models 探测）
 * - AI 工具：管理 AI 生成的自定义工具（内嵌 ToolManageDialog，改名/图标/快捷键/删除）
 * - 系统提示词：交流/编辑双模式查看与编辑（localStorage 持久化，可恢复默认）
 */
export class SettingsDialog {
  private mask!: HTMLElement;
  private store: AiProfileStore = { activeId: "", profiles: [] };
  /** 表单当前编辑的配置 id；空字符串表示"新建配置" */
  private editingId = "";
  private listEl!: HTMLElement;
  private themeBtns = new Map<ThemePref, HTMLButtonElement>();
  private toolManage!: ToolManageDialog;
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
  /** 页签按钮 / 内容面板（appearance | model | prompt） */
  private tabBtns = new Map<string, HTMLButtonElement>();
  private panes = new Map<string, HTMLElement>();
  // 系统提示词编辑
  private promptMode: AiMode = "chat";
  private promptTabs = new Map<AiMode, HTMLButtonElement>();
  private promptArea!: HTMLTextAreaElement;
  private promptStatusEl!: HTMLElement;
  // 工具栏布局：当前勾选平铺顶栏的工具 id 数组（顺序即显示顺序）
  private toolbarVisible: string[] = [];
  private toolbarListEl!: HTMLElement;
  private toolbarCountEl!: HTMLElement;
  private toolbarPreviewEl!: HTMLElement;

  constructor(
    private board: Board,
    private registry: ToolRegistry,
    /** 工具栏布局变更回调（main.ts 转 toolbar.setVisible 持久化并重渲染顶栏） */
    private onToolbarChange: (visible: string[] | null) => void,
  ) {
    this.build();
  }

  /** 打开设置弹窗；tab 可指定初始页签（appearance/model/prompt，缺省保持当前） */
  open(tab?: string) {
    this.store = loadProfiles();
    this.editingId = this.store.activeId;
    this.renderList();
    this.loadForm(this.editingId);
    // 画布网格表单与当前设置同步（每次打开弹窗刷新，外部改动不丢失）
    const g = loadGrid();
    this.gridForm.size.value = String(g.size);
    this.gridForm.show.checked = g.show;
    this.gridForm.snap.checked = g.snap;
    // 提示词编辑区与当前存储同步
    this.loadPromptEditor();
    // 工具栏布局与当前偏好同步（工具可能被 AI 增删，每次打开重建列表）
    this.renderToolbarPane();
    if (tab) {
      this.switchTab(tab);
    }
    // AI 工具列表与当前注册表同步（内嵌页签）
    this.toolManage.refresh();
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
    closeBtn.innerHTML = iconHTML("x", 14);
    closeBtn.addEventListener("click", () => {
      this.mask.hidden = true;
    });
    modal.appendChild(closeBtn);

    // ---- 页签栏：外观 / AI 模型 / 系统提示词 ----
    const tabsBar = document.createElement("div");
    tabsBar.className = "settings-tabs";
    const TAB_DEFS: { id: string; label: string }[] = [
      { id: "appearance", label: "外观" },
      { id: "toolbar", label: "工具栏" },
      { id: "model", label: "AI 模型" },
      { id: "tools", label: "AI 工具" },
      { id: "prompt", label: "系统提示词" },
    ];
    for (const def of TAB_DEFS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings-tab";
      btn.textContent = def.label;
      btn.addEventListener("click", () => this.switchTab(def.id));
      this.tabBtns.set(def.id, btn);
      tabsBar.appendChild(btn);
    }
    modal.appendChild(tabsBar);

    // ---- 外观页签：主题 + 画布网格 ----
    const appearancePane = document.createElement("div");
    appearancePane.className = "settings-pane";
    this.panes.set("appearance", appearancePane);
    modal.appendChild(appearancePane);

    // ---- 主题 ----
    const themeSection = document.createElement("section");
    themeSection.className = "settings-section";
    const themeLabel = document.createElement("h4");
    themeLabel.className = "settings-label";
    themeLabel.textContent = "主题";
    themeSection.appendChild(themeLabel);
    const themeOptions = document.createElement("div");
    themeOptions.className = "theme-options";
    const THEME_OPTIONS: { pref: ThemePref; label: string; icon: "moon" | "sun" | "monitor" }[] = [
      { pref: "dark", label: "深色", icon: "moon" },
      { pref: "light", label: "浅色", icon: "sun" },
      { pref: "system", label: "跟随系统", icon: "monitor" },
    ];
    for (const opt of THEME_OPTIONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "theme-option";
      btn.innerHTML = `${iconHTML(opt.icon, 14)} ${opt.label}`;
      btn.addEventListener("click", () => this.setTheme(opt.pref));
      this.themeBtns.set(opt.pref, btn);
      themeOptions.appendChild(btn);
    }
    themeSection.appendChild(themeOptions);
    appearancePane.appendChild(themeSection);

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
    appearancePane.appendChild(gridSection);
    this.gridForm = { size: sizeInput, show: showBox, snap: snapBox };

    // ---- AI 模型页签 ----
    const modelPane = document.createElement("div");
    modelPane.className = "settings-pane";
    modelPane.hidden = true;
    this.panes.set("model", modelPane);
    modal.appendChild(modelPane);

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
    modelPane.appendChild(aiSection);

    // ---- 工具栏页签：自定义顶栏布局（勾选平铺 + 排序） ----
    const toolbarPane = document.createElement("div");
    toolbarPane.className = "settings-pane";
    toolbarPane.hidden = true;
    this.panes.set("toolbar", toolbarPane);
    modal.appendChild(toolbarPane);

    const toolbarHint = document.createElement("div");
    toolbarHint.className = "ai-modal-hint";
    toolbarHint.textContent =
      "勾选「平铺顶栏」的工具按钮会直接显示在顶部工具栏；未勾选的分组工具收纳进对应下拉（形状▾/选择▾），未勾选的其他工具隐藏。拖拽勾选行可调整平铺顺序。";
    toolbarPane.appendChild(toolbarHint);

    // 实时预览：当前平铺顺序所见即所得（勾选/排序即时刷新）
    this.toolbarPreviewEl = document.createElement("div");
    this.toolbarPreviewEl.className = "tb-preview";
    toolbarPane.appendChild(this.toolbarPreviewEl);

    // 动态计数：超过 8 个标红警告（配合顶栏自动折叠“更多▾”兜底）
    this.toolbarCountEl = document.createElement("span");
    this.toolbarCountEl.className = "tb-count";
    toolbarPane.appendChild(this.toolbarCountEl);

    this.toolbarListEl = document.createElement("div");
    this.toolbarListEl.className = "tb-list";
    toolbarPane.appendChild(this.toolbarListEl);

    const toolbarActions = document.createElement("div");
    toolbarActions.className = "ai-modal-actions";
    const toolbarResetBtn = document.createElement("button");
    toolbarResetBtn.type = "button";
    toolbarResetBtn.className = "tool-btn prompt-reset";
    toolbarResetBtn.textContent = "恢复默认布局";
    toolbarResetBtn.addEventListener("click", () => this.resetToolbarLayout());
    toolbarActions.appendChild(toolbarResetBtn);
    toolbarPane.appendChild(toolbarActions);

    // ---- AI 工具页签：内嵌自定义工具管理（改名/图标/快捷键/分组、删除） ----
    const toolsPane = document.createElement("div");
    toolsPane.className = "settings-pane";
    toolsPane.hidden = true;
    this.panes.set("tools", toolsPane);
    modal.appendChild(toolsPane);
    this.toolManage = new ToolManageDialog(this.registry, toolsPane);

    // ---- 系统提示词页签：交流/编辑双模式查看与编辑 ----
    const promptPane = document.createElement("div");
    promptPane.className = "settings-pane";
    promptPane.hidden = true;
    this.panes.set("prompt", promptPane);
    modal.appendChild(promptPane);

    const promptHint = document.createElement("div");
    promptHint.className = "ai-modal-hint";
    promptHint.textContent =
      "AI 助手按当前模式使用对应系统提示词；编辑保存后对新对话生效，可随时恢复默认。";
    promptPane.appendChild(promptHint);

    const promptModeRow = document.createElement("div");
    promptModeRow.className = "prompt-mode-row";
    for (const m of ["chat", "edit"] as AiMode[]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "prompt-mode-tab";
      btn.textContent = m === "chat" ? "交流模式" : "编辑模式";
      btn.addEventListener("click", () => this.setPromptMode(m));
      this.promptTabs.set(m, btn);
      promptModeRow.appendChild(btn);
    }
    promptPane.appendChild(promptModeRow);

    this.promptArea = document.createElement("textarea");
    this.promptArea.className = "prompt-area";
    this.promptArea.spellcheck = false;
    promptPane.appendChild(this.promptArea);

    const promptActions = document.createElement("div");
    promptActions.className = "ai-modal-actions prompt-actions";
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "tool-btn prompt-reset";
    resetBtn.textContent = "恢复默认";
    resetBtn.addEventListener("click", () => this.resetPrompt());
    const promptSaveBtn = document.createElement("button");
    promptSaveBtn.type = "button";
    promptSaveBtn.className = "tool-btn ai-modal-save";
    promptSaveBtn.textContent = "保存提示词";
    promptSaveBtn.addEventListener("click", () => this.savePrompt());
    promptActions.append(resetBtn, promptSaveBtn);
    promptPane.appendChild(promptActions);

    this.promptStatusEl = document.createElement("div");
    this.promptStatusEl.className = "ai-modal-status";
    promptPane.appendChild(this.promptStatusEl);

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
    this.switchTab("appearance");
    this.setPromptMode("chat");
  }

  // ---------- 主题 ----------

  private setTheme(pref: ThemePref) {
    applyThemePref(pref, this.board);
    saveThemePref(pref);
    this.syncTheme();
  }

  private syncTheme() {
    const pref = loadThemePref();
    for (const [p, btn] of this.themeBtns) {
      btn.classList.toggle("active", p === pref);
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

  // ---------- 工具栏布局 ----------

  /**
   * 重建「工具栏」页签列表：每行一个工具（图标 + 名称 + 分组/来源徽章 +
   * 排序按钮 + 平铺复选框）。顺序 = 当前偏好顺序（无偏好时 = 默认布局的无分组顺序）。
   */
  private renderToolbarPane() {
    const pref = loadToolbarPref();
    this.toolbarVisible = pref ?? this.defaultToolbarVisible();
    this.toolbarListEl.innerHTML = "";
    // 勾选项按平铺顺序置顶显示，未勾选项按注册表顺序排后（所见即所得）
    const pinnedSet = new Set(this.toolbarVisible);
    const pinned: NonNullable<ReturnType<ToolRegistry["getTool"]>>[] = [];
    for (const id of this.toolbarVisible) {
      const t = this.registry.getTool(id);
      if (t) {
        pinned.push(t);
      }
    }
    const rest = this.registry.list().filter((t) => !pinnedSet.has(t.id));
    for (const t of [...pinned, ...rest]) {
      const row = document.createElement("div");
      row.className = "tb-row";
      const pinnedRow = pinnedSet.has(t.id);
      // 勾选项可拖拽排序（拖到目标行时插入其前）
      row.draggable = pinnedRow;
      if (pinnedRow) {
        row.title = "拖拽调整平铺顺序，或使用 ↑↓ 微调";
      }

      const icon = document.createElement("span");
      icon.className = "tb-row-icon";
      renderToolIcon(icon, t.icon);
      row.appendChild(icon);

      const name = document.createElement("span");
      name.className = "tb-row-name";
      name.textContent = t.name;
      name.title = t.title;
      if (t.group) {
        const g = document.createElement("span");
        g.className = "tb-badge";
        g.textContent = GROUP_LABEL[t.group];
        name.appendChild(g);
      }
      if (t.source === "custom") {
        const b = document.createElement("span");
        b.className = "tb-badge tb-badge-ai";
        b.textContent = "AI";
        name.appendChild(b);
      }
      row.appendChild(name);

      // 排序按钮：仅在勾选列表中可用（置灰处理）
      const idx = this.toolbarVisible.indexOf(t.id);
      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "tb-move";
      upBtn.textContent = "↑";
      upBtn.title = "上移（平铺顺序）";
      upBtn.disabled = !pinnedRow || idx === 0;
      upBtn.addEventListener("click", () => this.moveToolbarItem(t.id, -1));
      const downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "tb-move";
      downBtn.textContent = "↓";
      downBtn.title = "下移（平铺顺序）";
      downBtn.disabled = !pinnedRow || idx === this.toolbarVisible.length - 1;
      downBtn.addEventListener("click", () => this.moveToolbarItem(t.id, 1));
      row.append(upBtn, downBtn);

      const checkRow = document.createElement("label");
      checkRow.className = "tb-check";
      // 分组工具取消勾选 = 收进对应下拉（语义说明）
      checkRow.title = t.group
        ? `勾选：平铺顶栏；取消勾选：收进「${GROUP_LABEL[t.group]}▾」下拉`
        : "勾选：平铺顶栏；取消勾选：从顶栏隐藏";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = pinnedRow;
      box.addEventListener("change", () => this.toggleToolbarItem(t.id, box.checked));
      checkRow.append(document.createTextNode("平铺顶栏"), box);
      row.appendChild(checkRow);

      // 拖拽排序（仅勾选行）：拖到目标行时插入其前
      if (pinnedRow) {
        row.addEventListener("dragstart", (e) => {
          e.dataTransfer?.setData("text/plain", t.id);
          row.classList.add("dragging");
        });
        row.addEventListener("dragend", () => row.classList.remove("dragging"));
        row.addEventListener("dragover", (e) => e.preventDefault());
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          const src = e.dataTransfer?.getData("text/plain");
          if (!src || src === t.id) {
            return;
          }
          const list = [...this.toolbarVisible];
          const from = list.indexOf(src);
          const to = list.indexOf(t.id);
          if (from < 0 || to < 0) {
            return;
          }
          list.splice(from, 1);
          list.splice(to, 0, src);
          this.toolbarVisible = list;
          this.applyToolbarLayout();
        });
      }

      this.toolbarListEl.appendChild(row);
    }
    this.updateToolbarCount();
    this.renderToolbarPreview();
  }

  /** 动态计数：已平铺数量与建议上限对比，超限标红警告 */
  private updateToolbarCount() {
    const n = this.toolbarVisible.length;
    this.toolbarCountEl.textContent =
      n > 8
        ? `已平铺 ${n} 个工具（超出 8 个，顶栏将自动折叠多余工具进“更多▾”）`
        : `已平铺 ${n} 个工具（建议不超过 8 个；超出部分自动折叠进“更多▾”）`;
    this.toolbarCountEl.classList.toggle("warn", n > 8);
  }

  /** 实时预览：按平铺顺序渲染图标序列（含常驻的样式/填充开关示意） */
  private renderToolbarPreview() {
    this.toolbarPreviewEl.innerHTML = "";
    const label = document.createElement("span");
    label.className = "tb-preview-label";
    label.textContent = "顶栏预览：";
    this.toolbarPreviewEl.appendChild(label);
    for (const id of this.toolbarVisible) {
      const t = this.registry.getTool(id);
      if (!t) {
        continue;
      }
      const item = document.createElement("span");
      item.className = "tb-preview-item";
      item.title = t.name;
      renderToolIcon(item, t.icon);
      this.toolbarPreviewEl.appendChild(item);
    }
    const tail = document.createElement("span");
    tail.className = "tb-preview-tail";
    tail.textContent = "＋样式 / 填充开关（常驻）";
    this.toolbarPreviewEl.appendChild(tail);
  }

  /** 默认布局：无分组工具全部平铺（与未自定义时的顶栏一致） */
  private defaultToolbarVisible(): string[] {
    return this.registry
      .list()
      .filter((t) => !t.group)
      .map((t) => t.id);
  }

  /** 应用当前布局：持久化并通知顶栏重渲染（空列表 = 恢复默认） */
  private applyToolbarLayout() {
    const visible = this.toolbarVisible.length ? [...this.toolbarVisible] : null;
    saveToolbarPref(visible);
    this.onToolbarChange(visible);
    this.renderToolbarPane();
  }

  /** 勾选/取消平铺：取消时移除，勾选时追加到末尾（保持顺序可控） */
  private toggleToolbarItem(id: string, on: boolean) {
    if (on) {
      if (!this.toolbarVisible.includes(id)) {
        this.toolbarVisible.push(id);
      }
    } else {
      this.toolbarVisible = this.toolbarVisible.filter((v) => v !== id);
    }
    this.applyToolbarLayout();
  }

  /** 排序：在平铺列表中上移/下移一位 */
  private moveToolbarItem(id: string, dir: -1 | 1) {
    const idx = this.toolbarVisible.indexOf(id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= this.toolbarVisible.length) {
      return;
    }
    const list = [...this.toolbarVisible];
    [list[idx], list[target]] = [list[target], list[idx]];
    this.toolbarVisible = list;
    this.applyToolbarLayout();
  }

  /** 恢复默认布局：清除偏好（存 null 而非默认数组，与“未自定义过”状态一致）并重置顶栏 */
  private resetToolbarLayout() {
    if (!window.confirm("恢复默认工具栏布局？当前自定义的平铺/排序将被清除。")) {
      return;
    }
    this.toolbarVisible = this.defaultToolbarVisible();
    saveToolbarPref(null);
    this.onToolbarChange(null);
    this.renderToolbarPane();
  }

  // ---------- 页签切换 ----------

  private switchTab(tab: string) {
    for (const [t, btn] of this.tabBtns) {
      btn.classList.toggle("active", t === tab);
    }
    for (const [t, pane] of this.panes) {
      pane.hidden = t !== tab;
    }
  }

  // ---------- 系统提示词 ----------

  private setPromptMode(mode: AiMode) {
    this.promptMode = mode;
    for (const [m, btn] of this.promptTabs) {
      btn.classList.toggle("active", m === mode);
    }
    this.loadPromptEditor();
  }

  /** 载入当前模式提示词（打开弹窗/切换模式时调用，未保存的编辑会被覆盖） */
  private loadPromptEditor() {
    this.promptArea.value = loadSystemPrompt(this.promptMode);
    this.setPromptStatus("", "");
  }

  private savePrompt() {
    saveSystemPrompt(this.promptMode, this.promptArea.value);
    this.setPromptStatus("已保存，对新对话生效", "ok");
  }

  private resetPrompt() {
    if (!window.confirm("恢复默认提示词？自定义内容将被清除。")) {
      return;
    }
    resetSystemPrompt(this.promptMode);
    this.loadPromptEditor();
    this.setPromptStatus("已恢复默认提示词", "ok");
  }

  private setPromptStatus(text: string, cls: "" | "ok" | "error") {
    this.promptStatusEl.textContent = text;
    this.promptStatusEl.className = cls
      ? `ai-modal-status ${cls}`
      : "ai-modal-status";
  }
}
