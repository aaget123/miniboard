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
import type { ToolDef, ToolGroup } from "../types";
import { ToolManageDialog } from "./toolmanage";
import { iconHTML } from "./icons";
import {
  computeToolbarNodes,
  effectiveGroup,
  FILL_ICON_HTML,
  foldIntoMore,
  groupLabel,
  groupMarker,
  isGroupMarker,
  loadCustomGroups,
  loadGroupOrderPref,
  loadGroupOverrides,
  loadToolbarPref,
  markerGroup,
  renderToolIcon,
  saveCustomGroups,
  saveGroupOrderPref,
  saveGroupOverrides,
  saveToolbarPref,
  type CustomGroupDef,
} from "./toolbar";

/** 预览条按钮（无交互，仅展示真实顶栏外观；tool-btn 类供溢出折叠算法识别） */
function makePreviewBtn(
  icon: string,
  title: string,
  cls = "tb-preview-item",
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = cls;
  btn.title = title;
  renderToolIcon(btn, icon);
  return btn;
}

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
  /** 布局偏好（null = 默认布局）：预览按此渲染，与真实顶栏 1:1 */
  private toolbarPref: string[] | null = null;
  /** 分组收纳区展开状态（默认折叠，与顶栏下拉一致） */
  private toolbarGroupOpen = new Map<string, boolean>();
  /** 分组顺序（三个分组在顶栏中的显示顺序；拖动分组头调整） */
  private toolbarGroupOrder: ToolGroup[] = [];
  /** 自定义分组定义（用户自建；新建/删除/重命名后保存并同步顶栏） */
  private customGroups: CustomGroupDef[] = loadCustomGroups();
  /** 工具归属覆盖：toolId → 分组 id（拖到自定义分组头时写入，内置组清除） */
  private groupOverrides: Record<string, string> = loadGroupOverrides();
  /** 分组名称编辑状态：null=无；new=新建；rename=重命名该组（渲染内联输入行） */
  private groupEdit:
    | { mode: "new" }
    | { mode: "rename"; id: string; initial: string }
    | null = null;
  /** 待确认删除的自定义分组 id（删除按钮两段式确认，避免误删） */
  private confirmDelete: string | null = null;
  private toolbarListEl!: HTMLElement;
  private toolbarCountEl!: HTMLElement;
  private toolbarPreviewEl!: HTMLElement;

  constructor(
    private board: Board,
    private registry: ToolRegistry,
    /** 工具栏布局变更回调（main.ts 转 toolbar.setVisible；自定义组定义变化时一并同步顶栏） */
    private onToolbarChange: (
      visible: string[] | null,
      customGroups?: CustomGroupDef[],
    ) => void,
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
    this.toolbarPref = loadToolbarPref();
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
   * 重建「工具栏」页签：与顶栏同构分区展示——平铺区（拖拽排序）
   * + 分组收纳区（折叠展示，与顶栏下拉一一对应）+ 隐藏区。
   * 顺序 = 当前偏好顺序（无偏好时 = 默认布局的无分组顺序）。
   */
  private renderToolbarPane() {
    const pref = loadToolbarPref();
    this.toolbarPref = pref;
    this.toolbarVisible = pref ?? this.defaultToolbarVisible();
    // 分组顺序：偏好优先，缺失的组按注册表首次出现顺序补到末尾，自定义组最后
    const order = loadGroupOrderPref() ?? [];
    const overrides = loadGroupOverrides();
    this.groupOverrides = overrides;
    for (const t of this.registry.list()) {
      const g = effectiveGroup(t, overrides);
      if (g && !order.includes(g)) {
        order.push(g);
      }
    }
    for (const d of this.customGroups) {
      if (!order.includes(d.id as ToolGroup)) {
        order.push(d.id as ToolGroup);
      }
    }
    this.toolbarGroupOrder = order;
    this.toolbarListEl.innerHTML = "";
    const pinnedSet = new Set(this.toolbarVisible);
    // 平铺序列元素：工具 id 或分组标记（"g:select" = 顶栏该位置有一个完整分组按钮）
    const rest = this.registry
      .list()
      .filter((t) => !pinnedSet.has(t.id));

    // ---- 平铺区：勾选工具与分组按钮行，拖拽调整顺序 ----
    const pinnedSection = document.createElement("div");
    pinnedSection.className = "tb-section";
    const pinnedTitle = document.createElement("div");
    pinnedTitle.className = "tb-section-title";
    // 计数只算工具，分组按钮单独标注（数字不虚高）
    const pinnedTools = this.toolbarVisible.filter((x) => !isGroupMarker(x)).length;
    const pinnedGroups = this.toolbarVisible.length - pinnedTools;
    pinnedTitle.textContent = pinnedGroups
      ? `平铺顶栏（${pinnedTools} 工具 + ${pinnedGroups} 分组按钮）：拖拽调整顺序`
      : `平铺顶栏（${pinnedTools}）：拖拽调整顺序`;
    pinnedSection.appendChild(pinnedTitle);
    if (!this.toolbarVisible.length) {
      const empty = document.createElement("div");
      empty.className = "tb-section-empty";
      empty.textContent =
        "暂无平铺内容：勾选工具行「平铺顶栏」，或把下方分组头拖上来（保持分组整体）";
      // 空平铺区也是拖放目标：拖入工具行平铺到开头（分组头不再拖入——平铺区与分组区分开）
      empty.addEventListener("dragover", (e) => {
        const src = e.dataTransfer?.getData("text/plain");
        if (src && isGroupMarker(src)) {
          return; // 分组头/分组按钮行禁止拖入平铺区（保持两区分开）
        }
        e.preventDefault();
        empty.classList.add("drag-over");
      });
      empty.addEventListener("dragleave", () =>
        empty.classList.remove("drag-over"),
      );
      empty.addEventListener("drop", (e) => {
        e.preventDefault();
        empty.classList.remove("drag-over");
        const src = e.dataTransfer?.getData("text/plain");
        if (!src) {
          return;
        }
        const list = [...this.toolbarVisible];
        if (list.includes(src)) {
          return;
        }
        list.unshift(src);
        this.toolbarVisible = list;
        this.applyToolbarLayout();
      });
      pinnedSection.appendChild(empty);
    }
    for (const item of this.toolbarVisible) {
      if (isGroupMarker(item)) {
        // 分组按钮行：顶栏该位置显示完整分组按钮（不拆开）
        const g = markerGroup(item) as ToolGroup;
        const gTools = this.registry
          .list()
          .filter((t) => effectiveGroup(t, this.groupOverrides) === g);
        if (gTools.length || this.customGroups.some((d) => d.id === g)) {
          pinnedSection.appendChild(this.makeGroupPinnedRow(g, gTools));
        }
      } else {
        const t = this.registry.getTool(item);
        if (t) {
          pinnedSection.appendChild(this.makeToolbarRow(t, true));
        }
      }
    }
    this.toolbarListEl.appendChild(pinnedSection);

    // ---- 分组收纳区：与顶栏下拉一一对应（按分组顺序），默认折叠展示，分组头可拖拽排序 ----
    const groupTools = new Map<ToolGroup, ToolDef[]>();
    for (const t of rest) {
      const g = effectiveGroup(t, overrides);
      if (!g) {
        continue;
      }
      const arr = groupTools.get(g) ?? [];
      arr.push(t);
      groupTools.set(g, arr);
    }
    // 分组区总标题 + 新建分组（自定义分组即使为空也显示，可拖入工具归组）
    const groupsTitle = document.createElement("div");
    groupsTitle.className = "tb-pane-title";
    const gtText = document.createElement("span");
    gtText.textContent =
      "分组收纳区（顶栏下拉按钮）：拖拽分组头调序；工具行拖到分组头上收进该组";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "tb-add-group-btn";
    addBtn.title = "新建分组：创建后把工具行拖到分组头上即可归入";
    addBtn.innerHTML = iconHTML("plus", 12) + "新建分组";
    addBtn.addEventListener("click", () => this.createCustomGroup());
    groupsTitle.append(gtText, addBtn);
    this.toolbarListEl.appendChild(groupsTitle);
    // 新建/重命名内联输入行（不依赖 window.prompt，Tauri WebView 不支持原生 prompt）
    if (this.groupEdit) {
      this.toolbarListEl.appendChild(this.makeGroupEditRow());
    }
    for (const g of this.toolbarGroupOrder) {
      const tools = groupTools.get(g);
      const isCustom = this.customGroups.some((d) => d.id === g);
      if (!tools?.length && !isCustom) {
        continue; // 内置空组（如暂无 AI 工具）不显示；自定义空组显示（可拖入工具）
      }
      const section = document.createElement("div");
      section.className = "tb-section";
      const open = this.toolbarGroupOpen.get(g) ?? false;
      const head = document.createElement("div");
      head.className = "tb-group-head" + (open ? " open" : "");
      head.draggable = true;
      head.title = isCustom
        ? "点击展开/折叠组内工具；拖拽调整顺序；右侧可重命名/删除"
        : "点击展开/折叠组内工具；拖拽调整分组在顶栏中的顺序";
      // 拖拽手柄：提示该分组整体可拖拽（拖动后顶栏分组按钮顺序同步变化）
      const grip = document.createElement("span");
      grip.className = "tb-grip tb-group-grip";
      grip.title = "拖拽调整分组在顶栏中的顺序";
      grip.innerHTML = iconHTML("grip", 12);
      const gicon = document.createElement("span");
      gicon.className = "tb-group-icon";
      renderToolIcon(gicon, tools?.length ? tools[0].icon : "folder");
      const gname = document.createElement("span");
      gname.className = "tb-group-name";
      gname.textContent = `${groupLabel(g, this.customGroups)}▾`;
      const gdesc = document.createElement("span");
      gdesc.className = "tb-group-desc";
      gdesc.textContent = tools?.length
        ? tools.map((t) => t.name).join(" / ")
        : "（空分组：拖入工具归组）";
      const caret = document.createElement("span");
      caret.className = "tb-group-caret";
      caret.textContent = open ? "▾" : "▸";
      // 自定义分组操作：重命名 / 删除（内置组无）
      const ops = document.createElement("span");
      ops.className = "tb-group-ops";
      if (isCustom) {
        const rename = document.createElement("button");
        rename.type = "button";
        rename.className = "tb-group-op";
        rename.title = "重命名分组";
        rename.innerHTML = iconHTML("pencil", 11);
        rename.addEventListener("click", (e) => {
          e.stopPropagation();
          this.renameCustomGroup(g);
        });
        const del = document.createElement("button");
        del.type = "button";
        del.className =
          "tb-group-op tb-group-op-danger" +
          (this.confirmDelete === g ? " tb-group-op-confirm" : "");
        const deleting = this.confirmDelete === g;
        del.title = deleting
          ? "再次点击确认删除（组内工具回到原分组）"
          : "删除分组（组内工具回到原分组）";
        del.innerHTML = deleting
          ? iconHTML("trash", 11) + "确认删除"
          : iconHTML("trash", 11);
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          this.deleteCustomGroup(g);
        });
        ops.append(rename, del);
      }
      head.append(grip, gicon, gname, gdesc, ops, caret);
      head.addEventListener("click", () => {
        this.toolbarGroupOpen.set(g, !open);
        this.renderToolbarPane();
      });
      // 拖拽排序：把该分组移到目标分组前（同时作用于顶栏分组按钮顺序）；
      // 也可拖到上方平铺区：在该位置插入完整分组按钮（保持分组整体，不拆开）
      head.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/plain", groupMarker(g));
        head.classList.add("dragging");
      });
      head.addEventListener("dragend", () => {
        head.classList.remove("dragging", "drag-over");
      });
      head.addEventListener("dragover", (e) => {
        e.preventDefault();
        head.classList.add("drag-over");
      });
      head.addEventListener("dragleave", () =>
        head.classList.remove("drag-over"),
      );
      head.addEventListener("drop", (e) => {
        e.preventDefault();
        head.classList.remove("drag-over");
        const raw = e.dataTransfer?.getData("text/plain");
        if (!raw) {
          return;
        }
        if (isGroupMarker(raw)) {
          // 平铺区中的分组按钮行拖回分组区：移除标记（组按钮回到末尾/偏好位置）
          this.toolbarVisible = this.toolbarVisible.filter((x) => x !== raw);
          this.applyToolbarLayout();
          return;
        }
        if (this.registry.getTool(raw)) {
          // 平铺工具拖到分组头：归入该组并取消平铺
          // 自定义组写入归属覆盖；内置组清除覆盖（恢复注册默认归属）
          this.setToolGroup(raw, isCustom ? g : undefined);
          this.toggleToolbarItem(raw, false);
          return;
        }
        const src = raw as ToolGroup;
        if (src === g) {
          return;
        }
        const list = [...this.toolbarGroupOrder];
        const from = list.indexOf(src);
        const to = list.indexOf(g);
        if (from < 0 || to < 0) {
          return;
        }
        list.splice(from, 1);
        list.splice(to, 0, src);
        this.toolbarGroupOrder = list;
        saveGroupOrderPref(list);
        this.renderToolbarPane();
        // 通知顶栏重渲染（分组按钮顺序变化）
        this.onToolbarChange(this.toolbarPref);
      });
      section.appendChild(head);
      if (open) {
        const body = document.createElement("div");
        body.className = "tb-group-body";
        for (const t of tools ?? []) {
          body.appendChild(this.makeToolbarRow(t, false));
        }
        section.appendChild(body);
      }
      this.toolbarListEl.appendChild(section);
    }

    // ---- 隐藏区：无分组且未勾选（顶栏不可见） ----
    const hidden = rest.filter((t) => !t.group);
    if (hidden.length) {
      const section = document.createElement("div");
      section.className = "tb-section";
      const title = document.createElement("div");
      title.className = "tb-section-title";
      title.textContent = `已隐藏（${hidden.length}）：取消勾选后顶栏不可见`;
      section.appendChild(title);
      for (const t of hidden) {
        section.appendChild(this.makeToolbarRow(t, false));
      }
      this.toolbarListEl.appendChild(section);
    }

    this.updateToolbarCount();
    this.renderToolbarPreview();
  }

  /**
   * 单行工具：拖拽手柄 + 图标 + 名称/徽章 + 去向徽章 + 平铺复选框。
   * 所有行均可拖拽：拖到平铺区行 = 排序（未平铺则自动勾选并插入该位置）；
   * 拖到分组区/隐藏区行 = 取消平铺（分组工具收进对应下拉，其他工具隐藏）。
   */
  private makeToolbarRow(t: ToolDef, pinnedRow: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "tb-row";
    row.draggable = true;
    row.title = pinnedRow
      ? "拖拽调整平铺顺序；拖到下方分组区可取消平铺"
      : "拖到上方「平铺顶栏」区即可平铺到顶栏";
    // 拖拽手柄（所有行可拖；分组/隐藏行拖到平铺区 = 平铺）
    const grip = document.createElement("span");
    grip.className = "tb-grip";
    grip.title = pinnedRow
      ? "拖拽排序；拖到下方分组区取消平铺"
      : "拖到上方「平铺顶栏」区即可平铺";
    grip.innerHTML = iconHTML("grip", 12);
    row.appendChild(grip);

    const icon = document.createElement("span");
    icon.className = "tb-row-icon";
    renderToolIcon(icon, t.icon);
    row.appendChild(icon);

    const name = document.createElement("span");
    name.className = "tb-row-name";
    name.textContent = t.name;
    name.title = t.title;
    const grp = effectiveGroup(t, this.groupOverrides);
    if (grp) {
      const g = document.createElement("span");
      g.className = "tb-badge";
      g.textContent = groupLabel(grp, this.customGroups);
      name.appendChild(g);
    }
    if (t.source === "custom") {
      const b = document.createElement("span");
      b.className = "tb-badge tb-badge-ai";
      b.textContent = "AI";
      name.appendChild(b);
    }
    row.appendChild(name);

    // 去向徽章：勾选=平铺顶栏；未勾选分组=收进对应下拉；未勾选其他=从顶栏隐藏
    const dest = document.createElement("span");
    const grp2 = effectiveGroup(t, this.groupOverrides);
    dest.className = pinnedRow
      ? "tb-badge tb-badge-bar"
      : grp2
        ? "tb-badge tb-badge-drop"
        : "tb-badge tb-badge-hidden";
    dest.textContent = pinnedRow
      ? "顶栏"
      : grp2
        ? `收纳于 ${groupLabel(grp2, this.customGroups)}▾`
        : "隐藏";
    dest.title = pinnedRow
      ? "平铺在顶部工具栏，可拖拽调整顺序"
      : grp2
        ? `未平铺：点击顶栏「${groupLabel(grp2, this.customGroups)}▾」下拉仍可使用`
        : "未平铺且不在任何分组：顶栏不可见";
    row.appendChild(dest);

    const checkRow = document.createElement("label");
    checkRow.className = "tb-check";
    // 勾选/取消平铺：勾选顶栏；取消勾选：分组工具收进对应下拉，其他隐藏
    checkRow.title = grp
      ? `勾选：平铺顶栏；取消勾选：收进「${groupLabel(grp, this.customGroups)}▾」下拉`
      : "勾选：平铺顶栏；取消勾选：从顶栏隐藏";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = pinnedRow;
    box.addEventListener("change", () =>
      this.toggleToolbarItem(t.id, box.checked),
    );
    checkRow.append(document.createTextNode("平铺顶栏"), box);
    row.appendChild(checkRow);

    // 拖拽：所有行可拖（平铺区 ⇄ 分组/隐藏区双向）
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", t.id);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging", "drag-over");
    });
    row.addEventListener("dragover", (e) => {
      if (pinnedRow) {
        const src = e.dataTransfer?.getData("text/plain");
        if (src && isGroupMarker(src)) {
          return; // 分组头/分组按钮行禁止拖入平铺区（保持平铺区与分组区分开）
        }
      }
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const src = e.dataTransfer?.getData("text/plain");
      if (!src) {
        return;
      }
      if (pinnedRow) {
        // 目标在平铺区：工具行/分组按钮行 → 排序或插入该位置（分组保持整体，不拆开）
        this.dropIntoPinned(src, t.id);
      } else if (isGroupMarker(src)) {
        // 平铺区中的分组按钮行拖回分组/隐藏区：移除标记（组按钮回到末尾/偏好位置）
        this.toolbarVisible = this.toolbarVisible.filter((x) => x !== src);
        this.applyToolbarLayout();
      } else if (this.toolbarVisible.includes(src)) {
        // 目标在分组/隐藏区：源已平铺 → 取消勾选（分组工具收进对应下拉，其他隐藏）
        this.toggleToolbarItem(src, false);
      }
    });
    return row;
  }

  /**
   * 平铺区插入/排序：src 可为工具 id 或分组标记（"g:xxx"），插入到目标序列项位置。
   * 分组标记整体移动（分组按钮保持完整，不拆开）；from < to 时先删后插需回退一位。
   */
  private dropIntoPinned(src: string, targetItem: string) {
    if (!src || src === targetItem) {
      return;
    }
    const list = [...this.toolbarVisible];
    const to = list.indexOf(targetItem);
    if (to < 0) {
      return;
    }
    const from = list.indexOf(src);
    if (from >= 0) {
      list.splice(from, 1);
      list.splice(from < to ? to - 1 : to, 0, src);
    } else {
      list.splice(to, 0, src);
    }
    this.toolbarVisible = list;
    this.applyToolbarLayout();
  }

  /** 设置工具归属分组（自定义组写入覆盖；内置组传 undefined 清除覆盖恢复默认），并同步顶栏 */
  private setToolGroup(id: string, group: ToolGroup | undefined) {
    const next = { ...this.groupOverrides };
    if (group) {
      next[id] = group;
    } else {
      delete next[id];
    }
    this.groupOverrides = next;
    saveGroupOverrides(next);
    this.renderToolbarPane();
    this.onToolbarChange(this.toolbarPref);
  }

  /** 新建自定义分组：打开内联名称输入行（创建后即使为空也可拖入工具归组） */
  private createCustomGroup() {
    this.confirmDelete = null;
    this.groupEdit = { mode: "new" };
    this.renderToolbarPane();
  }

  /** 新建/重命名分组的内联输入行：回车/确定提交，Esc/取消关闭 */
  private makeGroupEditRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "tb-group-edit";
    const editing = this.groupEdit!;
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 24;
    input.placeholder =
      editing.mode === "new" ? "分组名称（如：常用）" : "重命名分组";
    if (editing.mode === "rename") {
      input.value = editing.initial;
      input.select();
    }
    const commit = () => {
      const name = input.value.trim();
      this.groupEdit = null;
      if (!name) {
        this.renderToolbarPane();
        return;
      }
      if (editing.mode === "new") {
        const id = `cg-${Date.now().toString(36)}`;
        this.customGroups = [...this.customGroups, { id, name }];
        saveCustomGroups(this.customGroups);
        // 新组默认展开，方便立即拖入工具
        this.toolbarGroupOpen.set(id, true);
      } else {
        const def = this.customGroups.find((d) => d.id === editing.id);
        if (def && def.name !== name) {
          def.name = name;
          saveCustomGroups(this.customGroups);
        }
      }
      this.renderToolbarPane();
      this.onToolbarChange(this.toolbarPref, this.customGroups);
    };
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "tb-group-op tb-group-edit-ok";
    ok.textContent = "确定";
    ok.addEventListener("click", commit);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "tb-group-op";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => {
      this.groupEdit = null;
      this.renderToolbarPane();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        commit();
      } else if (e.key === "Escape") {
        this.groupEdit = null;
        this.renderToolbarPane();
      }
    });
    row.append(input, ok, cancel);
    // 渲染完成后聚焦输入框
    requestAnimationFrame(() => input.focus());
    return row;
  }

  /** 重命名自定义分组：打开内联输入行（预填当前名称） */
  private renameCustomGroup(id: string) {
    const def = this.customGroups.find((d) => d.id === id);
    if (!def) {
      return;
    }
    this.confirmDelete = null;
    this.groupEdit = { mode: "rename", id, initial: def.name };
    this.renderToolbarPane();
  }

  /** 删除自定义分组：两段式确认（第二次点击执行）；组内工具清除归属覆盖回原分组 */
  private deleteCustomGroup(id: string) {
    if (this.confirmDelete !== id) {
      this.confirmDelete = id;
      this.renderToolbarPane();
      return;
    }
    this.confirmDelete = null;
    this.customGroups = this.customGroups.filter((d) => d.id !== id);
    saveCustomGroups(this.customGroups);
    const next = { ...this.groupOverrides };
    for (const [tid, g] of Object.entries(next)) {
      if (g === id) {
        delete next[tid];
      }
    }
    this.groupOverrides = next;
    saveGroupOverrides(next);
    this.toolbarGroupOpen.delete(id);
    this.renderToolbarPane();
    this.onToolbarChange(this.toolbarPref, this.customGroups);
  }

  /**
   * 平铺区中的分组按钮行：表示顶栏该位置有一个完整分组按钮（收纳组内工具，不拆开）。
   * 可拖拽排序（平铺区内），可拖回分组区或取消勾选移除（组按钮回到末尾/偏好位置）。
   */
  private makeGroupPinnedRow(g: ToolGroup, tools: ToolDef[]): HTMLElement {
    const row = document.createElement("div");
    row.className = "tb-row tb-group-pinned";
    row.draggable = true;
    row.title =
      "顶栏分组按钮（整体）：拖拽调整位置；拖回下方分组区或取消勾选可移除";

    const grip = document.createElement("span");
    grip.className = "tb-grip";
    grip.title = "拖拽调整分组按钮在顶栏中的位置";
    grip.innerHTML = iconHTML("grip", 12);
    row.appendChild(grip);

    const icon = document.createElement("span");
    icon.className = "tb-row-icon";
    renderToolIcon(icon, tools[0].icon);
    row.appendChild(icon);

    const name = document.createElement("span");
    name.className = "tb-row-name";
    name.textContent = `${groupLabel(g, this.customGroups)}▾`;
    name.title = "顶栏该位置显示完整分组按钮，点击箭头展开组内工具";
    row.appendChild(name);

    const dest = document.createElement("span");
    dest.className = "tb-badge tb-badge-bar";
    dest.textContent = "顶栏分组";
    dest.title = `顶栏分组按钮：收纳 ${tools.length} 个工具，保持整体不拆开`;
    row.appendChild(dest);

    const checkRow = document.createElement("label");
    checkRow.className = "tb-check";
    checkRow.title = "取消勾选：顶栏移除该分组按钮（组内工具未平铺时按钮回到末尾）";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.addEventListener("change", () => {
      this.toolbarVisible = this.toolbarVisible.filter(
        (x) => x !== groupMarker(g),
      );
      this.applyToolbarLayout();
    });
    checkRow.append(document.createTextNode("平铺顶栏"), box);
    row.appendChild(checkRow);

    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", groupMarker(g));
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging", "drag-over");
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const src = e.dataTransfer?.getData("text/plain");
      if (!src) {
        return;
      }
      this.dropIntoPinned(src, groupMarker(g));
    });
    return row;
  }

  /** 动态计数：已平铺工具/分组按钮数量与建议上限对比，超限标红警告 */
  private updateToolbarCount() {
    const total = this.toolbarVisible.length;
    // 分组按钮也占顶栏位置（计入折叠预算），但与工具分开标注
    const tools = this.toolbarVisible.filter((x) => !isGroupMarker(x)).length;
    const groups = total - tools;
    const warn = total > 8;
    const detail = groups
      ? `已平铺 ${tools} 个工具 + ${groups} 个分组按钮（共 ${total} 项）`
      : `已平铺 ${tools} 个工具`;
    this.toolbarCountEl.textContent = warn
      ? `${detail}：超出 8 项，顶栏将自动折叠多余工具进“更多▾”`
      : `${detail}（建议不超过 8 项；超出部分自动折叠进“更多▾”）`;
    this.toolbarCountEl.classList.toggle("warn", warn);
  }

  /**
   * 实时预览：与真实顶栏同一布局计算（含分组下拉按钮/更多▾折叠/常驻样式与填充），
   * 任何勾选/排序组合下所见即所得。
   */
  private renderToolbarPreview() {
    this.toolbarPreviewEl.innerHTML = "";
    const label = document.createElement("span");
    label.className = "tb-preview-label";
    label.textContent = "顶栏预览：";
    this.toolbarPreviewEl.appendChild(label);

    // 工具序列条（与真实顶栏 .tool-group 同构；样式/填充常驻按钮在条外，不参与折叠）
    const bar = document.createElement("span");
    bar.className = "tb-preview-bar";
    this.toolbarPreviewEl.appendChild(bar);

    const nodes = computeToolbarNodes(
      this.registry,
      this.toolbarPref,
      this.groupOverrides,
      this.customGroups,
    );
    const toolButtons = new Map<string, HTMLButtonElement>();
    for (const node of nodes) {
      if (node.kind === "tool") {
        const t = this.registry.getTool(node.id);
        if (!t) {
          continue;
        }
        const btn = makePreviewBtn(t.icon, t.name);
        btn.dataset.tool = t.id; // 溢出折叠时识别工具 id
        bar.appendChild(btn);
        toolButtons.set(t.id, btn);
      } else if (node.kind === "group") {
        // 分组拆分按钮（预览）：图标 = 组内第一个工具的图标（与真实顶栏默认态一致），箭头带分隔线
        const item = document.createElement("button");
        item.type = "button";
        item.className = "tb-preview-item tb-preview-group";
        item.title = `${groupLabel(node.group, this.customGroups)}▾：收纳 ${node.tools
          .map((t) => t.name)
          .join(" / ")}`;
        const gicon = document.createElement("span");
        gicon.className = "tb-preview-gicon";
        renderToolIcon(gicon, node.tools[0]?.icon ?? "");
        const caret = document.createElement("span");
        caret.className = "tb-preview-caret";
        caret.innerHTML = iconHTML("caret", 9);
        item.append(gicon, caret);
        bar.appendChild(item);
      }
    }

    // 更多▾：与真实顶栏同一折叠算法（预览条放不下时末尾平铺工具自动收进，hover 可见提示）
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "tb-preview-item tb-preview-more";
    moreBtn.style.display = "none";
    moreBtn.title = "更多▾：顶栏放不下时自动收纳的工具";
    moreBtn.innerHTML = iconHTML("menu", 13);
    bar.appendChild(moreBtn);
    const moreMenu = document.createElement("span");
    moreMenu.className = "tb-preview-more-menu";
    moreMenu.hidden = true;
    this.toolbarPreviewEl.appendChild(moreMenu);
    const moreItems = new Map<string, HTMLButtonElement>();
    foldIntoMore(bar, bar, moreBtn, moreMenu, toolButtons, moreItems, "");
    if (moreItems.size) {
      moreBtn.title = `更多▾：顶栏放不下时自动收纳（${[...moreItems.keys()]
        .map((id) => this.registry.getTool(id)?.name ?? id)
        .join(" / ")}）`;
    }

    // 常驻按钮：样式 / 填充开关（与真实顶栏一致位于工具序列之后）
    const styleItem = document.createElement("span");
    styleItem.className = "tb-preview-item tb-preview-const";
    styleItem.title = "样式（常驻）：描边/填充颜色与粗细";
    styleItem.innerHTML = iconHTML("sliders", 13);
    this.toolbarPreviewEl.appendChild(styleItem);
    const fillItem = document.createElement("span");
    fillItem.className = "tb-preview-item tb-preview-const";
    fillItem.title = "填充开关（常驻）";
    fillItem.innerHTML = FILL_ICON_HTML;
    this.toolbarPreviewEl.appendChild(fillItem);
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
    this.toolbarPref = visible;
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

  /** 恢复默认布局：清除平铺与分组顺序偏好（存 null 而非默认数组，与“未自定义过”状态一致）并重置顶栏 */
  private resetToolbarLayout() {
    if (!window.confirm("恢复默认工具栏布局？当前自定义的平铺/排序将被清除。")) {
      return;
    }
    this.toolbarVisible = this.defaultToolbarVisible();
    this.toolbarPref = null;
    saveToolbarPref(null);
    saveGroupOrderPref(null);
    this.toolbarGroupOrder = [];
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
