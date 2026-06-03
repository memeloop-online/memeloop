import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NodeConfig } from "../config";

interface MockNodeKeypair {
  nodeId: string;
  x25519PublicKey: string;
  x25519PrivateKey: string;
  ed25519PublicKey: string;
  ed25519PrivateKey: string;
  createdAt: number;
}

interface MockCloudJwtResult {
  accessToken: string;
}

interface MockCloudRegisterOtpResult {
  nodeId: string;
  nodeSecret?: string;
}

interface MockBinding extends Record<string, unknown> {
  imUserId: string;
  pendingQuestionId: string;
}

interface MockConversationSource {
  channelId: string;
  imUserId: string;
}

interface MockConversationMeta {
  sourceChannel?: MockConversationSource;
}

interface AskQuestionPayload {
  questionId: string;
  question: string;
  conversationId?: string;
  inputType?: "single-select" | "multi-select" | "text";
  options?: Array<{ label: string; description?: string }>;
  allowFreeform?: boolean;
}

interface MockRuntime {
  __notifyAskQuestion?: (payload: AskQuestionPayload) => void;
}

interface MockStorage {
  getConversationMeta: (conversationId: string) => Promise<MockConversationMeta | undefined>;
}

interface MockCreateNodeRuntimeOptions {
  dataDir?: string;
  fileBaseDir?: string;
  builtinToolContext?: {
    notifyAskQuestion?: (payload: AskQuestionPayload) => void;
  };
}

interface MockCreateNodeRuntimeResult {
  runtime: MockRuntime;
  storage: MockStorage;
  toolRegistry: Record<string, unknown>;
  wikiManager: unknown;
  agentDefinitions: unknown[];
  fileBaseDirResolved: string;
  refreshWikiAgentDefinitions?: () => Promise<void>;
}

interface MockStartNodeServerOptions {
  rpcContext: {
    runtime: MockRuntime;
  };
}

interface CliTestState {
  config: NodeConfig;
  saved: NodeConfig | null;
  createNodeRuntime: ReturnType<
    typeof vi.fn<(options: MockCreateNodeRuntimeOptions) => MockCreateNodeRuntimeResult>
  >;
  startNodeServerWithMdns: ReturnType<
    typeof vi.fn<(options: MockStartNodeServerOptions) => Promise<void>>
  >;
  registerWithOtp: ReturnType<
    typeof vi.fn<
      (
        code: string,
        keys?: { x25519PublicKey?: string; ed25519PublicKey?: string },
      ) => Promise<MockCloudRegisterOtpResult>
    >
  >;
  cloudClient: {
    getJwt: ReturnType<
      typeof vi.fn<(nodeId: string, nodeSecret: string) => Promise<MockCloudJwtResult>>
    >;
    getJwtByChallenge: ReturnType<
      typeof vi.fn<(nodeId: string, privateKey: string) => Promise<MockCloudJwtResult>>
    >;
    registerNode: ReturnType<
      typeof vi.fn<(payload: unknown, jwt: string) => Promise<{ ok: boolean }>>
    >;
    heartbeat: ReturnType<typeof vi.fn<(nodeId: string, jwt: string) => Promise<{ ok: boolean }>>>;
  };
}

const realSetInterval = global.setInterval;
const realSetTimeout = global.setTimeout;

function createMockFsWatcher(): FSWatcher {
  const eventEmitter = new EventEmitter();
  const watcher = eventEmitter as EventEmitter & {
    close: () => FSWatcher;
    ref: () => FSWatcher;
    unref: () => FSWatcher;
  };

  watcher.close = () => watcher as unknown as FSWatcher;
  watcher.ref = () => watcher as unknown as FSWatcher;
  watcher.unref = () => watcher as unknown as FSWatcher;

  return watcher as unknown as FSWatcher;
}

function createIntervalHandle(): ReturnType<typeof setInterval> {
  const timer = realSetInterval(() => undefined, 60_000);
  clearInterval(timer);
  return timer;
}

function createTimeoutHandle(): ReturnType<typeof setTimeout> {
  const timer = realSetTimeout(() => undefined, 0);
  clearTimeout(timer);
  return timer;
}

