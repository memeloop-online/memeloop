# memeloop-cli testing guide

This guide covers the current libp2p device-network implementation. The removed
raw WebSocket, LAN PIN, nodeSecret, `/api/nodes`, and FRP flows are not valid
test paths.

## Prerequisites

- Node.js 24 or newer.
- A workspace install completed from the repository root.
- Linux sandbox tools only when testing process RuntimeClasses.
- A real etcd cluster only for the explicitly gated quorum acceptance.

## Local package gate

```bash
pnpm --filter memeloop build
pnpm --filter @memeloop/libp2p build
pnpm --filter memeloop-cli build
pnpm --filter memeloop-cli lint
pnpm --filter memeloop-cli test:unit
```

The device-network focused gate is:

```bash
pnpm --filter @memeloop/libp2p test:unit
pnpm --filter memeloop-cli exec vitest run \
  src/deviceNetwork/__tests__/authorizer.test.ts \
  src/deviceNetwork/__tests__/cloudClient.test.ts \
  src/deviceNetwork/__tests__/cloudConnection.test.ts \
  src/deviceNetwork/__tests__/cloudDirectory.test.ts \
  src/deviceNetwork/__tests__/ordinaryPeerOrchestration.test.ts
```

The ordinary-peer E2E opens real loopback libp2p listeners. It must run in an
environment that permits binding `127.0.0.1`; a sandbox `listen EPERM` is an
environmental block, not a passing substitute.

## Cloud configuration

Run `memeloop config`, open **Cloud**, and enter the Cloud origin plus a user
access token. Saving performs both the grant-public-key request and an
authenticated device-list request before writing the configuration. Non-loopback
HTTP, redirects, embedded credentials, URL paths/query/fragment, invalid JSON,
responses over 2 MiB, and requests over 10 seconds fail closed. The YAML file is
written with mode `0600` on POSIX.

Start the node with:

```bash
memeloop start --config ./memeloop-cli.yaml
```

Expected behavior:

- The process prints its libp2p PeerId.
- Local operation remains available when Cloud is offline.
- Cloud authorization starts in local-pairing-only mode until the signed-grant
  verification key is available.
- Registration, Cloud directory reconciliation, heartbeat, and relay renewal
  retry in one serialized maintenance loop.
- Revoked or disappeared Cloud devices are removed; an explicit local pairing
  for the same PeerId is never overwritten by Cloud trust.

## SSH bootstrap

The target must already have Node.js 24+, npm, key-based SSH access, and a
verified host key:

```bash
memeloop remote bootstrap operator@worker.example --dry-run
memeloop remote bootstrap operator@worker.example --version 0.2.2
```

Use `--accept-new-host-key` only for an explicit first-use TOFU workflow. The
bootstrap installs an exact version without root access under
`~/.local/share/memeloop/cli/<version>` and atomically selects it through
`~/.local/bin/memeloop`.

## Release checks

```bash
npm pack --dry-run --json --ignore-scripts
node dist/cli.js --version
node dist/cli.js --help
```

The packed root and `memeloop-cli/auth` exports must not contain `CloudClient`,
`NodeKeypair`, or `loadOrCreateNodeKeypair`. `DeviceCloudClient` and the libp2p
device-network exports must remain available.

## Acceptance still requiring real infrastructure

- Two real devices using the private relay across separate networks.
- True cross-NAT/DCUtR hole punching rather than relay-only reachability.
- Android and iOS physical-device pairing/sync.
- A full remote SSH install against the published `memeloop-cli@0.2.2` package.
- Real etcd quorum acceptance through `scripts/accept-etcd-quorum.mjs`.
