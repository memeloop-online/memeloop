# Multi-host fleet acceptance

This acceptance closes the gap between the single-Docker-host fleet benchmark
and evidence from operator-declared separate physical fault domains. It
distributes the same digest-pinned worker image across at least three SSH hosts,
runs a total of at least 100 hardened workers, verifies that the inventory does
not alias the same machine or boot, and probes every remaining host after
excluding each host in turn.

Unique machine and boot IDs reject host aliases, containers, and multiple
Docker contexts on one kernel. They cannot prove physical tenancy or that two
VMs use different hypervisors: the inventory owner must attest that each
fault-domain label represents an independent failure domain. Raw SSH targets,
machine IDs, and boot IDs are excluded from the emitted evidence.

## Host prerequisites

Every inventory host must provide:

- Linux with `/etc/machine-id` and `/proc/sys/kernel/random/boot_id`;
- Node.js 24 or newer;
- Docker Engine access for the SSH user;
- enough capacity for its assigned 64 MiB / 0.25 CPU workers;
- the controller's SSH public key in `authorized_keys`;
- a known host key already present in the controller's `known_hosts`.

For the physical etcd drill, each host's `address` must be an IP address or DNS
name reachable from the controller and every other inventory host. TCP ports
32379 and 32380 must be mutually reachable by default; override them with
`MEMELOOP_ACCEPTANCE_ETCD_CLIENT_PORT` and
`MEMELOOP_ACCEPTANCE_ETCD_PEER_PORT` when necessary. The runner never opens the
ports itself.

The runner always uses `BatchMode=yes` and `StrictHostKeyChecking=yes`. Do not
put passwords, private keys, registry tokens, proxy credentials, or shell
fragments in the inventory. Private GHCR access must already be configured in
the remote Docker credential store. The runner transmits no registry
credential.

The remote worker command is fixed. Inventory values are schema-validated,
configuration is bounded and base64url encoded, and the remote side validates
it again before invoking Docker. Each worker uses:

- `--network none`;
- a read-only root filesystem;
- all Linux capabilities dropped;
- `no-new-privileges`;
- PID, memory, and CPU limits;
- the image's numeric `1000:1000` user.

Workers use `--rm`; the runner does not join or alter an existing Swarm/K3s
cluster and does not change host sysctls, firewall rules, SSH configuration, or
Docker daemon configuration.

## Run

Copy [multi-host-acceptance.inventory.example.json](multi-host-acceptance.inventory.example.json)
to a private path and replace the example hosts. Host names and fault-domain
labels appear in evidence, so use non-secret operational identifiers.

```bash
export MEMELOOP_ACCEPTANCE_IMAGE='ghcr.io/linonetwo/memeloop-worker-runtime@sha256:<64-hex-digest>'
export MEMELOOP_ACCEPTANCE_FLEET_SIZE=100
export MEMELOOP_ACCEPTANCE_PER_HOST_CONCURRENCY=8
node scripts/accept-multi-host-fleet.mjs /private/path/inventory.json \
  > /private/path/multi-host-evidence.json
```

Optional `MEMELOOP_ACCEPTANCE_HOST_TIMEOUT_MS` bounds each SSH host operation
(default 15 minutes, maximum one hour). The command fails closed unless all
hosts succeed, at least three distinct fault-domain labels exist, raw machine
and boot IDs are unique, every assigned worker returns exactly one healthy
result, and every single-host exclusion leaves all remaining hosts able to run
a fresh worker.

The final JSON is suitable for attaching to a release record after reviewing
the non-secret host labels. Passing this fleet acceptance does not by itself
prove a cross-host etcd quorum; that separate fault-injection run must also be
recorded before closing the final physical-fault-domain residual.

To make both physical-host drills mandatory inside the complete acceptance
runner, set the same inventory variable:

```bash
export MEMELOOP_ACCEPTANCE_MULTI_HOST_INVENTORY=/private/path/inventory.json
node scripts/accept-final-orchestration.mjs \
  > /private/path/final-orchestration-evidence.json
```

When the variable is absent, the complete runner keeps both single-host
limitations in `residualRisks`. When it is present, the runner removes them
only after both multi-host commands pass and their evidence is validated.

## Run the physical etcd fault drill

Build the CLI first so the acceptance controller uses the exact local
`EtcdControlStore` implementation:

```bash
pnpm --filter memeloop-cli build
node scripts/accept-multi-host-etcd.mjs /private/path/inventory.json \
  > /private/path/multi-host-etcd-evidence.json
```

The runner creates a one-day acceptance CA plus distinct server and controller
certificates in a private temporary directory. Certificate material crosses
SSH only as source on standard input, never in argv, environment variables,
inventory, ControlStore state, or evidence. Each remote host receives one
explicitly named host-network etcd 3.6.11 container with mutual client and peer
TLS. The runner:

1. proves three unique machine IDs, boot IDs, and fault domains;
2. waits for a healthy three-voter cluster and commits an acknowledged write;
3. stops the run-scoped voter on one host and requires another acknowledged
   write;
4. stops the voter on a second host and requires the write to fail closed with
   `UNAVAILABLE`;
5. restarts the second host, requires recovery, verifies both earlier writes,
   advances the fencing epoch, and takes a real snapshot.

Cleanup addresses only `memeloop-etcd-<random-run-id>-<host-name>` containers
and their matching `/tmp` certificate directories. It runs on normal success,
an assertion error, or another caught failure. Process termination or
SSH/network loss may prevent immediate remote cleanup, in which case the exact
random run ID in the container name identifies the bounded resources to
remove. Existing etcd, Swarm, K3s, Docker networks, volumes, firewall rules,
and host settings are untouched.