function runTimerHandler(handler: Parameters<typeof setInterval>[0]): void {
  if (typeof handler === "function") {
    handler();
  }
}

function createRuntimeResult(
  overrides: Partial<MockCreateNodeRuntimeResult> = {},
): MockCreateNodeRuntimeResult {
  return {
    runtime: {},
    storage: {
      getConversationMeta: vi
        .fn<(conversationId: string) => Promise<MockConversationMeta | undefined>>()
        .mockResolvedValue(undefined),
    },
    toolRegistry: {},
    wikiManager: undefined,
    agentDefinitions: [],
    fileBaseDirResolved: "/tmp",
    refreshWikiAgentDefinitions: undefined,
    ...overrides,
  };
}

function getSavedConfig(): NodeConfig {
  if (!state.saved) {
    throw new Error("Expected config to be saved");
  }

  return state.saved;
}

function getFirstRuntimeCreationOptions(): MockCreateNodeRuntimeOptions {
  const firstRuntimeCreationOptions = state.createNodeRuntime.mock.calls.at(0)?.[0];

  if (!firstRuntimeCreationOptions) {
    throw new Error("Expected createNodeRuntime to be called");
  }

  return firstRuntimeCreationOptions;
}

function getNotifyAskQuestionHandler(runtime: MockRuntime): (payload: AskQuestionPayload) => void {
  if (!runtime.__notifyAskQuestion) {
    throw new Error("Expected runtime notifyAskQuestion handler to be wired");
  }

  return runtime.__notifyAskQuestion;
}

const state = vi.hoisted(
  (): CliTestState => ({
    config: {},
    saved: null,
    createNodeRuntime:
      vi.fn<(options: MockCreateNodeRuntimeOptions) => MockCreateNodeRuntimeResult>(),
    startNodeServerWithMdns: vi.fn<(options: MockStartNodeServerOptions) => Promise<void>>(),
    registerWithOtp: vi
      .fn<
        (
          code: string,
          keys?: { x25519PublicKey?: string; ed25519PublicKey?: string },
        ) => Promise<MockCloudRegisterOtpResult>
      >()
      .mockResolvedValue({ nodeId: "node-x", nodeSecret: "sec-x" }),
    cloudClient: {
      getJwt: vi
        .fn<(nodeId: string, nodeSecret: string) => Promise<MockCloudJwtResult>>()
        .mockResolvedValue({ accessToken: "jwt-x" }),
      getJwtByChallenge: vi
        .fn<(nodeId: string, privateKey: string) => Promise<MockCloudJwtResult>>()
        .mockResolvedValue({ accessToken: "jwt-x" }),
      registerNode: vi
        .fn<(payload: unknown, jwt: string) => Promise<{ ok: boolean }>>()
        .mockResolvedValue({ ok: true }),
      heartbeat: vi
        .fn<(nodeId: string, jwt: string) => Promise<{ ok: boolean }>>()
        .mockResolvedValue({ ok: true }),
    },
  }),
);

const fsWatchMock = vi.hoisted(() =>
  vi.fn<(filePath: string, options: { recursive?: boolean }, listener: () => void) => FSWatcher>(),
);
const sendTelegramTextMessageMock = vi.hoisted(() =>
  vi.fn<(botToken: string, imUserId: string, text: string) => Promise<void>>(),
);
const autoConnectDiscoveredPeerMock = vi.hoisted(() =>
  vi.fn<(service: unknown, nodeId: string, manager: unknown) => Promise<void>>(),
);
const browseMock = vi.hoisted(() =>
  vi.fn<(options: { onServiceUp: (service: { name: string; type: string }) => void }) => void>(),
);
const imGetBindingMock = vi.hoisted(() =>
  vi.fn<(channelId: string, imUserId: string) => Promise<MockBinding | undefined>>(),
);
const imSetBindingMock = vi.hoisted(() => vi.fn<(binding: MockBinding) => Promise<void>>());

vi.mock("node:fs", () => ({
  watch: fsWatchMock,
}));

