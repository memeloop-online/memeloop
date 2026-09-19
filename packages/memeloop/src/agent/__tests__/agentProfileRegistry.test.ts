import { beforeEach, describe, expect, it } from 'vitest';

import { AgentProfileRegistry } from '../agentProfileRegistry.js';
import type { AgentProfile } from '../agentProfiles.js';
import { buildAgent, BUILTIN_AGENT_PROFILES, exploreAgent, librarianAgent, oracleAgent, planAgent } from '../agentProfiles.js';

function makeTestDef(overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    id: 'test:custom',
    name: 'Custom Test Agent',
    type: 'build',
    prompt: 'You are a test agent.',
    permissions: { default: 'allow', rules: [] },
    protocolDef: {
      id: 'test:custom',
      name: 'Custom Test Agent',
      description: 'Test agent',
      systemPrompt: 'You are a test agent.',
      tools: [],
      version: '1.0.0',
    },
    ...overrides,
  };
}

describe('AgentProfileRegistry', () => {
  let registry: AgentProfileRegistry;

  beforeEach(() => {
    registry = new AgentProfileRegistry();
  });

  it('is pre-seeded with built-in agent profiles', () => {
    const profiles = registry.listAgentProfiles();
    expect(profiles.length).toBe(5);
    expect(profiles.map((profile) => profile.id)).toEqual([
      'memeloop:build',
      'memeloop:plan',
      'memeloop:explore',
      'memeloop:oracle',
      'memeloop:librarian',
    ]);
  });

  it('can register a new agent profile', () => {
    const def = makeTestDef();
    registry.registerAgentProfile(def);
    expect(registry.listAgentProfiles().length).toBe(6);
    expect(registry.getAgentProfile('test:custom')).toEqual(def);
  });

  it('rejects accidental override of an existing agent profile', () => {
    const updated: AgentProfile = {
      ...buildAgent,
      prompt: 'Updated build agent prompt.',
    };
    expect(() => registry.registerAgentProfile(updated)).toThrow('already registered');
    expect(registry.getAgentProfile('memeloop:build')?.prompt).toBe(buildAgent.prompt);
  });

  it('throws when registering an agent with empty id', () => {
    expect(() => {
      registry.registerAgentProfile(makeTestDef({ id: '' }));
    }).toThrow(/non-empty id/);
  });

  it('throws when registering an agent without a name', () => {
    expect(() => {
      registry.registerAgentProfile(makeTestDef({ name: '' }));
    }).toThrow(/must have a name/);
  });

  it('throws when registering an agent without a type', () => {
    expect(() => {
      registry.registerAgentProfile(makeTestDef({ type: '' as never }));
    }).toThrow(/must have a type/);
  });

  it('throws when registering an agent without a prompt', () => {
    expect(() => {
      registry.registerAgentProfile(makeTestDef({ prompt: '' }));
    }).toThrow(/must have a prompt/);
  });

  it('getAgentProfile returns undefined for non-existent profile', () => {
    expect(registry.getAgentProfile('nonexistent')).toBeUndefined();
  });

  it('listAgentProfilesByType filters profiles by type', () => {
    const oracleAgents = registry.listAgentProfilesByType('oracle');
    expect(oracleAgents.length).toBe(1);
    expect(oracleAgents[0]?.id).toBe('memeloop:oracle');
  });

  it('does not allow raw removal of builtin profiles', () => {
    expect(registry.unregisterAgentProfile('memeloop:build')).toBe(false);
    expect(registry.getAgentProfile('memeloop:build')).toEqual(buildAgent);
    expect(registry.listAgentProfiles().length).toBe(5);
  });

  it('unregisterAgentProfile returns false for unknown profile', () => {
    expect(registry.unregisterAgentProfile('nonexistent')).toBe(false);
  });

  it('reset clears all custom agents and restores defaults', () => {
    const def = makeTestDef();
    registry.registerAgentProfile(def);
    expect(registry.listAgentProfiles().length).toBe(6);
    registry.reset();
    expect(registry.listAgentProfiles().length).toBe(5);
    expect(registry.getAgentProfile('test:custom')).toBeUndefined();
  });

  it('owned cleanup is isolated and stale cleanup cannot delete a trusted replacement', () => {
    const first = makeTestDef();
    const disposeFirst = registry.registerAgentProfile(first);
    const replacement = { ...first, name: 'Trusted replacement' };
    const disposeReplacement = registry.replaceAgentProfile(replacement);
    disposeFirst();
    expect(registry.getAgentProfile(first.id)).toEqual(replacement);
    disposeReplacement();
    expect(registry.getAgentProfile(first.id)).toBeUndefined();
  });
  it('does not expose mutable internal profile state', () => {
    const profile = registry.getAgentProfile('memeloop:build');
    expect(profile).toBeDefined();
    profile!.permissions.default = 'deny';
    profile!.protocolDef.tools.push('hostile.tool');

    expect(registry.getAgentProfile('memeloop:build')?.permissions.default).toBe('allow');
    expect(registry.getAgentProfile('memeloop:build')?.protocolDef.tools).toEqual([]);
  });

  it.each([
    ['Map', () => makeTestDef({ permissions: new Map() as never })],
    ['Date', () => makeTestDef({ protocolDef: new Date() as never })],
    ['invalid type', () => makeTestDef({ type: 42 as never })],
    ['invalid rule', () =>
      makeTestDef({
        permissions: { default: 'allow', rules: [{ pattern: 'x', action: 'maybe' as never }] },
      })],
  ])('rejects hostile non-schema input: %s', (_name, makeProfile) => {
    expect(() => registry.registerAgentProfile(makeProfile())).toThrow();
  });

  it('rejects cyclic, accessor, and over-budget profiles without invoking getters', () => {
    const cyclic = makeTestDef() as AgentProfile & { self?: unknown };
    cyclic.self = cyclic;
    expect(() => registry.registerAgentProfile(cyclic)).toThrow();

    let getterCalls = 0;
    const accessor = makeTestDef();
    Object.defineProperty(accessor, 'name', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'hostile';
      },
    });
    expect(() => registry.registerAgentProfile(accessor)).toThrow();
    expect(getterCalls).toBe(0);

    expect(() =>
      registry.registerAgentProfile(makeTestDef({
        prompt: 'x'.repeat(300_000),
      }))
    ).toThrow();
  });

  it('detaches registered input from later mutation', () => {
    const profile = makeTestDef();
    registry.registerAgentProfile(profile);
    profile.name = 'mutated';
    profile.permissions.default = 'deny';
    expect(registry.getAgentProfile('test:custom')?.name).toBe('Custom Test Agent');
    expect(registry.getAgentProfile('test:custom')?.permissions.default).toBe('allow');
  });
});

