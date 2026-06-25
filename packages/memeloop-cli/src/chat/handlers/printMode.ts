import { mkdirSync } from 'node:fs';
import { createNodeRuntime } from '../../runtime/nodeRuntime.js';
import type { ChatHooks } from '../hooks.js';
import { createCliAgentRunner } from '../types.js';
import type { ChatHookContext } from '../types.js';

export function registerPrintModeHandler(hooks: ChatHooks) {
  hooks.runPrintMode.tapAsync('default', (context, callback) => {
    void runPrintMode(context).then(() => {
      callback();
    }, callback);
  });
}

async function runPrintMode(context: ChatHookContext): Promise<void> {
  let prompt = context.options.prompt;
  if (!prompt) {
    prompt = await readStdin();
  }
  if (!prompt) {
    process.stderr.write('Error: --print requires --prompt or piped stdin\n');
    process.exit(1);
  }

  mkdirSync(context.dataDir, { recursive: true });
  const runtime = await createNodeRuntime({
    localNodeId: context.options.localNodeId ?? 'memeloop-cli-print',
    dataDir: context.dataDir,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    config: context.options.config as any,
  });

  const conversationId = `cli-print-${Date.now().toString(36)}`;
  const runAgent = await createCliAgentRunner(runtime, conversationId);
  if (!runAgent) {
    process.stderr.write('Error: Agent loop runner not configured.\n');
    process.exit(1);
  }

  const gen = runAgent({ conversationId, message: prompt });

  for await (const step of gen) {
    if (step.type === 'message') {
      const data = typeof step.data === 'string'
        ? step.data
        : ((step.data as { content?: string })?.content ?? '');
      process.stdout.write(data);
    }
  }

  process.stdout.write('\n');
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data.trim());
    });
    if (process.stdin.readableEnded) {
      resolve(data.trim());
    }
  });
}
