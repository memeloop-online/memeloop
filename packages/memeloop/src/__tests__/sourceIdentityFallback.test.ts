import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = new URL('../', import.meta.url);
const IMPLICIT_SHARED_IDENTITY = /\b(?:originNodeId|requestPeerId|executionNodeId|nodeId)\s*(?:\?\?|\|\|)\s*['"](?:local|unknown|default)['"]/g;

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...productionTypeScriptFiles(path));
      continue;
    }
    if (
      entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.stories.ts')
    ) files.push(path);
  }
  return files;
}

describe('stable production identities', () => {
  it('never silently shares a local/default node or peer identity', () => {
    const root = SOURCE_ROOT.pathname;
    const violations = productionTypeScriptFiles(root).flatMap(path => {
      const source = readFileSync(path, 'utf8');
      return [...source.matchAll(IMPLICIT_SHARED_IDENTITY)].map(match => ({
        file: relative(root, path),
        expression: match[0],
      }));
    });

    expect(violations).toEqual([]);
  });
});
