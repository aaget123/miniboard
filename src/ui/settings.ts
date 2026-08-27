import type { Board } from "../board/canvas";
import type { ToolRegistry } from "../board/registry";
import { ToolManageDialog } from "./toolmanage";
import { iconHTML } from "./icons";
import { DataDirPaneController } from "./data-pane";
import { ModelPaneController } from "./model-pane";
import { PromptPaneController } from "./prompt-pane";
import { ShortcutsPaneController } from "./shortcuts-pane";
import { ToolbarPaneController } from "./toolbar-pane";
import type { ShortcutManager } from "./shortcuts";
import type { CustomGroupDef } from "./toolbar";

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

// ---------- 绘制偏好 ----------

const DRAW_PREFS_KEY = "miniboard:draw-prefs";

/** 绘制偏好设置 */
export type DrawPrefs = {
  /** 绘制完成后自动切回选择工具（Excalidraw 同款默认行为） */
  autoBackToSelect: boolean;
  /** 画完笔迹自动吸附为标准图形（圆/方/三角/直线；Excalidraw 招牌交互） */
  shapeDetect: boolean;
};

const DEFAULT_DRAW_PREFS: DrawPrefs = { autoBackToSelect: true, shapeDetect: true };

/** 读取绘制偏好（localStorage，数据损坏/缺失时回退默认值） */
export function loadDrawPrefs(): DrawPrefs {
  try {
    const raw = localStorage.getItem(DRAW_PREFS_KEY);
    if (!raw) {
      return { ...DEFAULT_DRAW_PREFS };
    }
    const p = JSON.parse(raw) as Partial<DrawPrefs>;
    return {
      autoBackToSelect:
        typeof p.autoBackToSelect === "boolean"
          ? p.autoBackToSelect
          : DEFAULT_DRAW_PREFS.autoBackToSelect,
      // 旧偏好数据无此键 → 默认开启
      shapeDetect: typeof p.shapeDetect === "boolean" ? p.shapeDetect : true,
    };
  } catch {
    return { ...DEFAULT_DRAW_PREFS };
  }
}

