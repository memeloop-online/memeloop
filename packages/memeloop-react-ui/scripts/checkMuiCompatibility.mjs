import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
const consumerRoot = resolve(process.argv[2] ?? packageRoot);
const expectedVersion = process.argv[3] ?? manifest.devDependencies['@mui/material'];
const esmMode = process.argv[4] ?? 'node';
const requireFromConsumer = createRequire(resolve(consumerRoot, 'mui-compat-cjs-probe.cjs'));

function readInstalledVersion(packageName) {
  let current = dirname(requireFromConsumer.resolve(packageName));
  while (current !== dirname(current)) {
    const manifestPath = resolve(current, 'package.json');
    if (existsSync(manifestPath)) {
      const installedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (installedManifest.name === packageName) return installedManifest.version;
    }
    current = dirname(current);
  }
  throw new Error(`Unable to locate installed manifest for ${packageName}`);
}

for (const packageName of ['@mui/icons-material', '@mui/material']) {
  const version = readInstalledVersion(packageName);
  if (version !== expectedVersion) {
    throw new Error(`MUI compatibility probe requires ${packageName}@${expectedVersion}, found ${version}`);
  }
}

const rootCjsEntry = requireFromConsumer.resolve('@memeloop/react-ui');
const installedPackageRoot = resolve(dirname(rootCjsEntry), '..');
const distFiles = readdirSync(resolve(installedPackageRoot, 'dist'), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(?:c?js)$/u.test(entry.name))
  .map(entry => resolve(entry.parentPath, entry.name));
const iconSpecifiers = new Set();

for (const file of distFiles) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/["'](@mui\/icons-material\/[A-Za-z0-9]+)["']/gu)) {
    if (match[1]) iconSpecifiers.add(match[1]);
  }
}

if (iconSpecifiers.size === 0) throw new Error('MUI compatibility probe found no built icon imports');

const specifiers = [...iconSpecifiers].sort();
for (const specifier of specifiers) {
  const loaded = requireFromConsumer(specifier);
  if (loaded === undefined || loaded === null) throw new Error(`CJS icon import returned no export: ${specifier}`);
}

const cjsRoot = requireFromConsumer('@memeloop/react-ui');
if (cjsRoot === null || typeof cjsRoot !== 'object' || Object.keys(cjsRoot).length === 0) {
  throw new Error('Root CJS @memeloop/react-ui entrypoint returned no exports');
}

if (esmMode === 'node') {
  const esmProbe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const root = await import('@memeloop/react-ui');\n` +
        `if (Object.keys(root).length === 0) throw new Error('empty root ESM exports');\n` +
        `for (const specifier of ${JSON.stringify(specifiers)}) {\n` +
        `  const icon = await import(specifier);\n` +
        `  if (icon.default === undefined) throw new Error('missing default export: ' + specifier);\n` +
        `}`,
    ],
    { cwd: consumerRoot, encoding: 'utf8' },
  );

  if (esmProbe.status !== 0) {
    throw new Error(`Root ESM MUI compatibility probe failed:\n${esmProbe.stderr || esmProbe.stdout}`);
  }
} else if (esmMode === 'vite') {
  const probeRoot = mkdtempSync(resolve(consumerRoot, '.mui-esm-compat-'));
  try {
    const entry = resolve(probeRoot, 'index.js');
    writeFileSync(
      entry,
      `import * as root from '@memeloop/react-ui';\n` +
        specifiers.map((specifier, index) => `import Icon${index} from '${specifier}';`).join('\n') +
        `\nexport const compatibilityProbe = [Object.keys(root).length, ${specifiers.map((_, index) => `Icon${index}`).join(', ')}];\n`,
    );
    const viteRoot = dirname(requireFromConsumer.resolve('vite/package.json'));
    const { build } = await import(pathToFileURL(resolve(viteRoot, 'dist/node/index.js')).href);
    const output = await build({
      root: probeRoot,
      logLevel: 'silent',
      build: {
        lib: { entry, fileName: 'mui-compat-probe', formats: ['es'], name: 'MuiCompatProbe' },
        rollupOptions: {
          onwarn(warning, warn) {
            if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
          },
        },
        write: false,
      },
    });
    if (!output) throw new Error('Vite returned no ESM build output');
  } finally {
    rmSync(probeRoot, { force: true, recursive: true });
  }
} else {
  throw new Error(`Unknown ESM compatibility mode: ${esmMode}`);
}

console.log(`MUI ${expectedVersion} root CJS, ${esmMode} ESM, and ${specifiers.length} icon subpaths loaded successfully.`);
