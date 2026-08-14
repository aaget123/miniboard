import type { AiConfig, AiProfile, AiProfileStore } from "./types";

const LS_KEY = "miniboard:ai-config";
const LS_PROFILES = "miniboard:ai-profiles";

/** 分配配置条目 id：profile-N（取现有最大序号 +1） */
function allocProfileId(profiles: AiProfile[]): string {
  let max = 0;
  for (const p of profiles) {
    const m = /^profile-(\d+)$/.exec(p.id);
    if (m) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return `profile-${max + 1}`;
}

/** 读取旧版单配置（迁移用）；损坏/不存在返回空配置 */
function loadLegacy(): AiConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) {
      return { baseURL: "", apiKey: "", model: "", multimodal: false };
    }
    const parsed = JSON.parse(raw) as Partial<AiConfig>;
    return {
      baseURL: typeof parsed.baseURL === "string" ? parsed.baseURL : "",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      multimodal: parsed.multimodal === true,
    };
  } catch {
    return { baseURL: "", apiKey: "", model: "", multimodal: false };
  }
}

/** 读取全部模型配置；无新版数据时自动迁移旧版单配置为一个默认条目 */
export function loadProfiles(): AiProfileStore {
  try {
    const raw = localStorage.getItem(LS_PROFILES);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AiProfileStore>;
      const profiles = Array.isArray(parsed.profiles)
        ? parsed.profiles.filter(
            (p): p is AiProfile =>
              !!p &&
              typeof p.id === "string" &&
              typeof p.baseURL === "string" &&
              typeof p.apiKey === "string" &&
              typeof p.model === "string",
          )
        : [];
      const activeId =
        typeof parsed.activeId === "string" &&
        profiles.some((p) => p.id === parsed.activeId)
          ? parsed.activeId
          : profiles[0]?.id ?? "";
      return { activeId, profiles };
    }
    // 旧版单配置迁移
    const old = loadLegacy();
    if (old.baseURL || old.apiKey || old.model) {
      const profile: AiProfile = { ...old, id: "profile-1", name: "默认配置" };
      return { activeId: profile.id, profiles: [profile] };
    }
    return { activeId: "", profiles: [] };
  } catch {
    return { activeId: "", profiles: [] };
  }
}

export function saveProfiles(store: AiProfileStore) {
  try {
    localStorage.setItem(LS_PROFILES, JSON.stringify(store));
  } catch {
    // localStorage 不可用时忽略持久化
  }
}

/** 当前激活配置（无任何配置时返回空默认） */
export function loadConfig(): AiConfig {
  const { activeId, profiles } = loadProfiles();
  const active =
    profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null;
  if (!active) {
    return { baseURL: "", apiKey: "", model: "", multimodal: false };
  }
  const { id: _id, name: _name, ...cfg } = active;
  return cfg;
}

/** 更新当前激活配置（无配置时自动创建"默认配置"条目） */
export function saveConfig(cfg: AiConfig) {
  const store = loadProfiles();
  const active =
    store.profiles.find((p) => p.id === store.activeId) ?? store.profiles[0];
  if (active) {
    Object.assign(active, cfg);
  } else {
    const profile: AiProfile = {
      ...cfg,
      id: allocProfileId(store.profiles),
      name: "默认配置",
    };
    store.profiles.push(profile);
    store.activeId = profile.id;
  }
  saveProfiles(store);
}

/** 配置是否完整可用 */
export function isConfigReady(cfg: AiConfig): boolean {
  return (
    cfg.baseURL.trim().length > 0 &&
    cfg.apiKey.trim().length > 0 &&
    cfg.model.trim().length > 0
  );
}

export { allocProfileId };
