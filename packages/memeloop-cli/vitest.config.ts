import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const memeloopSrcPath = fileURLToPath(new URL("../memeloop/src", import.meta.url));
const protocolSrcPath = fileURLToPath(new URL("../memeloop/src/protocol", import.meta.url));

/**
 * Resolve a CJS native module from the `memeloop` package's node_modules directory.
 * Used by `memeloop-cli` tests because the vitest alias `memeloop` → source dir causes Vite
 * to load source files that import `sodium-universal` / `noise-handshake`, which are CJS
 * native modules that Vite cannot process.
 *
 * Returns the realpath to avoid pnpm symlink issues during module resolution.
 */
function resolveFromMemeloopNodeModules(name: string): string {
  const base = fileURLToPath(new URL("../memeloop/node_modules", import.meta.url));
  return fs.realpathSync(`${base}/${name}`);
}

export default defineConfig({
  resolve: {
    alias: {
      "../memeloop/src/protocol/index.js": protocolSrcPath,
      "memeloop": memeloopSrcPath,
      "sodium-universal": resolveFromMemeloopNodeModules("sodium-universal"),
      "zod": resolveFromMemeloopNodeModules("zod"),
      "zod-to-json-schema": resolveFromMemeloopNodeModules("zod-to-json-schema"),
      "@inrupt/solid-client": resolveFromMemeloopNodeModules("@inrupt/solid-client"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    /** Prevent Vite from attempting to transform native CJS modules (ChaCha20-Poly1305 crypto). */
    server: {
      deps: {
        external: [/^sodium-universal$/, /^sodium-native$/, /^noise-handshake$/, /^zod-to-json-schema$/, /^@inrupt\/solid-client$/, /^better-sqlite3$/],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
