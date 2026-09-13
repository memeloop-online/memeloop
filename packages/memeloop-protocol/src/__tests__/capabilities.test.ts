import { describe, expect, it } from 'vitest';

import { createRemoteOnlyHostCapabilities } from '../index.js';

describe('portable host capability advertisement', () => {
  it('defaults low-power hosts to read/watch without claiming local drivers', () => {
    expect(createRemoteOnlyHostCapabilities({
      resourceKinds: ['AgentWorkload', 'AgentRun', 'AgentRun'],
    })).toEqual({
      operations: ['get', 'list', 'watch'],
      resourceKinds: ['AgentWorkload', 'AgentRun'],
      interfaces: ['resource'],
    });
  });

  it('advertises declarative writes only when the remote host enables them', () => {
    expect(
      createRemoteOnlyHostCapabilities({
        resourceKinds: ['AgentWorkload'],
        writable: true,
      }).operations,
    ).toEqual(['apply', 'get', 'list', 'watch', 'delete']);
  });
});
