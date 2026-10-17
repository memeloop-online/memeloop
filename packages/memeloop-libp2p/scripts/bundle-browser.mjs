#!/usr/bin/env node
import { build } from 'esbuild';
import { resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');

await build({
  absWorkingDir: packageRoot,
  entryPoints: ['dist/browser.js'],
  bundle: true,
  external: ['memeloop', 'memeloop/*'],
  format: 'esm',
  outfile: 'dist/browser.bundle.js',
  platform: 'browser',
  sourcemap: true,
});
