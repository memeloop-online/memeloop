#!/usr/bin/env node
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

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
  plugins: [{
    name: 'progress-event-inherited-type',
    setup(build) {
      build.onLoad({ filter: /[\\/]progress-events[\\/]dist[\\/]src[\\/]index\.js$/ }, async ({ path }) => ({
        // Event already owns its readonly type. Redeclaring it becomes an
        // assignment in downstream class-field transforms and throws in browsers.
        contents: (await readFile(path, 'utf8'))
          .replace(/^\s*type;\r?$/mu, '')
          .replace(/^\s*this\.type = type;\r?$/mu, ''),
        loader: 'js',
      }));
    },
  }],
});
