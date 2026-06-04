import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createNodeServer: vi.fn(),
  register: vi.fn(),
}));

vi.mock("../nodeServerImpl.js", () => {
  return {
    createNodeServer: (..._args: any[]) => mocks.createNodeServer(..._args),
  };
});

vi.mock("../lanDiscovery.js", () => {
  return {
    register: (...args: any[]) => mocks.register(...args),
  };
});

import { startNodeServerWithMdns } from "../nodeServer.js";

describe("startNodeServerWithMdns", () => {
  const oldEnv = {
    NODE_ENV: process.env.NODE_ENV,
    MEMELOOP_DISABLE_MDNS: process.env.MEMELOOP_DISABLE_MDNS,
  };

  let server: http.Server | undefined;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    process.env.MEMELOOP_DISABLE_MDNS = "0";

    server = undefined;
    mocks.createNodeServer.mockReset();
    mocks.register.mockReset();

    mocks.createNodeServer.mockImplementation(() =>
      http.createServer((_req, res) => {
        res.end("ok");
      }),
    );
  });

  afterEach(async () => {
    process.env.NODE_ENV = oldEnv.NODE_ENV;
    process.env.MEMELOOP_DISABLE_MDNS = oldEnv.MEMELOOP_DISABLE_MDNS;

    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });

  it("calls LAN discovery register when mdns enabled", async () => {
    mocks.register.mockImplementation(() => undefined);
    server = await startNodeServerWithMdns({
      port: 0,
      nodeId: "node-1",
      serviceName: "memeloop-test",
      rpcContext: {} as any,
    });

    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(mocks.register.mock.calls[0][0]).toMatchObject({
      name: "memeloop-test",
      port: 0,
      nodeId: "node-1",
    });
  });

  it("ignores errors thrown by memeloop.register", async () => {
    mocks.register.mockImplementation(() => {
      throw new Error("mdns fail");
    });

    server = await startNodeServerWithMdns({
      port: 0,
      nodeId: "node-1",
      serviceName: "memeloop-test",
      rpcContext: {} as any,
    });

    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
});

