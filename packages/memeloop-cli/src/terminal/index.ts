export { TerminalSessionManager } from './sessionManager.js';
export type { ITerminalSessionManager, StartSessionOptions, TerminalSessionMode } from './sessionManager.js';
export { prepareTerminalSessionStorage, TerminalOutputPersistenceError, wireTerminalOutputToStorage } from './sessionStorage.js';
export { createThrottledTerminalOutputNotify, type ThrottledTerminalNotify } from './throttleOutputNotify.js';
export type { TerminalFollowResult, TerminalInteractionPrompt, TerminalOutputChunk, TerminalSessionInfo, TerminalSessionStatus } from './types.js';
