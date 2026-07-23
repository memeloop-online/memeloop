# MemeLoop Worker Runtime Image

This package is the minimal external-worker image used by the Swarm and Kubernetes/K3s drivers. It reads exactly one assignment from `MEMELOOP_WORKLOAD` or `MEMELOOP_TOOL_OPERATION` and emits a final `MEMELOOP_RESULT <json>` line.

Script workloads receive admitted source through `MEMELOOP_WORKLOAD_SCRIPT`. The runtime normalizes and re-hashes it against `spec.scriptReference` before import. It exposes only portable script state, output, cancellation, and logging helpers; cluster/model/tool authority is unavailable and fails closed. Profile/model workloads require the future authenticated worker bootstrap channel and are rejected rather than silently running without policy.

Scripts execute in a separate VM realm with string/Wasm code generation disabled, no `process` or `fetch`, and no module imports. The container image runs as the unprivileged Node image UID/GID `1000:1000` (numeric so Kubernetes `runAsNonRoot` can verify it); the drivers add read-only-root, no-new-privileges/capability-drop, and service-account hardening.

The built-in tool surface is deliberately limited to `memeloop.runtime.health` and `memeloop.runtime.echo`. Privileged ToolOperations must use a purpose-built executor image selected by policy.

Build from the monorepo root (the package directory is intentionally the
Docker context, so repository data and local artifacts are never sent to the
daemon):

```sh
docker build -t memeloop/worker-runtime:0.0.1 packages/memeloop-worker-runtime
```
