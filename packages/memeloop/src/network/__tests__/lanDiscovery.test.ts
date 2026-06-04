import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const publish = vi.fn();
  const unpublishAll = vi.fn((cb: () => void) => {
    cb();
  });
  const destroy = vi.fn();
  const browserStop = vi.fn();
  const find = vi.fn((_opts: any, cb: any) => {
    cb({ name: 'n1', host: '127.0.0.1', port: 38472, txt: { nodeId: 'node-1', wsPath: '/ws', k: 'v' } });
    return { stop: browserStop };
  });
  class Bonjour {
    publish = publish;
    unpublishAll = unpublishAll;
    destroy = destroy;
    find = find;
  }
  return { publish, unpublishAll, destroy, browserStop, find, Bonjour };
});

import { __setBonjourFactoryForTest, browse, register } from '../lanDiscovery.js';

describe('lanDiscovery', () => {
  afterEach(() => {
    __setBonjourFactoryForTest(null);
  });

  it('register publishes service and stop unpublishes/destroys', () => {
    __setBonjourFactoryForTest(() => state.Bonjour as any);
    const stop = register({
      name: 'node-a',
      port: 38472,
      nodeId: 'node-1',
      wsPath: '/ws',
      txt: { x: 'y' },
    });
    expect(state.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'node-a',
        type: 'memeloop',
        port: 38472,
        txt: expect.objectContaining({ x: 'y', nodeId: 'node-1', wsPath: '/ws' }),
      }),
    );
    stop();
    expect(state.unpublishAll).toHaveBeenCalledTimes(1);
    expect(state.destroy).toHaveBeenCalled();
  });

  it('browse maps discovered service info and stop closes browser', () => {
    __setBonjourFactoryForTest(() => state.Bonjour as any);
    const onServiceUp = vi.fn();
    const stop = browse({ onServiceUp });
    expect(onServiceUp).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'n1',
        host: '127.0.0.1',
        port: 38472,
        nodeId: 'node-1',
        wsPath: '/ws',
      }),
    );
    stop();
    expect(state.browserStop).toHaveBeenCalledTimes(1);
    expect(state.destroy).toHaveBeenCalled();
  });

  it('returns noop stop when bonjour is unavailable', () => {
    __setBonjourFactoryForTest(() => null);
    expect(() => {
      register({ name: 'x', port: 1 })();
    }).not.toThrow();
    expect(() => {
      browse({ onServiceUp: vi.fn() })();
    }).not.toThrow();
  });

  it('stop swallow errors in register/browse cleanup', () => {
    const BadBonjour = class {
      publish() {
        return { stop: vi.fn() };
      }
      unpublishAll() {
        throw new Error('bad-unpublish');
      }
      destroy() {
        throw new Error('bad-destroy');
      }
      find() {
        return {
          stop() {
            throw new Error('bad-stop');
          },
        };
      }
    };
    __setBonjourFactoryForTest(() => BadBonjour as any);
    expect(() => {
      register({ name: 'x', port: 1 })();
    }).not.toThrow();
    expect(() => {
      browse({ onServiceUp: vi.fn() })();
    }).not.toThrow();
  });
});
