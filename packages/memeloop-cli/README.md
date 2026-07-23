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

## Configuration

The CLI reads YAML configuration files (e.g. `memeloop-cli.yaml`) for node identity, relay endpoints, and profile selection.

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
