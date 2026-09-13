import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RuntimeClassSpec } from 'memeloop';

export interface LinuxProcessSandboxLaunch {
  executable: string;
  arguments_: string[];
}

export interface LinuxProcessSandboxRequest {
  executable: string;
  arguments_: string[];
  runtimeClass: RuntimeClassSpec;
  workerPath: string;
  volumeMounts?: Array<{ mountPath: string; readOnly: boolean }>;
}

export interface LinuxProcessSandbox {
  readonly enforcement: {
    cgroupCpu: true;
    cgroupMemory: true;
    namespaces: true;
    seccomp: true;
    directNetwork: 'host' | 'blocked';
  };
  wrap(request: LinuxProcessSandboxRequest): LinuxProcessSandboxLaunch;
}

export interface PrepareLinuxProcessSandboxOptions {
  systemdRunExecutable?: string;
  bubblewrapExecutable?: string;
  setprivExecutable?: string;
}

const FILTER_ARCHITECTURES = {
  x64: {
    audit: 0xc000_003e,
    denied: [
      101,
      153,
      155,
      163,
      164,
      165,
      166,
      167,
      168,
      169,
      172,
      173,
      175,
      176,
      212,
      227,
      246,
      248,
      249,
      250,
      298,
      304,
      308,
      310,
      311,
      313,
      320,
      321,
      323,
      272,
    ],
  },
  arm64: {
    audit: 0xc000_00b7,
    denied: [
      18,
      39,
      40,
      41,
      58,
      89,
      104,
      105,
      106,
      112,
      117,
      142,
      170,
      217,
      218,
      219,
      224,
      225,
      241,
      265,
      268,
      270,
      271,
      273,
      280,
      282,
      294,
      97,
    ],
  },
} as const;

const BPF_LOAD_WORD_ABSOLUTE = 0x20;
const BPF_JUMP_EQUAL = 0x15;
const BPF_RETURN = 0x06;
const SECCOMP_ALLOW = 0x7fff_0000;
const SECCOMP_ERRNO_EPERM = 0x0005_0001;
const SECCOMP_KILL_PROCESS = 0x8000_0000;

function instruction(code: number, jumpTrue: number, jumpFalse: number, value: number): Buffer {
  const result = Buffer.alloc(8);
  result.writeUInt16LE(code, 0);
  result.writeUInt8(jumpTrue, 2);
  result.writeUInt8(jumpFalse, 3);
  result.writeUInt32LE(value >>> 0, 4);
  return result;
}

function createSeccompFilter(): Buffer | undefined {
  const architecture = FILTER_ARCHITECTURES[process.arch as keyof typeof FILTER_ARCHITECTURES];
  if (!architecture) return undefined;
  const instructions = [
    instruction(BPF_LOAD_WORD_ABSOLUTE, 0, 0, 4),
    instruction(BPF_JUMP_EQUAL, 1, 0, architecture.audit),
    instruction(BPF_RETURN, 0, 0, SECCOMP_KILL_PROCESS),
    instruction(BPF_LOAD_WORD_ABSOLUTE, 0, 0, 0),
  ];
  for (const syscall of architecture.denied) {
    instructions.push(
      instruction(BPF_JUMP_EQUAL, 0, 1, syscall),
      instruction(BPF_RETURN, 0, 0, SECCOMP_ERRNO_EPERM),
    );
  }
  instructions.push(instruction(BPF_RETURN, 0, 0, SECCOMP_ALLOW));
  return Buffer.concat(instructions);
}

function ensureSeccompFilter(): string | undefined {
  const filter = createSeccompFilter();
  if (!filter) return undefined;
  const digest = createHash('sha256').update(filter).digest('hex').slice(0, 16);
  const target = path.join(os.tmpdir(), `memeloop-seccomp-${process.arch}-${digest}.bpf`);
  if (!fs.existsSync(target)) {
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, filter, { mode: 0o600 });
    fs.renameSync(temporary, target);
  }
  return target;
}

function executableAt(configured: string | undefined, fallback: string): string | undefined {
  const candidate = configured ?? fallback;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

function runProbe(executable: string, arguments_: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(executable, arguments_, {
      env: {
        PATH: '/usr/bin:/bin',
        ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
        ...(process.env.DBUS_SESSION_BUS_ADDRESS
          ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }
          : {}),
      },
      stdio: 'ignore',
    });
    child.once('error', () => {
      finish(false);
    });
    child.once('exit', (code) => {
      finish(code === 0);
    });
  });
}

function bindIfPresent(arguments_: string[], source: string, destination = source): void {
  if (fs.existsSync(source)) arguments_.push('--ro-bind', source, destination);
}

