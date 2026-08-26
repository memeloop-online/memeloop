import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = path.join(packageDirectory, 'dist');
const manifest = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
const mobileExport = manifest.exports?.['./mobile'];
const providerExport = manifest.exports?.['./mobile/providers'];

if (!mobileExport?.require || !mobileExport?.import || !mobileExport?.types) {
  throw new Error('memeloop/mobile must expose import, require, and types targets');
}
if (!providerExport?.require || !providerExport?.import || !providerExport?.types) {
  throw new Error('memeloop/mobile/providers must expose import, require, and types targets');
}

for (const target of [...Object.values(mobileExport), ...Object.values(providerExport)]) {
  if (!existsSync(path.resolve(packageDirectory, target))) throw new Error(`missing mobile export target: ${target}`);
}

const requireSmoke = spawnSync(process.execPath, ['--eval', `
  const portable = require(${JSON.stringify(path.resolve(packageDirectory, mobileExport.require))});
  if (typeof portable.AgentRunFailure !== 'function') throw new Error('missing portable AgentRunFailure');
  if ('createFetchLLMProvider' in portable) throw new Error('provider leaked into portable mobile entry');
  if ('ModelCatalogManager' in portable) throw new Error('catalog leaked into portable mobile entry');
  const providers = require(${JSON.stringify(path.resolve(packageDirectory, providerExport.require))});
  if (typeof providers.createFetchLLMProvider !== 'function') throw new Error('missing mobile provider factory');
`], { cwd: packageDirectory, encoding: 'utf8' });
if (requireSmoke.status !== 0) {
  throw new Error(`mobile CommonJS smoke failed:\n${requireSmoke.stderr || requireSmoke.stdout}`);
}

const portableCjs = path.resolve(packageDirectory, mobileExport.require);
const portableEsm = path.resolve(packageDirectory, mobileExport.import);
if (statSync(portableCjs).size > 1_500_000) throw new Error('portable mobile CommonJS bundle exceeds 1.5 MiB');
if (statSync(portableEsm).size > 64 * 1_024) throw new Error('portable mobile ESM entry exceeds 64 KiB');

const forbiddenSource = /(?:^|\/)(?:llm\/fetchProvider|modelCatalog)(?:\/|\.|$)|(?:^|\/)node_modules\/ai\//u;
const forbiddenRuntime = /(?:from\s+|require\(|import\()['"]ai['"]/u;
for (const artifact of reachableJavaScript(portableEsm)) {
  const source = readFileSync(artifact, 'utf8');
  if (forbiddenRuntime.test(source)) throw new Error(`portable mobile graph loads ai: ${path.basename(artifact)}`);
  const sourceMapPath = `${artifact}.map`;
  if (!existsSync(sourceMapPath)) throw new Error(`missing source map for mobile graph artifact: ${artifact}`);
  const sourceMap = JSON.parse(readFileSync(sourceMapPath, 'utf8'));
  const forbidden = sourceMap.sources?.find(sourcePath => forbiddenSource.test(sourcePath.replaceAll('\\', '/')));
  if (forbidden) throw new Error(`portable mobile graph includes forbidden source ${forbidden}`);
}
const cjsSourceMap = JSON.parse(readFileSync(`${portableCjs}.map`, 'utf8'));
const forbiddenCjs = cjsSourceMap.sources?.find(sourcePath => forbiddenSource.test(sourcePath.replaceAll('\\', '/')));
if (forbiddenCjs) throw new Error(`portable mobile CommonJS includes forbidden source ${forbiddenCjs}`);

console.log('memeloop/mobile boundary: CJS require-safe; provider/catalog/ai graph excluded.');

function reachableJavaScript(entry) {
  const pending = [entry];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const source = readFileSync(current, 'utf8');
    const specifiers = source.matchAll(/(?:from\s+|import\s*)["'](\.\/[A-Za-z0-9._-]+\.js)["']/gu);
    for (const match of specifiers) pending.push(path.resolve(path.dirname(current), match[1]));
  }
  return seen;
}
