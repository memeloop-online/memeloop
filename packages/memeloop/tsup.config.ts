import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'loop-api': 'src/loop-api.ts',
    // Unified pre-built LLM providers entry — bundles all @ai-sdk/* providers.
    // Consumers switch providers via config.provider without installing AI SDK packages.
    'llm-providers': 'src/llm-providers.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  // Provider SDKs are loaded on demand by createLLMProvider, so they stay
  // external in the llm-providers bundle. Hosts install only the providers
  // they actually use; unused providers never get imported at runtime.
  external: [
    'noise-handshake',
    'sodium-universal',
    '@ai-sdk/anthropic',
    '@ai-sdk/azure',
    '@ai-sdk/cohere',
    '@ai-sdk/deepseek',
    '@ai-sdk/google',
    '@ai-sdk/google-vertex',
    '@ai-sdk/groq',
    '@ai-sdk/mistral',
    '@ai-sdk/openai',
    '@ai-sdk/openai-compatible',
    '@ai-sdk/perplexity',
    '@ai-sdk/togetherai',
    '@ai-sdk/xai',
    'ollama-ai-provider-v2',
  ],
  outExtension({ format }) {
    if (format === 'cjs') {
      return { js: '.cjs' };
    }
    return {};
  },
});
