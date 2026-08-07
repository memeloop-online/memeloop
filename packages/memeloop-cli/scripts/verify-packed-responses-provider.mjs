import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-packed-provider-'));

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? packageDirectory,
    encoding: 'utf8',
    env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true', ...options.env },
    maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeout ?? 240_000,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? `exit ${String(result.status)}`;
    throw new Error(`${command} ${arguments_.join(' ')} failed: ${reason}\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

try {
  run('pnpm', ['pack', '--pack-destination', temporaryDirectory]);
  const tarballs = fs.readdirSync(temporaryDirectory).filter(file => file.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, 'pnpm pack must create exactly one archive');
  const tarball = path.join(temporaryDirectory, tarballs[0]);
  const installDirectory = path.join(temporaryDirectory, 'install');
  fs.mkdirSync(installDirectory);
  fs.writeFileSync(
    path.join(installDirectory, 'package.json'),
    JSON.stringify({ name: 'memeloop-cli-packed-provider-check', private: true, type: 'module' }),
  );
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball],
    { cwd: installDirectory },
  );

  const runner = `
import assert from 'node:assert/strict';
import { createLLMProvider, createProviderFromEntry } from 'memeloop/llm-providers';

const requests = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const bodyText = typeof init.body === 'string'
    ? init.body
    : new TextDecoder().decode(init.body);
  requests.push({ method: init.method, path: url.pathname, body: JSON.parse(bodyText) });
  return new Response(
    JSON.stringify({ error: { message: 'intercepted', type: 'invalid_request_error' } }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
};

const responsesProvider = await createLLMProvider({
  provider: 'openai',
  name: 'packed-openai',
  apiKey: 'test-only',
  baseUrl: 'https://packed-provider.invalid/v1',
  model: 'gpt-5.6-luna',
  openAIApiMode: 'responses',
});
const chatCompletionsProvider = await createProviderFromEntry({
  name: 'packed-compatible',
  apiKey: 'test-only',
  baseUrl: 'https://packed-provider.invalid/v1',
  models: { primary: { name: 'westlake/deepseek' } },
});
assert.equal(responsesProvider.model('gpt-5.6-luna').provider, 'openai.responses');
assert.equal(chatCompletionsProvider.model('westlake/deepseek').provider, 'packed-compatible.chat');

for (const [provider, model] of [
  [responsesProvider, 'gpt-5.6-luna'],
  [chatCompletionsProvider, 'westlake/deepseek'],
]) {
  let interceptedError = false;
  try {
    const output = await provider.chat({
      model,
      messages: [{ role: 'user', content: 'test' }],
      maxOutputTokens: 16,
      stream: true,
    });
    for await (const _chunk of output) {
      // The intercepted 400 response must fail before yielding text.
    }
  } catch {
    interceptedError = true;
  }
  assert.equal(interceptedError, true);
}
assert.deepEqual(
  requests.map(request => ({
    method: request.method,
    path: request.path,
    model: request.body.model,
  })),
  [
    { method: 'POST', path: '/v1/responses', model: 'gpt-5.6-luna' },
    { method: 'POST', path: '/v1/chat/completions', model: 'westlake/deepseek' },
  ],
);
process.stdout.write(JSON.stringify({
  providers: ['openai.responses', 'packed-compatible.chat'],
  paths: requests.map(request => request.path),
  intercepted: true,
}));
`;
  const runnerPath = path.join(installDirectory, 'verify.mjs');
  fs.writeFileSync(runnerPath, runner);
  const output = run(process.execPath, [runnerPath], { cwd: installDirectory });
  assert.deepEqual(JSON.parse(output), {
    providers: ['openai.responses', 'packed-compatible.chat'],
    paths: ['/v1/responses', '/v1/chat/completions'],
    intercepted: true,
  });
  process.stdout.write(`${output}\n`);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