vi.mock("../auth/keypair.js", () => {
  const keypair: MockNodeKeypair = {
    nodeId: "kp-node-id",
    x25519PublicKey: "x-pub",
    x25519PrivateKey: "x-priv",
    ed25519PublicKey: "e-pub",
    ed25519PrivateKey: "e-priv",
    createdAt: 1,
  };

  return {
    getDefaultKeypairPath: () => "/tmp/keypair.yaml",
    loadOrCreateNodeKeypair: vi.fn<() => MockNodeKeypair>().mockReturnValue(keypair),
  };
});

vi.mock("../auth/noiseKeypair.js", () => ({
  nodeKeypairToNoiseStaticKeyPair: vi.fn().mockReturnValue({
    publicKey: Buffer.alloc(32, 7),
    secretKey: Buffer.alloc(32, 8),
  }),
}));

vi.mock("../im/telegramAdapter.js", () => ({
  sendTelegramTextMessage: sendTelegramTextMessageMock,
}));

vi.mock("../network/lanAutoConnect.js", () => ({
  autoConnectDiscoveredPeer: autoConnectDiscoveredPeerMock,
}));

vi.mock("../config", () => ({
  getDefaultConfigPath: () => "/tmp/memeloop-cli.yaml",
  loadConfig: (): NodeConfig => state.config,
  saveConfig: (config: NodeConfig) => {
    state.saved = config;
  },
}));

vi.mock("../auth/wsAuth.js", () => ({
  createLanPinWsAuth: () => ({ mode: "lan-pin" as const }),
}));

vi.mock("../auth/index.js", () => ({
  CloudClient: class CloudClient {
    readonly baseUrl: string;

    constructor(baseUrl: string) {
      this.baseUrl = baseUrl;
    }

    registerWithOtp(
      code: string,
      keys?: { x25519PublicKey?: string; ed25519PublicKey?: string },
    ): Promise<MockCloudRegisterOtpResult> {
      return state.registerWithOtp(code, keys);
    }

    getJwt = state.cloudClient.getJwt;
    getJwtByChallenge = state.cloudClient.getJwtByChallenge;
    registerNode = state.cloudClient.registerNode;
    heartbeat = state.cloudClient.heartbeat;
  },
  buildRegistrationPayload: vi.fn().mockReturnValue({}),
}));

vi.mock("../runtime/index.js", () => ({
  createNodeRuntime: (options: MockCreateNodeRuntimeOptions): MockCreateNodeRuntimeResult =>
    state.createNodeRuntime(options),
}));

vi.mock("../terminal/index.js", () => ({
  TerminalSessionManager: class TerminalSessionManager {
    readonly createdAt = 0;
  },
}));

vi.mock("../network/index.js", () => ({
  PeerConnectionManager: class PeerConnectionManager {
    readonly options: unknown;

    constructor(options: unknown) {
      this.options = options;
    }
  },
  startNodeServerWithMdns: (options: MockStartNodeServerOptions): Promise<void> =>
    state.startNodeServerWithMdns(options),
}));

vi.mock("../im/createImWebhookHandler.js", () => ({
  createImWebhookHandler: vi.fn<() => undefined>().mockReturnValue(undefined),
}));

vi.mock("memeloop", () => ({
  IMChannelManager: class IMChannelManager {
    readonly storage: unknown;

    constructor(storage: unknown) {
      this.storage = storage;
    }

    getBinding = imGetBindingMock;
    setBinding = imSetBindingMock;
  },
  browse: browseMock,
  ConnectivityManager: class ConnectivityManager {
    readonly port: number;
    detectPublicIP = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    constructor(port: number) {
      this.port = port;
    }
  },
}));

function setArgv(args: string[]): void {
  process.argv = ["node", "memeloop", ...args];
}

