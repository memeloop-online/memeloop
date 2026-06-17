import { beforeEach, describe, expect, it } from 'vitest';

import { getLoopRegistry, resetLoopRegistry } from '../registry.js';
import type { LoopProfile } from '../types.js';

interface InstallCall {
  id: string;
  config: Record<string, unknown> | undefined;
  target: { [key: string]: unknown };
}

function makeProfile(overrides: Partial<LoopProfile> = {}): LoopProfile {
  return {
    id: 'profile:test',
    name: 'Test Profile',
    description: 'Test profile',
    loopId: 'llm-io',
    ...overrides,
  };
}

describe('LoopRegistry', () => {
  beforeEach(() => {
    resetLoopRegistry();
  });

  it('installs only enabled profile plugins and passes plugin config', () => {
    const registry = getLoopRegistry();
    const calls: InstallCall[] = [];

    registry.registerPlugin({
      id: 'plugin:alpha',
      targetLoopId: 'llm-io',
      install: (target, config) => calls.push({ id: 'plugin:alpha', config, target }),
    });
    registry.registerPlugin({
      id: 'plugin:beta',
      targetLoopId: 'llm-io',
      install: (target, config) => calls.push({ id: 'plugin:beta', config, target }),
    });
    registry.registerPlugin({
      id: 'plugin:gamma',
      targetLoopId: 'llm-io',
      install: (target, config) => calls.push({ id: 'plugin:gamma', config, target }),
    });

    const profile = makeProfile({
      plugins: [
        { id: 'plugin:alpha', config: { threshold: 3 } },
        { id: 'plugin:beta', enabled: false, config: { ignored: true } },
      ],
    });
    const target = { marker: 'target' };

    registry.installPluginsForProfile(profile, target);

    expect(calls).toEqual([{ id: 'plugin:alpha', config: { threshold: 3 }, target }]);
  });

  it('respects plugin target loop ids when installing profile plugins', () => {
    const registry = getLoopRegistry();
    const calls: string[] = [];

    registry.registerPlugin({
      id: 'plugin:sub-agent-only',
      targetLoopId: 'sub-agent',
      install: () => calls.push('sub-agent'),
    });
    registry.registerPlugin({
      id: 'plugin:any-loop',
      targetLoopId: '*',
      install: () => calls.push('any-loop'),
    });

    registry.installPluginsForProfile(
      makeProfile({
        loopId: 'llm-io',
        plugins: [{ id: 'plugin:sub-agent-only' }, { id: 'plugin:any-loop' }],
      }),
      {},
    );

    expect(calls).toEqual(['any-loop']);
  });

  it('keeps installPluginsForLoop compatible with string selections', () => {
    const registry = getLoopRegistry();
    const calls: string[] = [];

    registry.registerPlugin({
      id: 'plugin:alpha',
      targetLoopId: '*',
      install: () => calls.push('alpha'),
    });
    registry.registerPlugin({
      id: 'plugin:beta',
      targetLoopId: '*',
      install: () => calls.push('beta'),
    });

    registry.installPluginsForLoop('llm-io', {}, ['plugin:beta']);

    expect(calls).toEqual(['beta']);
  });
});
