import { allocProfileId, isConfigReady, loadProfiles, saveProfiles } from "../ai/config";
import { testConnection } from "../ai/client";
import type { AiConfig, AiProfile, AiProfileStore } from "../ai/types";
import { showConfirm } from "./confirm";

/**
 * 「AI 模型」页签控制器：多配置注册（名称/地址/Key/模型/多模态），点选激活使用，
 * 支持编辑/删除/新建与连接测试（复用 /models 探测，不可用时自动降级最小请求）。
 * 页签 DOM（配置列表/表单/操作行）由控制器自建并挂到容器内。
 */
export class ModelPaneController {
  private store: AiProfileStore = { activeId: "", profiles: [] };
  /** 表单当前编辑的配置 id；空字符串表示"新建配置" */
  private editingId = "";
  private listEl!: HTMLElement;
  private form!: {
    name: HTMLInputElement;
    base: HTMLInputElement;
    key: HTMLInputElement;
    model: HTMLInputElement;
    vision: HTMLInputElement;
  };
  private formTitleEl!: HTMLElement;
  private testBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private modelListEl!: HTMLElement;
  private deleteBtn!: HTMLButtonElement;

  /** container 为「AI 模型」页签容器 */
  constructor(container: HTMLElement) {
    const aiSection = document.createElement("section");
    aiSection.className = "settings-section";
    const aiLabel = document.createElement("h4");
    aiLabel.className = "settings-label";
    aiLabel.textContent = "AI 模型配置";
    aiSection.appendChild(aiLabel);

    this.listEl = document.createElement("div");
    this.listEl.className = "profile-list";
    aiSection.appendChild(this.listEl);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "tool-btn profile-add";
    addBtn.textContent = "＋ 新建配置";
    addBtn.addEventListener("click", () => this.startNew());
    aiSection.appendChild(addBtn);

    this.formTitleEl = document.createElement("h4");
    this.formTitleEl.className = "settings-label settings-form-title";
    aiSection.appendChild(this.formTitleEl);

    const formEl = document.createElement("div");
    formEl.className = "settings-form";

    const fields: {
      key: "base" | "key" | "model";
      label: string;
      placeholder: string;
      password?: boolean;
    }[] = [
      {
        key: "base",
        label: "接口地址 baseURL",
        placeholder: "https://api.deepseek.com/v1",
      },
      {
        key: "key",
        label: "API Key",
        placeholder: "sk-…",
        password: true,
      },
      {
        key: "model",
        label: "模型名称",
        placeholder: "deepseek-chat",
      },
    ];
    const inputs = new Map<string, HTMLInputElement>();
    const nameInput = document.createElement("input");
    const makeField = (
      labelText: string,
      input: HTMLInputElement,
      placeholder: string,
      password = false,
    ) => {
      const label = document.createElement("label");
      label.className = "ai-modal-label";
      label.textContent = labelText;
      input.type = password ? "password" : "text";
      input.placeholder = placeholder;
      formEl.appendChild(label);
      formEl.appendChild(input);
    };
    makeField("配置名称", nameInput, "如：DeepSeek 官方");
    for (const f of fields) {
      const input = document.createElement("input");
      makeField(f.label, input, f.placeholder, f.password);
      inputs.set(f.key, input);
    }

    // 多模态开关：视觉模型开启后，交流模式发送消息时附带画布截图
    const visionRow = document.createElement("label");
    visionRow.className = "ai-modal-row";
    const visionBox = document.createElement("input");
    visionBox.type = "checkbox";
    visionRow.append(document.createTextNode("多模态（模型支持视觉时开启）"), visionBox);
    formEl.appendChild(visionRow);

    // 测试连接：验证 Key 并拉取模型列表（/models 不可用时自动降级最小请求）
    this.testBtn = document.createElement("button");
    this.testBtn.type = "button";
    this.testBtn.className = "tool-btn ai-test-btn";
    this.testBtn.textContent = "测试连接";
    this.statusEl = document.createElement("div");
    this.statusEl.className = "ai-modal-status";
    this.modelListEl = document.createElement("div");
    this.modelListEl.className = "ai-model-list";
    this.modelListEl.hidden = true;
    this.testBtn.addEventListener("click", () => this.runTest());
    formEl.append(this.testBtn, this.statusEl, this.modelListEl);

    const actions = document.createElement("div");
    actions.className = "ai-modal-actions";
    this.deleteBtn = document.createElement("button");
    this.deleteBtn.type = "button";
    this.deleteBtn.className = "tool-btn settings-del";
    this.deleteBtn.textContent = "删除此配置";
    this.deleteBtn.addEventListener("click", () => this.deleteEditing());
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "tool-btn ai-modal-save";
    saveBtn.textContent = "保存配置";
    saveBtn.addEventListener("click", () => this.saveForm());
    actions.append(this.deleteBtn, saveBtn);
    formEl.appendChild(actions);
    aiSection.appendChild(formEl);
    container.appendChild(aiSection);

    this.form = {
      name: nameInput,
      base: inputs.get("base")!,
      key: inputs.get("key")!,
      model: inputs.get("model")!,
      vision: visionBox,
    };
  }

  /** 打开弹窗时同步：配置存储可能与外部改动不同步，全量重载并载入激活配置 */
  refresh() {
    this.store = loadProfiles();
    this.editingId = this.store.activeId;
    this.renderList();
    this.loadForm(this.editingId);
  }

  // ---------- 配置列表 ----------

