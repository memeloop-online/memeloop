import http from "node:http";

// ─── Types ──────────────────────────────────────────────────────────────

export interface MockRule {
  /** Assistant content to return for this call. */
  response: string;
  /** Whether to simulate streaming via SSE chunks (default false). */
  stream?: boolean;
  /** Optional: split response into multiple SSE chunks via this separator. */
  splitSeparator?: string;
}

export interface StartedMockOpenAI {
  server: http.Server;
  port: number;
  baseUrl: string;
  /** Replace all rules. Does NOT reset call count. */
  setRules(rules: MockRule[]): void;
  /** Append additional rules to the end. */
  addRules(rules: MockRule[]): void;
  /** Reset call count to 0 (next API call = rules[0]). */
  resetCount(): void;
  /** Stop the server. */
  stop(): Promise<void>;
}

// ─── Implementation ─────────────────────────────────────────────────────

export async function startMockOpenAI(rules: MockRule[]): Promise<StartedMockOpenAI> {
  let currentRules: MockRule[] = [...rules];
  let callIndex = 0;

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.writeHead(200);
      res.end();
      return;
    }

    // Admin: reset call count
    if (req.method === "POST" && url === "/reset") {
      callIndex = 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // Chat completions
    if (req.method === "POST" && url.startsWith("/v1/chat/completions")) {
      let body = "";
      req.on("data", (d: Buffer) => { body += d.toString(); });
      req.on("end", () => {
        const ruleIdx = Math.min(callIndex, currentRules.length - 1);
        const rule = currentRules[ruleIdx];
        callIndex += 1;

        if (!rule) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: `chatcmpl_mock_empty`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "mock-model",
            choices: [],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }));
          return;
        }

        const isStream = body.includes('"stream":true') || rule.stream === true;

        if (isStream) {
          // SSE streaming
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.writeHead(200);

          const separator = rule.splitSeparator ?? "<stream_split>";
          const chunks = rule.response.split(separator);

          const writeChunk = (delta: Record<string, string | null>, finishReason: string | null = null) => {
            if (res.writableEnded) return;
            const payload = {
              id: `chatcmpl_mock_${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "mock-model",
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          };

          // 1) role chunk
          writeChunk({ role: "assistant", content: null });
          // 2) content chunks
          for (const chunk of chunks) {
            writeChunk({ content: chunk });
          }
          // 3) final done chunk
          writeChunk({}, "stop");
          res.write(`data: [DONE]\n\n`);
          res.end();
          return;
        }

        // Non-streaming JSON
        const payload = {
          id: `chatcmpl_mock`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "mock-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: rule.response },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      });
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start mock OpenAI server");
  }

  return {
    server,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    setRules(r: MockRule[]) {
      currentRules = [...r];
    },
    addRules(r: MockRule[]) {
      currentRules.push(...r);
    },
    resetCount() {
      callIndex = 0;
    },
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
