// Core protocol types that are shared across modules
export * from "./message.js";
export * from "./attachment.js";
export * from "./uri.js";

// Terminal streaming WebSocket notification method name
export const MEMELOOP_TERMINAL_OUTPUT_NOTIFICATION = "memeloop.terminal.output.delta" as const;
export type MemeloopTerminalOutputNotificationMethod = typeof MEMELOOP_TERMINAL_OUTPUT_NOTIFICATION;
