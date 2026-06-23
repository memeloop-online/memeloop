import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runFileListRpc, runFileReadRpc, runFileSearchRpc, runFileTailRpc, runFileWriteRpc } from '../fileSystem.js';

describe('fileSystem tools', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function mkRoot(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-fs-'));
    dirs.push(d);
    return d;
  }

  it('writes and reads a file with structured ref', async () => {
    const root = mkRoot();
    const write = (await runFileWriteRpc({ path: 'a.txt', content: 'hello' }, root)) as { ok?: boolean };
    expect(write.ok).toBe(true);

    const read = (await runFileReadRpc({ path: 'a.txt' }, root)) as Record<string, unknown>;
    expect(read.path).toBe('a.txt');
    expect(typeof read.byteLength).toBe('number');
    const structured = Object.values(read).find(
      (v) => v && typeof v === 'object' && 'detailRef' in (v as Record<string, unknown>),
    ) as { detailRef?: { type?: string } } | undefined;
    expect(structured?.detailRef?.type).toBe('file');
  });

  it('lists directory recursively', async () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'x.ts'), 'export const x = 1;\n', 'utf8');

    const listed = (await runFileListRpc({ path: '.', recursive: true }, root)) as {
      entries?: Array<{ name: string; type: string }>;
    };
    expect(listed.entries?.some((e) => e.name.includes('sub/x.ts'))).toBe(true);
  });

  it('tails last lines', async () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, 'log.txt'), '1\n2\n3\n4\n', 'utf8');
    const tail = (await runFileTailRpc({ path: 'log.txt', lines: 2 }, root)) as {
      lines?: string[];
      totalLines?: number;
    };
    expect(tail.lines).toEqual(['4', '']);
    expect(tail.totalLines).toBe(5);
  });

  it('returns error when reading escaped path', async () => {
    const root = mkRoot();
    const read = (await runFileReadRpc({ path: '../etc/passwd' }, root)) as { error?: string };
    expect(read.error).toContain('Path escapes base directory');
  });

  it('searches text with rg', async () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, 'x.ts'), 'function hello() {}\n', 'utf8');
    const res = (await runFileSearchRpc({ pattern: 'hello', path: '.' }, root)) as {
      count?: number;
      error?: string;
    };
    expect(res.error).toBeUndefined();
    expect((res.count ?? 0) >= 1).toBe(true);
  });

  it('validates required args and common error branches', async () => {
    const root = mkRoot();

    const missRead = (await runFileReadRpc({}, root)) as any;
    expect(missRead.error).toContain("Missing 'path'");

    const missWrite = (await runFileWriteRpc({ path: 'a.txt' }, root)) as any;
    expect(missWrite.error).toContain("invalid 'content'");

    const badList = (await runFileListRpc({ path: 'missing.txt' }, root)) as any;
    expect(badList.error).toBeTruthy();

    const missSearch = (await runFileSearchRpc({}, root)) as any;
    expect(missSearch.error).toContain("Missing 'pattern'");

    const missTail = (await runFileTailRpc({}, root)) as any;
    expect(missTail.error).toContain("Missing 'path'");
  });

  it('summarizes read as URI reference without inlining file bytes', async () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, 'empty.txt'), '', 'utf8');
    const read = (await runFileReadRpc({ path: 'empty.txt' }, root)) as any;
    const structured = Object.values(read).find(
      (v) => v && typeof v === 'object' && 'summary' in (v as Record<string, unknown>),
    ) as any;
    expect(structured.summary).toContain('empty.txt (0 bytes)');
    expect(structured.summary).toContain('memeloop://');
  });

  it('search resolves on rg exit code 1 (no matches)', async () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, 'x.ts'), 'function hello() {}\n', 'utf8');
    const res = (await runFileSearchRpc({ pattern: 'no_such_symbol', path: '.' }, root)) as any;
    expect(res.error).toBeUndefined();
    expect(res.count).toBe(0);
    expect(res.matches).toEqual([]);
  });

  it('search returns error+hint when rg fails (invalid regex)', async () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, 'x.ts'), 'function hello() {}\n', 'utf8');
    const res = (await runFileSearchRpc({ pattern: '[', path: '.' }, root)) as any;
    expect(res.error).toBeTruthy();
    expect(res.hint).toContain('ripgrep');
  });

  it('lists returns Not a directory when path points to a file', async () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x', 'utf8');
    const res = (await runFileListRpc({ path: 'a.txt' }, root)) as any;
    expect(res.error).toContain('Not a directory');
    expect(res.path).toBeTruthy();
  });
});
