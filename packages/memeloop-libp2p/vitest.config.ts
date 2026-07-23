import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const memeloopSource = fileURLToPath(new URL('../memeloop/src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: 'memeloop/device-network',
        replacement: `${memeloopSource}/device-network-entry.ts`,
      },
      {
        find: 'memeloop',
        replacement: `${memeloopSource}/index.ts`,
      },
    ],
  },
});
