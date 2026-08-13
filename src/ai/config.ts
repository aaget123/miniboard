import type { AiConfig } from "./types";

const LS_KEY = "miniboard:ai-config";

/** OpenAI 兼容服务配置（仅存本地，由用户自行保管 Key） */
export function loadConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) {
      return { baseURL: "", apiKey: "", model: "" };
    }
    const parsed = JSON.parse(raw) as Partial<AiConfig>;
    return {
      baseURL: typeof parsed.baseURL === "string" ? parsed.baseURL : "",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
    };
  } catch {
    return { baseURL: "", apiKey: "", model: "" };
  }
}

export function saveConfig(cfg: AiConfig) {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
}

/** 配置是否完整可用 */
export function isConfigReady(cfg: AiConfig): boolean {
  return (
    cfg.baseURL.trim().length > 0 &&
    cfg.apiKey.trim().length > 0 &&
    cfg.model.trim().length > 0
  );
}
