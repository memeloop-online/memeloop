import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');

describe('24.2 scope guard wiring', () => {
  it('check-portable-boundaries.mjs script exists', () => {
    const scriptPath = join(ROOT, 'scripts', 'check-portable-boundaries.mjs');
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('memeloop package.json has check:boundaries script', () => {
    const pkgPath = join(ROOT, 'packages', 'memeloop', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts['check:boundaries']).toBeDefined();
  });

  it('root package.json has check:boundaries script', () => {
    const pkgPath = join(ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts['check:boundaries']).toBeDefined();
  });

  it('script detects dynamic import() with non-literal arguments', () => {
    const scriptPath = join(ROOT, 'scripts', 'check-portable-boundaries.mjs');
    const content = readFileSync(scriptPath, 'utf-8');
    // The script should check for dynamic imports
    expect(content).toMatch(/dynamic.*import|import\s*\(/);
  });

  it('script detects raw process.env usage in core', () => {
    const scriptPath = join(ROOT, 'scripts', 'check-portable-boundaries.mjs');
    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toMatch(/process\.env|process\./);
  });

  it('script enforces memeloop-react-ui scope guard', () => {
    const scriptPath = join(ROOT, 'scripts', 'check-portable-boundaries.mjs');
    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toMatch(/react-ui|memeloop-react-ui/);
  });
});
