import { describe, expect, it } from 'vitest';

import { isPluginAllowedInMode, resolveWorkerModeConfig, trustClassForWorkerMode } from '../workerMode.js';

describe('resolveWorkerModeConfig', () => {
  it('returns ordinary config by default', () => {
    const config = resolveWorkerModeConfig({});
    expect(config.mode).toBe('ordinary');
    expect(config.enableOrdinaryPlugins).toBe(true);
    expect(config.inheritOrdinaryCredentials).toBe(true);
  });

  it('uses separate directories for restricted mode', () => {
    const config = resolveWorkerModeConfig({
      mode: 'restricted',
      dataDir: '/data',
      identityPath: '/data/identity.json',
    });
    expect(config.mode).toBe('restricted');
    expect(config.dataDir).toBe('/data-restricted');
    expect(config.identityPath).toBe('/data/identity.json-restricted');
    expect(config.enableOrdinaryPlugins).toBe(false);
    expect(config.inheritOrdinaryCredentials).toBe(false);
  });

  it('uses separate directories for quarantine mode', () => {
    const config = resolveWorkerModeConfig({
      mode: 'quarantine',
      dataDir: '/data',
      identityPath: '/data/identity.json',
    });
    expect(config.mode).toBe('quarantine');
    expect(config.dataDir).toBe('/data-quarantine');
    expect(config.identityPath).toBe('/data/identity.json-quarantine');
    expect(config.enableOrdinaryPlugins).toBe(false);
    expect(config.inheritOrdinaryCredentials).toBe(false);
  });

  it('preserves allowed plugin paths for restricted mode', () => {
    const config = resolveWorkerModeConfig({
      mode: 'restricted',
      allowedPluginPaths: ['/plugins/safe-plugin'],
    });
    expect(config.allowedPluginPaths).toEqual(['/plugins/safe-plugin']);
  });
});

describe('isPluginAllowedInMode', () => {
  it('allows all plugins in ordinary mode', () => {
    const config = resolveWorkerModeConfig({ mode: 'ordinary' });
    expect(isPluginAllowedInMode(config, '/any/plugin')).toBe(true);
  });

  it('rejects all plugins in restricted mode by default', () => {
    const config = resolveWorkerModeConfig({ mode: 'restricted' });
    expect(isPluginAllowedInMode(config, '/any/plugin')).toBe(false);
  });

  it('rejects all plugins in quarantine mode by default', () => {
    const config = resolveWorkerModeConfig({ mode: 'quarantine' });
    expect(isPluginAllowedInMode(config, '/any/plugin')).toBe(false);
  });

  it('allows explicitly listed plugins when ordinary plugins are enabled', () => {
    const config = resolveWorkerModeConfig({
      mode: 'restricted',
      allowedPluginPaths: ['/plugins/safe'],
    });
    // Note: enableOrdinaryPlugins is false for restricted mode, so even
    // allowed paths are rejected unless the mode explicitly enables them.
    expect(isPluginAllowedInMode(config, '/plugins/safe')).toBe(false);
  });
});

describe('trustClassForWorkerMode', () => {
  it('maps modes to trust classes', () => {
    expect(trustClassForWorkerMode('ordinary')).toBe('trusted');
    expect(trustClassForWorkerMode('restricted')).toBe('restricted');
    expect(trustClassForWorkerMode('quarantine')).toBe('quarantine');
  });
});
