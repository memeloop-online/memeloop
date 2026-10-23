import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { lspImpl } from '../lsp.js';

const temporaryDirectories: string[] = [];

function workspace(): { directory: string; source: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-lsp-'));
  temporaryDirectories.push(directory);
  fs.writeFileSync(
    path.join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext' },
      include: ['src/**/*.ts'],
    }),
  );
  const sourceDirectory = path.join(directory, 'src');
  fs.mkdirSync(sourceDirectory);
  const source = path.join(sourceDirectory, 'sample.ts');
  fs.writeFileSync(
    source,
    [
      'export const answer = 42;',
      'export function readAnswer(): number {',
      '  return answer;',
      '}',
    ].join('\n'),
  );
  return { directory, source };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('lspImpl', () => {
  it('uses the real TypeScript language server for document symbols', async () => {
    const { source } = workspace();

    const response = await lspImpl({
      operation: 'documentSymbol',
      filePath: source,
      timeoutMs: 15_000,
    });

    expect(response, JSON.stringify(response)).toHaveProperty('result');
    expect('result' in response ? response.result : '').toContain('readAnswer');
    expect(JSON.stringify(response)).not.toMatch(/stub|TODO/i);
  }, 20_000);

  it('rejects missing workspace queries and unsupported file types honestly', async () => {
    const { directory, source } = workspace();
    expect(
      await lspImpl({
        operation: 'workspaceSymbol',
        filePath: source,
      }),
    ).toEqual({ error: 'symbolName is required for workspaceSymbol operation' });

    const unsupported = path.join(directory, 'asset.bin');
    fs.writeFileSync(unsupported, 'data');
    await expect(lspImpl({
      operation: 'hover',
      filePath: unsupported,
    })).resolves.toEqual({
      error: "No allowlisted language server is configured for '.bin'",
    });
  });

  it('fails promptly and honestly when an allowlisted server is unavailable', async () => {
    const { directory } = workspace();
    const source = path.join(directory, 'sample.py');
    fs.writeFileSync(source, 'answer = 42\n');
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(lspImpl({
        operation: 'documentSymbol',
        filePath: source,
        timeoutMs: 500,
      })).resolves.toEqual({
        error: "Language server 'pyright-langserver' is not installed for python",
      });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });
});
