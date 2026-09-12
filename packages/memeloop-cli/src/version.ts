/**
 * Published CLI identity used by Commander, SSH bootstrap, MCP, and LSP.
 * A release test keeps this value equal to package.json so remote exact-version
 * installation cannot silently drift from the archive being executed.
 */
export const MEMELOOP_CLI_VERSION = '0.3.1';
