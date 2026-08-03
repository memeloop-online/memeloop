import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagesRoot = fileURLToPath(new URL('../packages/', import.meta.url));
const sourceExtensions = new Set(['.cjs', '.js', '.json', '.mjs', '.rs', '.ts', '.tsx']);
const skippedDirectories = new Set(['build', 'coverage', 'dist', 'node_modules', 'out']);
const legacyRevision = String(1);
const legacyProtocolRevision = `1.${0}.${0}`;
const forbidden = [
  `memeloop-device-binding-v${legacyRevision}`,
  `memeloop-device-connection-grant-v${legacyRevision}`,
  `memeloop-device-relay-admission-v${legacyRevision}`,
  `memeloop.resource.v${legacyRevision}`,
  `memeloop-peer-driver/v${legacyRevision}`,
  `protocol-v${legacyRevision}.json`,
  ...['agent', 'orchestration', 'pairing', 'relay-admission', 'rpc', 'sync'].map(
    (name) => `/memeloop/${name}/${legacyProtocolRevision}`,
  ),
];
const required = [
  'memeloop-device-binding-v2',
  'memeloop-device-connection-grant-v2',
  'memeloop-device-relay-admission-v2',
  'memeloop.resource.v2',
  'memeloop-peer-driver/v2',
  'protocol-v2.json',
  '/memeloop/orchestration/2.0.0',
  '/memeloop/pairing/2.0.0',
  '/memeloop/relay-admission/2.0.0',
  '/memeloop/rpc/2.0.0',
  '/memeloop/sync/2.0.0',
];

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) files.push(...await sourceFiles(path));
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

const files = await sourceFiles(packagesRoot);
const contents = await Promise.all(files.map(async (path) => ({ path, text: await readFile(path, 'utf8') })));
const forbiddenHits = forbidden.flatMap((literal) =>
  contents.filter(({ text }) => text.includes(literal)).map(({ path }) => ({ literal, path })),
);
const missingRequired = required.filter(
  (literal) => !contents.some(({ text }) => text.includes(literal)),
);

if (forbiddenHits.length > 0 || missingRequired.length > 0) {
  for (const { literal, path } of forbiddenHits) {
    console.error(`obsolete MemeLoop network contract literal ${JSON.stringify(literal)} in ${path}`);
  }
  for (const literal of missingRequired) {
    console.error(`required MemeLoop v2 network contract literal is absent: ${JSON.stringify(literal)}`);
  }
  process.exitCode = 1;
} else {
  console.log(`MemeLoop v2 network contract audit passed across ${files.length} source files`);
}
