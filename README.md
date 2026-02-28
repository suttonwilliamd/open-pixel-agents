# Pixel Agents - OpenCode Edition

Pixel art office where your OpenCode agents come to life as animated characters.

## ⚠️ Architecture Change!

This is now a **standalone server** that doesn't require VS Code. It connects directly to OpenCode via ACP (Agent Client Protocol).

## Quick Start

```bash
# Install dependencies
npm install

# Run in a project directory
npm start /path/to/your/project

# Or run in current directory
npm start
```

Then open http://localhost:5173 in your browser.

## How It Works

```
┌─────────────────────┐      SSE       ┌─────────────────────┐
│  Pixel Agents      │ ←─────────────→ │  OpenCode Server   │
│  (webview)        │  real-time      │  (ACP)             │
│                   │   events        │                    │
└─────────────────────┘                └─────────────────────┘
```

1. Server starts OpenCode in server mode (`opencode serve`)
2. Creates a session and subscribes to SSE events
3. When agent uses tools (bash, edit, write, etc.), webview updates character animation

## Events Supported

| Event | Description |
|-------|-------------|
| `message.part.updated` (tool) | Tool starts/completes → character types |
| `message.updated` (completed) | Turn ends → character waits |

## Tool Animations

| Tool | Animation |
|------|-----------|
| glob | Searching files |
| grep | Searching code |
| view/read | Reading |
| edit | Editing |
| write | Writing |
| bash | Running commands |
| fetch | Fetching web |
| agent | Subtask |

## API

### HTTP Endpoints

- `GET /` - Serve webview
- `GET /events` - SSE endpoint for real-time updates

### Webview Messages (received)

```javascript
{ type: "agentStatus", id: 1, status: "active" | "waiting" }
{ type: "agentToolStart", id: 1, toolId: "xxx", status: "Running: git status" }
{ type: "agentToolDone", id: 1, toolId: "xxx" }
{ type: "agentToolsClear", id: 1 }
```

## Development

```bash
# Build the webview (or just edit webview.html directly)
# The server serves webview.html directly

# Run
npm start /path/to/project
```

## Files

- `server/index.js` - Main server (connects to OpenCode, streams SSE)
- `server/webview.html` - Frontend (pixel office + canvas rendering)

## Requirements

- Node.js 18+
- OpenCode CLI installed (`opencode` on PATH)