function ensureSandboxParents(arguments_: string[], destination: string): void {
  const parent = path.dirname(destination);
  const segments = parent.split(path.sep).filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current += `/${segment}`;
    if (
      current === '/usr' ||
      current === '/lib' ||
      current === '/lib64' ||
      current === '/etc' ||
      current === '/dev' ||
      current === '/proc' ||
      current === '/tmp' ||
      current === '/home'
    ) continue;
    arguments_.push('--dir', current);
  }
}

export async function prepareLinuxProcessSandbox(
  options: PrepareLinuxProcessSandboxOptions = {},
): Promise<LinuxProcessSandbox | undefined> {
  if (process.platform !== 'linux') return undefined;
  const systemdRun = executableAt(options.systemdRunExecutable, '/usr/bin/systemd-run');
  const bubblewrap = executableAt(options.bubblewrapExecutable, '/usr/bin/bwrap');
  const setpriv = executableAt(options.setprivExecutable, '/usr/bin/setpriv');
  const seccompFilter = ensureSeccompFilter();
  if (!systemdRun || !bubblewrap || !setpriv || !seccompFilter) return undefined;

  const probePassed = await runProbe(systemdRun, [
    '--user',
    '--scope',
    '--quiet',
    '--property=MemoryMax=64M',
    '--property=MemorySwapMax=0',
    '--property=CPUQuota=50%',
    '--property=TasksMax=64',
    bubblewrap,
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind-try',
    '/lib',
    '/lib',
    '--ro-bind-try',
    '/lib64',
    '/lib64',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--unshare-net',
    '--unshare-user',
    '--disable-userns',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
    '--ro-bind',
    seccompFilter,
    seccompFilter,
    setpriv,
    '--no-new-privs',
    '--pdeathsig',
    'keep',
    '--seccomp-filter',
    seccompFilter,
    '/usr/bin/true',
  ]);
  if (!probePassed) return undefined;

  return {
    enforcement: {
      cgroupCpu: true,
      cgroupMemory: true,
      namespaces: true,
      seccomp: true,
      directNetwork: 'blocked',
    },
    wrap(request) {
      const cpuQuota = Math.max(1, (request.runtimeClass.cpuLimitMillis ?? 500) / 10);
      const memoryLimit = Math.max(16 * 1024 * 1024, request.runtimeClass.memoryLimitBytes ?? 32 * 1024 * 1024);
      const bubblewrapArguments = [
        '--ro-bind',
        '/usr',
        '/usr',
        '--ro-bind-try',
        '/lib',
        '/lib',
        '--ro-bind-try',
        '/lib64',
        '/lib64',
        '--dev',
        '/dev',
        '--proc',
        '/proc',
        '--tmpfs',
        '/tmp',
        '--dir',
        '/home',
        '--unshare-pid',
        '--unshare-ipc',
        '--unshare-uts',
        '--unshare-cgroup-try',
        '--unshare-user',
        '--disable-userns',
        '--die-with-parent',
        '--new-session',
        '--cap-drop',
        'ALL',
        '--setenv',
        'HOME',
        '/tmp',
        '--setenv',
        'TMPDIR',
        '/tmp',
      ];
      for (const source of ['/etc/ssl/certs', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf']) {
        bindIfPresent(bubblewrapArguments, source);
      }
      ensureSandboxParents(bubblewrapArguments, request.executable);
      bindIfPresent(bubblewrapArguments, request.executable);
      bindIfPresent(bubblewrapArguments, request.workerPath);
      bindIfPresent(bubblewrapArguments, seccompFilter);
      for (const mount of request.volumeMounts ?? []) {
        ensureSandboxParents(bubblewrapArguments, mount.mountPath);
        bubblewrapArguments.push(
          mount.readOnly ? '--ro-bind' : '--bind',
          mount.mountPath,
          mount.mountPath,
        );
      }
      if (request.runtimeClass.networkAccess !== 'full') {
        bubblewrapArguments.push('--unshare-net');
      }
      bubblewrapArguments.push(
        setpriv,
        '--no-new-privs',
        '--pdeathsig',
        'keep',
        '--seccomp-filter',
        seccompFilter,
        request.executable,
        ...request.arguments_,
      );
      const properties = [
        `MemoryMax=${memoryLimit}`,
        'MemorySwapMax=0',
        `CPUQuota=${cpuQuota}%`,
        'TasksMax=64',
      ];
      if (request.runtimeClass.networkAccess !== 'full') {
        properties.push('IPAddressDeny=any');
      }
      return {
        executable: systemdRun,
        arguments_: [
          '--user',
          '--scope',
          '--quiet',
          ...properties.flatMap((property) => [`--property=${property}`]),
          bubblewrap,
          ...bubblewrapArguments,
        ],
      };
    },
  };
}
