import { describe, expect, it } from 'vitest';

import {
  createScheduledTaskAggregatePageController,
  decodeScheduledTaskAggregateCursor,
  encodeScheduledTaskAggregateCursor,
  normalizeScheduledTaskAggregateStates,
  type ScheduledTaskAggregateCursor,
} from '../scheduledTaskCursor.js';

const expectation = {
  agentInstanceId: 'agent-1',
  scope: 'local-peer:local|remote-peer:live',
  states: ['active', 'paused'] as const,
  sourceCount: 2,
};

function cursor(overrides: Partial<ScheduledTaskAggregateCursor> = {}): ScheduledTaskAggregateCursor {
  return {
    version: 1,
    agentInstanceId: expectation.agentInstanceId,
    scope: expectation.scope,
    states: [...expectation.states],
    sourceIndex: 0,
    sourceCount: expectation.sourceCount,
    sources: [{ executionNodeId: 'local-peer', done: false, cursor: 'core-cursor' }],
    ...overrides,
  };
}

describe('scheduled aggregate cursor', () => {
  it('round-trips canonical base64url across a controller and direct decoder', () => {
    const controller = createScheduledTaskAggregatePageController(expectation);
    const encoded = controller.encodePage({
      sourceIndex: 0,
      sources: [{ executionNodeId: 'local-peer', done: false, cursor: 'core-cursor' }],
    });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(controller.decode(encoded)).toEqual(cursor());
    expect(decodeScheduledTaskAggregateCursor(encoded, expectation)).toEqual(cursor());
  });

  it('rejects duplicate states instead of changing the cursor scope', () => {
    expect(() => normalizeScheduledTaskAggregateStates(['paused', 'paused'])).toThrow('scheduled_task_invalid_states');
    expect(() => createScheduledTaskAggregatePageController({ ...expectation, states: ['active', 'active'] })).toThrow(
      'scheduled_task_invalid_states',
    );
  });

  it('rejects malformed, non-canonical and legacy envelopes', () => {
    const encoded = encodeScheduledTaskAggregateCursor(cursor());
    expect(() => decodeScheduledTaskAggregateCursor(`${encoded}=`, expectation)).toThrow('scheduled_task_invalid_cursor');
    expect(() => decodeScheduledTaskAggregateCursor('not-base64!', expectation)).toThrow('scheduled_task_invalid_cursor');
    const legacy = Buffer.from(JSON.stringify({
      version: 3,
      agentInstanceId: 'agent-1',
      executionNodeId: 'local-peer',
      states: ['active'],
      storageCursor: 'core-cursor',
    })).toString('base64url');
    expect(() => decodeScheduledTaskAggregateCursor(legacy, expectation)).toThrow('scheduled_task_invalid_cursor');
  });

  it('enforces exact max and rejects max+1 source counts and cursor bounds', () => {
    const max = createScheduledTaskAggregatePageController({ ...expectation, sourceCount: 64 });
    expect(max.sourceCount).toBe(64);
    expect(() => createScheduledTaskAggregatePageController({ ...expectation, sourceCount: 65 })).toThrow(
      'scheduled_task_invalid_source_count',
    );
    expect(() => encodeScheduledTaskAggregateCursor(cursor({ sourceIndex: 3 }))).toThrow('scheduled_task_invalid_cursor');
  });

  it('rejects cross-host scope, agent, state and source-count reuse', () => {
    const encoded = encodeScheduledTaskAggregateCursor(cursor());
    expect(() => decodeScheduledTaskAggregateCursor(encoded, { ...expectation, scope: 'other-host' })).toThrow(
      'scheduled_task_cursor_stale',
    );
    expect(() => decodeScheduledTaskAggregateCursor(encoded, { ...expectation, agentInstanceId: 'other-agent' })).toThrow(
      'scheduled_task_cursor_stale',
    );
    expect(() => decodeScheduledTaskAggregateCursor(encoded, { ...expectation, states: ['active'] })).toThrow(
      'scheduled_task_cursor_stale',
    );
    expect(() => decodeScheduledTaskAggregateCursor(encoded, { ...expectation, sourceCount: 1 })).toThrow(
      'scheduled_task_cursor_stale',
    );
  });

  it('rejects unknown keys, duplicate source identities and max+1 sources', () => {
    const unknown = { ...cursor(), extra: true } as unknown as ScheduledTaskAggregateCursor;
    expect(() => encodeScheduledTaskAggregateCursor(unknown)).toThrow('scheduled_task_invalid_cursor');
    const duplicate = cursor({
      sources: [
        { executionNodeId: 'local-peer', done: false },
        { executionNodeId: 'local-peer', done: true },
      ],
    });
    expect(() => encodeScheduledTaskAggregateCursor(duplicate)).toThrow('scheduled_task_invalid_cursor');
    const tooMany = cursor({
      sources: Array.from({ length: 3 }, (_, index) => ({ executionNodeId: `peer-${index}`, done: true })),
    });
    expect(() => encodeScheduledTaskAggregateCursor(tooMany)).toThrow('scheduled_task_invalid_cursor');
  });
});
