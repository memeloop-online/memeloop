export const MODEL_CATALOG_SCHEMA_VERSION = 1 as const;
export const MODEL_CATALOG_SOURCE_URL = 'https://models.dev/api.json';

import type { AgentReasoningEffort } from '../agent/types.js';

export interface ModelCatalogModel {
  id: string;
  name: string;
  attachment: boolean;
  reasoning: boolean;
  toolCall: boolean;
  /** Reasoning effort values accepted by the canonical agent model config. */
  reasoningEfforts?: readonly AgentReasoningEffort[];
  structuredOutput?: boolean;
  temperature?: boolean;
  releaseDate?: string;
  lastUpdated?: string;
  status?: 'alpha' | 'beta' | 'deprecated';
  modalities?: {
    readonly input: readonly string[];
    readonly output: readonly string[];
  };
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
}

export interface ModelCatalogProvider {
  id: string;
  name: string;
  npm?: string;
  api?: string;
  doc?: string;
  readonly env: readonly string[];
  readonly models: readonly ModelCatalogModel[];
}

export interface ModelCatalog {
  schemaVersion: typeof MODEL_CATALOG_SCHEMA_VERSION;
  source: typeof MODEL_CATALOG_SOURCE_URL;
  catalogVersion: string;
  fetchedAt: string;
  readonly providers: readonly ModelCatalogProvider[];
}

export interface FetchModelCatalogOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}
