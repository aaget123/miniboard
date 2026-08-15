// 统一 SVG 线性图标集（Lucide 风格，stroke=currentColor 跟随主题）：
// 所有 UI 按钮图标从这里取，替代 emoji 保证跨平台渲染一致与视觉统一。
// 内置工具的 ToolDef.icon 字段存图标名（本文件 key）；AI 自定义工具图标为 1-2 字符符号。

export type IconName =
  // 工具
  | "select"
  | "hand"
  | "marquee"
  | "lasso"
  | "pen"
  | "eraser"
  | "line"
  | "arrow"
  | "rect"
  | "ellipse"
  | "text"
  | "shapes"
  | "sparkle"
  | "scribble"
  | "crop"
  | "sliders"
  // 文件与操作
  | "folder"
  | "save"
  | "image"
  | "camera"
  | "file"
  | "bot"
  | "trash"
  | "settings"
  | "menu"
  | "undo"
  | "redo"
  | "zoomIn"
  | "zoomOut"
  | "x"
  | "search"
  | "command"
  | "keyboard"
  | "plus"
  | "pencil"
  | "rotate"
  | "moon"
  | "sun"
  | "monitor"
  | "download"
  | "caret";

type IconDef = {
  /** 内部元素（path/circle/rect 等），stroke 风格统一由外层 svg 属性控制 */
  body: string;
  /** 是否需要虚线描边（如框选） */
  dash?: boolean;
};

const DEFS: Record<IconName, IconDef> = {
  // ---- 工具 ----
  select: { body: `<path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13.5 13.5l6 6"/>` },
  hand: {
    body:
      `<path d="M18 11.5V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1.4"/>` +
      `<path d="M14 10V8a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/>` +
      `<path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/>` +
      `<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>`,
  },
  marquee: { body: `<rect x="4" y="4" width="16" height="16" rx="2"/>`, dash: true },
  lasso: {
    body:
      `<path d="M12 2C6.5 2 2 5.6 2 10s4.5 8 10 8a12 12 0 0 0 5-1"/>` +
      `<path d="M7 22a5 5 0 0 1-2-4"/>` +
      `<path d="M5 18a2 2 0 1 0 0-4"/>`,
  },
  pen: { body: `<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>` },
  eraser: { body: `<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>` },
  line: { body: `<path d="M4 20 20 4"/><circle cx="4" cy="20" r="1.6" fill="currentColor" stroke="none"/><circle cx="20" cy="4" r="1.6" fill="currentColor" stroke="none"/>` },
  arrow: { body: `<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>` },
  rect: { body: `<rect x="4" y="4" width="16" height="16" rx="2"/>` },
  ellipse: { body: `<circle cx="12" cy="12" r="8"/>` },
  text: { body: `<path d="M4 7V4h16v3"/><path d="M12 4v16"/><path d="M8 20h8"/>` },
  shapes: {
    body:
      `<path d="M8.3 10a.7.7 0 0 1-.6-1L9 6.5a.7.7 0 0 1 1.2 0L11.6 9a.7.7 0 0 1-.6 1Z"/>` +
      `<path d="m14 18 1.6-2.9a.7.7 0 0 1 1.2 0L18.4 18a.7.7 0 0 1-.6 1h-3.2a.7.7 0 0 1-.6-1Z"/>` +
      `<path d="m7 14-1.4 2.5A.7.7 0 0 0 6.1 17h2.8a.7.7 0 0 0 .6-1L8.4 13.5a.7.7 0 0 0-1.2 0Z"/>`,
  },
  sparkle: { body: `<path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3Z"/>` },
  scribble: { body: `<path d="M3 16c2-8 4-10 6-7s3 9 5 6 2-7 4-5 3 3 3 3"/>` },
  crop: { body: `<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>` },
  sliders: {
    body:
      `<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/>` +
      `<path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/>`,
  },

  // ---- 文件与操作 ----
  folder: { body: `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>` },
  save: { body: `<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>` },
  image: { body: `<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>` },
  camera: { body: `<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>` },
  file: { body: `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>` },
  bot: { body: `<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>` },
  trash: { body: `<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>` },
  settings: {
    body:
      `<circle cx="12" cy="12" r="3"/>` +
      `<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>`,
  },
  menu: { body: `<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>` },
  undo: { body: `<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/>` },
  redo: { body: `<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>` },
  zoomIn: { body: `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/>` },
  zoomOut: { body: `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/>` },
  x: { body: `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>` },
  search: { body: `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>` },
  command: { body: `<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>` },
  keyboard: {
    body:
      `<rect x="2" y="4" width="20" height="16" rx="2"/>` +
      `<path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/>` +
      `<path d="M6 12h.01"/><path d="M10 12h.01"/><path d="M14 12h.01"/><path d="M18 12h.01"/>` +
      `<path d="M9 16h6"/>`,
  },
  plus: { body: `<path d="M5 12h14"/><path d="M12 5v14"/>` },
  pencil: { body: `<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>` },
  rotate: { body: `<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>` },
  moon: { body: `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>` },
  sun: {
    body:
      `<circle cx="12" cy="12" r="4"/>` +
      `<path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/>` +
      `<path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>`,
  },
  monitor: { body: `<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>` },
  download: { body: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>` },
  caret: { body: `<path d="m6 9 6 6 6-6"/>` },
};

/** 生成完整 SVG 字符串（默认 16px，描边风格跟随 currentColor） */
export function iconHTML(name: IconName, size = 16): string {
  const def = DEFS[name];
  if (!def) {
    return "";
  }
  return (
    `<svg class="ui-icon" viewBox="0 0 24 24" width="${size}" height="${size}" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${def.body}</svg>`
  );
}

/** 是否内置图标名（ToolDef.icon 为内置图标名时按 SVG 渲染；否则按字符渲染） */
export function isIconName(v: string): v is IconName {
  return v in DEFS;
}
