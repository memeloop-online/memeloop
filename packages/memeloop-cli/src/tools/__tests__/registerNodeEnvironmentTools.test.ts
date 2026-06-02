import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../registerCoreNodeTools", () => ({ registerCoreNodeTools: mocks.registerCoreNodeTools }));
vi.mock("../fileSystem", () => ({ registerFileTools: mocks.registerFileTools }));
vi.mock("../genericNodeTools", () => ({ registerGenericNodeTools: mocks.registerGenericNodeTools }));
vi.mock("../terminal", () => ({ registerTerminalTools: mocks.registerTerminalTools }));
vi.mock("../vscodeCli", () => ({ registerVscodeTools: mocks.registerVscodeTools }));
vi.mock("../wikiTools", () => ({ registerWikiTools: mocks.registerWikiTools }));
vi.mock("../screenshot", () => ({ registerScreenshotTool: mocks.registerScreenshotTool }));
vi.mock("../demo", () => ({ registerDemoTools: mocks.registerDemoTools }));

import { registerNodeEnvironmentTools } from "../registerNodeEnvironmentTools";

describe("registerNodeEnvironmentTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers file/generic/vscode by default", () => {
    registerNodeEnvironmentTools({} as never, {});

    expect(mocks.registerCoreNodeTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerFileTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerGenericNodeTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerVscodeTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerTerminalTools).not.toHaveBeenCalled();
    expect(mocks.registerWikiTools).not.toHaveBeenCalled();
  });

  it("registers optional terminal/wiki and forwards node/storage options", () => {
    const terminalManager = { t: 1 };
    const wikiManager = { w: 1 };
    const storage = { s: 1 };
    registerNodeEnvironmentTools({} as never, {
      terminalManager: terminalManager as never,
      wikiManager: wikiManager as never,
      wikiDefaultId: "wk",
      nodeId: "node-a",
      storage: storage as never,
      fileBaseDir: "/tmp/x",
      includeVscodeCli: false,
    });

    expect(mocks.registerTerminalTools).toHaveBeenCalledWith(
      expect.anything(),
      terminalManager,
      expect.objectContaining({ nodeId: "node-a", storage }),
    );
    expect(mocks.registerFileTools).toHaveBeenCalledWith(
      expect.anything(),
      "/tmp/x",
      expect.objectContaining({ nodeId: "node-a" }),
    );
    expect(mocks.registerWikiTools).toHaveBeenCalledWith(expect.anything(), wikiManager, "wk");
    expect(mocks.registerVscodeTools).not.toHaveBeenCalled();
  });
});
