import type { Board } from "./board/canvas";
import type { SceneFile } from "./types";

/**
 * 存储层：自动保存 / 打开 / 另存为 / 导出 PNG。
 * 桌面环境走 Tauri 原生对话框与文件系统；浏览器环境回退到 localStorage + 下载。
 */

export const isDesktop = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const LS_KEY = "miniboard:autosave";
const FILE_EXT = "json";
const FILE_FILTER = { name: "Miniboard 文件", extensions: [FILE_EXT] };

function dateStamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}`;
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

export class Storage {
  private board: Board;
  private timer = 0;
  private dirPromise: Promise<string> | null = null;

  constructor(board: Board) {
    this.board = board;
  }

  /** 元素变化后调用：防抖自动保存 */
  scheduleAutosave() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.autosave().catch((err) =>
        console.error("[storage] autosave failed", err),
      );
    }, 800);
  }

  private appDir(): Promise<string> {
    if (!this.dirPromise) {
      this.dirPromise = (async () => {
        const { appDataDir, join } = await import("@tauri-apps/api/path");
        return join(await appDataDir(), "autosave.json");
      })();
    }
    return this.dirPromise;
  }

  async autosave() {
    const json = this.board.toJSON();
    if (isDesktop()) {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(await this.appDir(), json);
    } else {
      localStorage.setItem(LS_KEY, json);
    }
  }

  /** 启动时恢复上次内容，返回是否恢复成功 */
  async restoreAutosave(): Promise<boolean> {
    try {
      let json: string | null = null;
      if (isDesktop()) {
        const { readTextFile } = await import("@tauri-apps/plugin-fs");
        json = await readTextFile(await this.appDir());
      } else {
        json = localStorage.getItem(LS_KEY);
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

  /** 打开文件 */
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
}
