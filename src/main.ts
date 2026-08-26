import { Board } from "./board/canvas";
import { pdfFirstPageToImage } from "./board/pdf";
import { ToolRegistry } from "./board/registry";
import { ProjectStore, isDesktop, resolveDataDir } from "./storage";
import type { CustomToolDef, FontWeight } from "./types";
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
import type { AiPanel } from "./ai/panel";
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

// ---- 默认样式持久化：跨启动记住上次使用的颜色/粗细/填充 ----
const LS_STYLE = "miniboard:last-style";
type DefaultStyle = {
  stroke: string;
  strokeWidth: number;
  fillEnabled: boolean;
  fillColor: string;
};
function loadDefaultStyle(): DefaultStyle {
  const fallback: DefaultStyle = {
    stroke: "#4f8cff",
    strokeWidth: 2,
    fillEnabled: false,
    fillColor: "#4f8cff",
  };
  try {
    const raw = localStorage.getItem(LS_STYLE);
    if (!raw) {
      return fallback;
    }
    const s = JSON.parse(raw) as Partial<DefaultStyle>;
    return {
      stroke: typeof s.stroke === "string" ? s.stroke : fallback.stroke,
      strokeWidth:
        typeof s.strokeWidth === "number" && s.strokeWidth >= 1 && s.strokeWidth <= 40
          ? s.strokeWidth
          : fallback.strokeWidth,
      fillEnabled: s.fillEnabled === true,
      fillColor: typeof s.fillColor === "string" ? s.fillColor : fallback.fillColor,
    };
  } catch {
    return fallback;
  }
}

