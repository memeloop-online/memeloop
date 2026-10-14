import packageManifest from '../package.json' with { type: 'json' };

/**
 * Published CLI identity used by Commander, SSH bootstrap, MCP, and LSP.
 * Bundle the package version so remote exact-version installation cannot
 * silently drift from the archive being executed.
 */
export const MEMELOOP_CLI_VERSION = packageManifest.version;
