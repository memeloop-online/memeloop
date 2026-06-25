import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'loop-api': 'src/loop-api.ts',
    // Provider subpaths — each bundles only one @ai-sdk/* package.
    // Consumers install the specific @ai-sdk/* dep they need.
    'openai': 'src/llm/providers/openai.ts',
    'anthropic': 'src/llm/providers/anthropic.ts',
    'google': 'src/llm/providers/google.ts',
    'deepseek': 'src/llm/providers/deepseek.ts',
    'groq': 'src/llm/providers/groq.ts',
    'mistral': 'src/llm/providers/mistral.ts',
    'cohere': 'src/llm/providers/cohere.ts',
    'xai': 'src/llm/providers/xai.ts',
    'togetherai': 'src/llm/providers/togetherai.ts',
    'perplexity': 'src/llm/providers/perplexity.ts',
    'azure': 'src/llm/providers/azure.ts',
    'google-vertex': 'src/llm/providers/google-vertex.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
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
