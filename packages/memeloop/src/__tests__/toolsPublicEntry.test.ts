import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import type { AgentDefinitionToolConfig } from '../agent/types.js';
import { mergeAgentToolsIntoFrameworkConfig } from '../tools-entry.js';

describe('memeloop/tools public entry', () => {
  it('declares the browser-safe package subpath', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports?: Record<string, unknown> };

    expect(packageJson.exports?.['./tools']).toEqual({
      types: './dist/tools/index.d.ts',
      import: './dist/tools.js',
      require: './dist/tools.cjs',
    });
  });

  it('exports the pure host-tool merge without importing the runtime entry', () => {
    const tools: AgentDefinitionToolConfig[] = [{
      toolId: 'wiki-search',
      enabled: true,
      parameters: { workspace: 'notes' },
    }];

    expect(mergeAgentToolsIntoFrameworkConfig(undefined, tools)).toMatchObject({
      prompts: [],
      plugins: [{
        id: 'wiki-search-agent-tool',
        toolId: 'wiki-search',
        enabled: true,
        workspace: 'notes',
      }],
    });
  });
});
