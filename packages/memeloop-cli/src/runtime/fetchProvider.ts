import type { ILLMProvider } from "memeloop";
import type { ProviderEntry } from "../config";

/**
 * Creates a minimal ILLMProvider placeholder.
 * The `model` field is populated by the caller (e.g. nodeRuntime) with a Vercel AI SDK LanguageModelV1 instance.
 */
export function createFetchLLMProvider(entry: ProviderEntry): ILLMProvider {
  return {
    name: entry.name,
    model: undefined,
  };
}
