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
  // Bundle all @ai-sdk/* providers into llm-providers so consumers don't need
  // to install them individually. Size is acceptable for non-browser hosts.
  noExternal: [/^@ai-sdk\//],
  external: [
    'noise-handshake',
    'sodium-universal',
    // Provider packages are installed by consumers, not bundled into core
    '@ai-sdk/openai',
    '@ai-sdk/anthropic',
    '@ai-sdk/google',
    '@ai-sdk/deepseek',
    '@ai-sdk/groq',
    '@ai-sdk/mistral',
    '@ai-sdk/cohere',
    '@ai-sdk/xai',
    '@ai-sdk/togetherai',
    '@ai-sdk/perplexity',
    '@ai-sdk/azure',
    '@ai-sdk/google-vertex',
  ],
  outExtension({ format }) {
    if (format === 'cjs') {
      return { js: '.cjs' };
    }
    return {};
  },
});
