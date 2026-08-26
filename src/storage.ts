import type { Board } from "./board/canvas";
import { dataURLToJpeg, jpegToPdf, PDF_EXPORT_MAX_SIDE } from "./board/pdf";
import {
  detectExternalModification,
  migrateScene,
  parseProjectIndex,
  parseScene,
  resolveActiveIndex,
} from "./storage-core";
import type { ProjectIndex } from "./storage-core";
import type { ProjectMeta } from "./types";

/**
 * 存储层（多项目）：项目索引 + 每项目独立场景，自动保存 / 切换 / 增删改查；
 * 另存为 / 打开 / 导出 PNG / 导出 SVG 文件级操作保留（与项目管理并存）。
 * 桌面环境走 Tauri 原生对话框与文件系统；浏览器环境回退到 localStorage + 下载。
 * 桌面端写入统一走原子化路径（临时文件 + 上一版备份），中断不产生半截主文件。
 */

export const isDesktop = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const LS_INDEX_KEY = "miniboard:projects";
const LS_SCENE_PREFIX = "miniboard:project:";
/** 单项目时代的旧自动保存键（首次启动迁移为“项目一”后不再读取） */
const LS_LEGACY_KEY = "miniboard:autosave";
/** 自定义数据目录配置文件名（桌面 appDataDir 下；Rust 端 set_data_dir 写入/读取） */
const DATA_DIR_CFG = "data-dir.json";
const FILE_EXT = "json";
const FILE_FILTER = { name: "Miniboard 文件", extensions: [FILE_EXT] };

/**
 * 解析桌面端数据根目录：读 appDataDir()/data-dir.json 配置；
 * 未配置时默认 appDataDir()（兼容旧版 projects 目录位置）。
 * 浏览器环境返回 null（数据走 localStorage）。
 */
export async function resolveDataDir(): Promise<string | null> {
  if (!isDesktop()) {
    return null;
  }
  try {
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const cfg = JSON.parse(
      await readTextFile(await join(await appDataDir(), DATA_DIR_CFG)),
    ) as { dir?: string };
    if (cfg.dir?.trim()) {
      return cfg.dir.trim();
    }
  } catch {
    // 无配置或读取失败：回退默认目录
  }
  const { appDataDir } = await import("@tauri-apps/api/path");
  return await appDataDir();
}

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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 滚动备份保留代数（bak.1 最新 … bak.N 最旧） */
const BAK_KEEP = 5;

/**
 * 原子化写文本文件（滚动备份）：
 * 1. 写 .tmp 临时文件；
 * 2. 旧版本滚动为 bak.1..N（主文件让位为 bak.1，最旧一代淘汰）；
 * 3. .tmp 原子重命名为主文件。
 * 任一步骤中断最多丢本次写入；载入侧按 主文件 → bak.1..N 回退。
 * 返回写入后主文件的 mtime（毫秒），供多开竞争检测记录基线；stat 失败返回 null。
 */
async function writeTextAtomic(path: string, text: string): Promise<number | null> {
  const fs = await import("@tauri-apps/plugin-fs");
  const tmp = `${path}.tmp`;
  await fs.writeTextFile(tmp, text);
  for (let i = BAK_KEEP; i >= 2; i--) {
    try {
      await fs.rename(`${path}.bak.${i - 1}`, `${path}.bak.${i}`);
    } catch {
      // 该代备份不存在，跳过
    }
  }
  try {
    await fs.rename(path, `${path}.bak.1`);
  } catch {
    // 主文件尚不存在（首次写入）
  }
  await fs.rename(tmp, path);
  try {
    const info = await fs.stat(path);
    return info.mtime?.getTime() ?? null;
  } catch {
    return null;
  }
}

/** 读文本文件，失败（不存在/无权限）返回 null */
async function readTextAt(path: string): Promise<string | null> {
  try {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return await readTextFile(path);
  } catch {
    return null;
  }
}

/** 读主文件，缺失时沿滚动备份回退（bak.1 最新 → bak.N 最旧） */
async function readTextWithFallback(path: string): Promise<string | null> {
  const main = await readTextAt(path);
  if (main !== null) {
    return main;
  }
  for (let i = 1; i <= BAK_KEEP; i++) {
    const bak = await readTextAt(`${path}.bak.${i}`);
    if (bak !== null) {
      return bak;
    }
  }
  return null;
}

