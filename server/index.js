// OpenCode ACP Client for Pixel Agents
// Connects to OpenCode server and streams events to the pixel office webview

const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { readFileSync, existsSync } = require("node:fs");
const { join, extname } = require("node:path");

const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";
const DEFAULT_PORT = 5173;

// Parse listening URL from OpenCode output
function parseListeningUrl(text) {
  const m = text.match(/opencode server listening on (https?:\/\/[^\s]+)/i);
  return m ? m[1] : null;
}

// Start OpenCode server in a directory
async function startOpenCodeServer(cwd) {
  console.error("[Pixel Agents] Starting OpenCode server in:", cwd);

  const child = spawn(OPENCODE_BIN, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd,
    env: { ...process.env, OPENCODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: true
  });

  let url = undefined;
  let stdoutData = "";
  let stderrData = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdoutData += text;
    console.error("[Pixel Agents] opencode stdout:", text);
    const maybeUrl = parseListeningUrl(text);
    if (maybeUrl) url = maybeUrl;
  });

  child.stderr.on("data", (chunk) => {
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
async function createSession(baseUrl) {
  const res = await fetch(`${baseUrl}/session`, { method: "POST", body: JSON.stringify({}) });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  return res.json();
}

// Subscribe to SSE events
function sseSubscribe(baseUrl, onEvent) {
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

// Send a message to a session - async style
async function sendMessageAsync(baseUrl, sessionId, text, onEvent) {
  console.error("[Pixel Agents] Sending message:", text);
  
  // Send the message - this starts processing but we get a message ID back
  const body = {
    parts: [{ type: "text", text: text }],
    agent: "build"
  };
  
  const res = await fetch(`${baseUrl}/session/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  
  if (!res.ok) {
    const err = await res.text();
    console.error("[Pixel Agents] Send error:", res.status, err);
    return;
  }
  
  const result = await res.json();
  console.error("[Pixel Agents] Send result:", JSON.stringify(result));
  
  // The message was sent - events will come via SSE
  // We just need to wait for completion
  // For now, just mark as active
  onEvent({ type: 'agentStatus', status: 'active' });
}

// Format tool for display
function formatToolStatus(toolName, input) {
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
  constructor() {
    this.httpServer = null;
    this.opencodeProcess = null;
    this.opencodeUrl = null;
    this.sessionId = null;
    this.sseClose = null;
    this.activeTools = new Map();
    this.eventSource = null;
  }

  async start(cwd, port = DEFAULT_PORT) {
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

  handleEvent(event) {
    // console.error("[Pixel Agents] Event received:", JSON.stringify(event));

    // Track session status
    if (event.type === "session.status") {
      const status = event.properties?.status?.type;
      if (status === "busy") {
        this.broadcast({ type: "agentStatus", id: 1, status: "active" });
      } else if (status === "idle") {
        this.broadcast({ type: "agentStatus", id: 1, status: "waiting" });
      }
    }

    // Handle message parts (reasoning, text, tool)
    if (event.type === "message.part.updated") {
      const part = event.properties?.part;
      if (!part) return;

      // Reasoning = thinking
      if (part.type === "reasoning") {
        this.broadcast({ type: "agentThinking", id: 1, text: part.text?.slice(0, 100) });
      }

      // Text output
      if (part.type === "text" && part.text) {
        // First text part means agent is responding
        this.broadcast({ type: "agentResponding", id: 1, text: part.text?.slice(0, 100) });
      }

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
        } else if (state === "completed" || state === "error") {
          this.activeTools.delete(toolCallId);
          this.broadcast({ type: "agentToolDone", id: 1, toolId: toolCallId });
        }
      }

      // Step start/finish
      if (part.type === "step-start") {
        this.broadcast({ type: "agentStatus", id: 1, status: "active" });
      }
      if (part.type === "step-finish") {
        this.broadcast({ type: "agentToolsClear", id: 1 });
      }
    }

    // Handle message completion
    if (event.type === "message.updated") {
      const info = event.properties?.info;
      if (!info) return;

      if (info.role === "assistant" && info.time?.completed) {
        this.activeTools.clear();
        this.broadcast({ type: "agentToolsClear", id: 1 });
        this.broadcast({ type: "agentStatus", id: 1, status: "waiting" });
      }
    }
  }

  broadcast(message) {
    // Send to all connected webview clients
    const data = JSON.stringify(message);
    if (this.eventSource) {
      try {
        this.eventSource.write(`data: ${data}\n\n`);
      } catch {}
    }
    console.error("[Pixel Agents] Broadcast:", message.type, message.status || "");
  }

  startHttpServer(port) {
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

        this.eventSource = res;

        // Send initial connection message
        res.write("data: {\"type\":\"connected\"}\n\n");

        // Keep alive
        const keepAlive = setInterval(() => {
          try {
            res.write(": keepalive\n\n");
          } catch {
            clearInterval(keepAlive);
          }
        }, 30000);

        req.on("close", () => {
          clearInterval(keepAlive);
          this.eventSource = null;
        });
        return;
      }

      // Serve static files from webview.html
      let filePath = req.url === "/" ? "/webview.html" : req.url;
      
      const fs = require("node:fs");
      const path = require("node:path");
      
      // Handle /prompt endpoint
      if (req.url === "/prompt" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
          try {
            const { text } = JSON.parse(body);
            // Send message and broadcast events as they come
            sendMessageAsync(server.opencodeUrl, server.sessionId, text, (event) => {
              server.broadcast(event);
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, message: "Processing..." }));
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }
      
      filePath = path.join(__dirname, filePath);
      
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found: " + filePath);
        return;
      }

      const ext = extname(filePath);
      const contentTypes = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".json": "application/json"
      };

      try {
        const data = readFileSync(filePath);
        res.writeHead(200, { "Content-Type": contentTypes[ext] || "text/plain" });
        res.end(data);
      } catch (err) {
        res.writeHead(500);
        res.end(err.message);
      }
    });

    this.httpServer.listen(port, () => {
      console.error(`[Pixel Agents] Server running at http://localhost:${port}`);
      console.error(`[Pixel Agents] Open this URL in your browser!`);
    });
  }

  async stop() {
    if (this.sseClose) this.sseClose();
    if (this.opencodeProcess) this.opencodeProcess.kill();
    if (this.httpServer) this.httpServer.close();
  }

  sendMessage(text) {
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
