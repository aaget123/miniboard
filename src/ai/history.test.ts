// 对话存档治理函数单测：tool 轮次丢弃、图片降级、轮次截断、开头为 user
import { describe, expect, it } from "vitest";
import { MAX_PERSIST_TURNS, sanitizeForStorage, textOf } from "./history";
import type { ChatMessage } from "./types";

const user = (content: ChatMessage["content"]): ChatMessage => ({
  role: "user",
  content,
});
const assistant = (content: ChatMessage["content"]): ChatMessage => ({
  role: "assistant",
  content,
});

describe("textOf", () => {
  it("纯文本原样返回", () => {
    expect(textOf("你好")).toBe("你好");
  });

  it("多模态数组只取文本片段，图片丢弃", () => {
    expect(
      textOf([
        { type: "text", text: "第一段" },
        { type: "image_url", image_url: { url: "data:image/..." } },
        { type: "text", text: "第二段" },
      ]),
    ).toBe("第一段\n第二段");
  });

  it("null 返回空串", () => {
    expect(textOf(null)).toBe("");
  });
});

describe("sanitizeForStorage", () => {
  it("丢弃 tool 轮次（画布快照与图片数据不落盘）", () => {
    const history: ChatMessage[] = [
      user("看一下画布"),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "get_canvas", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "当前画布元素数据：..." },
      assistant("画布上有 3 个元素"),
    ];
    const cleaned = sanitizeForStorage(history);
    expect(cleaned).toEqual([
      user("看一下画布"),
      assistant("画布上有 3 个元素"),
    ]);
  });

  it("工具调用轮有总结文本时保留纯文本，无文本整条丢弃", () => {
    const withText: ChatMessage[] = [
      user("u"),
      {
        role: "assistant",
        content: "正在画流程图",
        tool_calls: [{ id: "c", type: "function", function: { name: "draw_flowchart", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c", content: "已生成" },
    ];
    const cleaned = sanitizeForStorage(withText);
    expect(cleaned).toEqual([user("u"), assistant("正在画流程图")]);
    expect(cleaned[1]).not.toHaveProperty("tool_calls");

    const noText: ChatMessage[] = [
      user("u"),
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c", type: "function", function: { name: "get_canvas", arguments: "{}" } }],
      },
    ];
    expect(sanitizeForStorage(noText)).toEqual([user("u")]);
  });

  it("多模态消息降级为纯文本，纯图片消息丢弃", () => {
    const history: ChatMessage[] = [
      user([
        { type: "text", text: "看看这张图" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } },
      ]),
      assistant([{ type: "image_url", image_url: { url: "data:image/..." } }]),
    ];
    expect(sanitizeForStorage(history)).toEqual([user("看看这张图")]);
  });

  it("空消息与 null 内容丢弃", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "" },
      { role: "assistant", content: null },
      user("有效消息"),
      assistant("有效回复"),
    ];
    expect(sanitizeForStorage(history)).toEqual([
      user("有效消息"),
      assistant("有效回复"),
    ]);
  });

  it("超过轮次上限时保留最近 MAX_PERSIST_TURNS 轮，开头必须为 user", () => {
    const history: ChatMessage[] = [];
    // 开头放一条残留 assistant，验证被清掉
    history.push(assistant("残留开头"));
    for (let i = 0; i < MAX_PERSIST_TURNS + 5; i++) {
      history.push(user(`问题${i}`));
      history.push(assistant(`回答${i}`));
    }
    const cleaned = sanitizeForStorage(history);
    // 保留最近 12 轮 = 12 条 user + 12 条 assistant
    expect(cleaned.length).toBe(MAX_PERSIST_TURNS * 2);
    expect(cleaned[0].role).toBe("user");
    expect(cleaned[0].content).toBe(`问题${5}`);
    expect(cleaned[cleaned.length - 1].content).toBe(
      `回答${MAX_PERSIST_TURNS + 4}`,
    );
  });
});