async function runCli(args: string[]): Promise<void> {
  setArgv(args);
  vi.resetModules();
  await import("../cli.js");
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

describe("cli", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    state.config = {};
    state.saved = null;
    state.createNodeRuntime.mockReset().mockReturnValue(createRuntimeResult());
    state.startNodeServerWithMdns.mockReset().mockResolvedValue(undefined);
    state.registerWithOtp.mockReset().mockResolvedValue({ nodeId: "node-x", nodeSecret: "sec-x" });
    state.cloudClient.getJwt.mockReset().mockResolvedValue({ accessToken: "jwt-x" });
    state.cloudClient.getJwtByChallenge.mockReset().mockResolvedValue({ accessToken: "jwt-x" });
    state.cloudClient.registerNode.mockReset().mockResolvedValue({ ok: true });
    state.cloudClient.heartbeat.mockReset().mockResolvedValue({ ok: true });
    fsWatchMock.mockReset().mockReturnValue(createMockFsWatcher());
    sendTelegramTextMessageMock.mockReset().mockResolvedValue(undefined);
    autoConnectDiscoveredPeerMock.mockReset().mockResolvedValue(undefined);
    browseMock.mockReset();
    imGetBindingMock.mockReset();
    imSetBindingMock.mockReset().mockResolvedValue(undefined);

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const noopProcessExit = ((code?: string | number | null) => {
      void code;
      return undefined;
    }) as unknown as typeof process.exit;

    exitSpy = vi.spyOn(process, "exit").mockImplementation(noopProcessExit);

    setIntervalSpy = vi.spyOn(global, "setInterval").mockImplementation((handler) => {
      void handler;
      return createIntervalHandle();
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

  it("start command wires runtime/server and prints startup log", async () => {
    state.config = {
      name: "node-a",
      providers: [],
      tools: { allowlist: [], blocklist: [] },
      im: { channels: [] },
    };
    process.env.NODE_ENV = "test";

    await runCli(["start", "--port", "38472", "--data-dir", "/tmp"]);

    expect(state.createNodeRuntime).toHaveBeenCalled();
    expect(state.startNodeServerWithMdns).toHaveBeenCalled();
  });

  it("start uses config fileBaseDir separately from dataDir", async () => {
    state.config = {
      name: "node-a",
      providers: [],
      tools: { allowlist: [], blocklist: [] },
      fileBaseDir: "../workspace",
      im: { channels: [] },
    };
    process.env.NODE_ENV = "test";

    await runCli(["start", "--port", "38472", "--data-dir", "/tmp/data"]);

    const firstRuntimeCreationOptions = getFirstRuntimeCreationOptions();
    expect(state.createNodeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDir: path.resolve("/tmp/data"),
        fileBaseDir: path.resolve("../workspace"),
      }),
    );
    expect(firstRuntimeCreationOptions.fileBaseDir).not.toBe(firstRuntimeCreationOptions.dataDir);
  });

  it("start lets cli fileBaseDir override config fileBaseDir", async () => {
    state.config = {
      name: "node-a",
      providers: [],
      tools: { allowlist: [], blocklist: [] },
      fileBaseDir: "/config-workspace",
      im: { channels: [] },
    };
    process.env.NODE_ENV = "test";

    await runCli([
      "start",
      "--port",
      "38472",
      "--data-dir",
      "/tmp/data",
      "--file-base-dir",
      "/cli-workspace",
    ]);

    const firstRuntimeCreationOptions = getFirstRuntimeCreationOptions();
    expect(state.createNodeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDir: path.resolve("/tmp/data"),
        fileBaseDir: path.resolve("/cli-workspace"),
      }),
    );
    expect(firstRuntimeCreationOptions.fileBaseDir).not.toBe(
      path.resolve(state.config.fileBaseDir ?? ""),
    );
  });

  it("start with cloudUrl+nodeSecret schedules heartbeat", async () => {
    state.config = {
      name: "node-a",
      cloudUrl: "https://cloud.example",
      nodeSecret: "sec-x",
      providers: [],
      tools: { allowlist: [], blocklist: [] },
      im: { channels: [] },
    };
    process.env.NODE_ENV = "test";

    setIntervalSpy.mockImplementation((handler) => {
      runTimerHandler(handler);
      return createIntervalHandle();
    });

    await runCli(["start", "--port", "38472", "--data-dir", "/tmp"]);

    expect(state.cloudClient.heartbeat).toHaveBeenCalledWith(expect.any(String), "jwt-x");
  });

  it("start refreshes node jwt when heartbeat gets 401", async () => {
    state.config = {
      name: "node-a",
      cloudUrl: "https://cloud.example",
      nodeSecret: "sec-x",
      providers: [],
      tools: { allowlist: [], blocklist: [] },
      im: { channels: [] },
    };
    process.env.NODE_ENV = "test";

    state.cloudClient.getJwt
      .mockReset()
      .mockResolvedValueOnce({ accessToken: "jwt-initial" })
      .mockResolvedValueOnce({ accessToken: "jwt-refreshed" });
    state.cloudClient.heartbeat
      .mockReset()
      .mockRejectedValueOnce(new Error("Cloud API 401: unauthorized"))
      .mockResolvedValueOnce({ ok: true });

    setIntervalSpy.mockImplementation((handler) => {
      runTimerHandler(handler);
      return createIntervalHandle();
    });

    await runCli(["start", "--port", "38472", "--data-dir", "/tmp"]);

    expect(state.cloudClient.getJwt).toHaveBeenCalledTimes(2);
    expect(state.cloudClient.heartbeat).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      "jwt-initial",
    );
    expect(state.cloudClient.heartbeat).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      "jwt-refreshed",
    );
  });

  it("start keeps existing jwt when heartbeat fails non-auth", async () => {
    state.config = {
      name: "node-a",
      cloudUrl: "https://cloud.example",
      nodeSecret: "sec-x",
      providers: [],
      tools: { allowlist: [], blocklist: [] },
      im: { channels: [] },
    };
    process.env.NODE_ENV = "test";

    state.cloudClient.getJwt.mockReset().mockResolvedValue({ accessToken: "jwt-x" });
    state.cloudClient.heartbeat.mockReset().mockRejectedValueOnce(new Error("Cloud API 500: boom"));

    setIntervalSpy.mockImplementation((handler) => {
      runTimerHandler(handler);
      return createIntervalHandle();
    });

    await runCli(["start", "--port", "38472", "--data-dir", "/tmp"]);

    expect(state.cloudClient.getJwt).toHaveBeenCalledTimes(1);
    expect(state.cloudClient.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("start with wikiPath and refreshWikiAgentDefinitions wires fs.watch (success path)", async () => {
    state.config = {
      name: "node-a",
      providers: [],
      tools: { allowlist: [], blocklist: [] },
      wikiPath: "wiki",
      im: { channels: [] },
    };

    const refreshWikiAgentDefinitionsMock = vi
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    state.createNodeRuntime
      .mockReset()
      .mockReturnValue(
        createRuntimeResult({ refreshWikiAgentDefinitions: refreshWikiAgentDefinitionsMock }),
      );

    process.env.NODE_ENV = "test";
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    let scheduledRefreshListener: (() => void) | undefined;

    const setTimeoutSpy = vi
      .spyOn(global, "setTimeout")
      .mockImplementation((handler, timeout, ...arguments_) => {
        if (timeout === 900) {
          runTimerHandler(handler);
          return createTimeoutHandle();
        }

        return realSetTimeout(handler, timeout, ...arguments_);
      });

    fsWatchMock.mockImplementationOnce((watchedPath, watchOptions, listener) => {
      void watchedPath;
      void watchOptions;
      scheduledRefreshListener = listener;
      return createMockFsWatcher();
    });

    try {
      await runCli(["start", "--port", "38472", "--data-dir", "/tmp"]);

      expect(fsWatchMock.mock.calls.length).toBeGreaterThan(0);

      if (!scheduledRefreshListener) {
        throw new Error("Expected fs.watch listener to be registered");
      }

      scheduledRefreshListener();
      scheduledRefreshListener();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(refreshWikiAgentDefinitionsMock).toHaveBeenCalled();
    } finally {
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("start with wikiPath and refreshWikiAgentDefinitions covers fs.watch error catch", async () => {
    state.config = {
      name: "node-a",
      providers: [],
      tools: { allowlist: [], blocklist: [] },
      wikiPath: "wiki",
      im: { channels: [] },
    };

    state.createNodeRuntime.mockReset().mockReturnValue(
      createRuntimeResult({
        refreshWikiAgentDefinitions: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      }),
    );

    process.env.NODE_ENV = "test";
    fsWatchMock.mockImplementationOnce(() => {
      throw new Error("watch fail");
    });

    await runCli(["start", "--port", "38472", "--data-dir", "/tmp"]);

    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining("watch fail"));
  });

  it("start covers LAN mdns path (NODE_ENV!=test)", async () => {
    state.config = {
      name: "node-a",
      providers: [],
      tools: { allowlist: [], blocklist: [] },
      im: { channels: [] },
    };
    process.env.NODE_ENV = "production";
    delete process.env.MEMELOOP_DISABLE_MDNS;

    browseMock.mockImplementationOnce(({ onServiceUp }) => {
      onServiceUp({ name: "svc", type: "memeloop" });
    });

    await runCli(["start", "--port", "38472", "--data-dir", "/tmp"]);
  });

  it("start covers cloudUrl && nodeSecret registration path", async () => {
    state.config = {
      name: "node-a",
      providers: [],
      tools: { allowlist: [], blocklist: [] },
      cloudUrl: "https://cloud.example",
      nodeSecret: "sec-x",
      im: { channels: [] },
    };

    process.env.NODE_ENV = "test";

    await runCli(["start", "--port", "38472", "--data-dir", "/tmp"]);

    expect(setIntervalSpy).toHaveBeenCalled();
  });

  it("start uses challenge auth when nodeSecret is absent", async () => {
    state.config = {
      name: "node-a",
      providers: [],
      tools: { allowlist: [], blocklist: [] },
      cloudUrl: "https://cloud.example",
      im: { channels: [] },
    };
    process.env.NODE_ENV = "test";

    await runCli(["start", "--port", "38472", "--data-dir", "/tmp"]);

    expect(state.cloudClient.getJwtByChallenge).toHaveBeenCalled();
    expect(state.cloudClient.getJwt).not.toHaveBeenCalled();
  });

  it("start wires notifyAskQuestion passthrough for IM channels", async () => {
    const getConversationMeta = vi
      .fn<(conversationId: string) => Promise<MockConversationMeta | undefined>>()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ sourceChannel: { channelId: "missing", imUserId: "u-x" } })
      .mockResolvedValueOnce({ sourceChannel: { channelId: "tg1", imUserId: "u-tg" } })
      .mockResolvedValueOnce({ sourceChannel: { channelId: "d1", imUserId: "u-discord" } });

    imGetBindingMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ imUserId: "u-discord", pendingQuestionId: "old" });
    imSetBindingMock.mockResolvedValueOnce(undefined);

    state.config = {
      name: "node-a",
      providers: [],
      tools: { allowlist: [], blocklist: [] },
      im: {
        channels: [
          { channelId: "tg1", platform: "telegram", botToken: "bt1" },
          { channelId: "d1", platform: "discord", botToken: "bt2" },
        ],
      },
    };
    process.env.NODE_ENV = "test";

    state.createNodeRuntime.mockReset().mockImplementationOnce((options) =>
      createRuntimeResult({
        runtime: { __notifyAskQuestion: options.builtinToolContext?.notifyAskQuestion },
        storage: { getConversationMeta },
      }),
    );

    state.startNodeServerWithMdns.mockImplementationOnce(async ({ rpcContext }) => {
      const notifyAskQuestionHandler = getNotifyAskQuestionHandler(rpcContext.runtime);

      notifyAskQuestionHandler({ questionId: "q1", question: "Q1", conversationId: "c1" });
      await new Promise<void>((resolve) => setImmediate(resolve));

      notifyAskQuestionHandler({ questionId: "q2", question: "Q2", conversationId: "c2" });
      await new Promise<void>((resolve) => setImmediate(resolve));

      notifyAskQuestionHandler({ questionId: "q3", question: "Hello", conversationId: "c3" });
      await new Promise<void>((resolve) => setImmediate(resolve));

      notifyAskQuestionHandler({ questionId: "q4", question: "Q4", conversationId: "c4" });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(sendTelegramTextMessageMock).toHaveBeenCalledWith("bt1", "u-tg", "❓ Hello");
      expect(imSetBindingMock).toHaveBeenCalledWith(
        expect.objectContaining({ pendingQuestionId: "q4" }),
      );
    });

    await runCli(["start", "--port", "38472", "--data-dir", "/tmp"]);
  });
});
