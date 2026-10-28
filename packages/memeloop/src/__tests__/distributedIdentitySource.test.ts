import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : productionTypeScriptFiles(path);
    }
    return extname(entry.name) === '.ts' && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('distributed identity source guard', () => {
  it('does not silently alias a missing persistent node identity to local', () => {
    const violations = productionTypeScriptFiles(sourceRoot)
      .filter(path => relative(sourceRoot, path) !== join('storage', 'conformance.ts'))
      .flatMap(path => {
        const source = readFileSync(path, 'utf8');
        return [
            /localNodeId\?\.trim\(\)\s*\|\|\s*['"]local['"]/u,
            /originNodeId\s*:\s*['"]local['"]/u,
          ].some(pattern => pattern.test(source))
          ? [relative(sourceRoot, path)]
          : [];
      });

    expect(violations).toEqual([]);
  });
});
