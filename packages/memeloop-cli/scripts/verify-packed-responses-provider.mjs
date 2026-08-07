import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corePackageDirectory = path.resolve(packageDirectory, '../memeloop');
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
  let coreTarball = process.env.MEMELOOP_CORE_TARBALL;
  let cliTarball = process.env.MEMELOOP_CLI_TARBALL;
  if (coreTarball || cliTarball) {
    assert.ok(coreTarball && cliTarball, 'both exact package archives must be supplied together');
    coreTarball = path.resolve(coreTarball);
    cliTarball = path.resolve(cliTarball);
    assert.ok(fs.statSync(coreTarball).isFile(), 'the supplied Core archive is not a file');
    assert.ok(fs.statSync(cliTarball).isFile(), 'the supplied CLI archive is not a file');
  } else {
    run('pnpm', ['pack', '--pack-destination', temporaryDirectory], { cwd: corePackageDirectory });
    run('pnpm', ['pack', '--pack-destination', temporaryDirectory]);
    const tarballs = fs.readdirSync(temporaryDirectory).filter(file => file.endsWith('.tgz'));
    assert.equal(tarballs.length, 2, 'pnpm pack must create the Core and CLI archives');
    const coreArchive = tarballs.find(file => /^memeloop-0\.2\.4\.tgz$/.test(file));
    const cliArchive = tarballs.find(file => /^memeloop-cli-0\.2\.4\.tgz$/.test(file));
    assert.ok(coreArchive, 'Core 0.2.4 archive is missing');
    assert.ok(cliArchive, 'CLI 0.2.4 archive is missing');
    coreTarball = path.join(temporaryDirectory, coreArchive);
    cliTarball = path.join(temporaryDirectory, cliArchive);
  }
  const installDirectory = path.join(temporaryDirectory, 'install');
  fs.mkdirSync(installDirectory);
  fs.writeFileSync(
    path.join(installDirectory, 'package.json'),
    JSON.stringify({ name: 'memeloop-cli-packed-provider-check', private: true, type: 'module' }),
  );
  run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      coreTarball,
      cliTarball,
    ],
    { cwd: installDirectory },
  );

  const runner = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from 'memeloop-cli';
import { createLLMProvider, createProviderFromEntry } from 'memeloop/llm-providers';

const coreManifest = JSON.parse(fs.readFileSync(new URL('./node_modules/memeloop/package.json', import.meta.url), 'utf8'));
assert.equal(coreManifest.version, '0.2.4', 'the clean install must use the packed Core, not registry 0.2.3');
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
requests.length = 0;

const runtimeDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-packed-multi-model-'));
const runtime = await createNodeRuntime({
  dataDir: runtimeDataDirectory,
  includeVscodeCli: false,
  localNodeId: 'packed-multi-model',
  config: {
    providers: [{
      name: 'cpa',
      apiKey: 'test-only',
      baseUrl: 'https://packed-provider.invalid/v1',
      models: [
        {
          id: 'westlake/deepseek',
          name: 'DeepSeek V4 Flash',
          apiMode: 'chat-completions',
          maxOutputTokens: 32768,
          toolCalling: true,
          vision: false,
        },
        {
          id: 'kimi-k3-256k',
          name: 'Kimi K3 256K',
          apiMode: 'chat-completions',
          maxOutputTokens: 131072,
          modelOptions: { top_p: 0.95 },
          toolCalling: true,
          vision: true,
        },
        {
          id: 'gpt-5.6-luna',
          name: 'GPT-5.6 Luna',
          apiMode: 'responses',
          maxOutputTokens: 128000,
          toolCalling: true,
          vision: true,
        },
        {
          id: 'gpt-5.6-sol',
          name: 'GPT-5.6 Sol',
          apiMode: 'responses',
          maxOutputTokens: 128000,
          toolCalling: true,
          vision: true,
        },
      ],
    }],
  },
});
try {
  for (const model of [
    'westlake/deepseek',
    'kimi-k3-256k',
    'gpt-5.6-luna',
    'gpt-5.6-sol',
  ]) {
    let interceptedError = false;
    try {
      const output = runtime.context.llmProvider.chat({
        model,
        messages: [{ role: 'user', content: 'test' }],
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
    requests.map(request => ({ path: request.path, model: request.body.model })),
    [
      { path: '/v1/chat/completions', model: 'westlake/deepseek' },
      { path: '/v1/chat/completions', model: 'kimi-k3-256k' },
      { path: '/v1/responses', model: 'gpt-5.6-luna' },
      { path: '/v1/responses', model: 'gpt-5.6-sol' },
    ],
  );
  assert.equal(requests[0].body.max_tokens, 32768);
  assert.equal(requests[1].body.max_tokens, 131072);
  assert.equal(requests[1].body.top_p, 0.95);
  assert.equal(requests[2].body.max_output_tokens, 128000);
  assert.equal(requests[3].body.max_output_tokens, 128000);
} finally {
  await runtime.stop();
  fs.rmSync(runtimeDataDirectory, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({
  coreVersion: coreManifest.version,
  providers: ['openai.responses', 'packed-compatible.chat'],
  paths: requests.map(request => request.path),
  intercepted: true,
}));
`;
  const runnerPath = path.join(installDirectory, 'verify.mjs');
  fs.writeFileSync(runnerPath, runner);
  const output = run(process.execPath, [runnerPath], { cwd: installDirectory });
  assert.deepEqual(JSON.parse(output), {
    coreVersion: '0.2.4',
    providers: ['openai.responses', 'packed-compatible.chat'],
    paths: [
      '/v1/chat/completions',
      '/v1/chat/completions',
      '/v1/responses',
      '/v1/responses',
    ],
    intercepted: true,
  });
  process.stdout.write(`${output}\n`);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
