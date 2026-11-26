import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

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
const providerCjs = path.resolve(packageDirectory, providerExport.require);
const providerEsm = path.resolve(packageDirectory, providerExport.import);
if (statSync(portableCjs).size > 1_500_000) throw new Error('portable mobile CommonJS bundle exceeds 1.5 MiB');
if (statSync(portableEsm).size > 512 * 1_024) throw new Error('portable mobile ESM entry exceeds 512 KiB');

const forbiddenSource = /(?:^|\/)(?:llm\/fetchProvider|modelCatalog)(?:\/|\.|$)|(?:^|\/)node_modules\/ai\/|(?:^|\/)loopAPI\/nodeAgentLoopModuleImporter\.ts$/u;
const forbiddenRuntime = /(?:from\s+|require\(|import\()['"]ai['"]/u;
const portableEsmGraph = reachableJavaScript(portableEsm);
const portableEsmGraphBytes = [...portableEsmGraph]
  .reduce((total, artifact) => total + statSync(artifact).size, 0);
if (portableEsmGraphBytes > 1_500_000) {
  throw new Error('portable mobile reachable ESM graph exceeds 1.5 MiB');
}
for (const artifact of portableEsmGraph) {
  const source = readFileSync(artifact, 'utf8');
  assertNoVariableDynamicImports(source, artifact, 'module');
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
assertNoVariableDynamicImports(readFileSync(portableCjs, 'utf8'), portableCjs, 'script');
for (const artifact of reachableJavaScript(providerEsm)) {
  assertNoVariableDynamicImports(readFileSync(artifact, 'utf8'), artifact, 'module');
}
assertNoVariableDynamicImports(readFileSync(providerCjs, 'utf8'), providerCjs, 'script');

console.log('memeloop/mobile boundary: CJS require-safe; provider/catalog/ai/Node importer graph excluded; no variable dynamic import.');

function reachableJavaScript(entry) {
  const pending = [entry];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const source = readFileSync(current, 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    walkAst(ast, (node) => {
      if (
        (node.type === 'ImportDeclaration' ||
          node.type === 'ExportAllDeclaration' ||
          node.type === 'ExportNamedDeclaration') &&
        typeof node.source?.value === 'string' &&
        node.source.value.startsWith('./')
      ) {
        pending.push(path.resolve(path.dirname(current), node.source.value));
      }
      if (
        node.type === 'ImportExpression' &&
        isStaticImportSource(node.source) &&
        node.source.value.startsWith('./')
      ) {
        pending.push(path.resolve(path.dirname(current), node.source.value));
      }
    });
  }
  return seen;
}

function assertNoVariableDynamicImports(source, artifact, sourceType) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType });
  walkAst(ast, (node) => {
    if (node.type === 'ImportExpression' && !isStaticImportSource(node.source)) {
      throw new Error(`portable mobile graph contains a non-literal dynamic import: ${artifact}`);
    }
  });
}

function isStaticImportSource(node) {
  return node?.type === 'Literal' && typeof node.value === 'string';
}

function walkAst(value, visit) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.type === 'string') visit(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'parent') continue;
    if (Array.isArray(child)) {
      for (const item of child) walkAst(item, visit);
    } else {
      walkAst(child, visit);
    }
  }
}
