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
      'memeloop/device-network/portable': `${memeloopSourcePath}/device-network-portable.ts`,
      'memeloop/device-network': `${memeloopSourcePath}/device-network-entry.ts`,
      memeloop: memeloopSourcePath,
      zod: resolveFromMemeloopNodeModules('zod'),
      'zod-to-json-schema': resolveFromMemeloopNodeModules('zod-to-json-schema'),
      '@inrupt/solid-client': resolveFromMemeloopNodeModules('@inrupt/solid-client'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Several suites boot real SQLite-backed NodeRuntime controllers and use
    // explicit 10–15 second protocol deadlines. Running one worker per CPU
    // makes those independent runtimes contend for disk and timers, while the
    // Vitest 5 second default can expire before their own bounded deadline.
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
