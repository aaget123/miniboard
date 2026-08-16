import { Board } from "./board/canvas";
import { ToolRegistry } from "./board/registry";
import { ProjectStore, resolveDataDir } from "./storage";
import type { CustomToolDef } from "./types";
import { Toolbar } from "./ui/toolbar";
import { SelectionBar } from "./ui/selectionbar";
import { ToolsFloat } from "./ui/toolsfloat";
import {
  SettingsDialog,
  applyTheme,
  applyThemePref,
  loadGrid,
  loadTheme,
  saveThemePref,
  watchSystemTheme,
} from "./ui/settings";
import type { ThemePref } from "./ui/settings";
import { ProjectDialog } from "./ui/projects";
import { ExportDialog } from "./ui/exportdialog";
import { CommandPalette, showShortcutHelp, getShortcutHelpRows } from "./ui/palette";
import { ShortcutManager, comboFromEvent, formatCombo } from "./ui/shortcuts";
import { StatusBar } from "./ui/statusbar";
import { ContextMenu } from "./ui/contextmenu";
import type { ContextMenuAction } from "./ui/contextmenu";
import { AiPanel } from "./ai/panel";
import { PointerEvent } from "leafer-ui";
import type { IPointerEvent } from "@leafer-ui/interface";
import type { SelectionInfo } from "./board/canvas";

