# ACP — Agent Communication Protocol

ACP (Agent Communication Protocol) enables MemeLoop nodes to expose agent capabilities as a JSON-RPC server, allowing IDE integrations (VSCode, Zed, JetBrains) to communicate with agents directly.

## What is ACP

ACP is a JSON-RPC 2.0 protocol layer over stdio or TCP/WebSocket transport. It standardizes how external clients (IDEs, editors, CLI tools) can:

- Discover available agents and their capabilities
- Start agent sessions
- Send messages and receive streaming responses
- Execute tools with approval workflows
- Subscribe to status changes

### ACP vs Node RPC

| Feature | Node RPC (`memeloop-cli`) | ACP Server |
|---------|---------------------------|------------|
| Transport | WebSocket | stdio / TCP / WS |
| Client | Other MemeLoop nodes | IDEs, editors, external tools |
| Auth | Noise_XX + Ed25519 | Token-based or none (localhost) |
| Purpose | Peer sync, node management | Agent interaction, IDE bridge |
| Protocol | Custom JSON-RPC | MCP-compatible JSON-RPC |

## How to Start ACP Server

### CLI Mode

```bash
# Start ACP over stdio (for IDE extensions)
memeloop acp --stdio

# Start ACP over TCP port
memeloop acp --port 8080

# Start ACP with a specific agent definition
memeloop acp --stdio --agent memeloop:build

# Start with skill restrictions
memeloop acp --stdio --skills security-audit,performance-review
```

### Programmatic Mode

```typescript
import { createAcpServer } from "memeloop/acp";
import { getAgentRegistry } from "memeloop/agent/agentRegistry";

const server = createAcpServer({
  transport: "stdio", // "stdio" | "tcp" | "websocket"
  port: 8080,
  agentRegistry: getAgentRegistry(),
  defaultAgentId: "memeloop:build",
  allowedOrigins: ["vscode://memeloop.extension", "zed://memeloop"],
});

await server.start();

// Handle shutdown
process.on("SIGINT", async () => {
  await server.stop();
  process.exit(0);
});
```

### Configuration File

```json
// ~/.memeloop/acp.json
{
  "transport": "stdio",
  "defaultAgentId": "memeloop:build",
  "skills": ["security-audit"],
  "logging": {
    "level": "info",
    "file": "~/.memeloop/logs/acp.log"
  },
  "ide": {
    "autoDetect": true,
    "bridgePort": 38473
  }
}
```

## JSON-RPC Protocol Reference

### Transport

ACP uses line-delimited JSON-RPC 2.0 messages:

```
Content-Length: 123\r\n
\r\n
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
```

### Methods

#### `initialize`

Client-server handshake. Must be the first message.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "sampling": {},
      "roots": { "listChanged": true }
    },
    "clientInfo": {
      "name": "vscode-memeloop",
      "version": "1.0.0"
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "prompts": { "listChanged": true },
      "resources": { "subscribe": true, "listChanged": true },
      "tools": { "listChanged": true }
    },
    "serverInfo": {
      "name": "memeloop-acp",
      "version": "0.1.0"
    }
  }
}
```

#### `agents/list`

List available agent definitions.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "agents/list",
  "params": {}
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "agents": [
      {
        "id": "memeloop:build",
        "name": "Build Agent",
        "description": "Execute tasks, write code, run commands",
        "type": "build",
        "tools": ["file.read", "file.write", "terminal.exec"],
        "modelConfig": { "provider": "openai", "model": "gpt-4o" }
      },
      {
        "id": "memeloop:explore",
        "name": "Explore Agent",
        "description": "Fast codebase search and discovery",
        "type": "explore",
        "tools": ["file.read", "grep.search", "lsp.*"]
      }
    ]
  }
}
```

#### `agents/start`

Start a new agent session.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "agents/start",
  "params": {
    "agentId": "memeloop:build",
    "conversationId": "conv-abc-123",
    "initialMessage": "Refactor the auth module to use JWT",
    "context": {
      "fileBaseDir": "/home/user/project",
      "skills": ["security-audit"]
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "sessionId": "sess-xyz-789",
    "conversationId": "conv-abc-123",
    "status": "working",
    "agentId": "memeloop:build"
  }
}
```

#### `messages/send`

Send a message to an active session.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "messages/send",
  "params": {
    "sessionId": "sess-xyz-789",
    "message": "Also add rate limiting to the login endpoint"
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "messageId": "msg-001",
    "status": "accepted"
  }
}
```

