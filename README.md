# Pixel Agents - OpenCode Edition

A VS Code extension that turns your OpenCode AI coding agents into animated pixel art characters in a virtual office.

This is a fork of [pixel-agents](https://github.com/pablodelucca/pixel-agents) adapted to work with [OpenCode](https://opencode.ai) instead of Claude Code.

## Features

- One agent, one character — every OpenCode session gets its own animated character
- Live activity tracking — characters animate based on what the agent is actually doing
- Office layout editor — design your office with floors, walls, and furniture
- Speech bubbles — visual indicators when an agent is waiting for input
- Sound notifications — optional chime when an agent finishes its turn
- Sub-agent visualization — Task tool sub-agents spawn as separate characters
- Persistent layouts — your office design is saved and shared across VS Code windows

## Requirements

- VS Code 1.107.0 or later
- [OpenCode CLI](https://opencode.ai) installed and configured

## Installation

### From Source

```bash
git clone https://github.com/your-username/pixel-agents-opencode.git
cd pixel-agents-opencode
npm install
cd webview-ui && npm install && cd ..
npm run build
```

Then press F5 in VS Code to launch the Extension Development Host.

## How It Works

Instead of watching JSONL transcript files (like Claude Code), this version polls the OpenCode SQLite database to track agent activity:

1. **Database polling** — Watches `~/.local/share/opencode/opencode.db` for new messages
2. **Message parsing** — Parses OpenCode's JSON message format to detect tools
3. **Status mapping** — Maps OpenCode tools (`glob`, `grep`, `view`, `write`, `bash`, etc.) to character animations

### Tool Mapping

| OpenCode Tool | Character Animation |
|---------------|-------------------|
| `glob` | Searching files |
| `grep` | Searching code |
| `view` | Reading |
| `edit` | Editing |
| `write` | Writing |
| `bash` | Running commands |
| `fetch` | Fetching web |
| `agent` | Subtask |

## Architecture

- **Extension**: TypeScript, VS Code Webview API, esbuild
- **Webview**: React 19, TypeScript, Vite, Canvas 2D
- **Backend**: Polls OpenCode SQLite database instead of file watching

## Differences from Claude Code Version

| Feature | Claude Code | OpenCode |
|---------|-------------|----------|
| Session format | JSONL files | SQLite database |
| Tracking method | File watcher | DB polling |
| Terminal spawning | Yes | No (uses existing sessions) |
| Tools | Claude-specific | OpenCode tools |

## License

MIT License - See LICENSE file

## Original Project

This is a fork of [pixel-agents](https://github.com/pablodelucca/pixel-agents) by [pablodelucca](https://github.com/pablodelucca), adapted for OpenCode.
