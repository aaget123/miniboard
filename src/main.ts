import { Board } from "./board/canvas";
import { beautifyScene } from "./board/beautify";
import { ToolRegistry } from "./board/registry";
import { Storage } from "./storage";
import { Toolbar } from "./ui/toolbar";
import { ContextMenu } from "./ui/contextmenu";
import type { ContextMenuAction } from "./ui/contextmenu";
import { AiPanel } from "./ai/panel";

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
      toolbar.setUndoRedo(board.canUndo, board.canRedo);
      updateStatus();
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

  const storage = new Storage(board);

  let aiPanel!: AiPanel;

  const toolbar = new Toolbar(toolbarEl, registry, {
    onTool: (tool) => {
      board.setTool(tool);
      toolbar.setTool(tool);
    },
    onToggleAI: () => aiPanel.toggle(),
    onUndo: () => board.undo(),
    onRedo: () => board.redo(),
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
    onBeautify: () => {
      const before = board.serialize();
      const { elements, stats } = beautifyScene(before);
      if (!stats.length) {
        toast("✨ 没有需要整理的画笔笔迹");
        return;
      }
      board.loadElements(elements);
      board.pushSnapshot(before);
      board.pushSnapshot(elements);
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
    onZoomIn: () => board.zoomIn(),
    onZoomOut: () => board.zoomOut(),
    onZoomReset: () => board.zoomReset(),
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
    onExport: () => {
      storage
        .exportPNG()
        .then((ok) => {
          if (ok) {
            toast("🖼 已导出 PNG");
          }
        })
        .catch((err) => toast(`导出失败：${err}`));
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
    onStrokeChange: (color) => {
      style.stroke = color;
      toolbar.setStroke(color);
      // 有选中元素时同步应用新描边色（不再联动填充）
      board.applyStyleToSelection({ stroke: color });
    },
    onFillColorChange: (color) => {
      style.fillColor = color;
      toolbar.setFillColor(color);
      // 有选中元素时应用独立填充色（自动开启填充）
      board.applyStyleToSelection({ fillColor: color });
    },
    onWidthChange: (width) => {
      style.strokeWidth = width;
      // 有选中元素时同步应用新粗细
      board.applyStyleToSelection({ strokeWidth: width });
    },
    onFillChange: (enabled) => {
      style.fillEnabled = enabled;
      // 有选中元素时同步开/关填充
      board.applyStyleToSelection({ fillEnabled: enabled });
    },
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

  // AI 助手面板（交流 + 编辑双模式）
  aiPanel = new AiPanel(board, registry, toolbar);

  function updateStatus() {
    const zoom = Math.round((board.app.tree.zoomLayer?.scaleX ?? 1) * 100);
    statusEl.textContent = `${board.elementCount} 个元素 · ${zoom}%`;
  }

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
      board.editor.cancel();
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

  const restored = await storage.restoreAutosave();
  // 压入会话基线快照：保证本会话首个操作（含 AI 画的流程图）可直接撤销
  board.pushSnapshot(board.serialize());
  toolbar.setUndoRedo(board.canUndo, board.canRedo);
  updateStatus();
  toast(restored ? "已恢复上次的画布" : "欢迎使用 Miniboard");
}

void main();
