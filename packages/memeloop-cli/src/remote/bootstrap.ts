import { spawn } from 'node:child_process';
import path from 'node:path';

import { MEMELOOP_CLI_VERSION } from '../version.js';

export { MEMELOOP_CLI_VERSION } from '../version.js';

const sshTargetPattern = /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}@)?[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const maximumOutputBytes = 512 * 1024;

export interface RemoteBootstrapOptions {
  target: string;
  version?: string;
  port?: number;
  identityFile?: string;
  hostKeyPolicy?: 'strict' | 'accept-new';
  knownHostsFile?: string;
  replaceExistingLink?: boolean;
  dryRun?: boolean;
  timeoutMs?: number;
  sshCommand?: string;
}

export interface RemoteBootstrapEvidence {
  ok: true;
  version: string;
  nodeVersion: string;
  executable: string;
  changed: boolean;
  dryRun: boolean;
}

const remoteBootstrapSource = String.raw`set -eu
version="$1"
replace_link="$2"
dry_run="$3"

fail() {
  printf '%s\n' "memeloop bootstrap: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js 24 or newer is required"
node_version="$(node -p 'process.versions.node')" || fail "cannot inspect Node.js"
node_major="$(printf '%s' "$node_version" | cut -d. -f1)"
remote_platform="$(node -p 'process.platform')" || fail "cannot inspect remote platform"
case "$node_major" in
  ''|*[!0-9]*) fail "invalid Node.js version: $node_version" ;;
esac
[ "$node_major" -ge 24 ] || fail "Node.js 24 or newer is required (found $node_version)"
command -v npm >/dev/null 2>&1 || fail "npm is required"

emit_result() {
  node -e '
    const [version, nodeVersion, executable, changed, dryRun] = process.argv.slice(1);
    process.stdout.write("MEMELOOP_BOOTSTRAP_RESULT " + JSON.stringify({
      ok: true,
      version,
      nodeVersion,
      executable,
      changed: changed === "true",
      dryRun: dryRun === "true"
    }) + "\n");
  ' "$version" "$node_version" "$executable" "$changed" "$dry_run"
}

data_home="$HOME/.local/share"
install_parent="$data_home/memeloop/cli"
install_root="$install_parent/$version"
bin_home="$HOME/.local/bin"
case "$remote_platform" in
  win32)
    executable="$install_root/memeloop.cmd"
    entry="$install_root/node_modules/memeloop-cli/dist/cli.js"
    ;;
  *)
    executable="$install_root/bin/memeloop"
    entry=""
    ;;
esac
changed=false

if [ "$dry_run" = "1" ]; then
  dry_run=true
  emit_result
  exit 0
fi

umask 077
mkdir -p "$install_parent" "$bin_home"
is_complete_install() {
  case "$remote_platform" in
    win32) [ -f "$executable" ] && [ -f "$entry" ] ;;
    *) [ -x "$executable" ] ;;
  esac
}

installed_version() {
  case "$remote_platform" in
    win32) node "$entry" --version ;;
    *) "$executable" --version ;;
  esac
}

if ! is_complete_install; then
  [ ! -e "$install_root" ] || fail "$install_root exists but is incomplete; inspect and remove it explicitly"
  temporary="$install_parent/.install-$version-$$"
  trap 'rm -rf "$temporary"' EXIT HUP INT TERM
  mkdir "$temporary"
  PUPPETEER_SKIP_DOWNLOAD=1 npm install \
    --global \
    --prefix "$temporary" \
    --omit=dev \
    --no-audit \
    --no-fund \
    --loglevel=error \
    "memeloop-cli@$version"
  case "$remote_platform" in
    win32)
      temporary_executable="$temporary/memeloop.cmd"
      temporary_entry="$temporary/node_modules/memeloop-cli/dist/cli.js"
      [ -f "$temporary_executable" ] && [ -f "$temporary_entry" ] || fail "installed package has no Windows memeloop executable"
      observed="$(node "$temporary_entry" --version)"
      ;;
    *)
      [ -x "$temporary/bin/memeloop" ] || fail "installed package has no memeloop executable"
      observed="$("$temporary/bin/memeloop" --version)"
      ;;
  esac
  [ "$observed" = "$version" ] || fail "installed CLI reported version $observed, expected $version"
  mv "$temporary" "$install_root"
  trap - EXIT HUP INT TERM
  changed=true
else
  observed="$(installed_version)"
  [ "$observed" = "$version" ] || fail "existing version directory reported $observed"
fi

case "$remote_platform" in
  win32)
    shell_launcher="$bin_home/memeloop"
    cmd_launcher="$bin_home/memeloop.cmd"
    for launcher in "$shell_launcher" "$cmd_launcher"; do
      if [ -e "$launcher" ] || [ -L "$launcher" ]; then
        grep -Fq "MemeLoop managed launcher" "$launcher" 2>/dev/null ||
          [ "$replace_link" = "1" ] ||
          fail "$launcher exists and is not managed by MemeLoop; rerun with --replace-existing-link"
      fi
    done
    temporary_shell="$bin_home/.memeloop-shell-$$"
    printf '%s\n' '#!/bin/sh' '# MemeLoop managed launcher' "exec node \"$entry\" \"\$@\"" > "$temporary_shell"
    chmod 700 "$temporary_shell"
    entry_windows="$(node -e 'process.stdout.write(require("node:path").win32.normalize(process.argv[1]))' "$entry")"
    temporary_cmd="$bin_home/.memeloop-cmd-$$"
    printf '@echo off\r\nrem MemeLoop managed launcher\r\nnode "%s" %%*\r\n' "$entry_windows" > "$temporary_cmd"
    mv -f "$temporary_shell" "$shell_launcher"
    mv -f "$temporary_cmd" "$cmd_launcher"
    ;;
  *)
    link="$bin_home/memeloop"
    if [ -e "$link" ] || [ -L "$link" ]; then
      existing="$(readlink "$link" 2>/dev/null || true)"
      case "$existing" in
        "$install_parent"/*/bin/memeloop) ;;
        "$executable") ;;
        *)
          [ "$replace_link" = "1" ] || fail "$link exists and is not managed by MemeLoop; rerun with --replace-existing-link"
          ;;
      esac
    fi
    temporary_link="$bin_home/.memeloop-link-$$"
    ln -s "$executable" "$temporary_link"
    mv -f "$temporary_link" "$link"
    ;;
esac

dry_run=false
emit_result
`;

function validateOptions(
  options: RemoteBootstrapOptions,
):
  & Required<
    Pick<
      RemoteBootstrapOptions,
      | 'target'
      | 'version'
      | 'port'
      | 'hostKeyPolicy'
      | 'replaceExistingLink'
      | 'dryRun'
      | 'timeoutMs'
      | 'sshCommand'
    >
  >
  & Pick<RemoteBootstrapOptions, 'identityFile' | 'knownHostsFile'>
{
  if (!sshTargetPattern.test(options.target)) {
    throw new Error('target must be a bounded user@host SSH target without shell syntax');
  }
  const version = options.version ?? MEMELOOP_CLI_VERSION;
  if (!versionPattern.test(version)) {
    throw new Error('version must be an exact semantic version');
  }
  const port = options.port ?? 22;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('port must be an integer between 1 and 65535');
  }
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60 * 60_000) {
    throw new Error('timeoutMs must be between 1000 and 3600000');
  }
  for (
    const [label, value] of [
      ['identityFile', options.identityFile],
      ['knownHostsFile', options.knownHostsFile],
    ] as const
  ) {
    if (value !== undefined && (value.length < 1 || value.length > 4_096 || value.includes('\0'))) {
      throw new Error(`${label} is invalid`);
    }
  }
  return {
    target: options.target,
    version,
    port,
    hostKeyPolicy: options.hostKeyPolicy ?? 'strict',
    replaceExistingLink: options.replaceExistingLink ?? false,
    dryRun: options.dryRun ?? false,
    timeoutMs,
    sshCommand: options.sshCommand ?? 'ssh',
    ...(options.identityFile ? { identityFile: path.resolve(options.identityFile) } : {}),
    ...(options.knownHostsFile ? { knownHostsFile: path.resolve(options.knownHostsFile) } : {}),
  };
}

