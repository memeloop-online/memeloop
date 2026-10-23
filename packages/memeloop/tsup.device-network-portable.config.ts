import { defineConfig } from 'tsup';

/**
 * Publish the portable ESM facade as one self-contained module.
 *
 * The shared multi-entry build emits redundant bare imports for two chunks
 * that are already reached through named imports. Consumers correctly drop
 * those imports because this package is side-effect-free, but esbuild warns.
 * Keeping only this facade unsplit removes the meaningless imports without
 * falsely marking generated chunks as side-effectful or duplicating every ESM
 * entry in the package.
 */
export default defineConfig({
  entry: {
    'device-network-portable': 'src/device-network-portable.ts',
  },
  format: ['esm'],
  target: 'es2022',
  splitting: false,
  clean: false,
  dts: false,
  sourcemap: true,
});
