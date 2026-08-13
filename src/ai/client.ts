import { isDesktop } from "../storage";
import type { AiConfig, AiToolCall, ChatMessage } from "./types";

/** 单轮补全结果 */
export type ChatTurnResult = {
  /** 本轮流式输出的文本（追加到消息气泡） */
  text: string;
  /** 本轮模型请求的工具调用（若有） */
  toolCalls: AiToolCall[];
};

export type ChatCallbacks = {
  /** 流式文本增量（渲染到气泡） */
  onText?: (delta: string) => void;
};

/** 浏览器直接 fetch；Tauri 桌面端经 plugin-http 转发（绕开 CORS） */
async function httpFetch(url: string, init: RequestInit): Promise<Response> {
  if (isDesktop()) {
    const { fetch } = await import("@tauri-apps/plugin-http");
    return fetch(url, init);
  }
  return fetch(url, init);
}

function chatURL(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function headers(cfg: AiConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
  };
}

/** 解析 OpenAI 兼容 SSE 流，累积文本与工具调用 */
function parseSSE(body: string): ChatTurnResult {
  let text = "";
  const toolCalls: AiToolCall[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    let chunk: {
      choices?: { delta?: { content?: string | null; tool_calls?: unknown[] } }[];
    };
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) {
      continue;
    }
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const item of delta.tool_calls as {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[]) {
        const idx = item.index ?? 0;
        let call = toolCalls[idx];
        if (!call) {
          call = { id: "", type: "function", function: { name: "", arguments: "" } };
          toolCalls[idx] = call;
        }
        if (item.id) {
          call.id = item.id;
        }
        if (item.function?.name) {
          call.function.name += item.function.name;
        }
        if (item.function?.arguments) {
          call.function.arguments += item.function.arguments;
        }
      }
    }
  }
  return { text, toolCalls: toolCalls.filter((c) => c.function.name) };
}

/**
 * 请求一轮补全（流式，带 tools）。
 * 返回文本与工具调用；若模型最终未产出内容且无工具调用，返回空结果。
 */
export async function chatTurn(
  cfg: AiConfig,
  messages: ChatMessage[],
  openAiTools: unknown[],
  cb?: ChatCallbacks,
): Promise<ChatTurnResult> {
  const url = chatURL(cfg.baseURL);
  const body = {
    model: cfg.model,
    messages,
    tools: openAiTools.length ? openAiTools : undefined,
    stream: true,
  };

  // 流式主路径；失败时降级为非流式（个别服务对 stream 参数不友好）
  try {
    const resp = await httpFetch(url, {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw await toApiError(resp);
    }
    const result = parseSSE(await resp.text());
    cb?.onText?.(result.text);
    return result;
  } catch (err) {
    if (err instanceof Error && /stream/i.test(err.message)) {
      return nonStreamChat(url, cfg, messages, openAiTools, cb);
    }
    throw err;
  }
}

/** 非流式降级：一次返回完整内容或工具调用 */
async function nonStreamChat(
  url: string,
  cfg: AiConfig,
  messages: ChatMessage[],
  openAiTools: unknown[],
  cb?: ChatCallbacks,
): Promise<ChatTurnResult> {
  const resp = await httpFetch(url, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({
      model: cfg.model,
      messages,
      tools: openAiTools.length ? openAiTools : undefined,
    }),
  });
  if (!resp.ok) {
    throw await toApiError(resp);
  }
  const json = (await resp.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: unknown[] } }[];
  };
  const message = json.choices?.[0]?.message;
  const text = message?.content ?? "";
  const toolCalls: AiToolCall[] = Array.isArray(message?.tool_calls)
    ? (message.tool_calls as AiToolCall[])
    : [];
  cb?.onText?.(text);
  return { text, toolCalls };
}

/** 把非 2xx 响应转成带服务端错误信息的 Error */
async function toApiError(resp: Response): Promise<Error> {
  let detail = "";
  try {
    const j = (await resp.json()) as { error?: { message?: string } };
    detail = j?.error?.message ?? "";
  } catch {
    // 响应体不是 JSON，忽略
  }
  return new Error(`请求失败 (HTTP ${resp.status})${detail ? `：${detail}` : ""}`);
}
