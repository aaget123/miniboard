import type { ToolType } from "../types";

export const SWATCHES = [
  "#e03131",
  "#e8590c",
  "#f08c00",
  "#fab005",
  "#40c057",
  "#12b886",
  "#1098ad",
  "#1c7ed6",
  "#4f8cff",
  "#7048e8",
  "#9c36b5",
  "#e64980",
  "#ffffff",
  "#adb5bd",
  "#495057",
  "#000000",
];

const TOOLS: { tool: ToolType; icon: string; title: string }[] = [
  { tool: "select", icon: "↖", title: "选择 (V)" },
  { tool: "pen", icon: "✏", title: "画笔 (P)" },
  { tool: "line", icon: "╱", title: "直线 (L)" },
  { tool: "arrow", icon: "→", title: "箭头 (A)" },
  { tool: "rect", icon: "▭", title: "矩形 (R)" },
  { tool: "ellipse", icon: "◯", title: "椭圆 (O)" },
  { tool: "text", icon: "T", title: "文本 (T)" },
];

export type ToolbarHandlers = {
  onTool: (tool: ToolType) => void;
  onUndo: () => void;
  onRedo: () => void;
  onBeautify: () => void;
  onOpen: () => void;
  onSave: () => void;
  onExport: () => void;
  onClear: () => void;
  onStrokeChange: (color: string) => void;
  onWidthChange: (width: number) => void;
  onFillChange: (enabled: boolean) => void;
};

function makeButton(
  icon: string,
  title: string,
  onClick: () => void,
  cls = "tool-btn",
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = cls;
  btn.title = title;
  btn.textContent = icon;
  btn.addEventListener("click", onClick);
  return btn;
}

export class Toolbar {
  private toolButtons = new Map<ToolType, HTMLButtonElement>();
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private swatches = new Map<string, HTMLDivElement>();
  private colorInput!: HTMLInputElement;
  private widthInput!: HTMLInputElement;
  private fillBtn!: HTMLButtonElement;

  constructor(container: HTMLElement, handlers: ToolbarHandlers) {
    const toolGroup = document.createElement("div");
    toolGroup.className = "tool-group";
    for (const t of TOOLS) {
      const btn = makeButton(t.icon, t.title, () => handlers.onTool(t.tool));
      toolGroup.appendChild(btn);
      this.toolButtons.set(t.tool, btn);
    }

    const editGroup = document.createElement("div");
    editGroup.className = "tool-group";
    this.undoBtn = makeButton("↩", "撤销 (Ctrl+Z)", () => handlers.onUndo());
    this.redoBtn = makeButton("↪", "重做 (Ctrl+Y)", () => handlers.onRedo());
    editGroup.append(this.undoBtn, this.redoBtn);

    const beautifyBtn = makeButton(
      "✨ 整理",
      "一键美化：对齐、间距、配色、容器包裹",
      () => handlers.onBeautify(),
      "tool-btn beautify",
    );

    const fileGroup = document.createElement("div");
    fileGroup.className = "tool-group";
    fileGroup.append(
      makeButton("📂", "打开文件 (Ctrl+O)", () => handlers.onOpen()),
      makeButton("💾", "保存文件 (Ctrl+S)", () => handlers.onSave()),
      makeButton("🖼", "导出 PNG 图片", () => handlers.onExport()),
      makeButton("🗑", "清空画布", () => handlers.onClear()),
    );

    container.append(toolGroup, editGroup, beautifyBtn, fileGroup);

    // ---- 样式面板 ----
    const panel = document.createElement("div");
    panel.id = "panel";

    const label = document.createElement("span");
    label.className = "panel-label";
    label.textContent = "颜色";
    panel.appendChild(label);

    const swatches = document.createElement("div");
    swatches.className = "swatches";
    for (const c of SWATCHES) {
      const s = document.createElement("div");
      s.className = "swatch";
      s.style.background = c;
      s.title = c;
      s.addEventListener("click", () => handlers.onStrokeChange(c));
      swatches.appendChild(s);
      this.swatches.set(c, s);
    }
    panel.appendChild(swatches);

    this.colorInput = document.createElement("input");
    this.colorInput.type = "color";
    this.colorInput.value = "#4f8cff";
    this.colorInput.title = "自定义颜色";
    this.colorInput.addEventListener("input", () =>
      handlers.onStrokeChange(this.colorInput.value),
    );
    panel.appendChild(this.colorInput);

    const sep = document.createElement("div");
    sep.className = "tool-sep";
    panel.appendChild(sep);

    const widthLabel = document.createElement("span");
    widthLabel.className = "panel-label";
    widthLabel.textContent = "粗细";
    panel.appendChild(widthLabel);

    this.widthInput = document.createElement("input");
    this.widthInput.id = "stroke-width";
    this.widthInput.type = "range";
    this.widthInput.min = "1";
    this.widthInput.max = "12";
    this.widthInput.step = "1";
    this.widthInput.value = "2";
    this.widthInput.addEventListener("input", () =>
      handlers.onWidthChange(Number(this.widthInput.value)),
    );
    panel.appendChild(this.widthInput);

    this.fillBtn = makeButton("⬛ 填充", "填充开/关", () => {
      const next = !this.fillBtn.classList.contains("active");
      this.fillBtn.classList.toggle("active", next);
      handlers.onFillChange(next);
    });
    panel.appendChild(this.fillBtn);

    container.appendChild(panel);

    this.setTool("select");
    this.setStroke("#4f8cff");
  }

  setTool(tool: ToolType) {
    for (const [t, btn] of this.toolButtons) {
      btn.classList.toggle("active", t === tool);
    }
  }

  setUndoRedo(canUndo: boolean, canRedo: boolean) {
    this.undoBtn.classList.toggle("disabled", !canUndo);
    this.redoBtn.classList.toggle("disabled", !canRedo);
  }

  setStroke(color: string) {
    for (const [c, el] of this.swatches) {
      el.classList.toggle("active", c.toLowerCase() === color.toLowerCase());
    }
    this.colorInput.value = color;
  }

  setWidth(width: number) {
    this.widthInput.value = String(width);
  }

  setFill(enabled: boolean) {
    this.fillBtn.classList.toggle("active", enabled);
  }
}
