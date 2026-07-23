#!/usr/bin/env node
import { build } from 'esbuild';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageRoot = resolve(root, 'packages/memeloop-libp2p');

await build({
  absWorkingDir: packageRoot,
  entryPoints: ['dist/browser.bundle.js'],
  bundle: true,
  format: 'esm',
  logLevel: 'warning',
  platform: 'browser',
  write: false,
});

await build({
  absWorkingDir: packageRoot,
  entryPoints: ['../memeloop/src/mobile.ts'],
  bundle: true,
  format: 'esm',
  logLevel: 'warning',
  platform: 'browser',
  write: false,
});

console.log('@memeloop/libp2p/browser and memeloop/mobile bundle without Node built-ins.');
