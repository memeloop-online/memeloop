/**
 * Demo tools: Start development servers and capture their output
 * Inspired by Cursor 3's demo generation for result verification
 */

import { MEMELOOP_STRUCTURED_TOOL_KEY } from 'memeloop';
import { type ChildProcess, spawn } from 'node:child_process';
import { disposeOwnedToolRegistrations, type OwnedToolRegistry } from './ownedToolRegistry.js';
import { type ScreenshotResult, takeScreenshot } from './screenshot.js';

interface DemoServer {
  process: ChildProcess;
  port: number;
  url: string;
  startTime: number;
}

const demoLaunchProperties = {
  command: { type: 'string', minLength: 1 },
  cwd: { type: 'string', minLength: 1 },
  port: { type: 'integer', minimum: 1, maximum: 65_535 },
  waitForReady: { type: 'integer', minimum: 1, maximum: 300_000 },
} as const;

export const demoToolSchemas = {
  'demo.start': {
    type: 'object',
    properties: demoLaunchProperties,
    required: ['command', 'cwd'],
    additionalProperties: false,
  },
  'demo.stop': {
    type: 'object',
    properties: {
      serverId: { type: 'string', minLength: 1 },
    },
    required: ['serverId'],
    additionalProperties: false,
  },
  'demo.screenshot': {
    type: 'object',
    properties: {
      ...demoLaunchProperties,
      path: { type: 'string' },
      fullPage: { type: 'boolean' },
    },
    required: ['command', 'cwd'],
    additionalProperties: false,
  },
} as const;

interface DemoStartParameters {
  command: string;
  cwd: string;
  port?: number;
  env?: Record<string, string>;
  waitForReady?: number;
}

interface DemoStartResult {
  success: boolean;
  url?: string;
  port?: number;
  serverId?: string;
  error?: string;
  output?: string;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function isPortProbeRetryableError(error: unknown): boolean {
  if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return true;
  }
  if (error instanceof TypeError) return true;
  return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']
    .includes(errorCode(error) ?? '');
}

function isProcessAlreadyExitedError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ESRCH' || (error instanceof Error && /already exited|not running/iu.test(error.message));
}

/**
 * Wait for a port to be ready
 */