export function saveDrawPrefs(p: DrawPrefs) {
  try {
    localStorage.setItem(DRAW_PREFS_KEY, JSON.stringify(p));
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
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
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
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
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
  private themeBtns = new Map<ThemePref, HTMLButtonElement>();
  private toolManage!: ToolManageDialog;
  private gridForm!: {
    size: HTMLInputElement;
    show: HTMLInputElement;
    snap: HTMLInputElement;
  };
  /** 页签按钮 / 内容面板（appearance | model | prompt） */
  private tabBtns = new Map<string, HTMLButtonElement>();
  private panes = new Map<string, HTMLElement>();
  // 页签控制器：内容自治的页签域（DOM 构建/刷新/交互收进各自模块）
  private promptPaneCtrl!: PromptPaneController;
  private dataPaneCtrl!: DataDirPaneController;
  private scPane!: ShortcutsPaneController;
  private toolbarPaneCtrl!: ToolbarPaneController;
  private modelPaneCtrl!: ModelPaneController;

  constructor(
    private board: Board,
    private registry: ToolRegistry,
    /** 工具栏布局变更回调（main.ts 转 toolbar.setVisible；自定义组定义变化时一并同步顶栏） */
    private onToolbarChange: (visible: string[] | null, customGroups?: CustomGroupDef[]) => void,
  ) {
    this.build();
  }

  /** 打开设置弹窗；tab 可指定初始页签（appearance/model/prompt，缺省保持当前） */
  open(tab?: string) {
    // AI 模型配置与当前存储同步（外部改动不丢失）
    this.modelPaneCtrl.refresh();
    // 画布网格表单与当前设置同步（每次打开弹窗刷新，外部改动不丢失）
    const g = loadGrid();
    this.gridForm.size.value = String(g.size);
    this.gridForm.show.checked = g.show;
    this.gridForm.snap.checked = g.snap;
    // 提示词编辑区与当前存储同步
    this.promptPaneCtrl.refresh();
    // 工具栏布局与当前偏好同步（工具可能被 AI 增删，每次打开重建列表）
    this.toolbarPaneCtrl.refresh();
    if (tab) {
      this.switchTab(tab);
    }
    // AI 工具列表与当前注册表同步（内嵌页签）
    this.toolManage.refresh();
    // 数据页签与当前目录同步（目录可能在外部被更改）
    this.dataPaneCtrl.refresh();
    // 快捷键页签与当前配置同步（配置可能被外部/其他页签修改）
    this.scPane.refresh();
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
      { id: "shortcuts", label: "快捷键" },
      { id: "prompt", label: "系统提示词" },
      { id: "data", label: "数据" },
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
        size: Math.min(100, Math.max(4, Math.round(Number(sizeInput.value) || DEFAULT_GRID.size))),
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

    // ---- 绘制 ----
    const drawSection = document.createElement("section");
    drawSection.className = "settings-section";
    const drawLabel = document.createElement("h4");
    drawLabel.className = "settings-label";
    drawLabel.textContent = "绘制";
    drawSection.appendChild(drawLabel);
    const backRow = document.createElement("label");
    backRow.className = "ai-modal-row";
    const backBox = document.createElement("input");
    backBox.type = "checkbox";
    backBox.checked = loadDrawPrefs().autoBackToSelect;
    backRow.append(document.createTextNode("绘制完成后自动切回选择工具"), backBox);
    backBox.addEventListener("change", () => {
      const p: DrawPrefs = { ...loadDrawPrefs(), autoBackToSelect: backBox.checked };
      saveDrawPrefs(p);
      this.board.setAutoBackToSelect(p.autoBackToSelect);
    });
    drawSection.appendChild(backRow);
    // 笔迹形状吸附：画完近似圆/方/三角/直线的笔迹自动替换为标准图形（Excalidraw 招牌）
    const shapeRow = document.createElement("label");
    shapeRow.className = "ai-modal-row";
    const shapeBox = document.createElement("input");
    shapeBox.type = "checkbox";
    shapeBox.checked = loadDrawPrefs().shapeDetect;
    shapeRow.append(document.createTextNode("笔迹自动吸附为标准图形（圆/方/三角/直线）"), shapeBox);
    shapeBox.addEventListener("change", () => {
      const p: DrawPrefs = { ...loadDrawPrefs(), shapeDetect: shapeBox.checked };
      saveDrawPrefs(p);
      this.board.setShapeDetect(p.shapeDetect);
    });
    drawSection.appendChild(shapeRow);
    appearancePane.appendChild(drawSection);

    // ---- AI 模型页签：多配置注册/激活/编辑/连接测试（内容收进控制器） ----
    const modelPane = document.createElement("div");
    modelPane.className = "settings-pane";
    modelPane.hidden = true;
    this.panes.set("model", modelPane);
    modal.appendChild(modelPane);
    this.modelPaneCtrl = new ModelPaneController(modelPane);

    // ---- 工具栏页签：自定义顶栏布局（勾选平铺 + 排序；内容/拖拽引擎收进控制器） ----
    const toolbarPane = document.createElement("div");
    toolbarPane.className = "settings-pane";
    toolbarPane.hidden = true;
    this.panes.set("toolbar", toolbarPane);
    modal.appendChild(toolbarPane);
    this.toolbarPaneCtrl = new ToolbarPaneController(toolbarPane, {
      registry: this.registry,
      onToolbarChange: this.onToolbarChange,
    });

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

    const promptLabel = document.createElement("h4");
    promptLabel.className = "settings-label";
    promptLabel.textContent = "系统提示词";
    promptPane.appendChild(promptLabel);
    const promptHint = document.createElement("p");
    promptHint.className = "settings-hint";
    promptHint.textContent =
      "自定义 AI 助手的行为指令：交流模式用于对话与建议，编辑模式用于绘制工具管理；保存后立即生效。";
    promptPane.appendChild(promptHint);

    // ---- 数据页签：存储位置管理（桌面端可更改目录，浏览器环境提示 localStorage） ----
    const dataPane = document.createElement("div");
    dataPane.className = "settings-pane";
    dataPane.hidden = true;
    this.panes.set("data", dataPane);
    modal.appendChild(dataPane);
    this.dataPaneCtrl = new DataDirPaneController(dataPane);

    // ---- 快捷键页签：操作 + 内置工具键位自定义（内容由 ShortcutsPaneController 重建） ----
    const shortcutsPane = document.createElement("div");
    shortcutsPane.className = "settings-pane";
    shortcutsPane.hidden = true;
    this.panes.set("shortcuts", shortcutsPane);
    modal.appendChild(shortcutsPane);
    this.scPane = new ShortcutsPaneController(shortcutsPane, this.registry);

    // 提示词编辑区/操作行/状态行由页签控制器自建
    this.promptPaneCtrl = new PromptPaneController(promptPane);

    document.body.appendChild(this.mask);
    this.mask.hidden = true;
    this.syncTheme();
    this.switchTab("appearance");
    this.promptPaneCtrl.refresh();
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

  // ---------- 页签切换 ----------

  private switchTab(tab: string) {
    for (const [t, btn] of this.tabBtns) {
      btn.classList.toggle("active", t === tab);
    }
    for (const [t, pane] of this.panes) {
      pane.hidden = t !== tab;
    }
  }

  // ---------- 数据存储 ----------

  /** 数据页签回调注入（main.ts：storage.getDataDir + Rust set_data_dir + 重载） */
  setDataDirHandlers(handlers: {
    getDir: () => string | null;
    change: (newDir: string) => Promise<void>;
  }) {
    this.dataPaneCtrl.setHandlers(handlers);
  }

  // ---------- 快捷键 ----------

  /** 快捷键配置中心注入（main.ts 创建，操作/内置工具键位自定义；AI 工具键仍由注册表维护） */
  setShortcutSource(manager: ShortcutManager) {
    this.scPane.setSource(manager);
  }
}
