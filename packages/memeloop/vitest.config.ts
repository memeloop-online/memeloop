import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        'src/**/index.ts',
        'src/**/types.ts',
        'src/**/interface.ts',
        '**/*.d.ts',
        'src/agentLoops/taskAgentContract.ts',
        'src/tools/defineToolTypes.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
