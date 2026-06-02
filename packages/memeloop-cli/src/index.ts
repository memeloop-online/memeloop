export { loadConfig, saveConfig, getDefaultConfigPath } from "./config";
export type { NodeConfig, ProviderEntry, ToolPermissionConfig } from "./config";
export { createNodeRuntime, ToolRegistry } from "./runtime/index.js";
export type {
  NodeRuntimeOptions,
  NodeRuntimeResult,
  NodeRuntimeBuiltinToolOverrides,
} from "./runtime/index.js";
export { TerminalSessionManager } from "./terminal/index.js";
export type {
  ITerminalSessionManager,
  StartSessionOptions,
  TerminalSessionInfo,
  TerminalOutputChunk,
  TerminalInteractionPrompt,
} from "./terminal/index.js";
export type { IWikiManager, TiddlerFields } from "./knowledge/index.js";
export { registerNodeEnvironmentTools } from "./tools/registerNodeEnvironmentTools.js";
export type { RegisterNodeEnvironmentToolsOptions } from "./tools/registerNodeEnvironmentTools.js";
export {
  getDefaultKeypairPath,
  loadNodeKeypair,
  loadOrCreateNodeKeypair,
  nodeIdFromX25519PublicKey,
  saveNodeKeypair,
} from "./auth/keypair.js";
export type { NodeKeypair } from "./auth/keypair.js";
export { CloudClient, buildRegistrationPayload } from "./auth/cloudClient.js";
export type {
  CloudRegisterOtpResult,
  CloudJwtResult,
  CloudNodeChallengeResult,
  NodeRegistrationPayload,
} from "./auth/cloudClient.js";

// Network: node server, RPC, peer management
export { createNodeServer, startNodeServerWithMdns } from "./network/index.js";
export type { NodeServerOptions, NodeGitHandler } from "./network/index.js";
export { PeerConnectionManager } from "./network/index.js";
export type { PeerConnectionManagerOptions } from "./network/index.js";
export { handleRpc } from "./network/index.js";
export type { RpcHandlerContext } from "./network/index.js";
