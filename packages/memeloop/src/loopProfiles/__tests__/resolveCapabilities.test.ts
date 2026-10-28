import { describe, expect, it } from 'vitest';

import { LoopRegistryImpl } from '../../loopAPI/registry.js';
import { registerBuiltinLoopProfiles } from '../loadBuiltins.js';
import { LOOP_PROFILE_TOOL_CAPABILITY_MISSING, MissingLoopProfileToolCapabilityError, resolveLoopProfileCapabilities } from '../resolveCapabilities.js';

function capabilities(toolIds: readonly string[]) {
  const registered = new Set(toolIds);
  return {
    hasTool: (toolId: string) => registered.has(toolId),
    listTools: () => [...registered],
  };
}

describe('resolveLoopProfileCapabilities', () => {
  it('resolves the neutral general assistant after its exact tools are registered', () => {
    const loopRegistry = new LoopRegistryImpl();
    registerBuiltinLoopProfiles(loopRegistry);

    const profile = resolveLoopProfileCapabilities({
      profileId: 'memeloop:general-assistant',
      loopRegistry,
      toolRegistry: capabilities([
        'mcpClient',
        'mcpForward',
        'spawnAgent',
        'ask-question',
        'todoWrite',
      ]),
    });

    expect(profile.id).toBe('memeloop:general-assistant');
    expect(profile.systemPrompt).toContain('Treat every host capability as optional');
    expect(profile.systemPrompt).not.toMatch(/wiki/i);
  });

  it('fails closed with a typed error listing exact missing capabilities', () => {
    const loopRegistry = new LoopRegistryImpl();
    registerBuiltinLoopProfiles(loopRegistry);

    expect(() =>
      resolveLoopProfileCapabilities({
        profileId: 'memeloop:general-assistant',
        loopRegistry,
        toolRegistry: capabilities(['mcpClient', 'spawnAgent']),
      })
    ).toThrowError(expect.objectContaining({
      code: LOOP_PROFILE_TOOL_CAPABILITY_MISSING,
      missingToolIds: ['ask-question', 'mcpForward', 'todoWrite'],
    }));

    try {
      resolveLoopProfileCapabilities({
        profileId: 'memeloop:general-assistant',
        loopRegistry,
        toolRegistry: capabilities(['mcpClient', 'spawnAgent']),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MissingLoopProfileToolCapabilityError);
    }
  });

  it('returns a detached, deeply immutable profile snapshot', () => {
    const loopRegistry = new LoopRegistryImpl();
    registerBuiltinLoopProfiles(loopRegistry);
    const profile = resolveLoopProfileCapabilities({
      profileId: 'memeloop:general-assistant',
      loopRegistry,
      toolRegistry: capabilities([
        'mcpClient',
        'mcpForward',
        'spawnAgent',
        'ask-question',
        'todoWrite',
      ]),
    });

    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.agentTools)).toBe(true);
    expect(Object.isFrozen(profile.agentTools?.[0]?.parameters)).toBe(true);
    expect(() => profile.agentTools?.push({ toolId: 'wikiSearch' })).toThrow();
    expect(loopRegistry.getProfile(profile.id)?.agentTools).toHaveLength(4);
  });

  it('does not invoke accessors returned by a third-party loop registry', () => {
    let getterCalls = 0;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(hostile, {
      id: { enumerable: true, value: 'hostile-profile' },
      name: { enumerable: true, value: 'Hostile profile' },
      description: { enumerable: true, value: '' },
      tools: {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return ['terminal'];
        },
      },
    });

    expect(() =>
      resolveLoopProfileCapabilities({
        profileId: 'hostile-profile',
        loopRegistry: { getProfile: () => hostile as never },
        toolRegistry: capabilities(['terminal']),
      })
    ).toThrow();
    expect(getterCalls).toBe(0);
  });
});
