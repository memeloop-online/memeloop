import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, '..', 'src', 'loopProfiles');
const outDir = join(__dirname, '..', 'dist');

mkdirSync(outDir, { recursive: true });
for (const file of readdirSync(srcDir)) {
  if (file.endsWith('.json')) {
    copyFileSync(join(srcDir, file), join(outDir, file));
  }
}
