import path from 'node:path';

import type { NodeTrustClass } from 'memeloop';

export type WorkerMode = 'ordinary' | 'restricted' | 'quarantine';

export interface WorkerModeConfig {
  mode: WorkerMode;
  /** Separate data directory for this worker mode. */
  dataDir: string;
  /** Separate identity path; restricted/quarantine workers never use the ordinary daemon identity. */
  identityPath: string;
  /** Whether to load plugins from the ordinary plugin directories. */
  enableOrdinaryPlugins: boolean;
  /** Whether to inherit ordinary daemon credentials. */
  inheritOrdinaryCredentials: boolean;
  /** Signed allowlist of plugin paths that may be loaded in this mode. */
  allowedPluginPaths?: string[];
}

const MODE_DIRECTORY_SUFFIX: Record<WorkerMode, string> = {
  ordinary: '',
  restricted: '-restricted',
  quarantine: '-quarantine',
};

/**
 * Resolve the worker mode configuration from CLI options and environment.
 *
 * Restricted and quarantine workers always use separate directories and
 * identities, never inherit ordinary daemon credentials, and do not load
 * ordinary plugins unless explicitly allowed by a signed manifest.
 */
export function resolveWorkerModeConfig(options: {
  mode?: WorkerMode;
  dataDir?: string;
  identityPath?: string;
  allowedPluginPaths?: string[];
}): WorkerModeConfig {
  const mode = options.mode ?? 'ordinary';
  const baseDataDirectory = options.dataDir ?? process.cwd();
  const baseIdentityPath = options.identityPath ?? path.join(baseDataDirectory, 'device-identity.json');

  if (mode === 'ordinary') {
    return {
      mode,
      dataDir: baseDataDirectory,
      identityPath: baseIdentityPath,
      enableOrdinaryPlugins: true,
      inheritOrdinaryCredentials: true,
    };
  }

  // Restricted/quarantine modes use separate directories and identities.
  const dataDirectory = `${baseDataDirectory}${MODE_DIRECTORY_SUFFIX[mode]}`;
  const identityPath = `${baseIdentityPath}${MODE_DIRECTORY_SUFFIX[mode]}`;

  return {
    mode,
    dataDir: dataDirectory,
    identityPath,
    enableOrdinaryPlugins: false,
    inheritOrdinaryCredentials: false,
    allowedPluginPaths: options.allowedPluginPaths,
  };
}

/**
 * Check whether a plugin path is allowed in the given worker mode.
 */
export function isPluginAllowedInMode(config: WorkerModeConfig, pluginPath: string): boolean {
  if (config.mode === 'ordinary') return true;
  if (!config.enableOrdinaryPlugins) return false;
  return config.allowedPluginPaths?.includes(pluginPath) ?? false;
}

/**
 * Get the trust class associated with a worker mode.
 */
export function trustClassForWorkerMode(mode: WorkerMode): NodeTrustClass {
  switch (mode) {
    case 'restricted':
      return 'restricted';
    case 'quarantine':
      return 'quarantine';
    default:
      return 'trusted';
  }
}
