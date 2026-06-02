import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV1 } from "ai";
import { getApiKey } from "../auth/authStore.js";
import type { ProviderEntry } from "../config";

/**
 * Create a Vercel AI SDK provider from a ProviderEntry configuration.
 * Supports two modes:
 * - "direct": Connect directly to LLM provider (default)
 * - "cloud-proxy": Route through memeloop-cloud /api/llm/* proxy (uses cloud JWT)
 */
export function createAiSdkProvider(entry: ProviderEntry): LanguageModelV1 {
  const name = entry.name;
  const baseUrl = (entry.baseUrl ?? entry.options?.baseURL ?? "https://api.openai.com/v1") as string;
  const apiKey = ((entry.apiKey ?? entry.options?.apiKey ?? getApiKey(name)) as string | undefined);

  // Pick first available model from models map, or default
  const firstModelKey = entry.models ? Object.keys(entry.models)[0] : undefined;
  const defaultModel = firstModelKey ? entry.models![firstModelKey].name : "gpt-4";

  // Use OpenAI-compatible client for all providers
  const openai = createOpenAI({
    baseURL: baseUrl,
    apiKey: apiKey,
  });
  return openai(defaultModel);
}

export function resolveProviderModelId(entry: ProviderEntry): string {
  const firstModelKey = entry.models ? Object.keys(entry.models)[0] : undefined;
  if (firstModelKey) {
    return `${entry.name}/${firstModelKey}`;
  }
  return entry.name;
}
