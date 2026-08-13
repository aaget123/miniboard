import { Board } from "./board/canvas";
import { beautifyScene } from "./board/beautify";
import { Storage } from "./storage";
import { Toolbar } from "./ui/toolbar";

const TOOL_KEYS: Record<string, import("./types").ToolType> = {
  v: "select",
  p: "pen",
  l: "line",
  a: "arrow",
  r: "rect",
  o: "ellipse",
  t: "text",
};

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
    target instanceof HTMLTextAreaElement
  );
}

async function main() {
  const canvasEl = document.getElementById("board") as HTMLCanvasElement;
  const toolbarEl = document.getElementById("toolbar") as HTMLDivElement;
  const statusEl = document.getElementById("statusbar") as HTMLDivElement;

  const style = { stroke: "#4f8cff", strokeWidth: 2, fillEnabled: false };

  const board = new Board(canvasEl, {
    getStyle: () => ({ ...style }),
    onMutated: () => {
      storage.scheduleAutosave();
      toolbar.setUndoRedo(board.canUndo, board.canRedo);
      updateStatus();
    },
  });

  const storage = new Storage(board);

  const toolbar = new Toolbar(toolbarEl, {
    onTool: (tool) => {
      board.setTool(tool);
      toolbar.setTool(tool);
    },
    onUndo: () => board.undo(),
    onRedo: () => board.redo(),
    onBeautify: () => {
      const before = board.serialize();
      const { elements, stats } = beautifyScene(before);
      if (!stats.length) {
        toast("✨ 画布已经很整齐了");
        return;
      }
      board.loadElements(elements);
      board.pushSnapshot(before);
      board.pushSnapshot(elements);
      toast(
        `✨ 整理完成：${stats.map((s) => `${s.label} ${s.count} 处`).join(" · ")}`,
      );
    },
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
    },
    onWidthChange: (width) => {
      style.strokeWidth = width;
    },
    onFillChange: (enabled) => {
      style.fillEnabled = enabled;
    },
  });

  function updateStatus() {
    const zoom = Math.round((board.app.tree.zoomLayer?.scaleX ?? 1) * 100);
    statusEl.textContent = `${board.elementCount} 个元素 · ${zoom}%`;
  }

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
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      board.deleteSelected();
      return;
    }
    if (e.key === "Escape") {
      board.editor.cancel();
      return;
    }
    const tool = TOOL_KEYS[e.key.toLowerCase()];
    if (tool && !mod && !e.altKey) {
      board.setTool(tool);
      toolbar.setTool(tool);
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
  toolbar.setUndoRedo(false, false);
  updateStatus();
  toast(restored ? "已恢复上次的画布" : "欢迎使用 Miniboard");
}

void main();
