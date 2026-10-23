import { describe, expect, it } from 'vitest';

import { MODEL_GATEWAY_ENV, sanitizeWorkerEnvironment } from '../orchestration/workerEnvironment.js';

describe('sanitizeWorkerEnvironment', () => {
  it('strips provider key variables and keeps platform basics', () => {
    const { environment, stripped } = sanitizeWorkerEnvironment({
      baseEnvironment: {
        PATH: '/usr/bin',
        HOME: '/home/worker',
        OPENAI_API_KEY: 'sk-abcdefghijklmnop',
        ANTHROPIC_API_KEY: 'sk-ant-abcdefghijklmnop',
        GROQ_API_KEY: 'gsk_abcdefghijklmnop',
        EDITOR: 'vim',
      } as NodeJS.ProcessEnv,
    });

    expect(environment.PATH).toBe('/usr/bin');
    expect(environment.HOME).toBe('/home/worker');
    expect(environment.EDITOR).toBe('vim');
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.GROQ_API_KEY).toBeUndefined();
    expect(stripped).toEqual(['ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY']);
  });

  it('strips values that look secret-shaped even under innocent names', () => {
    const { environment, stripped } = sanitizeWorkerEnvironment({
      baseEnvironment: {
        MY_CONFIG: 'prefix sk-abcdefghijklmnop suffix',
        SAFE_CONFIG: 'just text',
      } as NodeJS.ProcessEnv,
    });

    expect(environment.MY_CONFIG).toBeUndefined();
    expect(environment.SAFE_CONFIG).toBe('just text');
    expect(stripped).toEqual(['MY_CONFIG']);
  });

  it('respects the keep allowlist', () => {
    const { environment } = sanitizeWorkerEnvironment({
      baseEnvironment: { CUSTOM_API_KEY: 'needed-by-local-tool' } as NodeJS.ProcessEnv,
      keep: ['CUSTOM_API_KEY'],
    });

    expect(environment.CUSTOM_API_KEY).toBe('needed-by-local-tool');
  });

  it('rejects secret-shaped extra variables', () => {
    const { environment, stripped } = sanitizeWorkerEnvironment({
      baseEnvironment: {} as NodeJS.ProcessEnv,
      extra: {
        WORKER_LABEL: 'batch-7',
        SNEAKY: 'mlh1.abc123.def456',
      },
    });

    expect(environment.WORKER_LABEL).toBe('batch-7');
    expect(environment.SNEAKY).toBeUndefined();
    expect(stripped).toEqual(['SNEAKY']);
  });

  it('exposes the model gateway endpoint and never a provider key', () => {
    const { environment } = sanitizeWorkerEnvironment({
      baseEnvironment: { OPENAI_API_KEY: 'sk-abcdefghijklmnop' } as NodeJS.ProcessEnv,
      gatewayEndpoint: 'gateway://default',
    });

    expect(environment[MODEL_GATEWAY_ENV]).toBe('gateway://default');
    expect(Object.values(environment)).not.toContain('sk-abcdefghijklmnop');
  });
});
