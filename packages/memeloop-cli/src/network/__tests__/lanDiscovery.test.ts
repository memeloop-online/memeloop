import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const publish = vi.fn();
  const unpublishAll = vi.fn((callback: () => void) => {
    callback();
  });
  const destroy = vi.fn();
  const browserStop = vi.fn();
  const find = vi.fn((_options: unknown, callback: (service: { name: string; host: string; port: number; txt?: Record<string, string> }) => void) => {
    callback({ name: "n1", host: "127.0.0.1", port: 38472, txt: { nodeId: "node-1", wsPath: "/ws", k: "v" } });
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

import { __setBonjourFactoryForTest, browse, register } from "../lanDiscovery.js";

describe("lanDiscovery", () => {
  afterEach(() => {
    __setBonjourFactoryForTest(null);
  });

  it("register publishes service and stop unpublishes/destroys", () => {
    __setBonjourFactoryForTest(() => state.Bonjour as never);
    const stop = register({
      name: "node-a",
      port: 38472,
      nodeId: "node-1",
      wsPath: "/ws",
      txt: { x: "y" },
    });
    expect(state.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "node-a",
        type: "memeloop",
        port: 38472,
        txt: expect.objectContaining({ x: "y", nodeId: "node-1", wsPath: "/ws" }),
      }),
    );
    stop();
    expect(state.unpublishAll).toHaveBeenCalledTimes(1);
    expect(state.destroy).toHaveBeenCalled();
  });

  it("browse maps discovered service info and stop closes browser", () => {
    __setBonjourFactoryForTest(() => state.Bonjour as never);
    const onServiceUp = vi.fn();
    const stop = browse({ onServiceUp });
    expect(onServiceUp).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "n1",
        host: "127.0.0.1",
        port: 38472,
        nodeId: "node-1",
        wsPath: "/ws",
      }),
    );
    stop();
    expect(state.browserStop).toHaveBeenCalledTimes(1);
    expect(state.destroy).toHaveBeenCalled();
  });

  it("returns noop stop when bonjour is unavailable", () => {
    __setBonjourFactoryForTest(() => null);
    expect(() => register({ name: "x", port: 1 })()).not.toThrow();
    expect(() => browse({ onServiceUp: vi.fn() })()).not.toThrow();
  });

  it("swallows cleanup errors", () => {
    const BadBonjour = class {
      publish() {
        return { stop: vi.fn() };
      }
      unpublishAll() {
        throw new Error("bad-unpublish");
      }
      destroy() {
        throw new Error("bad-destroy");
      }
      find() {
        return {
          stop() {
            throw new Error("bad-stop");
          },
        };
      }
    };
    __setBonjourFactoryForTest(() => BadBonjour as never);
    expect(() => register({ name: "x", port: 1 })()).not.toThrow();
    expect(() => browse({ onServiceUp: vi.fn() })()).not.toThrow();
  });
});