// ---- 橡皮半径持久化（滑条 / [ ] 键 / 滚轮共用）----
const LS_ERASER_RADIUS = "miniboard:eraser-radius";
function loadEraserRadius(): number {
  const v = Number(localStorage.getItem(LS_ERASER_RADIUS));
  return Number.isFinite(v) && v >= 2 && v <= 80 ? Math.round(v) : 10;
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

  const style = loadDefaultStyle();
  const saveStyle = () => {
    try {
      localStorage.setItem(LS_STYLE, JSON.stringify(style));
    } catch {
      // 存储不可用时静默失败（仅影响下次启动的记忆）
    }
  };
  // 橡皮半径滑条反向同步（Board 回调先于 selectionBar 创建触发时安全空实现）
  let syncEraserSlider: (radiusPx: number) => void = () => {};
  // 选区尺寸状态栏同步（同上，晚绑定）
  let syncSelectionSize: () => void = () => {};

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
      const fs = board.frameActionState();
      contextMenu.open(x, y, {
        hasSelection: list.length > 0,
        anyLocked: list.some((el) => el.locked),
        canPaste: board.canPaste,
        // 整理/手绘资格与左侧选中栏显隐条件一致
        hasFreehand: lastSelectionInfo?.hasFreehand ?? false,
        hasSketchable: lastSelectionInfo?.hasSketchable ?? false,
        // 框架操作资格：单选未锁定 rect / frame（含约束/折叠/聚焦状态）
        canToFrame: fs.canToFrame,
        canToRect: fs.canToRect,
        frameConstrainOn: fs.constrainOn,
        canCollapse: fs.canCollapse,
        collapsedOn: fs.collapsedOn,
        canFocus: fs.canFocus,
        focusOn: fs.focusOn,
      });
    },
    // 双击文本/线元素自动切换选择工具时同步顶栏激活态
    onToolChange: (tool) => {
      toolbar.setTool(tool);
      refreshSelectionBar(lastSelectionInfo);
    },
    // 橡皮半径变化（滚轮/[ ] 键）：反向同步左侧栏滑条（滑条拖动走 onEraserRadiusChange 回调）
    onEraserRadiusChange: (radiusPx) => {
      localStorage.setItem(LS_ERASER_RADIUS, String(radiusPx));
      syncEraserSlider(radiusPx);
    },
    // 首次约束夹紧（拖动撞墙）：一次性提示 Alt 豁免
    onConstraintHint: () => toast("已吸附在约束框架内 · 按住 Alt 可拖出"),
    // 自定义工具运行时异常：toast 引导修复（每工具每会话一次）
    onToolRuntimeError: (toolId, message) => {
      const name = registry.list().find((t) => t.id === toolId)?.name ?? toolId;
      toast(`工具「${name}」执行出错：${message}（可在 ⚙→AI 工具 中对话修复）`);
    },
  });
  // 恢复上次使用的橡皮半径
  board.setEraserRadius(loadEraserRadius());

  // 左侧选中栏显隐判定：非 select 工具/文本编辑中整体隐藏（工具切换时同步刷新）
  let lastSelectionInfo: SelectionInfo | null = null;
  let textEditing = false;
  const refreshSelectionBar = (info: SelectionInfo | null) => {
    const tool = board.currentTool;
    syncSelectionSize();
    // 画笔激活：左侧栏显示样式按钮，用于设置新笔迹的默认颜色/粗细
    const penMode = tool === "pen";
    // 橡皮激活：左侧栏只显示半径滑条
    const eraserMode = tool === "eraser";
    if (penMode) {
      selectionBar.setWidth(style.strokeWidth);
    }
    selectionBar.show(
      info,
      (tool === "select" || penMode || eraserMode) && !textEditing,
      penMode,
      eraserMode,
    );
  };

  // 整理/手绘（左侧选中栏与右键菜单共用）：结果用 toast 反馈
  const doBeautify = () => {
    const { changed, stats } = board.beautifySelection();
    if (!changed) {
      toast("✨ 没有需要整理的画笔笔迹（先选中手绘笔迹）");
      return;
    }
    toast(`✨ 整理完成：${stats.map((s) => `${s.label} ${s.count} 处`).join(" · ")}`);
  };
  const doSketchify = () => {
    const ok = board.sketchifySelection();
    toast(ok ? "✎ 已应用手绘风格（选中图形）" : "✎ 请先选中图形（矩形/椭圆/直线/箭头等）");
  };

  const storage = new ProjectStore(board, dataDir);
  // 自动保存失败提示（连续失败只报一次，恢复后自动复位）
  storage.onStorageError = (message) => toast(`⚠️ ${message}`);

  // 项目管理弹窗（☰ → 📁 项目）：新建/切换/重命名/删除；独立于设置弹窗
  // 项目变更回调：刷新状态栏项目名 + 元素数（切换/新建/删除后场景内容已变）
  const projectDialog = new ProjectDialog(storage, () => {
    statusBar.setProject(storage.current?.name ?? "");
    updateStatus();
    // AI 对话随项目切换：先落盘旧项目分桶，再恢复新项目对应分桶（面板未加载则由工厂兜底）
    aiPanel?.setProject(storage.current?.id ?? "");
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

  // AI 面板懒加载：panel/tools/client 约 2900 行仅在首次唤起时加载（主包瘦身）。
  // 未加载期间所有引用点安全空转；工厂创建时兜底同步当前项目对话分桶
  let aiPanel: AiPanel | null = null;
  let toggleAiPanel: () => void = () => {};

  // 填充开关统一处理：顶部与左侧栏共用（同步默认样式、按钮态与选中元素）
  const applyFillChange = (enabled: boolean) => {
    style.fillEnabled = enabled;
    toolbar.setFill(enabled);
    // 有选中元素时同步开/关填充
    board.applyStyleToSelection({ fillEnabled: enabled });
    saveStyle();
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
      saveStyle();
    },
    onFillColorChange: (color) => {
      style.fillColor = color;
      selectionBar.setFillColor(color);
      // 有选中元素时应用独立填充色（自动开启填充）
      board.applyStyleToSelection({ fillColor: color });
      saveStyle();
    },
    onWidthChange: (width) => {
      style.strokeWidth = width;
      selectionBar.setWidth(width);
      // 有选中元素时同步应用新粗细（画笔笔迹会按新粗细重算轮廓）
      board.applyStyleToSelection({ strokeWidth: width });
      saveStyle();
    },
    onFontSizeChange: (size) => {
      // 仅对选中文字即时生效（新文字字号固定默认值，不进默认样式）
      board.applyStyleToSelection({ fontSize: size });
    },
    // ---- 文本排版扩展：对齐/字重/字体（仅作用于选中文字，不进默认样式） ----
    onTextAlignChange: (align) => {
      board.applyStyleToSelection({ textAlign: align });
    },
    onFontWeightChange: (weight) => {
      board.applyStyleToSelection({ fontWeight: weight as FontWeight });
    },
    onFontFamilyChange: (family) => {
      board.applyStyleToSelection({ fontFamily: family || undefined });
    },
    // ---- 箭头端点：起点/终点样式（仅作用于选中 line/arrow） ----
    onArrowHeadChange: (end, head) => {
      board.applyStyleToSelection(end === "start" ? { startArrow: head } : { endArrow: head });
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
    // 粗糙度：已手绘元素同一 seed 重绘（抖动态不变仅幅度变）
    onRoughnessChange: (roughness) => {
      board.setRoughness(roughness);
    },
    // 橡皮半径滑条：拖动即调 Board 半径并持久化
    onEraserRadiusChange: (radiusPx) => {
      board.setEraserRadius(radiusPx);
      localStorage.setItem(LS_ERASER_RADIUS, String(board.eraserRadiusPx));
    },
    onCrop: () => {
      const ok = board.startCrop();
      if (!ok) {
        toast("请单选一张未旋转的图片进行裁剪");
      }
    },
  });
  // 滑条初值对齐已恢复的半径；滚轮/[ ] 调节时经此反向同步滑条
  selectionBar.setEraserRadius(board.eraserRadiusPx);
  syncEraserSlider = (radiusPx) => selectionBar.setEraserRadius(radiusPx);

  // 统一导出弹窗（右侧悬浮栏/命令面板共用）：选格式后执行实际导出
  const exportDialog = new ExportDialog(document.body);
  exportDialog.onExport((fmt) => {
    if ((fmt === "pdf" || fmt === "png" || fmt === "copy") && board.elementCount === 0) {
      toast("画布是空的，没有内容可导出");
      return;
    }
    const p =
      fmt === "copy"
        ? storage.exportPNGClipboard()
        : fmt === "png"
          ? storage.exportPNG()
          : fmt === "svg"
            ? storage.exportSVG()
            : storage.exportPDF();
    p.then((ok) => {
      if (ok) {
        toast(
          fmt === "copy"
            ? "📋 已复制画布图片，可直接粘贴"
            : fmt === "png"
              ? "📷 已导出 PNG"
              : fmt === "svg"
                ? "📄 已导出 SVG"
                : "📕 已导出 PDF",
        );
      } else if (fmt === "copy") {
        toast("复制失败：浏览器不支持或权限被拒");
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

  // ---- 内容文件导入（MD/代码/文本 → 内容框架）：对话框 / 拖拽共用 ----
  // 内容类型推断：按扩展名区分 markdown / code / text
  const CONTENT_CODE_EXTS = new Set([
    "js",
    "ts",
    "tsx",
    "jsx",
    "py",
    "java",
    "c",
    "cpp",
    "h",
    "go",
    "rs",
    "rb",
    "php",
    "sh",
    "bat",
    "ps1",
    "sql",
    "yaml",
    "yml",
    "toml",
    "ini",
    "json",
    "css",
    "xml",
    "html",
    "vue",
    "svelte",
  ]);
  const contentTypeOf = (name: string): "markdown" | "code" | "text" => {
    const ext = (name.split(".").pop() ?? "").toLowerCase();
    if (ext === "md" || ext === "markdown") {
      return "markdown";
    }
    if (CONTENT_CODE_EXTS.has(ext)) {
      return "code";
    }
    return "text";
  };
  // 内容框架落位：视口中心略偏左上（autoSize 会按内容重算尺寸）
  const placeContentFrame = (name: string, text: string) => {
    if (!text.trim()) {
      toast(`文件为空：${name}`);
      return;
    }
    const c = board.viewport.center;
    board.createContentFrame(Math.round(c.x - 100), Math.round(c.y - 60), {
      name,
      contentType: contentTypeOf(name),
      content: text,
    });
    toast(`📄 已导入 ${name}`);
  };
  // 拖入文件分流：图片直插画布、PDF 首页转图片、文本/代码进内容框架、其他提示不支持
  const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"]);
  const handleDroppedFile = async (file: File) => {
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      const ok = await board.insertImage(file);
      toast(ok ? "🖻 已插入图片" : `图片加载失败：${file.name}`);
      return;
    }
    if (ext === "pdf") {
      try {
        const page = await pdfFirstPageToImage(await file.arrayBuffer());
        if (!page) {
          toast(`PDF 解析失败：${file.name}`);
          return;
        }
        // 渲染出的首页 PNG 转成 File，复用 insertImage 的缩放/落位逻辑
        const blob = await (await fetch(page.dataURL)).blob();
        const png = new File([blob], `${file.name.replace(/\.pdf$/i, "")}.png`, {
          type: "image/png",
        });
        const ok = await board.insertImage(png);
        toast(ok ? `📕 已导入 PDF 首页：${file.name}` : `PDF 导入失败：${file.name}`);
      } catch {
        toast(`PDF 导入失败：${file.name}`);
      }
      return;
    }
    if (
      ext === "md" ||
      ext === "markdown" ||
      ext === "txt" ||
      ext === "text" ||
      ext === "csv" ||
      CONTENT_CODE_EXTS.has(ext)
    ) {
      placeContentFrame(file.name, await file.text());
      return;
    }
    toast(`不支持的文件类型：${file.name}（支持图片/PDF/文本/代码）`);
  };
  // 文件选择对话框导入（右侧栏/命令面板共用）
  const importFile = () => {
    storage
      .importContentFile()
      .then((file) => {
        if (file) {
          placeContentFrame(file.name, file.text);
        }
      })
      .catch((err) => toast(`导入失败：${err}`));
  };
  // 拖拽导入：桌面走 Tauri rawDrop（File 对象免 fs scope），浏览器走原生 drop
  async function bindFileDrop() {
    if (isDesktop()) {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload as {
          type?: string;
          paths?: unknown[];
        };
        if (payload.type === "drop" && payload.paths) {
          for (const f of payload.paths) {
            if (f instanceof File) {
              void handleDroppedFile(f);
            }
          }
        }
      });
    } else {
      window.addEventListener("dragover", (e) => e.preventDefault());
      window.addEventListener("drop", (e) => {
        e.preventDefault();
        const files = e.dataTransfer?.files;
        if (!files) {
          return;
        }
        for (const file of files) {
          if (file.size > 5 * 1024 * 1024) {
            toast(`文件过大（>5MB）：${file.name}`);
            continue;
          }
          void handleDroppedFile(file);
        }
      });
    }
  }
  void bindFileDrop();

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
    onImport: importFile,
    onInsertImage: insertImage,
    onExport: () => exportDialog.open(),
    onToggleAI: () => toggleAiPanel(),
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
  // 自动保存成功轻提示（失败走 toast，成功走这里形成安全闭环）
  storage.onSaved = () => statusBar.flashSaved();
  // 选区尺寸：选中变化与画布变更时刷新状态栏 W×H
  syncSelectionSize = () => statusBar.setSelectionSize(board.getSelectionSize());

  // AI 助手面板（交流 + 编辑双模式）懒加载工厂；配置缺失时唤起设置弹窗并定位到模型页签。
  // 创建时兜底同步当前项目对话分桶，并接管「面板开合 → 圆形栏激活态/状态栏避让/浮层互斥」联动
  let aiPanelLoading: Promise<AiPanel> | null = null;
  const ensureAiPanel = (): Promise<AiPanel> => {
    if (aiPanel) {
      return Promise.resolve(aiPanel);
    }
    aiPanelLoading ??= import("./ai/panel").then((m) => {
      const panel = new m.AiPanel(board, registry, toolbar, () => settingsDialog.open("model"));
      panel.setProject(storage.current?.id ?? "");
      aiPanel = panel;
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
      return panel;
    });
    return aiPanelLoading;
  };
  const toggleAiPanelImpl = () => {
    void ensureAiPanel()
      .then((p) => p.toggle())
      .catch((err) => toast(`AI 面板加载失败：${err}`));
  };
  toggleAiPanel = toggleAiPanelImpl;

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
      // 内置/自定义工具统一显示生效键（配置优先，否则注册表键；无快捷键的工具不显示）
      hint: formatCombo(shortcuts.toolKeys(t)[0] ?? ""),
      keywords: `${t.kind} ${t.group ?? ""} ${t.source}`,
      run: () => {
        board.setTool(t.id);
        toolbar.setTool(t.id);
        refreshSelectionBar(lastSelectionInfo);
      },
    })),
    {
      id: "open",
      section: "操作",
      title: "打开文件",
      icon: "folder",
      hint: formatCombo(shortcuts.getKeys("open")[0]),
      run: () => storage.openFromFile().catch((err) => toast(`打开失败：${err}`)),
    },
    {
      id: "save",
      section: "操作",
      title: "保存文件",
      icon: "save",
      hint: formatCombo(shortcuts.getKeys("save")[0]),
      run: () => storage.saveToFile().catch((err) => toast(`保存失败：${err}`)),
    },
    { id: "image", section: "操作", title: "插入图片", icon: "image", run: insertImage },
    {
      id: "import",
      section: "操作",
      title: "导入文件（内容框架）",
      icon: "file",
      keywords: "MD Markdown 代码 文本 导入",
      run: importFile,
    },
    {
      id: "export",
      section: "操作",
      title: "导出画布",
      icon: "download",
      keywords: "PNG SVG 图片 矢量",
      run: () => exportDialog.open(),
    },
    {
      id: "copyImage",
      section: "操作",
      title: "复制画布图片到剪贴板",
      icon: "clipboard",
      keywords: "clipboard 剪贴板 粘贴 复制图片",
      run: () => {
        if (board.elementCount === 0) {
          toast("画布是空的");
          return;
        }
        storage
          .exportPNGClipboard()
          .then((ok) => {
            toast(ok ? "📋 已复制画布图片，可直接粘贴" : "复制失败：浏览器不支持或权限被拒");
          })
          .catch(() => toast("复制失败"));
      },
    },
    {
      id: "projects",
      section: "操作",
      title: "项目管理",
      icon: "folder",
      keywords: "项目 切换 重命名",
      run: () => projectDialog.open(),
    },
    {
      id: "settings",
      section: "操作",
      title: "设置",
      icon: "settings",
      keywords: "AI 模型 主题 网格 提示词",
      run: () => settingsDialog.open(),
    },
    {
      id: "ai",
      section: "操作",
      title: "AI 助手",
      icon: "bot",
      hint: formatCombo(shortcuts.getKeys("aiPanel")[0]),
      run: () => toggleAiPanel(),
    },
    { id: "clear", section: "操作", title: "清空画布", icon: "trash", run: clearCanvas },
    {
      id: "theme-dark",
      section: "操作",
      title: "主题：深色",
      icon: "moon",
      keywords: "dark 深色",
      run: () => setThemePref("dark"),
    },
    {
      id: "theme-light",
      section: "操作",
      title: "主题：浅色",
      icon: "sun",
      keywords: "light 浅色",
      run: () => setThemePref("light"),
    },
    {
      id: "theme-system",
      section: "操作",
      title: "主题：跟随系统",
      icon: "monitor",
      keywords: "system 自动",
      run: () => setThemePref("system"),
    },
    {
      id: "shortcuts",
      section: "操作",
      title: "快捷键帮助",
      icon: "keyboard",
      keywords: "help 帮助",
      run: () => showShortcutHelp(getShortcutHelpRows(registry, shortcuts)),
    },
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
    toFrame: () => {
      if (!board.toFrame()) {
        toast("请单选一个未锁定的矩形转为框架");
      }
    },
    toRect: () => {
      if (!board.toRect()) {
        toast("请单选一个未锁定的框架转为矩形");
      }
    },
    toggleFrameConstrain: () => {
      if (!board.frameActionState().canToRect) {
        toast("请单选一个未锁定的框架");
        return;
      }
      board.toggleFrameConstrain();
      toast(
        board.frameActionState().constrainOn
          ? "已开启内容约束：框内绘制/拖动将被夹紧（按住 Alt 可拖出）"
          : "已关闭内容约束",
      );
    },
    toggleFrameCollapse: () => {
      if (!board.frameActionState().canCollapse) {
        toast("请单选一个内容超高的内容框架");
        return;
      }
      board.toggleFrameCollapsed();
      toast(
        board.frameActionState().collapsedOn
          ? "已折叠内容：滚轮在框架上滚动查看"
          : "已展开全部内容",
      );
    },
    toggleFrameFocus: () => {
      if (!board.frameActionState().canFocus) {
        toast("请单选一个未锁定的框架");
        return;
      }
      board.toggleFrameFocus();
      toast(
        board.frameActionState().focusOn ? "已聚焦框架：视口放大到框架" : "已退出聚焦，恢复原视图",
      );
    },
  };
  contextMenu.onAction((action) => MENU_ACTIONS[action]());

  // 悬浮内容互斥管理：关闭所有浮层（右键菜单/分组下拉/样式浮层/右侧面板）
  const closeAllFloating = () => {
    contextMenu.close();
    toolbar.closeMenus();
    selectionBar.hidePopover();
    toolsFloat.collapse();
  };
  const nudgeOrToast = (dx: number, dy: number) => {
    if (!board.nudgeSelected(dx, dy)) {
      toast("没有选中的元素");
    }
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
    bold: () => board.toggleBold(),
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
    aiPanel: () => toggleAiPanel(),
    zoomIn: () => board.zoomIn(),
    zoomOut: () => board.zoomOut(),
    zoomReset: () => board.zoomReset(),
    // 方向键微移（1px；按住方向键由系统重复连续移动）
    nudgeUp: () => nudgeOrToast(0, -1),
    nudgeDown: () => nudgeOrToast(0, 1),
    nudgeLeft: () => nudgeOrToast(-1, 0),
    nudgeRight: () => nudgeOrToast(1, 0),
    // 缩放适配：定位选中/全部内容，大画布不再盲逛
    zoomFitSelection: () => {
      if (!board.zoomToFitSelection()) {
        toast("请先选中元素");
      }
    },
    zoomFitAll: () => {
      if (!board.zoomToFitAll()) {
        toast("画布是空的");
      }
    },
    // 橡皮半径步进（[ ] 键）
    eraserSmaller: () => board.adjustEraserRadius(-2),
    eraserBigger: () => board.adjustEraserRadius(2),
  };
  // ---- 长按临时橡皮：按住快捷键借用橡皮，松手还原原工具；快拍则持久选中 ----
  const ERASER_HOLD_MS = 250;
  let eraserHold: { prevTool: string; start: number } | null = null;
  const switchTool = (tool: string) => {
    board.setTool(tool);
    toolbar.setTool(tool);
    refreshSelectionBar(lastSelectionInfo);
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
    if (id === "tool:eraser") {
      // 长按临时橡皮：按住借用橡皮擦除，松手回到原工具；
      // 快拍（<250ms 未产生擦除）视为常规切换，持久选中橡皮
      if (!eraserHold && board.currentTool !== "eraser" && !e.repeat) {
        eraserHold = { prevTool: board.currentTool, start: Date.now() };
        switchTool("eraser");
      }
      return;
    }
    if (id.startsWith("tool:")) {
      switchTool(id.slice("tool:".length));
      return;
    }
    ACTION_HANDLERS[id]?.();
  });
  // 松开橡皮快捷键：按住使用过则还原原工具；手势进行中不切换（避免打断撤销合成）
  window.addEventListener("keyup", (e) => {
    if (!eraserHold || isEditableTarget(e.target)) {
      return;
    }
    const combo = comboFromEvent(e);
    if (keymap[combo] !== "tool:eraser") {
      return;
    }
    const held = eraserHold;
    eraserHold = null;
    if (board.isErasing) {
      // 正在拖拽擦除：保持橡皮，本次不还原
      return;
    }
    if (Date.now() - held.start >= ERASER_HOLD_MS) {
      const prev = held.prevTool;
      if (prev && prev !== "eraser") {
        switchTool(prev);
      }
    }
    // 快拍：保持橡皮选中（与旧版单击 E 行为一致）
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

  // AI 面板开合同步已移入懒加载工厂（创建时挂 MutationObserver）

  // 项目恢复（多项目：初始化迁移旧数据并载入激活项目场景）
  const restored = await storage.init();
  statusBar.setProject(storage.current?.name ?? "");
  // AI 面板懒加载：对话分桶由工厂创建时按当前项目恢复，启动时无需加载
  // 压入会话基线快照：保证本会话首个操作（含 AI 画的流程图）可直接撤销
  board.pushSnapshot(board.serialize());
  statusBar.setUndoRedo(board.canUndo, board.canRedo);
  updateStatus();
  // 顶部填充开关与样式按钮圆点对齐默认样式
  toolbar.setFill(style.fillEnabled);
  toolbar.setStyleColor(style.stroke);
  toast(restored ? `已恢复项目「${storage.current?.name ?? ""}」的画布` : "欢迎使用 Miniboard");
}

void main();
