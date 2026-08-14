import type { ToolRegistry } from "../board/registry";

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



export type ToolbarHandlers = {
  onTool: (tool: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onBeautify: () => void;
  /** 选中图形应用手绘风格（rough.js） */
  onSketchify: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onOpen: () => void;
  onSave: () => void;
  onExport: () => void;
  onClear: () => void;
  onInsertImage: () => void;
  /** 打开/关闭 AI 助手面板 */
  onToggleAI: () => void;
  onStrokeChange: (color: string) => void;
  /** 填充通道：色板点击时应用独立填充颜色 */
  onFillColorChange: (color: string) => void;
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
  private toolButtons = new Map<string, HTMLButtonElement>();
  private toolGroup: HTMLDivElement;
  /** 当前激活工具（refresh 重渲染时保留） */
  private activeToolId = "select";
  private handlers: ToolbarHandlers;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private swatches = new Map<string, HTMLDivElement>();
  private colorInput!: HTMLInputElement;
  private widthInput!: HTMLInputElement;
  private fillBtn!: HTMLButtonElement;
  // 描边/填充双通道：色板点击作用于当前激活通道
  private activeChannel: "stroke" | "fill" = "stroke";
  private strokeChannelBtn!: HTMLButtonElement;
  private fillChannelBtn!: HTMLButtonElement;
  private strokeChannelColor = "#4f8cff";
  private fillChannelColor = "#4f8cff";

  constructor(
    container: HTMLElement,
    private registry: ToolRegistry,
    handlers: ToolbarHandlers,
  ) {
    this.handlers = handlers;
    this.toolGroup = document.createElement("div");
    this.toolGroup.className = "tool-group";
    this.renderTools();

    const editGroup = document.createElement("div");
    editGroup.className = "tool-group";
    this.undoBtn = makeButton("↩", "撤销 (Ctrl+Z)", () => handlers.onUndo());
    this.redoBtn = makeButton("↪", "重做 (Ctrl+Y)", () => handlers.onRedo());
    editGroup.append(this.undoBtn, this.redoBtn);

    const beautifyBtn = makeButton(
      "✨ 整理",
      "智能整理：识别手绘形状并完善为标准图形（圆/椭圆/矩形/多边形/直线）",
      () => handlers.onBeautify(),
      "tool-btn beautify",
    );

    const sketchBtn = makeButton(
      "✎ 手绘",
      "手绘风格：选中图形转手绘外观（rough.js，可复现）",
      () => handlers.onSketchify(),
      "tool-btn sketch",
    );

    const zoomGroup = document.createElement("div");
    zoomGroup.className = "tool-group";
    zoomGroup.append(
      makeButton("−", "缩小 (Ctrl+−)", () => handlers.onZoomOut()),
      makeButton("100%", "重置为 100% (Ctrl+0)", () => handlers.onZoomReset()),
      makeButton("＋", "放大 (Ctrl+＋)", () => handlers.onZoomIn()),
    );

    const fileGroup = document.createElement("div");
    fileGroup.className = "tool-group";
    fileGroup.append(
      makeButton("📂", "打开文件 (Ctrl+O)", () => handlers.onOpen()),
      makeButton("💾", "保存文件 (Ctrl+S)", () => handlers.onSave()),
      makeButton("🖻", "插入图片", () => handlers.onInsertImage()),
      makeButton("🖼", "导出 PNG 图片", () => handlers.onExport()),
      makeButton("🗑", "清空画布", () => handlers.onClear()),
      makeButton("🤖", "AI 助手", () => handlers.onToggleAI()),
    );

    container.append(this.toolGroup, editGroup, beautifyBtn, sketchBtn, zoomGroup, fileGroup);

    // ---- 样式面板 ----
    const panel = document.createElement("div");
    panel.id = "panel";

    const label = document.createElement("span");
    label.className = "panel-label";
    label.textContent = "颜色";
    panel.appendChild(label);

    // 描边/填充通道切换：色板与取色器作用于激活通道
    const channelGroup = document.createElement("div");
    channelGroup.className = "channel-group";
    this.strokeChannelBtn = this.makeChannelBtn("描边", () =>
      this.setChannel("stroke"),
    );
    this.fillChannelBtn = this.makeChannelBtn("填充", () =>
      this.setChannel("fill"),
    );
    channelGroup.append(this.strokeChannelBtn, this.fillChannelBtn);
    panel.appendChild(channelGroup);

    const swatches = document.createElement("div");
    swatches.className = "swatches";
    for (const c of SWATCHES) {
      const s = document.createElement("div");
      s.className = "swatch";
      s.style.background = c;
      s.title = c;
      s.addEventListener("click", () => {
        if (this.activeChannel === "fill") {
          handlers.onFillColorChange(c);
        } else {
          handlers.onStrokeChange(c);
        }
      });
      swatches.appendChild(s);
      this.swatches.set(c, s);
    }
    panel.appendChild(swatches);

    this.colorInput = document.createElement("input");
    this.colorInput.type = "color";
    this.colorInput.value = "#4f8cff";
    this.colorInput.title = "自定义颜色";
    this.colorInput.addEventListener("input", () => {
      if (this.activeChannel === "fill") {
        handlers.onFillColorChange(this.colorInput.value);
      } else {
        handlers.onStrokeChange(this.colorInput.value);
      }
    });
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

  /** 按注册表渲染工具按钮（内置 + 自定义），保留当前激活态 */
  private renderTools() {
    this.toolGroup.innerHTML = "";
    this.toolButtons.clear();
    for (const t of this.registry.list()) {
      const btn = makeButton(t.icon, t.title, () => this.handlers.onTool(t.id));
      btn.classList.toggle("active", t.id === this.activeToolId);
      this.toolGroup.appendChild(btn);
      this.toolButtons.set(t.id, btn);
    }
  }

  /** 注册表变化（AI 添加/修改/删除工具）后重渲染工具区；激活工具被删则回退选择工具 */
  refresh() {
    if (!this.registry.getTool(this.activeToolId)) {
      this.activeToolId = "select";
      this.handlers.onTool("select");
    }
    this.renderTools();
  }

  setTool(tool: string) {
    this.activeToolId = tool;
    for (const [t, btn] of this.toolButtons) {
      btn.classList.toggle("active", t === tool);
    }
  }

  setUndoRedo(canUndo: boolean, canRedo: boolean) {
    this.undoBtn.classList.toggle("disabled", !canUndo);
    this.redoBtn.classList.toggle("disabled", !canRedo);
  }

  setStroke(color: string) {
    this.strokeChannelColor = color;
    this.strokeChannelBtn.querySelector<HTMLElement>(".channel-chip")!.style.background = color;
    if (this.activeChannel === "stroke") {
      this.setActiveColor(color);
    }
  }

  /** 更新填充通道颜色（仅激活填充通道时同步色板高亮） */
  setFillColor(color: string) {
    this.fillChannelColor = color;
    this.fillChannelBtn.querySelector<HTMLElement>(".channel-chip")!.style.background = color;
    if (this.activeChannel === "fill") {
      this.setActiveColor(color);
    }
  }

  private setChannel(channel: "stroke" | "fill") {
    this.activeChannel = channel;
    this.strokeChannelBtn.classList.toggle("active", channel === "stroke");
    this.fillChannelBtn.classList.toggle("active", channel === "fill");
    // 切换后色板高亮与取色器跟随当前通道颜色
    this.setActiveColor(
      channel === "stroke" ? this.strokeChannelColor : this.fillChannelColor,
    );
  }

  private setActiveColor(color: string) {
    for (const [c, el] of this.swatches) {
      el.classList.toggle("active", c.toLowerCase() === color.toLowerCase());
    }
    this.colorInput.value = color;
  }

  private makeChannelBtn(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "channel-btn";
    btn.title = `${label}颜色：色板点击作用于${label}色`;
    const chip = document.createElement("span");
    chip.className = "channel-chip";
    chip.style.background = "#4f8cff";
    btn.append(chip, document.createTextNode(label));
    btn.addEventListener("click", onClick);
    return btn;
  }

  setWidth(width: number) {
    this.widthInput.value = String(width);
  }

  setFill(enabled: boolean) {
    this.fillBtn.classList.toggle("active", enabled);
  }
}
