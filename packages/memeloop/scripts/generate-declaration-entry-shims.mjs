import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const declarationShims = {
  'conversation.d.ts': "export * from './conversation/index.js';\n",
  'device-network.d.ts': "export * from './device-network-entry.js';\n",
  'tools.d.ts': "export * from './tools-entry.js';\n",
};

for (const [filename, source] of Object.entries(declarationShims)) {
  fs.writeFileSync(path.join(packageDirectory, 'dist', filename), source);
}
