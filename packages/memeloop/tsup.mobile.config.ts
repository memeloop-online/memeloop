import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const mobileModuleImporter = fileURLToPath(
  new URL('./src/loopAPI/mobileAgentLoopModuleImporter.ts', import.meta.url),
);

/**
 * Build React Native entries separately so their reachable graph substitutes
 * the Node variable-import adapter with a fail-closed portable adapter. A
 * shared multi-entry build could otherwise place the Node implementation in a
 * chunk that Metro must parse even though a Mobile runtime never calls it.
 */
export default defineConfig({
  entry: {
    mobile: 'src/mobile.ts',
    'mobile-providers': 'src/mobile-providers.ts',
  },
  format: ['cjs', 'esm'],
  clean: false,
  dts: false,
  sourcemap: true,
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
  esbuildPlugins: [{
    name: 'memeloop-mobile-script-module-importer',
    setup(build) {
      build.onResolve(
        { filter: /nodeAgentLoopModuleImporter\.js$/ },
        (arguments_) =>
          arguments_.path === './nodeAgentLoopModuleImporter.js'
            ? { path: mobileModuleImporter }
            : undefined,
      );
    },
  }],
  outExtension({ format }) {
    if (format === 'cjs') return { js: '.cjs' };
    return {};
  },
});
