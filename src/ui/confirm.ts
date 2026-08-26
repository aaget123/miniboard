/**
 * 应用内确认弹窗（window.confirm 替代品）：
 * - Tauri 的 WKWebView 等环境不支持同步 JS 对话框（confirm 会静默返回 false，
 *   危险操作无法进行、AI 批量确认闸门形同虚设），统一改用应用内实现；
 * - Promise 语义：`await showConfirm(...)` 即用户是否确认，调用方无需改造
 *   异步流程；每次调用创建独立遮罩，关闭即销毁，无跨调用状态。
 */
export interface ConfirmOptions {
  /** 弹窗标题（缺省「请确认」） */
  title?: string;
  /** 正文说明 */
  message: string;
  /** 确认按钮文案（缺省「确定」） */
  confirmLabel?: string;
  /** 取消按钮文案（缺省「取消」） */
  cancelLabel?: string;
  /** 危险操作：确认按钮呈警示色（清空/删除类动作） */
  danger?: boolean;
}

export function showConfirm(opts: ConfirmOptions | string): Promise<boolean> {
  const o: ConfirmOptions = typeof opts === "string" ? { message: opts } : opts;
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "ai-modal-mask";
    const modal = document.createElement("div");
    modal.className = "ai-modal confirm-modal";
    mask.appendChild(modal);

    const title = document.createElement("h3");
    title.textContent = o.title ?? "请确认";
    modal.appendChild(title);

    const message = document.createElement("div");
    message.className = "confirm-message";
    message.textContent = o.message;
    modal.appendChild(message);

    let settled = false;
    const done = (v: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener("keydown", onKey, true);
      mask.remove();
      resolve(v);
    };

    const actions = document.createElement("div");
    actions.className = "ai-modal-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "tool-btn";
    cancelBtn.textContent = o.cancelLabel ?? "取消";
    cancelBtn.addEventListener("click", () => done(false));
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = o.danger ? "tool-btn confirm-btn-danger" : "tool-btn ai-modal-save";
    okBtn.textContent = o.confirmLabel ?? "确定";
    okBtn.addEventListener("click", () => done(true));
    actions.append(cancelBtn, okBtn);
    modal.appendChild(actions);

    // Esc=取消、Enter=确认（capture 捕获段处理，抢在页面级快捷键之前）
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        done(true);
      }
    };
    window.addEventListener("keydown", onKey, true);

    document.body.appendChild(mask);
    okBtn.focus();
  });
}
