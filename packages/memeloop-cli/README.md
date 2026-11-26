# memeloop-cli

Command-line compute node for the MemeLoop network.

## What is this package?

`memeloop-cli` turns any machine into a MemeLoop compute node. It can:

- Register itself with a MemeLoop relay/cloud directory.
- Run agent loops locally using the `memeloop` core runtime.
- Expose status and logs over RPC.
- Run headless browser tasks and MCP tools.

## Install

```bash
pnpm add -g memeloop-cli
# or
npm install -g memeloop-cli
```

## Usage

```bash
# Start a standalone node (SQLite control plane)
memeloop start

# Open the interactive provider/node configuration UI
memeloop config
```

### Bootstrap an SSH compute node

The CLI can install an exact `memeloop-cli` version into an unprivileged,
versioned directory on a remote Linux host. The host must already have Node.js
24+, npm, key-based SSH access, and outbound npm registry access:

```bash
# Default: require a previously verified known_hosts entry.
memeloop remote bootstrap operator@worker.example

# First connection only: explicitly opt into trust-on-first-use.
memeloop remote bootstrap operator@worker.example --accept-new-host-key

# Probe prerequisites without changing the host.
memeloop remote bootstrap operator@worker.example --dry-run
```

The command never uses `sudo`, never pipes a downloaded script into a shell,
and installs only the exact requested semantic version under
`~/.local/share/memeloop/cli/<version>`. It atomically selects that version
through `~/.local/bin/memeloop`, so selecting a previously installed version
is also the rollback mechanism. An unrelated existing executable is preserved
unless `--replace-existing-link` is explicitly supplied. SSH host-key changes
are always rejected; `--accept-new-host-key` accepts only a previously unseen
key. The same operation is exported as `bootstrapRemoteCli` for Desktop and
other trusted Node hosts.

SSH bootstrap only installs/selects the CLI. It does not start a daemon,
exchange PeerIds, or implicitly trust the SSH host. Configure the installed
node and run `memeloop start` separately.

## Configuration

The CLI reads YAML configuration files (e.g. `memeloop-cli.yaml`) for node identity, relay endpoints, and profile selection.

Both the historic model map and a richer model array are supported. The array
form allows each model behind one OpenAI-compatible gateway to select its wire
API and default request settings independently:

```yaml
name: remote-test-node
providers:
  - name: cpa
    baseUrl: https://cpa.example.invalid
    apiKey: ${env:CPA_API_KEY}
    models:
      - id: westlake/deepseek
        name: DeepSeek V4 Flash
        apiMode: chat-completions
        maxInputTokens: 1000000
        maxOutputTokens: 32768
        toolCalling: true
        vision: false
        thinking: true
        supportsReasoningEffort: [minimal, low, medium, high]
        reasoningEffortFormat: chat-completions
      - id: kimi-k3-256k
        name: Kimi K3 256K
        apiMode: chat-completions
        limit: { context: 262144, output: 131072 }
        modelOptions: { top_p: 0.95 }
        toolCalling: true
        vision: true
        thinking: true
      - id: gpt-5.6-luna
        name: GPT-5.6 Luna
        apiMode: responses
        maxInputTokens: 1050000
        maxOutputTokens: 128000
        toolCalling: true
        vision: true
        thinking: true
      - id: gpt-5.6-sol
        name: GPT-5.6 Sol
        apiMode: responses
        maxInputTokens: 1050000
        maxOutputTokens: 128000
        toolCalling: true
        vision: true
        thinking: true
```

Prefer `memeloop config` for entering credentials into the mode-`0600` auth
store. Environment interpolation is useful for an ephemeral test node; never
commit the resolved key.

### Pair a LAN node with a Desktop invite

Save the signed invitation copied from TidGi's Device Network settings to a
local file, then start the CLI with that exact file:

```bash
memeloop start \
  --config ./memeloop-cli.yaml \
  --data-dir ~/.local/share/memeloop/node \
  --pair-with-invite-file ./tidgi-device-invite.txt
```

The CLI verifies the invitation signature, expiry, public key, PeerId, and all
PeerId-bound WebSocket addresses before dialing. It trusts only that explicit
identity and prints the six-digit confirmation code. Compare the code and
accept the pending request in TidGi to complete bilateral trust. Unrelated mDNS
peers are never auto-trusted. Later starts omit `--pair-with-invite-file` because
the trust record is durable.

To invite a Desktop or Mobile host to this CLI node instead, print a signed,
short-lived invitation for every address the other host may dial. Each address
must end in this node's PeerId:

```bash
memeloop device invite \
  --multiaddr /dns4/worker.example.com/tcp/443/wss/p2p/12D3KooWYourCliPeerId \
  --ttl-ms 60000
```

Transfer the single JSON line through the QR/file invitation flow. The command
signs it with the selected local device identity; never edit the payload after
generation. Use `--identity <path>` when the node does not use the default
identity file.

### Quorum control plane

Use real etcd when multiple CLI/controller processes must share one
authoritative control plane. Supply every client endpoint so the client can
survive a member outage. Put the password in an environment variable rather
than argv:

```bash
export MEMELOOP_ETCD_PASSWORD='replace-me'
memeloop start \
  --control-store etcd \
  --etcd-endpoints https://control-1:2379,https://control-2:2379,https://control-3:2379 \
  --etcd-username memeloop-controller \
  --etcd-ca-cert /etc/memeloop/etcd-ca.pem \
  --etcd-client-cert /etc/memeloop/controller.pem \
  --etcd-client-key /etc/memeloop/controller-key.pem
```

`EtcdControlStore` is also exported by the Node SDK for embedding. Its
resource writes, replay events, idempotency records, and logical revision are
committed in one etcd transaction. Controller leases use native etcd leases
and retain a durable monotonic fencing epoch. Membership methods add learners,
promote caught-up voters, update peer URLs, and remove members; those methods
should be exposed only to cluster administrators.

The pinned acceptance test creates a real one-voter etcd cluster, adds and
promotes two learners, enables authentication, stops the elected leader,
proves two voters still commit, proves one voter cannot commit, restores
quorum, checks fencing, and streams an authenticated backend snapshot:

```bash
pnpm --filter memeloop-cli build
node scripts/accept-etcd-quorum.mjs
```

## Linux process RuntimeClasses

Local generated-script workloads are advertised only when the CLI can prepare
its Linux sandbox. The host needs:

- a working user systemd manager and cgroup v2;
- `systemd-run`, `bwrap` (bubblewrap), and `setpriv` (util-linux);
- unprivileged user namespaces enabled.

The startup probe executes the complete cgroup, namespace, no-new-privileges,
capability-drop, seccomp, and network-isolation chain. If it fails, the node
does not advertise any process RuntimeClass, so the scheduler cannot silently
place a restricted workload into a weaker runtime. Profile workloads remain
available, and container/Swarm/Kubernetes drivers can still provide external
execution.

## Development

```bash
pnpm install
pnpm --filter memeloop-cli build
pnpm --filter memeloop-cli test
```

## License

MIT
