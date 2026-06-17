import { describe, expect, it } from 'vitest';

import { collectPromptSourcePaths, findPromptById, flattenPrompts, promptConcatStream } from '../promptConcat.js';

describe('promptConcat', () => {
  it('collectPromptSourcePaths and findPromptById handle nested prompts', () => {
    const prompts: any[] = [{ id: 'a', children: [{ id: 'b' }] }, { id: 'c' }];
    const paths = collectPromptSourcePaths(prompts);
    expect(paths.a).toBe('agentFrameworkConfig.prompts.0');
    expect(paths.b).toBe('agentFrameworkConfig.prompts.0.children.0');
    expect(findPromptById(prompts, 'b')?.prompt.id).toBe('b');
    expect(findPromptById(prompts, 'missing')).toBeUndefined();
  });

  it('flattenPrompts skips disabled and merges roleless children', () => {
    const flat = flattenPrompts([
      { role: 'system', text: 'S', children: [{ text: '1' }, { role: 'assistant', text: 'A1' }] },
      { role: 'user', text: 'U', enabled: false },
    ] as any);
    expect(flat).toEqual([
      { role: 'system', content: 'S1' },
      { role: 'system', content: '1' },
      { role: 'assistant', content: 'A1' },
    ]);
  });

  it('promptConcatStream appends user text and attachment variants', async () => {
    const baseConfig: any = {
      agentFrameworkConfig: { prompts: [{ role: 'system', text: 'sys' }], plugins: [] },
    };
    const ctx: any = { tools: { getPromptPlugins: () => new Map() } };

    const run1 = promptConcatStream(baseConfig, [{ role: 'user', content: 'hello' } as any], ctx);
    const s1 = (await run1.next()).value;
    expect(s1.flatPrompts.at(-1)).toEqual({ role: 'user', content: 'hello' });

    const msgWithPath = [
      { role: 'user', content: 'img', metadata: { file: { path: '/tmp/a.png' } } },
    ] as any;
    const run2 = promptConcatStream(baseConfig, msgWithPath, ctx);
    const s2 = (await run2.next()).value;
    expect(String(s2.flatPrompts.at(-1)?.content)).toContain('[attached path: /tmp/a.png]');

    const run3 = promptConcatStream(baseConfig, msgWithPath, ctx, {
      readAttachmentFile: async () => new Uint8Array([1, 2, 3]),
    });
    const s3 = (await run3.next()).value;
    expect(Array.isArray(s3.flatPrompts.at(-1)?.content)).toBe(true);
    expect((s3.flatPrompts.at(-1) as any).content[0].type).toBe('image');

    const run4 = promptConcatStream(baseConfig, msgWithPath, ctx, {
      readAttachmentFile: async () => {
        throw new Error('read-failed');
      },
    });
    const s4 = (await run4.next()).value;
    // readAttachmentFile failed => should not append attachment payload branch
    expect((s4.flatPrompts.at(-1) as any).content).not.toEqual(expect.any(Array));
  });
});
