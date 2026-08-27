import type { ToolRegistry } from "../board/registry";
import { showConfirm } from "./confirm";
import { SHORTCUT_ACTIONS, comboFromEvent, formatCombo, formatKeys } from "./shortcuts";
import type { ShortcutManager } from "./shortcuts";

/**
 * 「快捷键」页签控制器：操作区 + 内置工具键位的展示与录制修改
 * （AI 自定义工具键只读，指向 AI 工具页签）。内容由 refresh() 全量重建。
 */
export class ShortcutsPaneController {
  private manager: ShortcutManager | null = null;
  private recordingId: string | null = null;
  private recordingHandler: ((e: KeyboardEvent) => void) | null = null;

  /** root 为快捷键页签的内容挂载点；registry 提供工具行（含 AI 工具只读行） */
  constructor(
    private readonly root: HTMLElement,
    private readonly registry: ToolRegistry,
  ) {}

  /** 快捷键配置中心注入（main.ts 创建；AI 工具键仍由注册表维护） */
  setSource(manager: ShortcutManager) {
    this.manager = manager;
    this.refresh();
  }

  /** 重建「快捷键」页签：操作区 + 工具区 */
  refresh() {
    const sm = this.manager;
    this.root.innerHTML = "";
    const section = document.createElement("section");
    section.className = "settings-section";
    const label = document.createElement("h4");
    label.className = "settings-label";
    label.textContent = "快捷键";
    const hint = document.createElement("p");
    hint.className = "settings-hint";
    hint.textContent =
      "点击「修改」后按下新组合键立即生效；Esc 取消录制。AI 自定义工具快捷键请在「AI 工具」页签编辑。";
    const head = document.createElement("div");
    head.className = "sc-head";
    const resetAll = document.createElement("button");
    resetAll.type = "button";
    resetAll.className = "data-dir-btn";
    resetAll.textContent = "恢复全部默认";
    resetAll.addEventListener("click", () => {
      // 应用内弹窗替代 window.confirm：WKWebView 等环境同步对话框静默失败
      void showConfirm({
        title: "恢复默认快捷键",
        message: "确定恢复全部默认快捷键？",
        confirmLabel: "恢复",
      }).then((ok) => {
        if (ok) {
          sm?.resetAll();
          this.refresh();
        }
      });
    });
    head.appendChild(resetAll);
    section.append(label, hint, head);
    section.appendChild(this.groupTitle("操作"));
    if (!sm) {
      section.appendChild(this.row("", "快捷键配置不可用", [], false, false));
    } else {
      for (const a of SHORTCUT_ACTIONS) {
        section.appendChild(
          this.row(a.id, a.label, sm.getKeys(a.id), true, this.recordingId === a.id),
        );
      }
      section.appendChild(this.groupTitle("工具"));
      for (const t of this.registry.list()) {
        const custom = t.source === "custom";
        section.appendChild(
          this.row(
            `tool:${t.id}`,
            `${t.name}${custom ? "（AI）" : ""}`,
            sm.toolKeys(t),
            !custom,
            this.recordingId === `tool:${t.id}`,
          ),
        );
      }
    }
    this.root.appendChild(section);
  }

  /** 快捷键分组小标题 */
  private groupTitle(text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "sc-group-title";
    el.textContent = text;
    return el;
  }

  /** 快捷键行：名称 + 当前键位（kbd）+ 修改/设置按钮；editable=false 时按钮禁用 */
  private row(
    id: string,
    name: string,
    keys: string[],
    editable: boolean,
    editing: boolean,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "sc-row";
    const nameEl = document.createElement("span");
    nameEl.className = "sc-name";
    nameEl.textContent = name;
    const keysEl = document.createElement("kbd");
    keysEl.className = editing ? "sc-keys sc-recording" : "sc-keys";
    keysEl.textContent = editing ? "按下新快捷键…" : keys.length ? formatKeys(keys) : "未设置";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "data-dir-btn sc-btn";
    if (!editable) {
      btn.disabled = true;
      btn.textContent = "AI 页签编辑";
    } else if (editing) {
      btn.textContent = "取消";
      btn.addEventListener("click", () => this.cancelRecord());
    } else {
      btn.textContent = keys.length ? "修改" : "设置";
      btn.addEventListener("click", () => this.beginRecord(id));
    }
    row.append(nameEl, keysEl, btn);
    return row;
  }

  /** 开始录制：捕获阶段监听 keydown（先于全局快捷键处理，阻止误触发） */
  private beginRecord(id: string) {
    if (this.recordingId) {
      this.cancelRecord();
    }
    this.recordingId = id;
    this.recordingHandler = (e) => this.onRecordKey(e);
    window.addEventListener("keydown", this.recordingHandler, { capture: true });
    this.refresh();
  }

  /** 取消录制（Esc 或点击取消按钮） */
  private cancelRecord() {
    if (this.recordingHandler) {
      window.removeEventListener("keydown", this.recordingHandler, true);
      this.recordingHandler = null;
    }
    this.recordingId = null;
    this.refresh();
  }

  /** 录制键位：捕获组合键 → 冲突检测 → 确认后写入配置并重建 keymap */
  private onRecordKey(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    const id = this.recordingId;
    const sm = this.manager;
    if (!id || !sm) {
      this.cancelRecord();
      return;
    }
    if (e.key === "Escape") {
      this.cancelRecord();
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) {
      return; // 纯修饰键：继续等待完整组合
    }
    const clash = sm.findConflict(combo, id, this.registry);
    const apply = () => {
      if (clash) {
        // 被挤占的是配置项（操作/内置工具）时恢复其默认键；AI 工具键不在配置层，仅失效提示
        const toolId = clash.id.startsWith("tool:") ? clash.id.slice(5) : null;
        const isCustomTool = toolId !== null && this.registry.getTool(toolId)?.source === "custom";
        if (!isCustomTool) {
          sm.restoreDefault(clash.id);
        }
      }
      sm.setKeys(id, [combo]);
      this.cancelRecord();
    };
    if (clash) {
      // 应用内弹窗替代 window.confirm：WKWebView 等环境同步对话框静默失败
      void showConfirm({
        title: "快捷键冲突",
        message: `快捷键 ${formatCombo(combo)} 已被${clash.label}占用，确定覆盖？`,
        confirmLabel: "覆盖",
        danger: true,
      }).then((ok) => {
        if (ok) {
          apply();
        }
      });
    } else {
      apply();
    }
  }
}
