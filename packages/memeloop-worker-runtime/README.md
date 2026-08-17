# MemeLoop Worker Runtime Image

This package is the minimal external-worker image used by the Swarm and Kubernetes/K3s drivers. It reads exactly one assignment from `MEMELOOP_WORKLOAD` or `MEMELOOP_TOOL_OPERATION` and emits a final `MEMELOOP_RESULT <json>` line.

Script workloads receive admitted source through `MEMELOOP_WORKLOAD_SCRIPT`. The runtime normalizes and re-hashes it against `spec.scriptReference` before import. It exposes only portable script state, output, cancellation, logging, and an authenticated `runAgent` capability. Profile workloads pull their assignment through the same signed worker gateway. Provider credentials, `ResourceClient`, peer topology, and reusable model handles never enter the container.

The one-time bootstrap descriptor is mounted by the driver as a read-only native Secret. Before reading it, the worker opens it without following symbolic links and verifies its ownership and permissions. It accepts either an owner-only file belonging to the worker (the Swarm `0400` form), or a root-owned file with at most group-read access (the Kubernetes projected-Secret `0440` form); all other ownership and permission combinations fail closed. The worker pins the gateway Ed25519 key, generates an ephemeral Ed25519 identity, proves possession during enrollment, verifies the gateway-signed session scope, and signs every later request with a monotonic sequence and nonce.

Scripts execute in a separate VM realm with string/Wasm code generation disabled, no `process` or `fetch`, and no module imports. Workload modules must only declare their exported async generator at module scope: top-level `await` is rejected, and other module initialization has a one-second VM execution limit. Awaited work belongs inside the exported generator, where `ctx.isCancelled()` is available. The container image runs as the unprivileged Node image UID/GID `1000:1000` (numeric so Kubernetes `runAsNonRoot` can verify it); the drivers add read-only-root, no-new-privileges/capability-drop, and service-account hardening.

The built-in tool surface is deliberately limited to `memeloop.runtime.health` and `memeloop.runtime.echo`. Privileged ToolOperations must use a purpose-built executor image selected by policy.

Build from the monorepo root (the package directory is intentionally the
Docker context, so repository data and local artifacts are never sent to the
daemon):

```sh
docker build -t memeloop/worker-runtime:0.0.1 packages/memeloop-worker-runtime
```

The canonical release coordinate is
`ghcr.io/linonetwo/memeloop-worker-runtime:<version>`. The
`publish-worker-runtime.yml` workflow publishes `linux/amd64` and `linux/arm64`
images with SBOM/provenance attestations. Deploy the digest printed in its
workflow summary, for example
`ghcr.io/linonetwo/memeloop-worker-runtime@sha256:<digest>`, rather than a
mutable tag.

The repository is private, so the first published GHCR package is private by
default. Configure a Kubernetes `imagePullSecret` or Swarm registry
authentication unless the package owner explicitly makes the image public.