  private renderList() {
    this.listEl.innerHTML = "";
    if (!this.store.profiles.length) {
      const empty = document.createElement("div");
      empty.className = "profile-empty";
      empty.textContent = "暂无配置，点击下方「新建配置」注册模型";
      this.listEl.appendChild(empty);
      return;
    }
    for (const p of this.store.profiles) {
      const row = document.createElement("div");
      row.className = `profile-item${p.id === this.store.activeId ? " active" : ""}`;
      row.title = "点击选用此配置并载入编辑";
      row.addEventListener("click", () => this.selectProfile(p.id));
      const radio = document.createElement("span");
      radio.className = "profile-radio";
      radio.textContent = p.id === this.store.activeId ? "●" : "○";
      const info = document.createElement("div");
      info.className = "profile-info";
      const name = document.createElement("div");
      name.className = "profile-name";
      name.textContent = p.name;
      const meta = document.createElement("div");
      meta.className = "profile-meta";
      meta.textContent = `${p.model || "未填模型"} · ${p.baseURL || "未填地址"}`;
      info.append(name, meta);
      row.append(radio, info);
      this.listEl.appendChild(row);
    }
  }

  private selectProfile(id: string) {
    this.store.activeId = id;
    saveProfiles(this.store);
    this.renderList();
    this.loadForm(id);
  }

  private startNew() {
    this.loadForm("");
    this.form.name.focus();
  }

  private deleteEditing() {
    if (!this.editingId) {
      return;
    }
    const p = this.store.profiles.find((x) => x.id === this.editingId);
    if (!p) {
      return;
    }
    // 应用内弹窗替代 window.confirm：WKWebView 等环境同步对话框静默失败
    void showConfirm({
      title: "删除配置",
      message: `删除配置「${p.name}」？`,
      confirmLabel: "删除",
      danger: true,
    }).then((ok) => {
      if (!ok) {
        return;
      }
      this.store.profiles = this.store.profiles.filter((x) => x.id !== this.editingId);
      if (this.store.activeId === this.editingId) {
        this.store.activeId = this.store.profiles[0]?.id ?? "";
      }
      saveProfiles(this.store);
      this.renderList();
      this.loadForm(this.store.activeId);
    });
  }

  // ---------- 编辑表单 ----------

  private loadForm(id: string) {
    this.editingId = id;
    const p = this.store.profiles.find((x) => x.id === id);
    if (p) {
      this.form.name.value = p.name;
      this.form.base.value = p.baseURL;
      this.form.key.value = p.apiKey;
      this.form.model.value = p.model;
      this.form.vision.checked = p.multimodal === true;
      this.formTitleEl.textContent = `编辑配置：${p.name}`;
      this.deleteBtn.disabled = false;
    } else {
      this.form.name.value = "";
      this.form.base.value = "";
      this.form.key.value = "";
      this.form.model.value = "";
      this.form.vision.checked = false;
      this.formTitleEl.textContent = "新建配置";
      this.deleteBtn.disabled = true;
    }
    this.setStatus("", "");
    this.modelListEl.hidden = true;
  }

  /** 读取表单当前值（含 id/name，供保存与测试共用） */
  private readForm(): AiProfile {
    return {
      id: this.editingId,
      name: this.form.name.value.trim() || "未命名配置",
      baseURL: this.form.base.value.trim(),
      apiKey: this.form.key.value.trim(),
      model: this.form.model.value.trim(),
      multimodal: this.form.vision.checked,
    };
  }

  private saveForm() {
    const draft = this.readForm();
    if (!isConfigReady(draft)) {
      this.setStatus("请完整填写 baseURL、API Key 与模型名称", "error");
      return;
    }
    const existing = this.store.profiles.find((x) => x.id === draft.id);
    if (existing) {
      Object.assign(existing, draft);
    } else {
      const profile: AiProfile = { ...draft, id: allocProfileId(this.store.profiles) };
      this.store.profiles.push(profile);
    }
    this.store.activeId = existing?.id ?? this.store.profiles[this.store.profiles.length - 1].id;
    saveProfiles(this.store);
    this.renderList();
    this.setStatus("已保存", "ok");
  }

  private async runTest() {
    const cfg: AiConfig = this.readForm();
    if (!isConfigReady(cfg)) {
      this.setStatus("请先完整填写 baseURL、API Key 与模型名称", "error");
      return;
    }
    this.testBtn.disabled = true;
    this.setStatus("测试中…", "");
    this.modelListEl.hidden = true;
    try {
      const res = await testConnection(cfg);
      this.setStatus(res.message, res.ok ? "ok" : "error");
      if (res.ok && res.models.length) {
        const modelInput = this.form.model;
        if (res.models.length === 1 && !modelInput.value.trim()) {
          modelInput.value = res.models[0];
        }
        this.modelListEl.innerHTML = "";
        const shown = res.models.slice(0, 30);
        for (const id of shown) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "ai-model-chip";
          chip.textContent = id;
          chip.addEventListener("click", () => {
            modelInput.value = id;
          });
          this.modelListEl.appendChild(chip);
        }
        if (res.models.length > shown.length) {
          const more = document.createElement("span");
          more.className = "ai-model-more";
          more.textContent = `…共 ${res.models.length} 个`;
          this.modelListEl.appendChild(more);
        }
        this.modelListEl.hidden = false;
      }
    } catch (err) {
      this.setStatus(`连接失败：${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      this.testBtn.disabled = false;
    }
  }

  private setStatus(text: string, cls: "" | "ok" | "error") {
    this.statusEl.textContent = text;
    this.statusEl.className = cls ? `ai-modal-status ${cls}` : "ai-modal-status";
  }
}
