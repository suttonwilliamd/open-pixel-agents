// OpenCode ACP Client for Pixel Agents
// Connects to OpenCode server and streams events to the pixel office webview

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";

const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";
const DEFAULT_PORT = 5173;

// Parse listening URL from OpenCode output
function parseListeningUrl(text: string): string | null {
  const m = text.match(/opencode server listening on (https?:\/\/[^\s]+)/i);
  return m ? m[1] : null;
}

// Start OpenCode server in a directory
async function startOpenCodeServer(cwd: string): Promise<{ url: string; process: ChildProcessWithoutNullStreams }> {
  console.error("[Pixel Agents] Starting OpenCode server in:", cwd);

  const child = spawn(OPENCODE_BIN, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd,
    env: { ...process.env, OPENCODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let url: string | undefined;
  let stdoutData = "";
  let stderrData = "";

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdoutData += text;
    console.error("[Pixel Agents] opencode stdout:", text);
    const maybeUrl = parseListeningUrl(text);
    if (maybeUrl) url = maybeUrl;
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrData += text;
    console.error("[Pixel Agents] opencode stderr:", text);
    const maybeUrl = parseListeningUrl(text);
    if (maybeUrl) url = maybeUrl;
  });

  // Wait for server to start
  const start = Date.now();
  while (!url && Date.now() - start < 10000) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!url) {
    child.kill();
    throw new Error(`Failed to start OpenCode server. stdout: ${stdoutData.slice(0, 500)}, stderr: ${stderrData.slice(0, 500)}`);
  }

  return { url, process: child };
}

// Create a new session
async function createSession(baseUrl: string): Promise<{ id: string }> {
  const res = await fetch(`${baseUrl}/session`, { method: "POST", body: JSON.stringify({}) });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  return res.json();
}

// Subscribe to SSE events
function sseSubscribe(baseUrl: string, onEvent: (event: any) => void): () => void {
  const controller = new AbortController();
  
  (async () => {
    try {
      const res = await fetch(`${baseUrl}/event`, { 
        signal: controller.signal,
        headers: { accept: "text/event-stream" }
      });
      
      if (!res.ok || !res.body) throw new Error(`SSE error: ${res.status}`);
      
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        let idx;
        
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          
          for (const line of raw.split("\n")) {
            if (line.startsWith("data: ")) {
              const json = line.slice(6);
              try {
                const evt = JSON.parse(json);
                onEvent(evt);
              } catch {}
            }
          }
        }
      }
    } catch (e) {
      // Connection closed
    }
  })();

  return () => controller.abort();
}

// Send a message to a session
async function sendMessage(baseUrl: string, sessionId: string, text: string): Promise<void> {
  await fetch(`${baseUrl}/session/${sessionId}/message`, {
    method: "POST",
    body: JSON.stringify({
      parts: [{ type: "text", text }]
    })
  });
}

// Format tool for display
function formatToolStatus(toolName: string, input: any): string {
  if (!input) return `Using ${toolName}`;
  
  switch (toolName) {
    case "view":
    case "read":
      return `Reading ${input.file_path || "file"}`;
    case "edit":
      return `Editing ${input.file_path || "file"}`;
    case "write":
      return `Writing ${input.file_path || "file"}`;
    case "bash":
      const cmd = input.command || "";
      return cmd.length > 30 ? `Running: ${cmd.slice(0, 30)}…` : `Running: ${cmd}`;
    case "glob":
      return "Searching files";
    case "grep":
      return "Searching code";
    case "fetch":
      return "Fetching web";
    case "agent":
      return "Running subtask";
    default:
      return `Using ${toolName}`;
  }
}

// Main Pixel Agents server
class PixelAgentsServer {
  private httpServer: Server | null = null;
  private opencodeProcess: ChildProcessWithoutNullStreams | null = null;
  private opencodeUrl: string | null = null;
  private sessionId: string | null = null;
  private sseClose: (() => void) | null = null;
  private wsClients: Set<any> = new Set();
  private activeTools: Map<string, { tool: string; status: string; input?: any }> = new Map();