#### `messages/stream`

Subscribe to streaming responses (server → client notifications).

**Client subscribes:**
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "messages/stream",
  "params": {
    "sessionId": "sess-xyz-789"
  }
}
```

**Server sends notifications:**
```json
{
  "jsonrpc": "2.0",
  "method": "messages/stream",
  "params": {
    "sessionId": "sess-xyz-789",
    "chunk": {
      "type": "message",
      "data": "I'll refactor the auth module..."
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "method": "messages/stream",
  "params": {
    "sessionId": "sess-xyz-789",
    "chunk": {
      "type": "tool",
      "data": {
        "toolId": "file.read",
        "parameters": { "path": "src/auth.ts" },
        "result": "...",
        "isError": false
      }
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "method": "messages/stream",
  "params": {
    "sessionId": "sess-xyz-789",
    "chunk": {
      "type": "thinking",
      "data": { "status": "completed", "conversationId": "conv-abc-123" }
    }
  }
}
```

#### `tools/execute`

Execute a tool directly (bypassing the agent loop).

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/execute",
  "params": {
    "toolId": "file.read",
    "parameters": { "path": "README.md" }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "success": true,
    "data": "# MemeLoop\n\n...",
    "duration": 12
  }
}
```

#### `tools/list`

List available tools.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/list",
  "params": {}
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "tools": [
      {
        "name": "file.read",
        "description": "Read a file from disk",
        "inputSchema": {
          "type": "object",
          "properties": {
            "path": { "type": "string" }
          },
          "required": ["path"]
        }
      },
      {
        "name": "terminal.exec",
        "description": "Execute a terminal command",
        "inputSchema": {
          "type": "object",
          "properties": {
            "command": { "type": "string" },
            "timeoutMs": { "type": "number" }
          },
          "required": ["command"]
        }
      }
    ]
  }
}
```

#### `approval/request`

Request user approval for a tool call.

**Server → Client notification:**
```json
{
  "jsonrpc": "2.0",
  "method": "approval/request",
  "params": {
    "approvalId": "approval-001",
    "sessionId": "sess-xyz-789",
    "toolId": "terminal.exec",
    "parameters": { "command": "rm -rf node_modules" },
    "timeoutMs": 60000
  }
}
```

**Client → Server response:**
```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "approval/resolve",
  "params": {
    "approvalId": "approval-001",
    "decision": "deny"
  }
}
```

### Error Responses

```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "error": {
    "code": -32602,
    "message": "Invalid params",
    "data": { "field": "agentId", "reason": "Agent not found" }
  }
}
```

**Error Codes:**

| Code | Meaning |
|------|---------|
| `-32700` | Parse error |
| `-32600` | Invalid request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |
| `-32000` | Agent not found |
| `-32001` | Session not found |
| `-32002` | Tool execution failed |
| `-32003` | Approval denied |

## IDE Integration Examples

### VSCode Extension

```typescript
// vscode-extension/src/acpClient.ts
import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";

export class AcpClient extends EventEmitter {
  private proc: ChildProcess;
  private messageBuffer = "";
  private nextId = 1;

  constructor() {
    super();
    this.proc = spawn("memeloop", ["acp", "--stdio"], {
      cwd: workspace.workspaceFolders?.[0]?.uri.fsPath,
    });

    this.proc.stdout?.on("data", (data) => this.handleData(data));
    this.proc.stderr?.on("data", (data) => console.error("[ACP]", data.toString()));
  }

  private handleData(data: Buffer) {
    this.messageBuffer += data.toString();
    while (true) {
      const lengthMatch = this.messageBuffer.match(/Content-Length: (\d+)\r\n/);
      if (!lengthMatch) break;
      const length = parseInt(lengthMatch[1], 10);
      const headerEnd = this.messageBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const messageStart = headerEnd + 4;
      if (this.messageBuffer.length < messageStart + length) break;

      const message = this.messageBuffer.slice(messageStart, messageStart + length);
      this.messageBuffer = this.messageBuffer.slice(messageStart + length);
      this.emit("message", JSON.parse(message));
    }
  }

