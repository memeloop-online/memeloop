/**
 * Browser-safe entry point for memeloop.
 *
 * Bundlers that respect the "browser" condition (Vite, webpack, etc.) will
 * resolve `import ... from 'memeloop'` to this file instead of the full Node.js
 * entry, avoiding libp2p, crypto, and other Node.js-specific dependencies.
 *
 * Only type-only re-exports and browser-safe utilities are included.
 * For the full Node.js runtime, import from 'memeloop/node' or use the
 * "default"/"node" condition.
 */

// ── Types (compile-time only — erased by TypeScript/esbuild) ──────────────
export type * from './agent-management/types.js';
export type * from './agent/agentProfileRegistry.js';
export type * from './agent/agentProfiles.js';
export type * from './agent/types.js';
export type * from './conversation/types.js';
export type * from './device-network/index.js';
export type * from './im/index.js';
export type * from './llm/providerRegistry.js';
export type * from './loopAPI/types.js';
export type * from './orchestration/index.js';
export type * from './permission/index.js';
export type * from './plugin/index.js';
export type * from './promptUtilities/types.js';
export type * from './storage/sessionStorage.js';
export type * from './sync/protocol.js';
export type * from './types.js';

// Re-export AgentInstance type (used by UI layer)
export type { AgentInstanceModel, AgentInstanceModel as AgentInstance } from './types.js';

// ── Browser-safe runtime values (no libp2p, no Node.js APIs) ─────────────

// Categories — constants with no dependencies
export * from './agent/categories.js';

// Agent management contracts — headless, type-only based
export * from './agent-management/index.js';
