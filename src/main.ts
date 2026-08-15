import { Board } from "./board/canvas";
import { ToolRegistry } from "./board/registry";
import { ProjectStore } from "./storage";
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
import { CommandPalette, showShortcutHelp } from "./ui/palette";
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

  // 统一功能注册表：内置 + AI 自定义工具（工具栏渲染、快捷键、绘制分发均以此为准）
  const registry = new ToolRegistry();
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

  const storage = new ProjectStore(board);

  // 项目管理弹窗（☰ → 📁 项目）：新建/切换/重命名/删除；独立于设置弹窗
  // 项目变更回调：刷新状态栏项目名 + 元素数（切换/新建/删除后场景内容已变）
  const projectDialog = new ProjectDialog(storage, () => {
    statusBar.setProject(storage.current?.name ?? "");
    updateStatus();
  });

  // 设置弹窗（☰ → ⚙）：页签式——外观（主题+网格）/ 工具栏布局 / AI 模型 / AI 工具 / 系统提示词
  const settingsDialog = new SettingsDialog(board, registry, (visible) =>
    toolbar.setVisible(visible),
  );
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

  // 注册表变化：重建快捷键映射 + 刷新工具栏
  const TOOL_KEYS: Record<string, string> = {};
  const rebuildKeys = () => {
    for (const k of Object.keys(TOOL_KEYS)) {
      delete TOOL_KEYS[k];
    }
    for (const t of registry.list()) {
      if (t.shortcut) {
        TOOL_KEYS[t.shortcut] = t.id;
      }
    }
  };
  rebuildKeys();
  registry.setOnChange(() => {
    rebuildKeys();
    toolbar.refresh();
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
      hint: t.shortcut ? t.shortcut.toUpperCase() : undefined,
      keywords: `${t.kind} ${t.group ?? ""} ${t.source}`,
      run: () => {
        board.setTool(t.id);
        toolbar.setTool(t.id);
        refreshSelectionBar(lastSelectionInfo);
      },
    })),
    { id: "open", section: "操作", title: "打开文件", icon: "folder", hint: "Ctrl+O", run: () => storage.openFromFile().catch((err) => toast(`打开失败：${err}`)) },
    { id: "save", section: "操作", title: "保存文件", icon: "save", hint: "Ctrl+S", run: () => storage.saveToFile().catch((err) => toast(`保存失败：${err}`)) },
    { id: "image", section: "操作", title: "插入图片", icon: "image", run: insertImage },
    { id: "export", section: "操作", title: "导出画布", icon: "download", keywords: "PNG SVG 图片 矢量", run: () => exportDialog.open() },
    { id: "projects", section: "操作", title: "项目管理", icon: "folder", keywords: "项目 切换 重命名", run: () => projectDialog.open() },
    { id: "settings", section: "操作", title: "设置", icon: "settings", keywords: "AI 模型 主题 网格 提示词", run: () => settingsDialog.open() },
    { id: "ai", section: "操作", title: "AI 助手", icon: "bot", hint: "K", run: () => aiPanel.toggle() },
    { id: "clear", section: "操作", title: "清空画布", icon: "trash", run: clearCanvas },
    { id: "theme-dark", section: "操作", title: "主题：深色", icon: "moon", keywords: "dark 深色", run: () => setThemePref("dark") },
    { id: "theme-light", section: "操作", title: "主题：浅色", icon: "sun", keywords: "light 浅色", run: () => setThemePref("light") },
    { id: "theme-system", section: "操作", title: "主题：跟随系统", icon: "monitor", keywords: "system 自动", run: () => setThemePref("system") },
    { id: "shortcuts", section: "操作", title: "快捷键帮助", icon: "keyboard", keywords: "help 帮助", run: () => showShortcutHelp() },
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
  // 快捷键
  window.addEventListener("keydown", (e) => {
    if (isEditableTarget(e.target)) {
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      storage.saveToFile().catch((err) => toast(`保存失败：${err}`));
      return;
    }
    if (mod && e.key.toLowerCase() === "o") {
      e.preventDefault();
      storage.openFromFile().catch((err) => toast(`打开失败：${err}`));
      return;
    }
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) {
        board.redo();
      } else {
        board.undo();
      }
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      board.redo();
      return;
    }
    if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      board.copy();
      return;
    }
    if (mod && e.key.toLowerCase() === "x") {
      e.preventDefault();
      board.cut();
      return;
    }
    if (mod && e.key.toLowerCase() === "v") {
      e.preventDefault();
      board.paste();
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      board.selectAll();
      return;
    }
    // 命令面板（Ctrl+K，与 AI 面板开关的裸 K 区分）
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      closeAllFloating();
      palette.toggle();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      board.deleteSelected();
      return;
    }
    if (e.key === "Escape") {
      // 逐层退出：点编辑 → 图片裁剪 → 编辑框取消 → 悬浮浮层全部收起
      closeAllFloating();
      board.editor.cancel();
      board.exitPointEdit();
      board.cancelCrop();
      return;
    }
    if (mod && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      board.zoomIn();
      return;
    }
    if (mod && e.key === "-") {
      e.preventDefault();
      board.zoomOut();
      return;
    }
    if (mod && e.key === "0") {
      e.preventDefault();
      board.zoomReset();
      return;
    }
    // AI 面板开关（k 为保留快捷键，优先级最高）
    if (!mod && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      aiPanel.toggle();
      return;
    }
    const tool = TOOL_KEYS[e.key.toLowerCase()];
    if (tool && !mod && !e.altKey) {
      board.setTool(tool);
      toolbar.setTool(tool);
      // 同步刷新左侧选中栏（画笔模式显示样式按钮）
      refreshSelectionBar(lastSelectionInfo);
      return;
    }
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
