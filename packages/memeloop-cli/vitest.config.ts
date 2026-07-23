import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const memeloopSourcePath = fileURLToPath(new URL('../memeloop/src', import.meta.url));

/**
 * Resolve test-only dependencies from the `memeloop` package's node_modules directory.
 * The `memeloop` source alias bypasses package dependency resolution, so its development
 * dependencies must be made explicit to Vite.
 *
 * Returns the realpath to avoid pnpm symlink issues during module resolution.
 */
function resolveFromMemeloopNodeModules(name: string): string {
  const base = fileURLToPath(new URL('../memeloop/node_modules', import.meta.url));
  return fs.realpathSync(`${base}/${name}`);
}

export default defineConfig({
  resolve: {
    alias: {
      memeloop: memeloopSourcePath,
      zod: resolveFromMemeloopNodeModules('zod'),
      'zod-to-json-schema': resolveFromMemeloopNodeModules('zod-to-json-schema'),
      '@inrupt/solid-client': resolveFromMemeloopNodeModules('@inrupt/solid-client'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    /** Prevent Vite from attempting to transform native CJS modules (ChaCha20-Poly1305 crypto). */
    server: {
      deps: {
        external: [
          /^sodium-universal$/,
          /^sodium-native$/,
          /^noise-handshake$/,
          /^zod-to-json-schema$/,
          /^@inrupt\/solid-client$/,
          /^better-sqlite3$/,
        ],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
