import { describe, it, expect } from "vitest";
import { bashImpl, bashSchema, BASH_TOOL_ID } from "../bash.js";

describe("bashImpl", () => {
  const ctx = {} as any;

  it("executes a simple echo command", async () => {
    const result = await bashImpl({ command: "echo hello" }, ctx);
    expect(result.output).toContain("hello");
    expect(result.metadata?.exitCode).toBe(0);
  });

  it("captures stderr", async () => {
    const result = await bashImpl({ command: "echo err >&2" }, ctx);
    expect(result.output).toContain("[stderr]");
    expect(result.output).toContain("err");
  });

  it("reports non-zero exit codes", async () => {
    const result = await bashImpl({ command: "exit 42" }, ctx);
    expect(result.metadata?.exitCode).toBe(42);
    expect(result.output).toContain("[exit code: 42]");
  });

  it("handles empty output", async () => {
    const result = await bashImpl({ command: "true" }, ctx);
    expect(result.output).toBe("(no output)");
  });

  it("blocks dangerous rm -rf commands", async () => {
    const result = await bashImpl({ command: "rm -rf /" }, ctx);
    expect(result.output).toContain("Blocked dangerous");
    expect(result.metadata?.blocked).toBe(true);
  });

  it("blocks dangerous dd commands", async () => {
    const result = await bashImpl({ command: "dd if=/dev/zero of=/dev/sda" }, ctx);
    expect(result.output).toContain("Blocked dangerous");
  });

  it("truncates very long output", async () => {
    const result = await bashImpl({ command: "python3 -c \"print('x'*40000)\"" }, ctx);
    expect(result.output).toContain("truncated");
  });

  it("respects timeout", async () => {
    const result = await bashImpl({ command: "sleep 10", timeout: 500 }, ctx);
    expect(result.metadata?.timedOut).toBe(true);
    expect(result.output).toContain("timed out");
  }, 10000);

  it("respects cwd option", async () => {
    const result = await bashImpl({ command: "pwd", cwd: "/tmp" }, ctx);
    expect(result.output.trim()).toBe("/tmp");
  });

  it("reports execution time", async () => {
    const result = await bashImpl({ command: "sleep 0.1" }, ctx);
    expect(result.metadata?.elapsed).toBeGreaterThan(50);
  });

  it("has correct tool ID", () => {
    expect(BASH_TOOL_ID).toBe("bash");
  });
});

describe("bashSchema", () => {
  it("validates required command", () => {
    expect(() => bashSchema.parse({})).toThrow();
  });

  it("accepts valid args", () => {
    const result = bashSchema.parse({ command: "echo hello" });
    expect(result.command).toBe("echo hello");
  });

  it("accepts optional timeout and cwd", () => {
    const result = bashSchema.parse({ command: "ls", timeout: 5000, cwd: "/tmp" });
    expect(result.timeout).toBe(5000);
    expect(result.cwd).toBe("/tmp");
  });

  it("rejects negative timeout", () => {
    expect(() => bashSchema.parse({ command: "ls", timeout: -1 })).toThrow();
  });

  it("rejects timeout over 600s", () => {
    expect(() => bashSchema.parse({ command: "ls", timeout: 700000 })).toThrow();
  });
});
