# Miniboard

**English** | [简体中文](./README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Release](https://img.shields.io/badge/Release-v0.1.0-blue.svg)](https://github.com/aaget123/miniboard/releases)
[![CI](https://github.com/aaget123/miniboard/actions/workflows/test.yml/badge.svg)](https://github.com/aaget123/miniboard/actions)

A **local-first, fully offline** hand-drawn whiteboard. Built with Tauri 2 and leafer-ui. All project data and AI-generated tools are stored on your own disk (customizable directory) — no cloud dependency.

## Features

- **Drawing tools**: pressure-sensitive freehand pen, line, arrow, rect, ellipse, text, eraser, marquee, lasso, etc., driven by a unified tool registry
- **AI assistant** (OpenAI-compatible API): chat mode with canvas awareness; edit mode lets AI create custom drawing tools at runtime (with smoke-test protection); multimodal screenshot support
- **Tidy & beautify**: recognize hand-drawn shapes and convert them into standard shapes; convert standard shapes into hand-drawn rough style (rough.js, reproducible seed)
- **Multi-project management**: independent canvases with autosave; restores the last project on launch
- **Customizable data directory**: projects and AI tools are stored as local files (default: system app-data dir; changeable with automatic migration)
- **Export**: PNG bitmap / SVG vector, lossless element structure

> Full feature details are available in the [Chinese README](./README.md) (功能细节 section).

## Installation

**Option 1: Download** (recommended)
- Grab the NSIS installer or portable exe from [Releases](../../releases)

**Option 2: Build from source**
1. Install [Rust](https://www.rust-lang.org/tools/install) and [Node.js](https://nodejs.org/) (≥ 18)
2. On Windows you also need [MSVC toolchain & Windows SDK](https://learn.microsoft.com/windows/msvc/building-on-the-command-line) (Visual Studio Build Tools recommended)
3. Clone and run:

```bash
npm install
npm run tauri build        # or Windows: powershell -ExecutionPolicy Bypass -File tools/build-tauri.ps1
```

Build output: `src-tauri/target/release/`.

## Development

Run in the browser for fast iteration (functionally identical to the desktop app):

```bash
npm install
npm run dev        # open http://localhost:5173
```

Use `npm run tauri dev` when you need to verify desktop integrations (dialogs, file system, etc.).

## AI Assistant Configuration

The AI assistant uses OpenAI-compatible APIs (works with local Ollama / vLLM / relay services):

1. Open ⚙ Settings → **AI Model** tab
2. Click "New Profile" and fill in:
   - **Name**: e.g. `Ollama`
   - **Base URL**: e.g. `http://localhost:11434/v1`
   - **API Key**: any value for local services; your real key for relay services
   - **Model**: e.g. `qwen2.5:7b` (or fetch the model list automatically)
   - **Multimodal**: attach canvas screenshots to chat messages (requires a vision-capable model)
3. Click "Test Connection", then activate the profile

> **Privacy**: API keys and profiles are stored locally only; conversation content is sent only to the API URL **you** configure. The app itself collects nothing.

## Data Storage

| Data | Default location | Notes |
| --- | --- | --- |
| Project canvases | `%APPDATA%\com.miniboard.app\projects\` | `index.json` index + one scene file per project |
| AI custom tools | `%APPDATA%\com.miniboard.app\custom-tools.json` | AI-generated tool definitions |
| UI preferences / AI profiles | WebView2 localStorage (under the same dir, `EBWebView`) | theme, toolbar layout, model profiles |

- **Change directory**: ⚙ Settings → **Data** tab → "Change Directory…" — old data migrates automatically and is restored on restart
- **Backup**: just copy the data directory (while the app is closed)

## Tech Stack

| Layer | Tech |
| --- | --- |
| Desktop shell | Tauri 2 (Rust) |
| Frontend build | Vite 6 + TypeScript |
| Canvas rendering | leafer-ui 2.2.9 + @leafer-in/editor / arrow / export / text-editor |
| Stroke outline | perfect-freehand |
| Rough style | roughjs |
| AI assistant | OpenAI-compatible API (SSE streaming) via fetch / @tauri-apps/plugin-http |

## Testing

```bash
npm test
```

## Contributing

Issues and PRs are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) first.

## License

[MIT](./LICENSE) © [aaget123](https://github.com/aaget123)