  send(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const payload = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
    this.proc.stdin?.write(payload);

    return new Promise((resolve) => {
      const handler = (msg: any) => {
        if (msg.id === id) {
          this.off("message", handler);
          resolve(msg.result ?? msg.error);
        }
      };
      this.on("message", handler);
    });
  }

  async initialize() {
    return this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vscode-memeloop", version: "1.0.0" },
    });
  }

  async listAgents() {
    return this.send("agents/list", {});
  }

  async startAgent(agentId: string, message: string) {
    return this.send("agents/start", {
      agentId,
      conversationId: `vscode-${Date.now()}`,
      initialMessage: message,
    });
  }

  dispose() {
    this.proc.kill();
  }
}
```

### VSCode Extension Usage

```typescript
// vscode-extension/src/extension.ts
import * as vscode from "vscode";
import { AcpClient } from "./acpClient";

export function activate(context: vscode.ExtensionContext) {
  const client = new AcpClient();

  const disposable = vscode.commands.registerCommand("memeloop.askAgent", async () => {
    const prompt = await vscode.window.showInputBox({ prompt: "Ask MemeLoop" });
    if (!prompt) return;

    await client.initialize();
    const session = await client.startAgent("memeloop:build", prompt);

    const panel = vscode.window.createWebviewPanel(
      "memeloopChat",
      "MemeLoop",
      vscode.ViewColumn.Two,
      {},
    );

    client.on("message", (msg) => {
      if (msg.method === "messages/stream") {
        const chunk = msg.params.chunk;
        if (chunk.type === "message") {
          panel.webview.postMessage({ type: "text", content: chunk.data });
        } else if (chunk.type === "tool") {
          panel.webview.postMessage({ type: "tool", ...chunk.data });
        }
      }
    });
  });

  context.subscriptions.push(disposable, { dispose: () => client.dispose() });
}
```

### Zed Extension

```rust
// zed-extension/src/memeloop.rs
use zed_extension_api::{self as zed, Command, Extension, Result};

struct MemeLoopExtension;

impl Extension for MemeLoopExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(&mut self, _config: zed::LanguageServerConfig) -> Result<Command> {
        Ok(Command {
            command: "memeloop".to_string(),
            args: vec!["acp".to_string(), "--stdio".to_string()],
            env: Default::default(),
        })
    }
}

zed::register_extension!(MemeLoopExtension);
```

## Implementation Status

ACP is a **Phase 3 roadmap feature**. The protocol specification above defines the target API. Current building blocks exist in:

- `@memeloop/protocol` — JSON-RPC message types and agent definitions
- `memeloop-cli` — Node server with WebSocket JSON-RPC transport
- `packages/memeloop/src/framework/taskAgent.ts` — Agent runtime ready for external session management

### Minimal ACP Server Stub

```typescript
// Planned implementation: packages/memeloop-cli/src/acp/server.ts
import { createNodeServer } from "../server/nodeServer";
import { getAgentRegistry } from "memeloop/agent/agentRegistry";

export async function createAcpServer(options: AcpServerOptions) {
  const registry = options.agentRegistry ?? getAgentRegistry();

  return createNodeServer({
    port: options.port ?? 8080,
    rpcHandlers: {
      "acp/initialize": async (params) => {
        return {
          protocolVersion: params.protocolVersion,
          capabilities: { prompts: {}, resources: {}, tools: {} },
          serverInfo: { name: "memeloop-acp", version: "0.1.0" },
        };
      },
      "acp/agents/list": async () => {
        return { agents: registry.listAgents() };
      },
      // ... additional methods
    },
  });
}
```

## Best Practices

1. **Use stdio for local IDE integration** — No network stack, lowest latency
2. **Use TCP/WS for remote development** — Pair with `memeloop-cli` tunneling
3. **Always call `initialize` first** — The server rejects other methods before handshake
4. **Handle `approval/request` notifications** — IDEs must surface approval UI for restricted tools
5. **Stream responses incrementally** — Use `messages/stream` for real-time UX
6. **Set reasonable timeouts** — Default 60s for approvals, 30s for tool execution
