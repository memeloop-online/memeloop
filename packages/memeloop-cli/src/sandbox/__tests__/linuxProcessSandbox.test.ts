import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { prepareLinuxProcessSandbox } from '../linuxProcessSandbox.js';

describe('prepareLinuxProcessSandbox', () => {
  it.runIf(process.platform === 'linux')(
    'launches with real cgroup, namespaces, seccomp, and blocked direct network',
    async ({ skip }) => {
      const sandbox = await prepareLinuxProcessSandbox();
      if (!sandbox) skip();
      expect(sandbox).toBeDefined();
      const source = [
        'const fs = require("node:fs");',
        'const status = fs.readFileSync("/proc/self/status", "utf8");',
        'fetch("http://127.0.0.1:9", { signal: AbortSignal.timeout(500) })',
        '  .then(() => process.send({ seccomp: status, blocked: false }))',
        '  .catch(() => process.send({ seccomp: status, blocked: true }));',
      ].join('');
      const launch = sandbox!.wrap({
        executable: process.execPath,
        arguments_: ['--eval', source],
        runtimeClass: {
          isolation: 'process',
          cpuLimitMillis: 500,
          memoryLimitBytes: 128 * 1024 * 1024,
          supportsCancellation: true,
          supportedTrustClasses: ['restricted'],
          networkAccess: 'none',
        },
        workerPath: process.execPath,
      });
      expect(launch.arguments_).toEqual(expect.arrayContaining([
        '--property=MemoryMax=134217728',
        '--property=MemorySwapMax=0',
        '--property=CPUQuota=50%',
        '--property=TasksMax=64',
        '--property=IPAddressDeny=any',
        '--unshare-net',
      ]));

      const result = await new Promise<{
        message: { seccomp: string; blocked: boolean };
        limits: { memory: string; swap: string; cpu: string; tasks: string };
      }>((resolve, reject) => {
        const child = spawn(launch.executable, launch.arguments_, {
          env: {
            PATH: '/usr/bin:/bin',
            ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
            ...(process.env.DBUS_SESSION_BUS_ADDRESS
              ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }
              : {}),
          },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.once('error', reject);
        child.once('message', (value) => {
          const cgroup = fs.readFileSync(`/proc/${String(child.pid)}/cgroup`, 'utf8');
          const relativePath = cgroup.match(/^0::(.+)$/m)?.[1];
          if (!relativePath) {
            reject(new Error(`sandbox process has no cgroup v2 path: ${cgroup}`));
            return;
          }
          const cgroupPath = `/sys/fs/cgroup${relativePath}`;
          resolve({
            message: value as { seccomp: string; blocked: boolean },
            limits: {
              memory: fs.readFileSync(`${cgroupPath}/memory.max`, 'utf8').trim(),
              swap: fs.readFileSync(`${cgroupPath}/memory.swap.max`, 'utf8').trim(),
              cpu: fs.readFileSync(`${cgroupPath}/cpu.max`, 'utf8').trim(),
              tasks: fs.readFileSync(`${cgroupPath}/pids.max`, 'utf8').trim(),
            },
          });
        });
        child.once('exit', (code) => {
          if (code !== 0) reject(new Error(`sandbox exited ${String(code)}: ${stderr}`));
        });
      });
      expect(result.message.blocked).toBe(true);
      expect(result.message.seccomp).toMatch(/^Seccomp:\s+2$/m);
      expect(result.message.seccomp).toMatch(/^NoNewPrivs:\s+1$/m);
      expect(result.limits).toEqual({
        memory: String(128 * 1024 * 1024),
        swap: '0',
        cpu: '50000 100000',
        tasks: '64',
      });
      expect(fs.existsSync('/sys/fs/cgroup/cgroup.controllers')).toBe(true);
    },
    15_000,
  );
});
