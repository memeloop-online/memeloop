import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['src/**/*.{test.ts,test.tsx}'],
    // @ts-expect-error — environmentMatchGlobs is supported in vitest
    environmentMatchGlobs: [['src/**/*.test.tsx', 'jsdom']],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['**/*.{test.ts,test.tsx}', 'src/**/index.ts', 'src/native/react-native-shim.d.ts'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