async function waitForPort(port: number, timeoutMs: number = 30000): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok || response.status < 500) {
        return true;
      }
    } catch (error) {
      if (!isPortProbeRetryableError(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

/**
 * Start a development server
 */
async function startDemoServerInStore(
  parameters: DemoStartParameters,
  runningServers: Map<string, DemoServer>,
): Promise<DemoStartResult> {
  try {
    const { command, cwd, port, env, waitForReady = 30000 } = parameters;

    // Parse command
    const [cmd, ...arguments_] = command.split(' ');

    // Start process
    const childProcess = spawn(cmd, arguments_, {
      cwd,
      env: { ...process.env, ...env },
      shell: true,
      detached: false,
    });

    const serverId = `demo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    let output = '';
    let detectedPort = port;
    if (!detectedPort) {
      const explicitPort = command.match(/(?:--port|-p)\s+(\d{2,5})/i)?.[1];
      if (explicitPort) {
        detectedPort = parseInt(explicitPort, 10);
      }
    }

    // Capture output to detect port
    childProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;

      // Try to detect port from common patterns
      if (!detectedPort) {
        const portMatch = text.match(/(?:localhost|127\.0\.0\.1):(\d+)/);
        if (portMatch?.[1]) {
          detectedPort = parseInt(portMatch[1], 10);
        }
      }
    });

    childProcess.stderr?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    // Wait a bit for server to start
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // If port was detected or provided, wait for it to be ready
    if (detectedPort) {
      const ready = await waitForPort(detectedPort, waitForReady);
      if (!ready) {
        childProcess.kill();
        return {
          success: false,
          error: `Server did not become ready on port ${detectedPort} within ${waitForReady}ms`,
          output,
        };
      }
    }

    const finalPort = detectedPort ?? 3000; // Default fallback
    const url = `http://localhost:${finalPort}`;

    // Store server info for cleanup
    runningServers.set(serverId, {
      process: childProcess,
      port: finalPort,
      url,
      startTime: Date.now(),
    });

    return {
      success: true,
      url,
      port: finalPort,
      serverId,
      output: output.slice(-500), // Last 500 chars
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Stop a demo server
 */
async function stopDemoServerInStore(
  serverId: string,
  runningServers: Map<string, DemoServer>,
): Promise<{ success: boolean; error?: string }> {
  const server = runningServers.get(serverId);
  if (!server) {
    return { success: false, error: `Server not found: ${serverId}` };
  }

  try {
    server.process.kill();
    runningServers.delete(serverId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Start server and take screenshot
 */
async function demoScreenshotInStore(parameters: {
  command: string;
  cwd: string;
  path?: string;
  port?: number;
  waitForReady?: number;
  fullPage?: boolean;
}, runningServers: Map<string, DemoServer>): Promise<{
  success: boolean;
  url?: string;
  serverId?: string;
  screenshot?: ScreenshotResult;
  error?: string;
}> {
  // Start server
  const startResult = await startDemoServerInStore({
    command: parameters.command,
    cwd: parameters.cwd,
    port: parameters.port,
    waitForReady: parameters.waitForReady,
  }, runningServers);

  if (!startResult.success || !startResult.url) {
    return {
      success: false,
      error: startResult.error ?? 'Failed to start server',
    };
  }

  // Take screenshot
  const screenshotUrl = `${startResult.url}${parameters.path ?? '/'}`;
  const screenshot = await takeScreenshot({
    url: screenshotUrl,
    fullPage: parameters.fullPage ?? false,
    timeout: 10000,
  });

  return {
    success: screenshot.success,
    url: startResult.url,
    serverId: startResult.serverId,
    screenshot,
    error: screenshot.success ? undefined : screenshot.error,
  };
}

/**
 * Register demo tools in the tool registry
 */
export function registerDemoTools(registry: OwnedToolRegistry): () => void {
  const runningServers = new Map<string, DemoServer>();
  const cleanups: Array<() => boolean> = [];
  try {
    cleanups.push(registry.registerOwnedTool(
      'demo.start',
      async (arguments_: Record<string, unknown>) => {
        const command = typeof arguments_.command === 'string' ? arguments_.command.trim() : '';
        const cwd = typeof arguments_.cwd === 'string' ? arguments_.cwd.trim() : '';
        if (!cwd) return { error: "Missing required 'cwd' parameter" };
        if (!command) return { error: "Missing required 'command' parameter" };

        const result = await startDemoServerInStore({
          command,
          cwd,
          port: typeof arguments_.port === 'number' ? arguments_.port : undefined,
          waitForReady: typeof arguments_.waitForReady === 'number'
            ? arguments_.waitForReady
            : undefined,
        }, runningServers);

        if (!result.success) {
          return {
            error: result.error,
            output: result.output,
          };
        }

        return {
          ok: true,
          success: true,
          message: `Server started successfully at ${result.url}`,
          url: result.url,
          port: result.port,
          serverId: result.serverId,
          note: `Use demo.stop with serverId="${result.serverId}" to stop the server`,
        };
      },
      demoToolSchemas['demo.start'],
      'execute',
    ));

    cleanups.push(registry.registerOwnedTool(
      'demo.stop',
      async (arguments_: Record<string, unknown>) => {
        const serverId = typeof arguments_.serverId === 'string'
          ? arguments_.serverId.trim()
          : '';
        if (!serverId) return { error: "Missing required 'serverId' parameter" };

        const result = await stopDemoServerInStore(serverId, runningServers);
        if (!result.success) {
          return { error: result.error };
        }

        return {
          ok: true,
          success: true,
          message: `Server ${serverId} stopped successfully`,
        };
      },
      demoToolSchemas['demo.stop'],
      'execute',
    ));

    cleanups.push(registry.registerOwnedTool(
      'demo.screenshot',
      async (arguments_: Record<string, unknown>) => {
        const command = typeof arguments_.command === 'string' ? arguments_.command.trim() : '';
        const cwd = typeof arguments_.cwd === 'string' ? arguments_.cwd.trim() : '';
        if (!cwd) return { error: "Missing required 'cwd' parameter" };
        if (!command) return { error: "Missing required 'command' parameter" };

        const result = await demoScreenshotInStore({
          command,
          cwd,
          path: typeof arguments_.path === 'string' ? arguments_.path : undefined,
          port: typeof arguments_.port === 'number' ? arguments_.port : undefined,
          fullPage: typeof arguments_.fullPage === 'boolean' ? arguments_.fullPage : undefined,
          waitForReady: typeof arguments_.waitForReady === 'number'
            ? arguments_.waitForReady
            : undefined,
        }, runningServers);

        if (!result.success) {
          return {
            error: result.error,
            suggestion: 'Check that the command is correct and the application builds successfully',
          };
        }

        return {
          ok: true,
          success: true,
          message: `Demo server started and screenshot captured`,
          url: result.url,
          serverId: result.serverId,
          screenshot: {
            contentHash: result.screenshot?.contentHash,
            imageBase64: result.screenshot?.imageBase64,
            width: result.screenshot?.width,
            height: result.screenshot?.height,
            bytes: result.screenshot?.bytes ?? 0,
          },
          note: `Server is still running. Use demo.stop with serverId="${result.serverId}" to stop it`,
          [MEMELOOP_STRUCTURED_TOOL_KEY]: {
            summary: `Demo screenshot captured at ${result.url ?? 'unknown'} ` +
              `(hash=${result.screenshot?.contentHash ?? 'unknown'}, ` +
              `${result.screenshot?.width ?? '?'}x${result.screenshot?.height ?? '?'}, ` +
              `${result.screenshot?.bytes ?? 0} bytes, serverId=${result.serverId ?? 'unknown'})`,
          },
        };
      },
      demoToolSchemas['demo.screenshot'],
      'execute',
    ));
  } catch (error) {
    cleanupDemoServerStore(runningServers);
    disposeOwnedToolRegistrations(cleanups);
    throw error;
  }
  return () => {
    cleanupDemoServerStore(runningServers);
    disposeOwnedToolRegistrations(cleanups);
  };
}

function cleanupDemoServerStore(runningServers: Map<string, DemoServer>): void {
  for (const [serverId, server] of runningServers.entries()) {
    try {
      server.process.kill();
      runningServers.delete(serverId);
    } catch (error) {
      if (!isProcessAlreadyExitedError(error)) throw error;
      runningServers.delete(serverId);
    }
  }
}
