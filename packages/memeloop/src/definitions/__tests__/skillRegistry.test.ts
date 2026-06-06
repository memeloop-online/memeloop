import { beforeEach, describe, expect, it } from 'vitest';

import { clearSkills, getSkill, listSkills, registerSkill, SkillRegistry, unregisterSkill } from '../skillRegistry.js';
import type { SkillDefinition } from '../skillTypes.js';

function makeSkill(overrides?: Partial<SkillDefinition>): SkillDefinition {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    instructions: 'You are a test skill.',
    ...overrides,
  };
}

describe('Skill Registry', () => {
  beforeEach(() => {
    clearSkills();
  });

  describe('registerSkill', () => {
    it('registers a valid skill', () => {
      const skill = makeSkill();
      registerSkill(skill);
      expect(getSkill('test-skill')).toBe(skill);
    });

    it('throws for skill with empty id', () => {
      expect(() => {
        registerSkill(makeSkill({ id: '' }));
      }).toThrow(/non-empty id/);
    });

    it('throws for skill without a name', () => {
      expect(() => {
        registerSkill(makeSkill({ name: '' }));
      }).toThrow(/must have a name/);
    });

    it('throws for skill without instructions', () => {
      expect(() => {
        registerSkill(makeSkill({ instructions: '' }));
      }).toThrow(/must have instructions/);
    });

    it('overwrites existing skill with same id', () => {
      const first = makeSkill({ id: 'dup', name: 'First' });
      const second = makeSkill({ id: 'dup', name: 'Second' });
      registerSkill(first);
      registerSkill(second);
      expect(getSkill('dup')?.name).toBe('Second');
    });
  });

  describe('getSkill', () => {
    it('returns undefined for unknown skill', () => {
      expect(getSkill('nonexistent')).toBeUndefined();
    });

    it('returns the registered skill', () => {
      const skill = makeSkill({ id: 'my-skill' });
      registerSkill(skill);
      expect(getSkill('my-skill')).toEqual(skill);
    });
  });

  describe('listSkills', () => {
    it('returns empty list initially', () => {
      expect(listSkills()).toEqual([]);
    });

    it('returns all registered skills', () => {
      registerSkill(makeSkill({ id: 'a' }));
      registerSkill(makeSkill({ id: 'b' }));
      expect(listSkills()).toHaveLength(2);
    });
  });

  describe('unregisterSkill', () => {
    it('removes a registered skill', () => {
      registerSkill(makeSkill({ id: 'to-remove' }));
      expect(unregisterSkill('to-remove')).toBe(true);
      expect(getSkill('to-remove')).toBeUndefined();
    });

    it('returns false for unknown skill', () => {
      expect(unregisterSkill('unknown')).toBe(false);
    });
  });

  describe('clearSkills', () => {
    it('removes all skills', () => {
      registerSkill(makeSkill({ id: 'a' }));
      registerSkill(makeSkill({ id: 'b' }));
      clearSkills();
      expect(listSkills()).toEqual([]);
    });
  });

  describe('SkillRegistry instances', () => {
    it('isolates skills between registry instances', () => {
      const first = new SkillRegistry();
      const second = new SkillRegistry();

      first.registerSkill(makeSkill({ id: 'only-first' }));
      second.registerSkill(makeSkill({ id: 'only-second' }));

      expect(first.getSkill('only-first')).toBeDefined();
      expect(first.getSkill('only-second')).toBeUndefined();
      expect(second.getSkill('only-first')).toBeUndefined();
      expect(second.getSkill('only-second')).toBeDefined();
    });

    it('uses the same validation rules as the default registry', () => {
      const registry = new SkillRegistry();

      expect(() => {
        registry.registerSkill(makeSkill({ id: '' }));
      }).toThrow(/non-empty id/);
      expect(() => {
        registry.registerSkill(makeSkill({ name: '' }));
      }).toThrow(/must have a name/);
      expect(() => {
        registry.registerSkill(makeSkill({ instructions: '' }));
      }).toThrow(/must have instructions/);
    });
  });
});
