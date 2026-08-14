import { SWATCHES } from "./toolbar";

export type SelectionBarHandlers = {
  /** 局部整理：识别选中手绘笔迹并完善为标准图形/拉直 */
  onBeautify: () => void;
  /** 手绘风格：选中标准图形转 rough.js 手绘外观 */
  onSketchify: () => void;
  onStrokeChange: (color: string) => void;
  onFillColorChange: (color: string) => void;
  onWidthChange: (width: number) => void;
};

function makeButton(
  icon: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "tool-btn sel-btn";
  btn.title = title;
  btn.textContent = icon;
  btn.addEventListener("click", onClick);
  return btn;
}

/**
 * 左侧悬浮工具栏：选中元素时出现（Excalidraw 同款）。
 * 操作组：✨ 整理 / ✎ 手绘；样式组：🎨 样式浮层（描边/填充色板 + 粗细）。
 * 填充开关不在此栏（由顶部常驻工具栏的 ⬛ 填充按钮统一负责，选中元素时同样生效）。
 * 未选中时整体隐藏。
 */
export class SelectionBar {
  private bar: HTMLElement;
  private popover: HTMLElement;
  // 描边/填充双通道：色板与取色器作用于激活通道
  private activeChannel: "stroke" | "fill" = "stroke";
  private strokeChannelBtn!: HTMLButtonElement;
  private fillChannelBtn!: HTMLButtonElement;
  private strokeChannelColor = "#4f8cff";
  private fillChannelColor = "#4f8cff";
  private swatches = new Map<string, HTMLDivElement>();
  private colorInput!: HTMLInputElement;
  private widthInput!: HTMLInputElement;
  private styleBtn!: HTMLButtonElement;

  constructor(
    container: HTMLElement,
    handlers: SelectionBarHandlers,
  ) {
    this.bar = document.createElement("div");
    this.bar.id = "selection-bar";
    this.bar.hidden = true;

    this.bar.append(
      makeButton("✨", "整理选中：识别手绘笔迹并完善为标准图形/拉直", () =>
        handlers.onBeautify(),
      ),
      makeButton("✎", "手绘风格：选中图形转手绘外观（rough.js）", () =>
        handlers.onSketchify(),
      ),
    );
    const sep = document.createElement("div");
    sep.className = "tool-sep";
    this.bar.appendChild(sep);
    this.styleBtn = makeButton("🎨", "样式：描边/填充颜色与粗细", () =>
      this.togglePopover(),
    );
    this.bar.appendChild(this.styleBtn);
    container.appendChild(this.bar);

    // ---- 样式浮层（色板 + 取色器 + 粗细）----
    this.popover = document.createElement("div");
    this.popover.id = "style-popover";
    this.popover.hidden = true;

    const channelGroup = document.createElement("div");
    channelGroup.className = "channel-group";
    this.strokeChannelBtn = this.makeChannelBtn("描边", () =>
      this.setChannel("stroke"),
    );
    this.fillChannelBtn = this.makeChannelBtn("填充", () =>
      this.setChannel("fill"),
    );
    channelGroup.append(this.strokeChannelBtn, this.fillChannelBtn);
    this.popover.appendChild(channelGroup);

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
    this.popover.appendChild(swatches);

    const row = document.createElement("div");
    row.className = "style-row";
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
    const widthLabel = document.createElement("span");
    widthLabel.className = "panel-label";
    widthLabel.textContent = "粗细";
    this.widthInput = document.createElement("input");
    this.widthInput.type = "range";
    this.widthInput.min = "1";
    this.widthInput.max = "12";
    this.widthInput.step = "1";
    this.widthInput.value = "2";
    this.widthInput.addEventListener("input", () =>
      handlers.onWidthChange(Number(this.widthInput.value)),
    );
    row.append(this.colorInput, widthLabel, this.widthInput);
    this.popover.appendChild(row);
    document.body.appendChild(this.popover);

    // 点击浮层外部关闭
    document.addEventListener("pointerdown", (e) => {
      if (this.popover.hidden) {
        return;
      }
      if (
        !this.popover.contains(e.target as Node) &&
        e.target !== this.styleBtn
      ) {
        this.hidePopover();
      }
    });

    this.setChannel("stroke");
  }

  /** 选中变化：有选中元素时显示，无选中隐藏（同时收起浮层） */
  show(hasSelection: boolean) {
    this.bar.hidden = !hasSelection;
    if (!hasSelection) {
      this.hidePopover();
    }
  }

  private togglePopover() {
    this.popover.hidden = !this.popover.hidden;
    if (!this.popover.hidden) {
      const r = this.bar.getBoundingClientRect();
      this.popover.style.left = `${r.left + r.width + 8}px`;
      this.popover.style.top = `${r.top}px`;
    }
  }

  private hidePopover() {
    this.popover.hidden = true;
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

  setWidth(width: number) {
    this.widthInput.value = String(width);
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
}
