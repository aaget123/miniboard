import { Board } from "./board/canvas";
import { ToolRegistry } from "./board/registry";
import { Storage } from "./storage";
import { Toolbar } from "./ui/toolbar";
import { SelectionBar } from "./ui/selectionbar";
import { ToolsFloat } from "./ui/toolsfloat";
import { SettingsDialog, applyTheme, loadTheme } from "./ui/settings";
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
      });
    },
  });

  // 左侧选中栏显隐判定：非 select 工具/文本编辑中整体隐藏（工具切换时同步刷新）
  let lastSelectionInfo: SelectionInfo | null = null;
  let textEditing = false;
  const refreshSelectionBar = (info: SelectionInfo | null) => {
    selectionBar.show(info, board.currentTool === "select" && !textEditing);
  };

  const storage = new Storage(board);

  // 设置弹窗（☰ 文件与工具 → ⚙）：主题切换 + AI 多模型配置
  const settingsDialog = new SettingsDialog(board);
  // 按已保存主题初始化画布背景（默认深色）
  applyTheme(loadTheme(), board);

  let aiPanel!: AiPanel;

  // 填充开关统一处理：顶部与左侧栏共用（同步默认样式、按钮态与选中元素）
  const applyFillChange = (enabled: boolean) => {
    style.fillEnabled = enabled;
    toolbar.setFill(enabled);
    // 有选中元素时同步开/关填充
    board.applyStyleToSelection({ fillEnabled: enabled });
  };

  // ---- 顶部悬浮工具栏：工具组（含形状下拉）+ 填充开关 ----
  const toolbar = new Toolbar(toolbarEl, registry, {
    onTool: (tool) => {
      board.setTool(tool);
      toolbar.setTool(tool);
      // 切换工具后按新工具状态刷新左侧选中栏（非 select 工具隐藏）
      refreshSelectionBar(lastSelectionInfo);
    },
    onFillChange: applyFillChange,
  });

  // ---- 左侧悬浮栏（选中时出现）：整理/手绘/样式 ----
  const selectionBar = new SelectionBar(document.body, {
    onBeautify: () => {
      const { changed, stats } = board.beautifySelection();
      if (!changed) {
        toast("✨ 没有需要整理的画笔笔迹（先选中手绘笔迹）");
        return;
      }
      toast(
        `✨ 整理完成：${stats.map((s) => `${s.label} ${s.count} 处`).join(" · ")}`,
      );
    },
    onSketchify: () => {
      const ok = board.sketchifySelection();
      toast(
        ok
          ? "✎ 已应用手绘风格（选中图形）"
          : "✎ 请先选中图形（矩形/椭圆/直线/箭头等）",
      );
    },
    onStrokeChange: (color) => {
      style.stroke = color;
      selectionBar.setStroke(color);
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
      // 有选中元素时同步应用新粗细
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
    onInsertImage: () => {
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
    },
    onExport: () => {
      storage
        .exportPNG()
        .then((ok) => {
          if (ok) {
            toast("📷 已导出 PNG");
          }
        })
        .catch((err) => toast(`导出失败：${err}`));
    },
    onToggleAI: () => {
      aiPanel.toggle();
    },
    onClear: () => {
      if (board.elementCount === 0) {
        toast("画布本来就是空的");
        return;
      }
      if (window.confirm("确定清空画布？此操作可撤销。")) {
        board.clearAll();
        toast("已清空画布");
      }
    },
    onSettings: () => settingsDialog.open(),
  });

  // ---- 右下角状态栏：信息 + 撤销/重做/缩放 ----
  const statusBar = new StatusBar(statusEl, {
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

  // AI 助手面板（交流 + 编辑双模式）；配置缺失时唤起设置弹窗
  aiPanel = new AiPanel(board, registry, toolbar, () => settingsDialog.open());

  function updateStatus() {
    const zoom = Math.round((board.app.tree.zoomLayer?.scaleX ?? 1) * 100);
    statusBar.setZoom(zoom);
    statusBar.setInfo(board.elementCount);
  }

  // 状态栏坐标：光标画布坐标实时跟随（tree 局部坐标，含缩放/平移）
  board.app.on(PointerEvent.MOVE, (e: IPointerEvent) => {
    const p = board.app.tree.getInnerPoint({ x: e.x ?? 0, y: e.y ?? 0 });
    statusBar.setInfo(board.elementCount, { x: p.x, y: p.y });
  });

  const MENU_ACTIONS: Record<ContextMenuAction, () => void> = {
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

  // 悬浮内容互斥管理：关闭所有浮层（右键菜单/样式浮层/右侧面板）
  const closeAllFloating = () => {
    contextMenu.close();
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

  const restored = await storage.restoreAutosave();
  // 压入会话基线快照：保证本会话首个操作（含 AI 画的流程图）可直接撤销
  board.pushSnapshot(board.serialize());
  statusBar.setUndoRedo(board.canUndo, board.canRedo);
  updateStatus();
  // 顶部填充开关状态与默认样式对齐
  toolbar.setFill(style.fillEnabled);
  toast(restored ? "已恢复上次的画布" : "欢迎使用 Miniboard");
}

void main();
