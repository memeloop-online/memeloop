import { describe, expect, it } from 'vitest';
import { BUILTIN_RUNTIME_CLASSES, selectRuntimeClass } from '../scripts/scriptRuntime.js';

describe('selectRuntimeClass', () => {
  it('selects trusted-process for trusted scripts', () => {
    const result = selectRuntimeClass('trusted');
    expect(result.runtimeClass).toBe('trusted-process');
    expect(result.isolation).toBe('process');
    expect(result.cpuLimitMillis).toBeGreaterThan(0);
    expect(result.networkAccess).toBe('full');
  });

  it('selects restricted-process for restricted scripts', () => {
    const result = selectRuntimeClass('restricted');
    expect(result.runtimeClass).toBe('restricted-process');
    expect(result.memoryLimitBytes).toBe(128 * 1024 * 1024);
    expect(result.networkAccess).toBe('outbound-only');
  });

  it('selects quarantine-process for quarantine scripts', () => {
    const result = selectRuntimeClass('quarantine');
    expect(result.runtimeClass).toBe('quarantine-process');
    expect(result.memoryLimitBytes).toBe(96 * 1024 * 1024);
    expect(result.networkAccess).toBe('none');
  });

  it('throws when no matching RuntimeClass is available (24.18 fix)', () => {
    expect(() => selectRuntimeClass('trusted', ['quarantine-process'])).toThrow(
      'No RuntimeClass available for trust class: trusted',
    );
  });

  it('throws when available list is empty', () => {
    expect(() => selectRuntimeClass('trusted', [])).toThrow(
      'No RuntimeClass available for trust class: trusted',
    );
  });

  it('quarantine has smallest resource limits', () => {
    const trusted = selectRuntimeClass('trusted');
    const restricted = selectRuntimeClass('restricted');
    const quarantine = selectRuntimeClass('quarantine');
    expect(quarantine.memoryLimitBytes).toBeLessThan(restricted.memoryLimitBytes);
    expect(restricted.memoryLimitBytes).toBeLessThan(trusted.memoryLimitBytes);
  });

  it('built-in classes cover all trust classes', () => {
    const names = Object.keys(BUILTIN_RUNTIME_CLASSES);
    const covered = new Set<string>();
    for (const name of names) {
      for (const tc of BUILTIN_RUNTIME_CLASSES[name].supportedTrustClasses) {
        covered.add(tc);
      }
    }
    expect(covered.has('trusted')).toBe(true);
    expect(covered.has('restricted')).toBe(true);
    expect(covered.has('quarantine')).toBe(true);
  });
});
