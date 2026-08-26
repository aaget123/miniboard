import type { ProjectMeta, SceneFile } from "./types";

/**
 * 存储层数据契约与纯函数：索引/场景文件解析、激活项目回退。
 * 不依赖 DOM 与 Tauri API，供 ProjectStore 与单元测试共用。
 */

/** 项目索引（localStorage / 桌面 index.json）：激活项目 + 项目列表 */
export type ProjectIndex = { activeId: string; projects: ProjectMeta[] };

/**
 * 解析项目索引 JSON：
 * - 文本为空 / 非法 JSON / 缺 projects 数组 → null（调用方按无索引处理，走首次初始化迁移）；
 * - 单个条目缺 id/name 字段时丢弃该条目、保留其余（索引损坏不放大为全部项目丢失）；
 * - createdAt/updatedAt 缺失或非数字时补当前时间。
 */
export function parseProjectIndex(text: string | null): ProjectIndex | null {
  if (!text) {
    return null;
  }
  let raw: Partial<ProjectIndex>;
  try {
    raw = JSON.parse(text) as Partial<ProjectIndex>;
  } catch {
    return null;
  }
  if (!Array.isArray(raw.projects)) {
    return null;
  }
  const projects: ProjectMeta[] = [];
  for (const p of raw.projects) {
    if (
      !p ||
      typeof p.id !== "string" ||
      !p.id ||
      typeof p.name !== "string"
    ) {
      continue;
    }
    projects.push({
      id: p.id,
      name: p.name,
      createdAt: numOf(p.createdAt),
      updatedAt: numOf(p.updatedAt),
    });
  }
  return {
    activeId: typeof raw.activeId === "string" ? raw.activeId : "",
    projects,
  };
}

/**
 * 激活项目不在列表中时回退到第一个项目；列表为空原样返回。
 * 返回的 activeId 与传入不同即代表发生了回退，调用方可据此持久化。
 */
export function resolveActiveIndex(idx: ProjectIndex): ProjectIndex {
  if (idx.projects.length && !idx.projects.some((p) => p.id === idx.activeId)) {
    return { ...idx, activeId: idx.projects[0].id };
  }
  return idx;
}

/**
 * 解析场景文件 JSON（打开/载入/自动保存恢复共用校验）。
 * 格式不符（app 标识不对或缺元素数组）返回 null。
 */
export function parseScene(text: string | null): SceneFile | null {
  if (!text) {
    return null;
  }
  let scene: SceneFile;
  try {
    scene = JSON.parse(text) as SceneFile;
  } catch {
    return null;
  }
  if (scene?.app !== "miniboard" || !Array.isArray(scene.elements)) {
    return null;
  }
  return scene;
}

function numOf(v: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : Date.now();
}

/**
 * 多开写入竞争检测（纯函数）：把"上次自己写入/读取时的 mtime 基线"与
 * 当前文件 mtime 对比——不一致即视为被其他窗口或程序改过，调用方应拒绝覆盖。
 * - current 为 null（文件不存在）：首次写入，放行；
 * - recorded 为 null（无基线，如首次保存或 stat 失败）：宁可不拦截也不误报；
 * - 比较基于等值而非绝对时间，对系统时钟漂移免疫。
 */
export function detectExternalModification(
  recorded: number | null,
  current: number | null,
): boolean {
  if (current === null || recorded === null) {
    return false;
  }
  return current !== recorded;
}
