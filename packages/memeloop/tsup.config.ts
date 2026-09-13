import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    browser: 'src/browser.ts',
    'loop-api': 'src/loop-api.ts',
    conversation: 'src/conversation/index.ts',
    'device-network': 'src/device-network-entry.ts',
    'device-network-portable': 'src/device-network-portable.ts',
    'orchestration-portable': 'src/orchestration-portable.ts',
    // Unified LLM-provider factory entry. Concrete SDKs are optional peers,
    // so a host installs only the providers it actually configures.
    'llm-providers': 'src/llm-providers.ts',
    'model-catalog': 'src/model-catalog.ts',
    tools: 'src/tools-entry.ts',
    testing: 'src/testing.ts',
  },
  format: ['cjs', 'esm'],
  // Generated declaration chunks are content-hashed. Without cleaning, every
  // local/CI build accumulates stale chunks and pnpm pack publishes them.
  clean: true,
  // Declarations are emitted by the native TypeScript compiler after tsup.
  // rollup-plugin-dts loses `export type *` intent in conditional barrels,
  // which makes browser/mobile declarations claim Node-only runtime values.
  dts: false,
  sourcemap: true,
  // Keep optional provider SDKs external to the library build.
  external: [
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
