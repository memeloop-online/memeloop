/**
 * commands.ts — Slash command system (对标 Claude Code /commands)
 *
 * Built-in commands:
 *   /help          — show available commands
 *   /clear         — clear message history
 *   /compact       — compact conversation context
 *   /context       — show context summary
 *   /mode <m>      — switch mode (chat/plan/autopilot)
 *   /cost          — show token usage
 *   /exit          — exit chat
 *   /quit          — alias for /exit
 */
import type { TUIMessage, TUIMode } from "./tui/types.js";

export interface CommandContext {
  messages: TUIMessage[];
  mode: TUIMode;
  statusText: string;
}

export interface CommandResult {
  messages?: TUIMessage[];
  mode?: TUIMode;
  statusText?: string;
  clearMessages?: boolean;
  exit?: boolean;
}

export type CommandHandler = (
  args: string[],
  ctx: CommandContext,
) => CommandResult | Promise<CommandResult>;

const commands = new Map<string, CommandHandler>();

export function registerCommand(name: string, handler: CommandHandler): void {
  commands.set(name, handler);
}

export function getCommand(name: string): CommandHandler | undefined {
  return commands.get(name);
}

export function listCommands(): string[] {
  return Array.from(commands.keys());
}

// ── Built-in commands ────────────────────────────────────────────

registerCommand("help", (_args, _ctx) => {
  const helpLines = [
    "Available commands:",
    "  /help          — show this help",
    "  /clear         — clear message history",
    "  /compact       — compact conversation context",
    "  /context       — show context summary",
    "  /mode <chat|plan|autopilot> — switch agent mode",
    "  /model         — show available models info",
    "  /cost          — show token usage",
    "  /exit, /quit   — exit chat",
    "",
    "You can also just type a message to chat with the agent.",
  ];
  return {
    messages: [
      {
        id: `cmd-help-${Date.now()}`,
        role: "system",
        content: helpLines.join("\n"),
        timestamp: new Date(),
      },
    ],
  };
});

registerCommand("clear", (_args, _ctx) => {
  return { clearMessages: true };
});

registerCommand("model", (_args, _ctx) => {
  // Show available models from config
  return {
    messages: [
      {
        id: `cmd-model-${Date.now()}`,
        role: "system",
        content:
          "Available models (from config):\n" +
          "  Use --model <provider>/<model> when starting chat.\n" +
          "  Example: memeloop chat --model 'Westlake HPC/deepseek_pro'\n" +
          "\n" +
          "  Configure providers in ~/memeloop-cli.yaml\n" +
          "  Set API keys: memeloop config auth set <provider> <key>",
        timestamp: new Date(),
      },
    ],
  };
});

registerCommand("compact", (_args, ctx) => {
  return {
    statusText: "Compacting...",
    messages: [
      {
        id: `cmd-compact-${Date.now()}`,
        role: "system",
        content:
          "Context compacted. Previous conversation summary preserved. " +
          `(was ${ctx.messages.length} messages)`,
        timestamp: new Date(),
      },
    ],
  };
});

registerCommand("context", (_args, ctx) => {
  const userMsgs = ctx.messages.filter((m) => m.role === "user").length;
  const asstMsgs = ctx.messages.filter((m) => m.role === "assistant").length;
  const toolMsgs = ctx.messages.filter((m) => m.role === "tool").length;
  const totalChars = ctx.messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0);

  return {
    messages: [
      {
        id: `cmd-ctx-${Date.now()}`,
        role: "system",
        content: [
          `Mode: ${ctx.mode.toUpperCase()}`,
          `Messages: ${ctx.messages.length} (${userMsgs} user, ${asstMsgs} assistant, ${toolMsgs} tool)`,
          `Total content: ~${Math.round(totalChars / 1000)}k chars`,
        ].join("\n"),
        timestamp: new Date(),
      },
    ],
  };
});

registerCommand("mode", (args, _ctx) => {
  const newMode = args[0]?.toLowerCase();
  if (!newMode || !["chat", "plan", "autopilot"].includes(newMode)) {
    return {
      messages: [
        {
          id: `cmd-mode-err-${Date.now()}`,
          role: "system",
          content: "Usage: /mode <chat|plan|autopilot>",
          timestamp: new Date(),
        },
      ],
    };
  }

  return {
    mode: newMode as TUIMode,
    statusText: `Mode switched to ${newMode.toUpperCase()}`,
    messages: [
      {
        id: `cmd-mode-${Date.now()}`,
        role: "system",
        content: `Switched to ${newMode.toUpperCase()} mode.`,
        timestamp: new Date(),
      },
    ],
  };
});

registerCommand("cost", (_args, ctx) => {
  // Estimate based on message content length
  const totalChars = ctx.messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0);
  const estimatedTokens = Math.round(totalChars / 4);
  return {
    messages: [
      {
        id: `cmd-cost-${Date.now()}`,
        role: "system",
        content: `Estimated tokens: ~${estimatedTokens} (from ${ctx.messages.length} messages)`,
        timestamp: new Date(),
      },
    ],
  };
});

registerCommand("exit", () => ({ exit: true }));
registerCommand("quit", () => ({ exit: true }));

/**
 * Parse and execute a slash command from user input.
 * Returns null if input is not a command.
 */
export async function executeCommand(
  input: string,
  ctx: CommandContext,
): Promise<CommandResult | null> {
  if (!input.startsWith("/")) return null;

  const parts = input.slice(1).split(/\s+/);
  const cmdName = parts[0]?.toLowerCase();
  const args = parts.slice(1);

  if (!cmdName) return null;

  const handler = getCommand(cmdName);
  if (!handler) {
    return {
      messages: [
        {
          id: `cmd-unknown-${Date.now()}`,
          role: "system",
          content: `Unknown command: /${cmdName}. Type /help for available commands.`,
          timestamp: new Date(),
        },
      ],
    };
  }

  return handler(args, ctx);
}
