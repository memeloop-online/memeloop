import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minify: false,
  // Only external: packages with native bindings, dynamic requires, or ESM-only issues
  external: [
    '@modelcontextprotocol/sdk',
    'better-sqlite3',
    'ink',
    'react',
    'react-reconciler',
    'ink-text-input',
    'ink-spinner',
    'scheduler',
    'puppeteer',
    'tiddlywiki',
    'zod',
  ],
  platform: 'node',
  target: 'node20',
});
