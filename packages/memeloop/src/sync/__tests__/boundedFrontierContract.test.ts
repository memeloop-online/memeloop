import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('bounded frontier contract', () => {
  it('does not reintroduce full-vector production reads', () => {
    const engine = readFileSync(fileURLToPath(new URL('../chatSyncEngine.ts', import.meta.url)), 'utf8');
    const ports = readFileSync(fileURLToPath(new URL('../../storage/ports.ts', import.meta.url)), 'utf8');
    const production = `${engine}\n${ports}`;

    expect(production).not.toMatch(/\bgetVersionVector\s*\(/u);
    expect(production).not.toMatch(/\bgetEventVersionFrontiers\s*\(/u);
    expect(production).toContain('getEventVersionFrontierPage');
    expect(production).toContain('getEventVersionFrontiersForKeys');
  });
});
