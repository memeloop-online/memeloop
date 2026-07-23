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
      "defaultWorkloadImage": "memeloop/worker-runtime:0.0.1",
      "defaultToolImage": "memeloop/worker-runtime:0.0.1"
    }
  }
}
```

Protect the manifest and Docker socket: access to the engine is host-root
equivalent. The bundled worker image runs as `node`; created containers also
use a read-only root filesystem, an init process, and drop all Linux
capabilities. Purpose-built executor images must declare their own non-root
`USER`.

Set `spec.placement.orchestrator` to the manifest name (`swarm`) on an
`AgentWorkload` or `ToolOperation`. The minimal worker image runs admitted
script workloads and the safe `memeloop.runtime.health` / `echo` built-ins.
Profile/model workloads and privileged tools fail closed until an authenticated
worker bootstrap or purpose-built executor image is configured.