/** 读文件 mtime（毫秒），失败返回 null */
async function mtimeOf(path: string): Promise<number | null> {
  try {
    const { stat } = await import("@tauri-apps/plugin-fs");
    return (await stat(path)).mtime?.getTime() ?? null;
  } catch {
    return null;
  }
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

  constructor(
    board: Board,
    /** 桌面端数据根目录（resolveDataDir 结果；null = 浏览器环境） */
    private dataDir: string | null,
  ) {
    this.board = board;
  }

  /** 当前数据根目录（桌面端；浏览器 null），用于设置页展示与更改目录时传旧目录 */
  getDataDir(): string | null {
    return this.dataDir;
  }

  /**
   * 数据目录变更后重载（Rust 端已复制文件并授权 scope）：
   * 重置目录缓存后重新初始化，返回是否恢复成功。
   */
  async reloadDataDir(): Promise<boolean> {
    this.dirPromise = null;
    return this.init();
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
    const parsed = await this.readIndex();
    if (parsed) {
      // 记录索引读取基线（多开竞争检测用）
      if (isDesktop()) {
        this.indexMtime = await mtimeOf(await this.indexPath());
      }
      const idx = resolveActiveIndex(parsed);
      this.projects = idx.projects;
      this.currentId = idx.activeId;
      // 激活项目失效发生回退时立即持久化，避免每次启动重复回退
      if (idx.activeId !== parsed.activeId) {
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

  /** 存储层错误回调：自动保存失败等需用户感知的场景（main.ts 接 toast） */
  onStorageError: ((message: string) => void) | null = null;

  /** 自动保存成功回调（main.ts 接状态栏轻提示） */
  onSaved: (() => void) | null = null;

  /** 场景文件的本地写入基线 mtime：写前比对，检测其他窗口/程序的并发修改 */
  private sceneMtimes = new Map<string, number | null>();
  /** 索引文件的写入基线 mtime（语义同上） */
  private indexMtime: number | null = null;

  /** 自动保存连续失败标记：失败只提示一次，成功后复位（避免持续变更时刷屏） */
  private autosaveFailing = false;

  /** 写前竞争检测：文件 mtime 与本地基线不一致即视为外部修改，抛错拒绝覆盖 */
  private async assertNoExternalWrite(path: string, recorded: number | null) {
    const current = await mtimeOf(path);
    if (detectExternalModification(recorded, current)) {
      throw new Error(
        "文件已被其他窗口或程序修改，本次保存已取消（请先在另一窗口保存或关闭后重试）",
      );
    }
  }

  /** 元素变化后调用：防抖自动保存到当前项目 */
  scheduleAutosave() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.saveCurrent()
        .then(() => {
          this.autosaveFailing = false;
          this.onSaved?.();
        })
        .catch((err) => {
          console.error("[storage] autosave failed", err);
          if (!this.autosaveFailing) {
            this.autosaveFailing = true;
            this.onStorageError?.(
              `自动保存失败：${errMessage(err)}（问题恢复后将继续自动保存）`,
            );
          }
        });
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

  /**
   * 导入内容文件（MD/代码/文本 → 内容框架用）：返回文件名与文本内容，
   * 取消/读取失败返回 null。桌面端走原生对话框，浏览器回退 input。
   */
  async importContentFile(): Promise<{ name: string; text: string } | null> {
    if (isDesktop()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await open({
        multiple: false,
        filters: [
          {
            name: "文本/代码文件",
            extensions: [
              "md", "markdown", "txt", "text", "json", "csv", "xml", "html",
              "css", "js", "ts", "tsx", "jsx", "py", "java", "c", "cpp",
              "h", "go", "rs", "rb", "php", "sh", "bat", "ps1", "sql",
              "yaml", "yml", "toml", "ini", "vue", "svelte",
            ],
          },
          { name: "所有文件", extensions: ["*"] },
        ],
      });
      if (!path || Array.isArray(path)) {
        return null;
      }
      const text = await readTextFile(path);
      return { name: path.split(/[\\/]/).pop() ?? "导入文件", text };
    }
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept =
        ".md,.markdown,.txt,.text,.json,.csv,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.java,.c,.cpp,.h,.go,.rs,.rb,.php,.sh,.bat,.ps1,.sql,.yaml,.yml,.toml,.ini,.vue,.svelte,text/*";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        resolve({ name: file.name, text: await file.text() });
      };
      input.click();
    });
  }

  /**
   * 导出 PNG 到剪贴板（Web Clipboard API，浏览器与 WebView2 均支持）：
   * 复制后可直接粘贴到聊天/文档；不支持或授权拒绝返回 false。
   */
  async exportPNGClipboard(): Promise<boolean> {
    try {
      const dataURL = await this.board.exportPNG();
      const blob = await (await fetch(dataURL)).blob();
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      return true;
    } catch {
      return false;
    }
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

  /** 导出 PDF 文档（画布位图化后嵌入单页 PDF；中文由浏览器渲染无字体问题） */
  async exportPDF(): Promise<boolean> {
    const png = await this.board.exportPNG();
    const jpeg = await dataURLToJpeg(png, PDF_EXPORT_MAX_SIDE);
    if (!jpeg) {
      return false;
    }
    const bytes = jpegToPdf(jpeg.dataURL, jpeg.width, jpeg.height);
    const name = `白板-${dateStamp()}.pdf`;
    if (isDesktop()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: name,
        filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
      });
      if (!path) {
        return false;
      }
      await writeFile(path, bytes);
      return true;
    }
    downloadBlob(new Blob([bytes.slice()], { type: "application/pdf" }), name);
    return true;
  }

  // ================= 内部：场景读写 =================

  private applyJSON(json: string): boolean {
    const scene = parseScene(json);
    if (!scene) {
      return false;
    }
    // 版本迁移管道：旧版本逐级升级；未来更高版本文件拒绝载入（防降级改写）
    const migrated = migrateScene(scene);
    if (!migrated) {
      return false;
    }
    this.board.loadElements(migrated.elements);
    return true;
  }

  /** 读取项目场景并载入画布；成功时重置历史。主文件缺失/损坏时沿滚动备份回退 */
  private async loadScene(id: string): Promise<boolean> {
    let json: string | null = null;
    let path: string | null = null;
    if (isDesktop()) {
      path = await this.scenePath(id);
      json = await readTextWithFallback(path);
    } else {
      json = localStorage.getItem(LS_SCENE_PREFIX + id);
    }
    if (!json) {
      return false;
    }
    const ok = this.applyJSON(json);
    if (ok) {
      this.board.resetHistory();
      // 记录读取基线（可能来自备份，此时主文件 mtime 为 null → 不设防，首次写入后恢复设防）
      if (path) {
        this.sceneMtimes.set(id, await mtimeOf(path));
      }
    }
    return ok;
  }

  private async writeScene(id: string, json: string) {
    if (isDesktop()) {
      const path = await this.scenePath(id);
      await this.assertNoExternalWrite(path, this.sceneMtimes.get(id) ?? null);
      this.sceneMtimes.set(id, await writeTextAtomic(path, json));
    } else {
      localStorage.setItem(LS_SCENE_PREFIX + id, json);
    }
  }

  private async deleteScene(id: string) {
    if (isDesktop()) {
      const { remove } = await import("@tauri-apps/plugin-fs");
      const path = await this.scenePath(id);
      try {
        await remove(path);
      } catch {
        // 场景文件不存在可忽略
      }
      for (let i = 1; i <= BAK_KEEP; i++) {
        try {
          await remove(`${path}.bak.${i}`);
        } catch {
          // 无该代备份可忽略
        }
      }
      this.sceneMtimes.delete(id);
    } else {
      localStorage.removeItem(LS_SCENE_PREFIX + id);
    }
  }

  // ================= 内部：索引读写 =================

  private async readIndex(): Promise<ProjectIndex | null> {
    let text: string | null = null;
    if (isDesktop()) {
      text = await readTextAt(await this.indexPath());
    } else {
      text = localStorage.getItem(LS_INDEX_KEY);
    }
    return parseProjectIndex(text);
  }

  private async saveIndex() {
    const idx: ProjectIndex = { activeId: this.currentId, projects: this.projects };
    const text = JSON.stringify(idx);
    if (isDesktop()) {
      const path = await this.indexPath();
      await this.assertNoExternalWrite(path, this.indexMtime);
      this.indexMtime = await writeTextAtomic(path, text);
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
        const { join } = await import("@tauri-apps/api/path");
        const dir = await join(this.dataDir!, "projects");
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