describe('pre-defined agents', () => {
  it('buildAgent has full access permissions', () => {
    expect(buildAgent.permissions.default).toBe('allow');
    expect(buildAgent.permissions.rules).toHaveLength(0);
    expect(buildAgent.type).toBe('build');
  });

  it('planAgent is read-only', () => {
    expect(planAgent.permissions.default).toBe('deny');
    expect(planAgent.permissions.rules.length).toBeGreaterThan(0);
    // All allowed tools are read/search
    for (const rule of planAgent.permissions.rules) {
      expect(['file.read', 'file.search', 'file.list', 'grep.search', 'glob.*']).toContain(
        rule.pattern,
      );
      expect(rule.action).toBe('allow');
    }
    expect(planAgent.type).toBe('plan');
  });

  it('exploreAgent has read + search + LSP permissions', () => {
    expect(exploreAgent.permissions.default).toBe('deny');
    const patterns = exploreAgent.permissions.rules.map((r) => r.pattern);
    expect(patterns).toContain('lsp.*');
    expect(patterns).toContain('file.read');
    expect(exploreAgent.type).toBe('explore');
  });

  it('oracleAgent is read-only for architecture consultation', () => {
    expect(oracleAgent.permissions.default).toBe('deny');
    const patterns = oracleAgent.permissions.rules.map((r) => r.pattern);
    expect(patterns).toContain('lsp.*');
    expect(patterns).not.toContain('terminal.*');
    expect(oracleAgent.type).toBe('oracle');
  });

  it('librarianAgent has read + web search permissions', () => {
    expect(librarianAgent.permissions.default).toBe('deny');
    const patterns = librarianAgent.permissions.rules.map((r) => r.pattern);
    expect(patterns).toContain('web.*');
    expect(patterns).not.toContain('terminal.*');
    expect(patterns).not.toContain('lsp.*');
    expect(librarianAgent.type).toBe('librarian');
  });

  it('all pre-defined agents have unique IDs', () => {
    const ids = BUILTIN_AGENT_PROFILES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all pre-defined agents have a protocolDef', () => {
    for (const agent of BUILTIN_AGENT_PROFILES) {
      expect(agent.protocolDef).toBeDefined();
      expect(agent.protocolDef.id).toBe(agent.id);
      expect(agent.protocolDef.name).toBe(agent.name);
      expect(agent.protocolDef.systemPrompt).toBe(agent.prompt);
    }
  });
});
