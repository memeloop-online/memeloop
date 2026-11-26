import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registerCoreNodeTools: vi.fn(),
  registerFileTools: vi.fn(),
  registerGenericNodeTools: vi.fn(),
  registerTerminalTools: vi.fn(),
  registerVscodeTools: vi.fn(),
  registerWikiTools: vi.fn(),
  registerScreenshotTool: vi.fn(),
  registerDemoTools: vi.fn(),
}));

vi.mock('../registerCoreNodeTools', () => ({ registerCoreNodeTools: mocks.registerCoreNodeTools }));
vi.mock('../fileSystem', () => ({ registerFileTools: mocks.registerFileTools }));
vi.mock('../genericNodeTools', () => ({ registerGenericNodeTools: mocks.registerGenericNodeTools }));
vi.mock('../terminal', () => ({ registerTerminalTools: mocks.registerTerminalTools }));
vi.mock('../vscodeCli', () => ({ registerVscodeTools: mocks.registerVscodeTools }));
vi.mock('../wikiTools', () => ({ registerWikiTools: mocks.registerWikiTools }));
vi.mock('../screenshot', () => ({ registerScreenshotTool: mocks.registerScreenshotTool }));
vi.mock('../demo', () => ({ registerDemoTools: mocks.registerDemoTools }));

import { registerNodeEnvironmentTools } from '../registerNodeEnvironmentTools.js';

describe('registerNodeEnvironmentTools', () => {
  const createRegistry = () => ({
    registerTool: vi.fn(),
    registerOwnedTool: vi.fn((_id: string, _impl: unknown) => () => true),
    getTool: vi.fn(),
    listTools: vi.fn(() => []),
  });

  beforeEach(() => {
    for (const registrar of Object.values(mocks)) {
      registrar.mockReset();
      registrar.mockReturnValue(() => undefined);
    }
  });

  it('registers file/generic/vscode by default', () => {
    registerNodeEnvironmentTools(createRegistry(), { nodeId: 'test-node' });

    expect(mocks.registerCoreNodeTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerFileTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerGenericNodeTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerVscodeTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerTerminalTools).not.toHaveBeenCalled();
    expect(mocks.registerWikiTools).not.toHaveBeenCalled();
  });

  it('registers optional terminal/wiki and forwards node/storage options', () => {
    const terminalManager = { t: 1 };
    const wikiManager = { w: 1 };
    const storage = { s: 1 };
    registerNodeEnvironmentTools(createRegistry(), {
      terminalManager: terminalManager as never,
      wikiManager: wikiManager as never,
      wikiDefaultId: 'wk',
      nodeId: 'node-a',
      storage: storage as never,
      fileBaseDir: '/tmp/x',
      includeVscodeCli: false,
    });

    expect(mocks.registerTerminalTools).toHaveBeenCalledWith(
      expect.anything(),
      terminalManager,
      expect.objectContaining({ nodeId: 'node-a', storage }),
    );
    expect(mocks.registerFileTools).toHaveBeenCalledWith(
      expect.anything(),
      '/tmp/x',
      expect.objectContaining({ nodeId: 'node-a' }),
    );
    expect(mocks.registerWikiTools).toHaveBeenCalledWith(expect.anything(), wikiManager, 'wk');
    expect(mocks.registerVscodeTools).not.toHaveBeenCalled();
  });

  it('fails closed without a stable resource identity', () => {
    expect(() => registerNodeEnvironmentTools(createRegistry(), { nodeId: ' ' })).toThrow(
      'requires a stable nodeId',
    );
    expect(mocks.registerCoreNodeTools).not.toHaveBeenCalled();
  });

  it('returns an ownership-safe disposer for owner-aware host registries', () => {
    const tools = new Map<string, unknown>();
    const registry = {
      registerTool: (_id: string, _impl: unknown) => undefined,
      registerOwnedTool: (id: string, impl: unknown) => {
        tools.set(id, impl);
        return () => {
          if (tools.get(id) !== impl) return false;
          tools.delete(id);
          return true;
        };
      },
      getTool: (id: string) => tools.get(id),
      listTools: () => [...tools.keys()],
    };
    const runtimeTool = () => 'runtime';
    const replacement = () => 'host replacement';
    mocks.registerCoreNodeTools.mockImplementationOnce(owned => {
      const dispose = owned.registerOwnedTool('owned.tool', runtimeTool);
      return () => {
        dispose();
      };
    });

    const dispose = registerNodeEnvironmentTools(registry, { nodeId: 'test-node' });
    expect(tools.get('owned.tool')).toBe(runtimeTool);
    tools.set('owned.tool', replacement);
    dispose();
    expect(tools.get('owned.tool')).toBe(replacement);
    expect(() => {
      dispose();
    }).not.toThrow();
  });

  it('rolls back earlier owned tools if a later registrar fails', () => {
    const tools = new Map<string, unknown>();
    const registry = {
      registerTool: (_id: string, _impl: unknown) => undefined,
      registerOwnedTool: (id: string, impl: unknown) => {
        tools.set(id, impl);
        return () => {
          if (tools.get(id) !== impl) return false;
          tools.delete(id);
          return true;
        };
      },
      getTool: (id: string) => tools.get(id),
      listTools: () => [...tools.keys()],
    };
    mocks.registerCoreNodeTools.mockImplementationOnce(owned => {
      const dispose = owned.registerOwnedTool('partial.tool', () => undefined);
      return () => {
        dispose();
      };
    });
    mocks.registerFileTools.mockImplementationOnce(() => {
      throw new Error('file registrar failed');
    });

    expect(() => registerNodeEnvironmentTools(registry, { nodeId: 'test-node' }))
      .toThrow('file registrar failed');
    expect(tools.has('partial.tool')).toBe(false);
  });
});
