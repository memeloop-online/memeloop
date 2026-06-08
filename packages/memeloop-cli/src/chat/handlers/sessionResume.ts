import type { TUIMessage } from "../../tui/types.js";
import type { ChatHooks } from "../hooks.js";
import type { ChatHookContext } from "../types.js";

export function registerSessionResumeHandler(hooks: ChatHooks) {
  hooks.beforeTUIRender.tapAsync("session-resume", (context, callback) => {
    void resumeSession(context).then(() => {
      callback();
    }, callback);
  });
}

async function resumeSession(context: ChatHookContext): Promise<void> {
  if (!context.options.continueLast && !context.options.resumeSessionId) return;
  if (!context.runtime) return;

  const { listSessions, resumeSession } = await import("../../sessions.js");

  let sessionId = context.options.resumeSessionId;
  if (!sessionId) {
    const sessions = await listSessions(context.runtime);
    if (sessions.length > 0) {
      sessionId = sessions[0].id;
      context.initialMessages.push({
        id: `sys-resume-${Date.now()}`,
        role: "system",
        content: `Resuming session: ${sessions[0].title} (${sessions[0].messageCount} messages)`,
        timestamp: new Date(),
      });
    }
  }

  if (sessionId) {
    const resumed = await resumeSession(context.runtime, sessionId);
    if (resumed?.messages) {
      context.initialMessages.push(
        ...resumed.messages.map((m) => ({
          id: m.messageId ?? m.id ?? `hist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          role: (m.role as TUIMessage["role"]) ?? "assistant",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
        })),
      );
    }
  }
}
