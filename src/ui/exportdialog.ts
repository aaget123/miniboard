import { iconHTML, type IconName } from "./icons";

/** 导出格式：PNG 位图 / SVG 矢量图 */
export type ExportFormat = "png" | "svg";

/**
 * 导出弹窗：统一导出入口（右侧悬浮栏与命令面板共用），
 * 选择格式后由宿主执行实际导出，避免导出按钮分散在多处。
 */
export class ExportDialog {
  private mask!: HTMLElement;
  private onExportFn: (fmt: ExportFormat) => void = () => {};

  constructor(host: HTMLElement) {
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
    modal.className = "ai-modal export-modal";
    this.mask.appendChild(modal);

    const title = document.createElement("h3");
    title.textContent = "导出";
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

    const hint = document.createElement("div");
    hint.className = "ai-modal-hint";
    hint.textContent =
      "PNG 为位图，适合分享与插入文档；SVG 为矢量图，可无损缩放。";
    modal.appendChild(hint);

    const options = document.createElement("div");
    options.className = "export-options";
    const OPTIONS: { fmt: ExportFormat; icon: IconName; label: string; desc: string }[] = [
      { fmt: "png", icon: "camera", label: "PNG 图片", desc: "位图，适合分享与插入文档" },
      { fmt: "svg", icon: "file", label: "SVG 矢量图", desc: "矢量，可无损缩放" },
    ];
    for (const opt of OPTIONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "export-option";
      const icon = document.createElement("span");
      icon.className = "export-option-icon";
      icon.innerHTML = iconHTML(opt.icon, 20);
      const info = document.createElement("span");
      info.className = "export-option-info";
      const name = document.createElement("span");
      name.className = "export-option-name";
      name.textContent = opt.label;
      const desc = document.createElement("span");
      desc.className = "export-option-desc";
      desc.textContent = opt.desc;
      info.append(name, desc);
      btn.append(icon, info);
      btn.addEventListener("click", () => {
        this.mask.hidden = true;
        this.onExportFn(opt.fmt);
      });
      options.appendChild(btn);
    }
    modal.appendChild(options);

    const actions = document.createElement("div");
    actions.className = "ai-modal-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "tool-btn";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", () => {
      this.mask.hidden = true;
    });
    actions.appendChild(cancelBtn);
    modal.appendChild(actions);

    host.appendChild(this.mask);
    this.mask.hidden = true;
  }

  open() {
    this.mask.hidden = false;
  }

  /** 注册格式选择回调（由宿主执行实际导出与提示） */
  onExport(fn: (fmt: ExportFormat) => void) {
    this.onExportFn = fn;
  }
}
