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
# Start the CLI node
memeloop start

# Register with a cloud relay
memeloop register --relay https://relay.example.com

# Check node status
memeloop status
```

## Configuration

The CLI reads YAML configuration files (e.g. `memeloop-cli.yaml`) for node identity, relay endpoints, and profile selection.

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