  async start(cwd: string, port: number = DEFAULT_PORT): Promise<void> {
    // Start OpenCode server
    const { url, process } = await startOpenCodeServer(cwd);
    this.opencodeUrl = url;
    this.opencodeProcess = process;

    console.error(`[Pixel Agents] OpenCode server: ${url}`);

    // Create a session
    const session = await createSession(url);
    this.sessionId = session.id;
    console.error(`[Pixel Agents] Session: ${session.id}`);

    // Subscribe to events
    this.sseClose = sseSubscribe(url, (event) => this.handleEvent(event));

    // Start HTTP server for webview
    this.startHttpServer(port);
  }

  private handleEvent(event: any): void {
    // console.error("[Pixel Agents] Event:", JSON.stringify(event, null, 2));

    if (event.type === "message.part.updated") {
      const part = event.properties?.part;
      if (!part) return;

      // Tool activity
      if (part.type === "tool") {
        const toolCallId = part.callID || part.id;
        const toolName = part.tool || "unknown";
        const state = part.state?.status;

        if (state === "running") {
          this.activeTools.set(toolCallId, { tool: toolName, status: "running", input: part.state?.input });
          this.broadcast({
            type: "agentToolStart",
            id: 1,
            toolId: toolCallId,
            status: formatToolStatus(toolName, part.state?.input)
          });
          this.broadcast({ type: "agentStatus", id: 1, status: "active" });
        } else if (state === "completed" || state === "error") {
          this.activeTools.delete(toolCallId);
          this.broadcast({
            type: "agentToolDone",
            id: 1,
            toolId: toolCallId
          });
        }
      }
    }

    if (event.type === "message.updated") {
      const info = event.properties?.info;
      if (!info) return;

      // Message completed - agent is waiting
      if (info.role === "assistant" && info.time?.completed) {
        this.activeTools.clear();
        this.broadcast({ type: "agentToolsClear", id: 1 });
        this.broadcast({ type: "agentStatus", id: 1, status: "waiting" });
      }
    }
  }

  private broadcast(message: any): void {
    // Send to all connected webview clients
    const data = JSON.stringify(message);
    for (const client of this.wsClients) {
      try {
        client.send(data);
      } catch {}
    }
    console.error("[Pixel Agents] Broadcast:", message.type, message.status || "");
  }

  private startHttpServer(port: number): void {
    this.httpServer = createServer((req, res) => {
      // CORS headers
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.url === "/events") {
        // Server-Sent Events for webview
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        });

        // Send initial connection message
        res.write("data: {\"type\":\"connected\"}\n\n");

        // Keep alive
        const keepAlive = setInterval(() => {
          res.write(": keepalive\n\n");
        }, 30000);

        req.on("close", () => clearInterval(keepAlive));
        return;
      }

      if (req.url === "/ws") {
        // WebSocket upgrade (simple version - just use SSE for now)
        res.writeHead(400, "Use /events SSE endpoint");
        res.end();
        return;
      }

      // Serve static files from webview-ui/dist
      const fs = require("fs");
      const path = require("path");
      
      let filePath = req.url === "/" ? "/index.html" : req.url!;
      filePath = path.join(__dirname, "webview-ui", "dist", filePath);
      
      const ext = path.extname(filePath);
      const contentTypes: Record<string, string> = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".json": "application/json",
      };

      fs.readFile(filePath, (err: any, data: Buffer) => {
        if (err) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": contentTypes[ext] || "text/plain" });
        res.end(data);
      });
    });

    this.httpServer.listen(port, () => {
      console.error(`[Pixel Agents] Server running at http://localhost:${port}`);
    });
  }

  async stop(): Promise<void> {
    if (this.sseClose) this.sseClose();
    if (this.opencodeProcess) this.opencodeProcess.kill();
    if (this.httpServer) this.httpServer.close();
  }

  sendMessage(text: string): void {
    if (this.opencodeUrl && this.sessionId) {
      sendMessage(this.opencodeUrl, this.sessionId, text);
    }
  }
}

// CLI
const args = process.argv.slice(2);
const cwd = args[0] || process.cwd();
const port = parseInt(args[1]) || DEFAULT_PORT;

const server = new PixelAgentsServer();
server.start(cwd, port).catch(err => {
  console.error("[Pixel Agents] Failed to start:", err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await server.stop();
  process.exit(0);
});
