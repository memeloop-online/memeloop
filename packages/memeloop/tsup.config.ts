import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'loop-api': 'src/loop-api.ts',
    // Unified pre-built LLM providers entry. Provider SDKs are runtime
    // dependencies, so consumers can switch providers without installing
    // AI SDK packages individually.
    'llm-providers': 'src/llm-providers.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  // Keep provider SDKs external to the library build. They are normal runtime
  // dependencies of memeloop; host bundlers decide whether to bundle, split, or
  // externalize them for their own runtime.
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