function toast(message: string) {
  let el = document.getElementById("toast") as HTMLDivElement | null;
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout((el as HTMLDivElement & { _t?: number })._t);
  (el as HTMLDivElement & { _t?: number })._t = window.setTimeout(
    () => el!.classList.remove("show"),
    2200,
  );
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    // contentEditable（leafer 文本内联编辑器）：编辑中的快捷键交给输入框原生处理
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

async function main() {
  const canvasEl = document.getElementById("board") as HTMLElement;
  const toolbarEl = document.getElementById("toolbar") as HTMLDivElement;
  const statusEl = document.getElementById("statusbar") as HTMLDivElement;

  const contextMenu = new ContextMenu(document.body);

  // 数据根目录：桌面端读配置（未配置时默认 appDataDir）；浏览器 null（localStorage）
  const dataDir = await resolveDataDir();

  // 统一功能注册表：内置 + AI 自定义工具（工具栏渲染、快捷键、绘制分发均以此为准）
  // 桌面端：自定义工具持久化到数据目录 custom-tools.json；首次启动把 localStorage 旧数据迁移到文件
  let registry: ToolRegistry;
  if (dataDir) {
    const { join } = await import("@tauri-apps/api/path");
    const { readTextFile, writeTextFile } = await import("@tauri-apps/plugin-fs");
    const toolsPath = await join(dataDir, "custom-tools.json");
    let initial: CustomToolDef[] | null = null;
    try {
      initial = JSON.parse(await readTextFile(toolsPath)) as CustomToolDef[];
    } catch {
      // 文件不存在：迁移 localStorage 旧数据（迁移成功后清理，避免下次重复）
      try {
        const legacy = localStorage.getItem("miniboard:custom-tools");
        if (legacy) {
          initial = JSON.parse(legacy) as CustomToolDef[];
          void writeTextFile(toolsPath, legacy);
          localStorage.removeItem("miniboard:custom-tools");
        }
      } catch {
        // 无旧数据或迁移失败：忽略（后续保存会重建文件）
      }
    }
    registry = new ToolRegistry({
      read: () => initial,
      write: (list) => {
        void writeTextFile(toolsPath, JSON.stringify(list)).catch(() => {
          console.error("[registry] 自定义工具保存失败");
        });
      },
    });
  } else {
    registry = new ToolRegistry();
  }
  // 顶部悬浮工具栏（创建于下方；board 双击自动切换工具与设置弹窗工具栏页签的回调闭包引用）
  let toolbar: Toolbar;

  const style = {
    stroke: "#4f8cff",
    strokeWidth: 2,
    fillEnabled: false,
    fillColor: "#4f8cff",
  };

  const board = new Board(canvasEl, {
    getStyle: () => ({ ...style }),
    registry,
    onMutated: () => {
      storage.scheduleAutosave();
      statusBar.setUndoRedo(board.canUndo, board.canRedo);
      updateStatus();
      updateWelcome();
    },
    onSelectionChange: (info) => {
      lastSelectionInfo = info;
      refreshSelectionBar(info);
    },
    // 文本内联编辑开合：编辑中隐藏左侧选中栏（避免遮挡输入框）
    onTextEditChange: (editing) => {
      textEditing = editing;
      refreshSelectionBar(lastSelectionInfo);
    },
    onContextMenu: (x, y) => {
      const list = board.editor.list;
      contextMenu.open(x, y, {
        hasSelection: list.length > 0,
        anyLocked: list.some((el) => el.locked),
        canPaste: board.canPaste,
        // 整理/手绘资格与左侧选中栏显隐条件一致
        hasFreehand: lastSelectionInfo?.hasFreehand ?? false,
        hasSketchable: lastSelectionInfo?.hasSketchable ?? false,
      });
    },
    // 双击文本/线元素自动切换选择工具时同步顶栏激活态
    onToolChange: (tool) => {
      toolbar.setTool(tool);
      refreshSelectionBar(lastSelectionInfo);
    },
  });

  // 左侧选中栏显隐判定：非 select 工具/文本编辑中整体隐藏（工具切换时同步刷新）
  let lastSelectionInfo: SelectionInfo | null = null;
  let textEditing = false;
  const refreshSelectionBar = (info: SelectionInfo | null) => {
    const tool = board.currentTool;
    // 画笔激活：左侧栏显示样式按钮，用于设置新笔迹的默认颜色/粗细
    const penMode = tool === "pen";
    if (penMode) {
      selectionBar.setWidth(style.strokeWidth);
    }
    selectionBar.show(
      info,
      (tool === "select" || penMode) && !textEditing,
      penMode,
    );
  };

  // 整理/手绘（左侧选中栏与右键菜单共用）：结果用 toast 反馈
  const doBeautify = () => {
    const { changed, stats } = board.beautifySelection();
    if (!changed) {
      toast("✨ 没有需要整理的画笔笔迹（先选中手绘笔迹）");
      return;
    }
    toast(
      `✨ 整理完成：${stats.map((s) => `${s.label} ${s.count} 处`).join(" · ")}`,
    );
  };
  const doSketchify = () => {
    const ok = board.sketchifySelection();
    toast(
      ok
        ? "✎ 已应用手绘风格（选中图形）"
        : "✎ 请先选中图形（矩形/椭圆/直线/箭头等）",
    );
  };

  const storage = new ProjectStore(board, dataDir);

  // 项目管理弹窗（☰ → 📁 项目）：新建/切换/重命名/删除；独立于设置弹窗
  // 项目变更回调：刷新状态栏项目名 + 元素数（切换/新建/删除后场景内容已变）
  const projectDialog = new ProjectDialog(storage, () => {
    statusBar.setProject(storage.current?.name ?? "");
    updateStatus();
    // AI 对话随项目切换：先落盘旧项目分桶，再恢复新项目对应分桶
    aiPanel.setProject(storage.current?.id ?? "");
  });

  // 快捷键配置中心：操作 + 内置工具键位可自定义（⚙ 设置 →「快捷键」页签，localStorage 持久化），
  // AI 自定义工具的快捷键仍由注册表维护（「AI 工具」页签编辑）；keymap 为生效映射（组合串 → 动作 id）
  const shortcuts = new ShortcutManager();
  let keymap: Record<string, string> = {};
  const rebuildKeymap = () => {
    keymap = shortcuts.allBindings(registry);
  };
  rebuildKeymap();
  registry.setOnChange(() => {
    rebuildKeymap();
    toolbar.refresh();
  });
  shortcuts.setOnChange(() => rebuildKeymap());

  // 设置弹窗（☰ → ⚙）：页签式——外观（主题+网格）/ 工具栏布局 / AI 模型 / AI 工具 / 系统提示词
  // 布局变更 → toolbar.setVisible；自定义分组增删 → toolbar.setCustomGroups 同步顶栏
  const settingsDialog = new SettingsDialog(board, registry, (visible, defs) => {
    toolbar.setVisible(visible);
    if (defs) {
      toolbar.setCustomGroups(defs);
    }
  });
  // 数据页签：展示当前数据目录；更改目录时调 Rust set_data_dir（创建/迁移/授权/记录），完成后重载存储
  settingsDialog.setDataDirHandlers({
    getDir: () => storage.getDataDir(),
    change: async (newDir) => {
      const oldDir = storage.getDataDir();
      if (!oldDir) {
        throw new Error("当前环境不支持更改数据目录");
      }
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_data_dir", { oldDir, newDir });
      const ok = await storage.reloadDataDir();
      if (!ok) {
        throw new Error("目录已切换，但项目加载失败");
      }
    },
  });
  // 快捷键页签：操作 + 内置工具键位自定义（改动即时重建 keymap）
  settingsDialog.setShortcutSource(shortcuts);
  // 按已保存主题初始化画布背景（默认跟随系统）
  applyTheme(loadTheme(), board);
  // 系统主题变化监听：偏好为“跟随系统”时自动切换实际主题
  watchSystemTheme(board);
  // 画布网格设置（显示/吸附/间距，默认关闭）
  board.applyGrid(loadGrid());

  let aiPanel!: AiPanel;

  // 填充开关统一处理：顶部与左侧栏共用（同步默认样式、按钮态与选中元素）
  const applyFillChange = (enabled: boolean) => {
    style.fillEnabled = enabled;
    toolbar.setFill(enabled);
    // 有选中元素时同步开/关填充
    board.applyStyleToSelection({ fillEnabled: enabled });
  };

  // ---- 顶部悬浮工具栏：工具组（含形状下拉）+ 样式/填充开关 ----
  toolbar = new Toolbar(toolbarEl, registry, {
    onTool: (tool) => {
      board.setTool(tool);
      toolbar.setTool(tool);
      // 切换工具后按新工具状态刷新左侧选中栏（非 select 工具隐藏）
      refreshSelectionBar(lastSelectionInfo);
    },
    onFillChange: applyFillChange,
    // 顶栏默认样式入口：打开与左侧栏共用的样式浮层（anchor 为样式按钮位置）
    onStyle: (anchor) => selectionBar.toggleStyle(anchor),
    // “AI 工具▾”下拉管理入口：定位到设置弹窗 AI 工具页签
    onManageTools: () => settingsDialog.open("tools"),
  });

  // ---- 左侧悬浮栏（选中时出现）：整理/手绘/样式 ----
  const selectionBar = new SelectionBar(document.body, {
    onBeautify: doBeautify,
    onSketchify: doSketchify,
    onStrokeChange: (color) => {
      style.stroke = color;
      selectionBar.setStroke(color);
      toolbar.setStyleColor(color);
      // 有选中元素时同步应用新描边色（不再联动填充）
      board.applyStyleToSelection({ stroke: color });
    },
    onFillColorChange: (color) => {
      style.fillColor = color;
      selectionBar.setFillColor(color);
      // 有选中元素时应用独立填充色（自动开启填充）
      board.applyStyleToSelection({ fillColor: color });
    },
    onWidthChange: (width) => {
      style.strokeWidth = width;
      selectionBar.setWidth(width);
      // 有选中元素时同步应用新粗细（画笔笔迹会按新粗细重算轮廓）
      board.applyStyleToSelection({ strokeWidth: width });
    },
    onFontSizeChange: (size) => {
      // 仅对选中文字即时生效（新文字字号固定默认值，不进默认样式）
      board.applyStyleToSelection({ fontSize: size });
    },
    // ---- P3 样式扩展：线型/透明度/圆角（仅作用于选中，不进默认样式） ----
    onStrokeDashChange: (dash) => {
      board.applyStyleToSelection({ strokeDash: dash });
    },
    onOpacityChange: (opacity) => {
      board.applyStyleToSelection({ opacity });
    },
    onCornerRadiusChange: (radius) => {
      board.applyStyleToSelection({ cornerRadius: radius });
    },
    // ---- 排列面板：对齐/分布/翻转/层序/成组（Board 内部合并快照） ----
    onAlign: (mode) => board.alignSelection(mode),
    onDistribute: (mode) => board.distributeSelection(mode),
    onFlip: (axis) => board.flipSelection(axis),
    onReorder: (mode) => {
      switch (mode) {
        case "front":
          board.toFront();
          break;
        case "back":
          board.toBack();
          break;
        case "forward":
          board.bringForward();
          break;
        case "backward":
          board.sendBackward();
          break;
      }
    },
    onGroup: () => {
      if (!board.groupSelected()) {
        toast("至少选中 2 个未锁定元素才能成组");
      }
    },
    onUngroup: () => {
      if (!board.ungroupSelected()) {
        toast("选中元素不在任何组中");
      }
    },
    onCrop: () => {
      const ok = board.startCrop();
      if (!ok) {
        toast("请单选一张未旋转的图片进行裁剪");
      }
    },
  });

  // 统一导出弹窗（右侧悬浮栏/命令面板共用）：选格式后执行实际导出
  const exportDialog = new ExportDialog(document.body);
  exportDialog.onExport((fmt) => {
    const p = fmt === "png" ? storage.exportPNG() : storage.exportSVG();
    p.then((ok) => {
      if (ok) {
        toast(fmt === "png" ? "📷 已导出 PNG" : "📄 已导出 SVG");
      }
    }).catch((err) => toast(`导出失败：${err}`));
  });

  // 插入图片（右侧栏/命令面板共用）：文件选择后写入画布
  const insertImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        return;
      }
      board
        .insertImage(file)
        .then((ok) => {
          toast(ok ? "🖻 已插入图片" : "图片加载失败，请换一张试试");
        })
        .catch(() => toast("图片加载失败，请换一张试试"));
    };
    input.click();
  };

  // 清空画布（右侧栏/命令面板共用）：可撤销
  const clearCanvas = () => {
    if (board.elementCount === 0) {
      toast("画布本来就是空的");
      return;
    }
    if (window.confirm("确定清空画布？此操作可撤销。")) {
      board.clearAll();
      toast("已清空画布");
    }
  };

  // ---- 右侧圆形悬浮栏（常驻可拖拽）：文件/AI/清空 ----
  const toolsFloat = new ToolsFloat(document.body, {
    onOpen: () => {
      storage
        .openFromFile()
        .then((ok) => {
          if (ok) {
            toast("📂 已打开文件");
          }
        })
        .catch((err) => toast(`打开失败：${err}`));
    },
    onSave: () => {
      storage
        .saveToFile()
        .then((ok) => {
          if (ok) {
            toast("💾 已保存");
          }
        })
        .catch((err) => toast(`保存失败：${err}`));
    },
    onInsertImage: insertImage,
    onExport: () => exportDialog.open(),
    onToggleAI: () => {
      aiPanel.toggle();
    },
    onClear: clearCanvas,
    onSettings: () => settingsDialog.open(),
  });

  // ---- 右下角状态栏：项目入口（点击项目名）+ 信息 + 撤销/重做/缩放 ----
  const statusBar = new StatusBar(statusEl, {
    onProjectClick: () => projectDialog.open(),
    onUndo: () => board.undo(),
    onRedo: () => board.redo(),
    onZoomIn: () => board.zoomIn(),
    onZoomOut: () => board.zoomOut(),
    onZoomReset: () => board.zoomReset(),
  });

  // AI 助手面板（交流 + 编辑双模式）；配置缺失时唤起设置弹窗并定位到模型页签
  aiPanel = new AiPanel(board, registry, toolbar, () => settingsDialog.open("model"));

  // 主题切换（命令面板用）：应用并持久化偏好
  const setThemePref = (pref: ThemePref) => {
    applyThemePref(pref, board);
    saveThemePref(pref);
  };

  // 命令面板（Ctrl+K）：搜索绘制工具与全局操作，每次打开时动态收集条目
  const palette = new CommandPalette(() => [
    ...registry.list().map((t) => ({
      id: `tool:${t.id}`,
      section: "工具" as const,
      title: t.name,
      icon: t.icon,
      // 内置/自定义工具统一显示生效键（配置优先，否则注册表键）
      hint: formatCombo(shortcuts.toolKeys(t)[0]),
      keywords: `${t.kind} ${t.group ?? ""} ${t.source}`,
      run: () => {
        board.setTool(t.id);
        toolbar.setTool(t.id);
        refreshSelectionBar(lastSelectionInfo);
      },
    })),
    { id: "open", section: "操作", title: "打开文件", icon: "folder", hint: formatCombo(shortcuts.getKeys("open")[0]), run: () => storage.openFromFile().catch((err) => toast(`打开失败：${err}`)) },
    { id: "save", section: "操作", title: "保存文件", icon: "save", hint: formatCombo(shortcuts.getKeys("save")[0]), run: () => storage.saveToFile().catch((err) => toast(`保存失败：${err}`)) },
    { id: "image", section: "操作", title: "插入图片", icon: "image", run: insertImage },
    { id: "export", section: "操作", title: "导出画布", icon: "download", keywords: "PNG SVG 图片 矢量", run: () => exportDialog.open() },
    { id: "projects", section: "操作", title: "项目管理", icon: "folder", keywords: "项目 切换 重命名", run: () => projectDialog.open() },
    { id: "settings", section: "操作", title: "设置", icon: "settings", keywords: "AI 模型 主题 网格 提示词", run: () => settingsDialog.open() },
    { id: "ai", section: "操作", title: "AI 助手", icon: "bot", hint: formatCombo(shortcuts.getKeys("aiPanel")[0]), run: () => aiPanel.toggle() },
    { id: "clear", section: "操作", title: "清空画布", icon: "trash", run: clearCanvas },
    { id: "theme-dark", section: "操作", title: "主题：深色", icon: "moon", keywords: "dark 深色", run: () => setThemePref("dark") },
    { id: "theme-light", section: "操作", title: "主题：浅色", icon: "sun", keywords: "light 浅色", run: () => setThemePref("light") },
    { id: "theme-system", section: "操作", title: "主题：跟随系统", icon: "monitor", keywords: "system 自动", run: () => setThemePref("system") },
    { id: "shortcuts", section: "操作", title: "快捷键帮助", icon: "keyboard", keywords: "help 帮助", run: () => showShortcutHelp(getShortcutHelpRows(registry, shortcuts)) },
  ]);

  function updateStatus() {
    const zoom = Math.round((board.app.tree.zoomLayer?.scaleX ?? 1) * 100);
    statusBar.setZoom(zoom);
    statusBar.setInfo(board.elementCount);
  }

  // 空画布欢迎语：有元素时淡出，清空后重新出现
  const welcomeEl = document.getElementById("welcome-hint") as HTMLElement;
  const updateWelcome = () => {
    welcomeEl.hidden = board.elementCount > 0;
  };
  updateWelcome();

  // 状态栏坐标：光标画布坐标实时跟随（tree 局部坐标，含缩放/平移）
  board.app.on(PointerEvent.MOVE, (e: IPointerEvent) => {
    const p = board.app.tree.getInnerPoint({ x: e.x ?? 0, y: e.y ?? 0 });
    statusBar.setInfo(board.elementCount, { x: p.x, y: p.y });
  });

  const MENU_ACTIONS: Record<ContextMenuAction, () => void> = {
    beautify: doBeautify,
    sketchify: doSketchify,
    copy: () => board.copy(),
    paste: () => board.paste(),
    cut: () => board.cut(),
    delete: () => board.deleteSelected(),
    selectAll: () => board.selectAll(),
    toFront: () => board.toFront(),
    toBack: () => board.toBack(),
    lock: () => board.lock(),
    unlock: () => board.unlock(),
  };
  contextMenu.onAction((action) => MENU_ACTIONS[action]());

  // 悬浮内容互斥管理：关闭所有浮层（右键菜单/分组下拉/样式浮层/右侧面板）
  const closeAllFloating = () => {
    contextMenu.close();
    toolbar.closeMenus();
    selectionBar.hidePopover();
    toolsFloat.collapse();
  };
  // 快捷键（配置驱动）：keymap 查表分发；工具键切换画布工具，操作键执行动作处理器
  const ACTION_HANDLERS: Record<string, () => void> = {
    save: () => storage.saveToFile().catch((err) => toast(`保存失败：${err}`)),
    open: () => storage.openFromFile().catch((err) => toast(`打开失败：${err}`)),
    undo: () => board.undo(),
    redo: () => board.redo(),
    copy: () => board.copy(),
    cut: () => board.cut(),
    paste: () => board.paste(),
    selectAll: () => board.selectAll(),
    delete: () => board.deleteSelected(),
    duplicate: () => {
      if (!board.duplicateSelected()) {
        toast("没有可重复的元素（先选中）");
      }
    },
    escape: () => {
      // 逐层退出：点编辑 → 图片裁剪 → 编辑框取消 → 悬浮浮层全部收起
      closeAllFloating();
      board.editor.cancel();
      board.exitPointEdit();
      board.cancelCrop();
    },
    palette: () => {
      closeAllFloating();
      palette.toggle();
    },
    aiPanel: () => aiPanel.toggle(),
    zoomIn: () => board.zoomIn(),
    zoomOut: () => board.zoomOut(),
    zoomReset: () => board.zoomReset(),
  };
  window.addEventListener("keydown", (e) => {
    if (isEditableTarget(e.target)) {
      return;
    }
    const id = keymap[comboFromEvent(e)];
    if (!id) {
      return;
    }
    // 逐层退出沿用原语义不拦截默认行为，其余动作统一阻止（避免触发浏览器默认快捷键）
    if (id !== "escape") {
      e.preventDefault();
    }
    if (id.startsWith("tool:")) {
      const tool = id.slice("tool:".length);
      board.setTool(tool);
      toolbar.setTool(tool);
      // 同步刷新左侧选中栏（画笔模式显示样式按钮）
      refreshSelectionBar(lastSelectionInfo);
      return;
    }
    ACTION_HANDLERS[id]?.();
  });

  // 状态栏 zoom 轮询（画布手势为 leafer 内置，无事件回调）
  let lastZoom = -1;
  setInterval(() => {
    const zoom = board.app.tree.zoomLayer?.scaleX ?? 1;
    if (zoom !== lastZoom) {
      lastZoom = zoom;
      updateStatus();
    }
  }, 400);

  // AI 面板开合同步：圆形栏按钮激活态 + 状态栏避开右侧面板（面板内部关闭按钮也生效）
  const aiEl = document.getElementById("ai-panel") as HTMLElement;
  new MutationObserver(() => {
    const open = !aiEl.hidden;
    toolsFloat.setAIActive(open);
    statusEl.classList.toggle("ai-open", open);
    // AI 面板打开时收起其他悬浮内容（互斥，避免遮挡重叠）
    if (open) {
      closeAllFloating();
    }
  }).observe(aiEl, { attributes: true, attributeFilter: ["hidden"] });

    // 项目恢复（多项目：初始化迁移旧数据并载入激活项目场景）
  const restored = await storage.init();
  statusBar.setProject(storage.current?.name ?? "");
  // AI 对话按激活项目恢复（项目×模式分桶存档，切模式/刷新/换项目均不丢）
  aiPanel.setProject(storage.current?.id ?? "");
  // 压入会话基线快照：保证本会话首个操作（含 AI 画的流程图）可直接撤销
  board.pushSnapshot(board.serialize());
  statusBar.setUndoRedo(board.canUndo, board.canRedo);
  updateStatus();
  // 顶部填充开关与样式按钮圆点对齐默认样式
  toolbar.setFill(style.fillEnabled);
  toolbar.setStyleColor(style.stroke);
  toast(
    restored
      ? `已恢复项目「${storage.current?.name ?? ""}」的画布`
      : "欢迎使用 Miniboard",
  );
}

void main();
