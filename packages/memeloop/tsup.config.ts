import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'loop-api': 'src/loop-api.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  external: ['noise-handshake', 'sodium-universal'],
  outExtension({ format }) {
    if (format === 'cjs') {
      return { js: '.cjs' };
    }
    return {};
  },
});
