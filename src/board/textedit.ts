/**
 * 文本编辑浮层：在画布上方覆盖一个 textarea，用于新建/编辑文本元素。
 * 定位使用 leafer 的 inner 坐标（相对画布元素左上），全屏画布下与视口坐标一致。
 */
export class TextOverlay {
  private el: HTMLDivElement;
  private ta: HTMLTextAreaElement;
  private onSubmit: ((text: string) => void) | null = null;
  private onCancel: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.el = container.querySelector("#text-editor") as HTMLDivElement;
    this.ta = this.el.querySelector("textarea") as HTMLTextAreaElement;

    this.ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.cancel();
      }
    });

    this.ta.addEventListener("blur", () => {
      this.commit();
    });
  }

  open(opts: {
    innerX: number;
    innerY: number;
    initialText: string;
    fontSize: number;
    onSubmit: (text: string) => void;
    onCancel?: () => void;
  }) {
    this.onSubmit = opts.onSubmit;
    this.onCancel = opts.onCancel ?? null;

    this.el.style.left = `${opts.innerX}px`;
    this.el.style.top = `${opts.innerY}px`;
    this.ta.style.fontSize = `${opts.fontSize}px`;
    this.ta.value = opts.initialText;
    this.el.hidden = false;
    this.el.style.display = "block";
    this.ta.focus();
    this.ta.select();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  private commit() {
    if (this.el.hidden) {
      return;
    }
    const text = this.ta.value.trim();
    this.close();
    if (text) {
      this.onSubmit?.(text);
    }
  }

  private cancel() {
    if (this.el.hidden) {
      return;
    }
    this.close();
    this.onCancel?.();
  }

  close() {
    this.el.hidden = true;
    this.el.style.display = "none";
    this.onSubmit = null;
    this.onCancel = null;
  }
}
