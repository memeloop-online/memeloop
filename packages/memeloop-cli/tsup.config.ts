import { defineConfig, type Options } from 'tsup';

const shared: Options = {
  format: ['esm'],
  sourcemap: true,
  splitting: false,
  treeshake: true,
  minify: false,
  // Only external: packages with native bindings, dynamic requires, or
  // dependencies that must retain the consuming host's singleton identity.
  external: [
    '@modelcontextprotocol/sdk',
    '@memeloop/libp2p',
    '@napi-rs/keyring',
    'better-sqlite3',
    'etcd3',
    'ink',
    'react',
    'react-reconciler',
    'ink-text-input',
    'ink-spinner',
    'scheduler',
    'memeloop',
    'puppeteer',
    'tiddlywiki',
    'zod',
  ],
  platform: 'node',
  target: 'node24',
};

export default defineConfig([
  {
    ...shared,
    entry: { cli: 'src/cli.ts' },
    dts: false,
    clean: true,
  },
  {
    ...shared,
    entry: {
      index: 'src/index.ts',
      auth: 'src/auth/index.ts',
      runtime: 'src/runtime/index.ts',
      terminal: 'src/terminal/index.ts',
    },
    dts: true,
    clean: false,
  },
]);