export async function bootstrapRemoteCli(
  input: RemoteBootstrapOptions,
): Promise<RemoteBootstrapEvidence> {
  const options = validateOptions(input);
  const arguments_ = [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    `StrictHostKeyChecking=${options.hostKeyPolicy === 'strict' ? 'yes' : 'accept-new'}`,
    '-o',
    'ConnectTimeout=10',
    '-p',
    String(options.port),
    ...(options.identityFile ? ['-i', options.identityFile] : []),
    ...(options.knownHostsFile ? ['-o', `UserKnownHostsFile=${options.knownHostsFile}`] : []),
    '--',
    options.target,
    'sh',
    '-s',
    '--',
    options.version,
    options.replaceExistingLink ? '1' : '0',
    options.dryRun ? '1' : '0',
  ];
  const child = spawn(options.sshCommand, arguments_, {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(remoteBootstrapSource);
  let stdout = '';
  let stderr = '';
  let exceededOutputBound = false;
  const append = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    if (stream === 'stdout') stdout += chunk.toString('utf8');
    else stderr += chunk.toString('utf8');
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maximumOutputBytes) {
      exceededOutputBound = true;
      child.kill('SIGKILL');
    }
  };
  child.stdout.on('data', append('stdout'));
  child.stderr.on('data', append('stderr'));
  const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timeout);
  if (exceededOutputBound) throw new Error('remote bootstrap exceeded the output bound');
  if (code !== 0) {
    throw new Error(
      `remote bootstrap failed with exit code ${String(code)}\n${stderr.slice(-16_384)}`,
    );
  }
  const prefix = 'MEMELOOP_BOOTSTRAP_RESULT ';
  const record = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)) as unknown)
    .at(-1);
  if (
    typeof record !== 'object' ||
    record === null ||
    (record as Partial<RemoteBootstrapEvidence>).ok !== true ||
    (record as Partial<RemoteBootstrapEvidence>).version !== options.version ||
    typeof (record as Partial<RemoteBootstrapEvidence>).nodeVersion !== 'string' ||
    typeof (record as Partial<RemoteBootstrapEvidence>).executable !== 'string' ||
    typeof (record as Partial<RemoteBootstrapEvidence>).changed !== 'boolean' ||
    (record as Partial<RemoteBootstrapEvidence>).dryRun !== options.dryRun
  ) {
    throw new Error('remote bootstrap did not return valid evidence');
  }
  return record as RemoteBootstrapEvidence;
}
