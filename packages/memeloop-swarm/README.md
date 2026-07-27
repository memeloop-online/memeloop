# memeloop-swarm

Optional Docker Swarm implementation of MemeLoop's external-orchestrator
driver. It talks to the Docker Engine REST API directly and does not add a
Docker SDK to `memeloop` or the default CLI.

Build the worker image on every Swarm node or push it to a registry, install
`memeloop-swarm` beside `memeloop-cli`, then create
`<dataDir>/drivers.d/swarm.json`:

```json
{
  "apiVersion": "drivers.memeloop.io/v1alpha1",
  "kind": "DriverManifest",
  "metadata": { "name": "swarm" },
  "spec": {
    "driverType": "external-orchestrator",
    "module": "memeloop-swarm",
    "export": "SwarmOrchestrationDriver",
    "construct": true,
    "config": {
      "socketPath": "/var/run/docker.sock",
      "defaultWorkloadImage": "ghcr.io/linonetwo/memeloop-worker-runtime@sha256:<digest>",
      "defaultToolImage": "ghcr.io/linonetwo/memeloop-worker-runtime@sha256:<digest>",
      "registryAuthFile": "/run/secrets/memeloop-registry-auth.json"
    }
  }
}
```

Protect the manifest and Docker socket: access to the engine is host-root
equivalent. The bundled worker image runs as `node`; created containers also
use a read-only root filesystem, an init process, and drop all Linux
capabilities. Purpose-built executor images must declare their own non-root
`USER`. Configure a Docker logging driver that supports `docker service logs`;
the MemeLoop driver uses that endpoint to recover terminal worker results.

For a private registry, `registryAuthFile` must be a regular `0400`/`0600`
file containing one Docker Engine `AuthConfig` object (for example
`username`, `password`, and `serveraddress`). It is re-read at service creation
for rotation and sent only through Docker's `X-Registry-Auth` request header;
credentials are never copied into the Swarm Service spec.

Set `spec.placement.orchestrator` to the manifest name (`swarm`) on an
`AgentWorkload` or `ToolOperation`. The worker image runs admitted script and
profile workloads through the authenticated worker gateway, plus the safe
`memeloop.runtime.health` / `echo` built-ins.
`defaultWorkloadImage` creates the host-owned `default` runtime contract;
workloads may select another operator-configured `workloadRuntimes`
`runtimeClass`, but cannot replace the image, command, or container environment
through annotations. `defaultToolImage` exposes only the two bundled read-only
runtime tools. Additional tools require explicit `toolContracts` entries
binding their kind/name, effect, input schema, and allowed image references.
Contracts also bind the output schema and hard CPU/memory ceiling. Workload
runtime contracts similarly provide default/max CPU and memory; unsupported
GPU, disk, or bandwidth requests fail closed.
Every successful worker must emit one final `MEMELOOP_RESULT <json>` line;
native Service success without that validated record is treated as failure
rather than silently losing the agent/tool result. Only the last 20 log lines
are read, with a 128 KiB response limit.
Privileged tools still require a purpose-built executor image.
