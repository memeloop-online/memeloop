import { containsSecrets } from 'memeloop';

/**
 * Worker launch environment policy (plan 24.35).
 *
 * Long-lived provider keys must never reach a worker's argv, environment, or
 * config. Workers receive a model gateway endpoint; short-lived
 * ModelAccessHandles are delivered over the worker bootstrap channel (unix
 * socket/stdio), never via env. This module strips provider-secret variables
 * from the inherited environment and asserts the result is clean.
 */

/**
 * Matches environment variable names that conventionally carry provider
 * secrets: OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, *_API_TOKEN,
 * *_SECRET*, *_ACCESS_TOKEN, *_PASSWORD, etc.
 */
export const PROVIDER_SECRET_ENV_PATTERN =
  /(^|_)(API[-_]?KEY|API[-_]?TOKEN|SECRET|SECRET[-_]?KEY|ACCESS[-_]?TOKEN|AUTH[-_]?TOKEN|PASSWORD|PRIVATE[-_]?KEY|CLIENT[-_]?SECRET)(_|$)/i;

/** Well-known non-secret variables always safe to inherit. */
const ALWAYS_KEEP = new Set([
  'HOME',
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TZ',
  'USER',
  'LOGNAME',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
]);

export interface WorkerEnvironmentOptions {
  /** Environment to sanitize (default: process.env). */
  baseEnvironment?: NodeJS.ProcessEnv;
  /** Explicitly keep these otherwise-stripped variable names (names only). */
  keep?: string[];
  /** Model gateway endpoint exposed as MEMELOOP_MODEL_GATEWAY (not a secret). */
  gatewayEndpoint?: string;
  /** Extra non-secret variables; rejected if they look secret-shaped. */
  extra?: Record<string, string>;
}

export interface WorkerEnvironmentResult {
  environment: Record<string, string>;
  /** Names of stripped variables (values are never recorded). */
  stripped: string[];
}

export const MODEL_GATEWAY_ENV = 'MEMELOOP_MODEL_GATEWAY';

/**
 * Build a worker environment with provider secrets removed. Returns the clean
 * env plus the names (never values) of stripped variables for audit. As a
 * final guard, any remaining value matching a known secret format is stripped
 * too, so passing a custom env cannot smuggle keys through.
 */
export function sanitizeWorkerEnvironment(options: WorkerEnvironmentOptions = {}): WorkerEnvironmentResult {
  const baseEnvironment = options.baseEnvironment ?? process.env;
  const keep = new Set(options.keep ?? []);
  const environment: Record<string, string> = {};
  const stripped = new Set<string>();

  for (const [name, value] of Object.entries(baseEnvironment)) {
    if (value === undefined) continue;
    if (ALWAYS_KEEP.has(name) || keep.has(name)) {
      environment[name] = value;
      continue;
    }
    if (PROVIDER_SECRET_ENV_PATTERN.test(name) || containsSecrets(value)) {
      stripped.add(name);
      continue;
    }
    environment[name] = value;
  }

  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (PROVIDER_SECRET_ENV_PATTERN.test(name) || containsSecrets(value)) {
      stripped.add(name);
      continue;
    }
    environment[name] = value;
  }

  if (options.gatewayEndpoint) {
    environment[MODEL_GATEWAY_ENV] = options.gatewayEndpoint;
  }

  return { environment, stripped: [...stripped].sort() };
}
