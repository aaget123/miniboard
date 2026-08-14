import type { Board } from "./board/canvas";
import type { ProjectMeta, SceneFile } from "./types";

/**
 * 存储层（多项目）：项目索引 + 每项目独立场景，自动保存 / 切换 / 增删改查；
 * 另存为 / 打开 / 导出 PNG / 导出 SVG 文件级操作保留（与项目管理并存）。
 * 桌面环境走 Tauri 原生对话框与文件系统；浏览器环境回退到 localStorage + 下载。
 */

export const isDesktop = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 项目索引（localStorage / 桌面 index.json）：激活项目 + 项目列表 */
type ProjectIndex = { activeId: string; projects: ProjectMeta[] };

const LS_INDEX_KEY = "miniboard:projects";
const LS_SCENE_PREFIX = "miniboard:project:";
/** 单项目时代的旧自动保存键（首次启动迁移为“项目一”后不再读取） */
const LS_LEGACY_KEY = "miniboard:autosave";
const FILE_EXT = "json";
const FILE_FILTER = { name: "Miniboard 文件", extensions: [FILE_EXT] };

function dateStamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}`;
}

function newProjectId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function downloadText(text: string, filename: string) {
  const blob = new Blob([text], { type: "application/json" });
  downloadBlob(blob, filename);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export class ProjectStore {
  private board: Board;
  private timer = 0;
  /** 桌面端 projects 目录（懒加载，含递归建目录） */
  private dirPromise: Promise<string> | null = null;
  private projects: ProjectMeta[] = [];
  private currentId = "";

  constructor(board: Board) {
    this.board = board;
  }

  get current(): ProjectMeta | null {
    return this.projects.find((p) => p.id === this.currentId) ?? null;
  }

  list(): ProjectMeta[] {
    return [...this.projects];
  }

  // ================= 初始化与迁移 =================

  /**
   * 启动初始化：加载项目索引；首次使用把旧 autosave 迁移为“项目一”；
   * 最后加载激活项目场景到画布，返回是否恢复成功。
   */
  async init(): Promise<boolean> {
    const idx = await this.readIndex();
    if (idx) {
      this.projects = idx.projects;
      this.currentId = idx.activeId;
      // 激活项目失效时回退到第一个
      if (!this.current && this.projects.length) {
        this.currentId = this.projects[0].id;
        await this.saveIndex();
      }
    } else {
      // 旧版本迁移：单 autosave 归入“项目一”
      const legacy = await this.readLegacyScene();
      const meta = this.makeMeta(legacy ? "项目一" : "欢迎使用");
      this.projects = [meta];
      this.currentId = meta.id;
      if (legacy) {
        await this.writeScene(meta.id, legacy);
      } else {
        await this.writeScene(meta.id, this.board.toJSON());
      }
      await this.saveIndex();
    }
    if (!this.current) {
      return false;
    }
    return this.loadScene(this.currentId);
  }

  /** 创建项目并切换过去（当前项目先保存）；返回新项目元数据 */
  async create(name: string): Promise<ProjectMeta> {
    await this.saveCurrent();
    const meta = this.makeMeta(name.trim() || "未命名项目");
    this.projects.push(meta);
    this.currentId = meta.id;
    // 新项目从空白画布开始：清空画布并重置历史（防止撤销把旧项目内容拉回），再落盘空场景
    this.board.clearAll();
    this.board.resetHistory();
    await this.writeScene(meta.id, this.board.toJSON());
    await this.saveIndex();
    return meta;
  }

  /** 重命名项目（更新名称与时间戳） */
  async rename(id: string, name: string): Promise<boolean> {
    const meta = this.projects.find((p) => p.id === id);
    if (!meta) {
      return false;
    }
    meta.name = name.trim() || meta.name;
    meta.updatedAt = Date.now();
    await this.saveIndex();
    return true;
  }

  /** 删除项目：删索引与场景文件；删除当前项目后切到剩余第一个（全删则自动建“项目一”） */
  async remove(id: string): Promise<boolean> {
    const meta = this.projects.find((p) => p.id === id);
    if (!meta) {
      return false;
    }
    this.projects = this.projects.filter((p) => p.id !== id);
    await this.deleteScene(id);
    if (this.currentId === id) {
      if (this.projects.length) {
        this.currentId = this.projects[0].id;
      } else {
        const first = this.makeMeta("项目一");
        this.projects = [first];
        this.currentId = first.id;
        await this.writeScene(first.id, this.board.toJSON());
      }
      // 切换后载入新当前项目的场景
      await this.loadScene(this.currentId);
    }
    await this.saveIndex();
    return true;
  }

  /**
   * 切换项目：先保存当前项目场景，再载入目标项目场景；
   * 目标场景损坏时不切换，保持当前项目。
   */
  async open(id: string): Promise<boolean> {
    if (id === this.currentId || !this.projects.some((p) => p.id === id)) {
      return false;
    }
    await this.saveCurrent();
    if (!(await this.loadScene(id))) {
      return false;
    }
    this.currentId = id;
    await this.saveIndex();
    return true;
  }

  // ================= 自动保存 =================

  /** 元素变化后调用：防抖自动保存到当前项目 */
  scheduleAutosave() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.saveCurrent().catch((err) =>
        console.error("[storage] autosave failed", err),
      );
    }, 800);
  }

  private async saveCurrent() {
    if (!this.current) {
      return;
    }
    await this.writeScene(this.current.id, this.board.toJSON());
  }

  // ================= 文件级操作（与项目管理并存） =================

  /** 另存为文件 */
  async saveToFile(): Promise<boolean> {
    const json = this.board.toJSON();
    const name = `白板-${dateStamp()}.${FILE_EXT}`;
    if (isDesktop()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: name,
        filters: [FILE_FILTER],
      });
      if (!path) {
        return false;
      }
      await writeTextFile(path, json);
      return true;
    }
    downloadText(json, name);
    return true;
  }

  /** 打开文件（载入当前项目画布，autosave 会自然覆盖保存） */
  async openFromFile(): Promise<boolean> {
    if (isDesktop()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await open({
        multiple: false,
        filters: [FILE_FILTER],
      });
      if (!path || Array.isArray(path)) {
        return false;
      }
      const json = await readTextFile(path);
      return this.applyJSON(json);
    }
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = `.${FILE_EXT},application/json`;
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(false);
          return;
        }
        resolve(this.applyJSON(await file.text()));
      };
      input.click();
    });
  }

  /** 导出 PNG 图片 */
  async exportPNG(): Promise<boolean> {
    const dataURL = await this.board.exportPNG();
    const name = `白板-${dateStamp()}.png`;
    if (isDesktop()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: name,
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      if (!path) {
        return false;
      }
      const blob = await (await fetch(dataURL)).blob();
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      return true;
    }
    const blob = await (await fetch(dataURL)).blob();
    downloadBlob(blob, name);
    return true;
  }

  /** 导出 SVG 矢量图（可无损缩放；浏览器端直接下载文本） */
  async exportSVG(): Promise<boolean> {
    const svg = this.board.exportSVG();
    const name = `白板-${dateStamp()}.svg`;
    if (isDesktop()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: name,
        filters: [{ name: "SVG 矢量图", extensions: ["svg"] }],
      });
      if (!path) {
        return false;
      }
      await writeTextFile(path, svg);
      return true;
    }
    const blob = new Blob([svg], { type: "image/svg+xml" });
    downloadBlob(blob, name);
    return true;
  }

  // ================= 内部：场景读写 =================

  private applyJSON(json: string): boolean {
    try {
      const scene = JSON.parse(json) as SceneFile;
      if (scene.app !== "miniboard" || !Array.isArray(scene.elements)) {
        return false;
      }
      this.board.loadElements(scene.elements);
      return true;
    } catch {
      return false;
    }
  }

  /** 读取项目场景并载入画布；成功时重置历史 */
  private async loadScene(id: string): Promise<boolean> {
    try {
      let json: string | null = null;
      if (isDesktop()) {
        const { readTextFile } = await import("@tauri-apps/plugin-fs");
        json = await readTextFile(await this.scenePath(id));
      } else {
        json = localStorage.getItem(LS_SCENE_PREFIX + id);
      }
      if (!json) {
        return false;
      }
      const ok = this.applyJSON(json);
      if (ok) {
        this.board.resetHistory();
      }
      return ok;
    } catch {
      return false;
    }
  }

  private async writeScene(id: string, json: string) {
    if (isDesktop()) {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(await this.scenePath(id), json);
    } else {
      localStorage.setItem(LS_SCENE_PREFIX + id, json);
    }
  }

  private async deleteScene(id: string) {
    if (isDesktop()) {
      try {
        const { remove } = await import("@tauri-apps/plugin-fs");
        await remove(await this.scenePath(id));
      } catch {
        // 场景文件不存在可忽略
      }
    } else {
      localStorage.removeItem(LS_SCENE_PREFIX + id);
    }
  }

  // ================= 内部：索引读写 =================

  private async readIndex(): Promise<ProjectIndex | null> {
    try {
      let text: string | null = null;
      if (isDesktop()) {
        const { readTextFile } = await import("@tauri-apps/plugin-fs");
        text = await readTextFile(await this.indexPath());
      } else {
        text = localStorage.getItem(LS_INDEX_KEY);
      }
      if (!text) {
        return null;
      }
      const idx = JSON.parse(text) as ProjectIndex;
      if (!Array.isArray(idx.projects)) {
        return null;
      }
      return idx;
    } catch {
      return null;
    }
  }

  private async saveIndex() {
    const idx: ProjectIndex = { activeId: this.currentId, projects: this.projects };
    const text = JSON.stringify(idx);
    if (isDesktop()) {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(await this.indexPath(), text);
    } else {
      localStorage.setItem(LS_INDEX_KEY, text);
    }
  }

  /** 旧版单项目 autosave（迁移用）：桌面 appDataDir/autosave.json，浏览器旧 localStorage 键 */
  private async readLegacyScene(): Promise<string | null> {
    try {
      if (isDesktop()) {
        const { readTextFile } = await import("@tauri-apps/plugin-fs");
        const { appDataDir, join } = await import("@tauri-apps/api/path");
        return await readTextFile(await join(await appDataDir(), "autosave.json"));
      }
      return localStorage.getItem(LS_LEGACY_KEY);
    } catch {
      return null;
    }
  }

  private makeMeta(name: string): ProjectMeta {
    const now = Date.now();
    return { id: newProjectId(), name, createdAt: now, updatedAt: now };
  }

  /** 桌面端 projects 目录（懒加载，自动建目录） */
  private async projectsDir(): Promise<string> {
    if (!this.dirPromise) {
      this.dirPromise = (async () => {
        const { appDataDir, join } = await import("@tauri-apps/api/path");
        const dir = await join(await appDataDir(), "projects");
        const { mkdir } = await import("@tauri-apps/plugin-fs");
        try {
          await mkdir(dir, { recursive: true });
        } catch {
          // 目录已存在
        }
        return dir;
      })();
    }
    return this.dirPromise;
  }

  private async indexPath(): Promise<string> {
    const { join } = await import("@tauri-apps/api/path");
    return join(await this.projectsDir(), "index.json");
  }

  private async scenePath(id: string): Promise<string> {
    const { join } = await import("@tauri-apps/api/path");
    return join(await this.projectsDir(), `${id}.json`);
  }
}
