# memeloop-k8s

Optional Kubernetes/K3s implementation of MemeLoop's external-orchestrator
driver. It uses the Kubernetes REST API directly and does not add a Kubernetes
SDK to `memeloop` or the default CLI.

Build and publish the worker image first:

```sh
docker build -t ghcr.io/linonetwo/memeloop-worker-runtime:0.0.1 packages/memeloop-worker-runtime
docker push ghcr.io/linonetwo/memeloop-worker-runtime:0.0.1
```

Install `memeloop-k8s` beside `memeloop-cli`, then create
`<dataDir>/drivers.d/k8s.json`:

```json
{
  "apiVersion": "drivers.memeloop.io/v1alpha1",
  "kind": "DriverManifest",
  "metadata": { "name": "k8s" },
  "spec": {
    "driverType": "external-orchestrator",
    "module": "memeloop-k8s",
    "export": "KubernetesOrchestrationDriver",
    "construct": true,
    "config": {
      "baseUrl": "https://kubernetes.default.svc",
      "namespace": "memeloop",
      "bearerTokenFile": "/var/run/secrets/kubernetes.io/serviceaccount/token",
      "caCertificateFile": "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
      "defaultWorkloadImage": "ghcr.io/linonetwo/memeloop-worker-runtime@sha256:<digest>",
      "defaultToolImage": "ghcr.io/linonetwo/memeloop-worker-runtime@sha256:<digest>",
      "imagePullSecrets": ["ghcr-pull"]
    }
  }
}
```

Use a dedicated ServiceAccount with only Job, Deployment, and Pod permissions
in the configured namespace. In addition to creating and inspecting workloads,
the driver needs `get` access to the `pods/log` subresource so it can recover the
bounded `MEMELOOP_RESULT` record from terminal workers. File-backed credentials
keep tokens out of the driver manifest. Workload pods disable service-account
token mounting, service links, privilege escalation, writable root filesystems,
and Linux capabilities.

For a private registry, create `ghcr-pull` as a
`kubernetes.io/dockerconfigjson` Secret in the managed namespace. The driver
places only its name in `imagePullSecrets`; registry credentials remain in
Kubernetes and never enter workload env or MemeLoop resources.

Set `spec.placement.orchestrator` to the manifest name (`k8s`) on an
`AgentWorkload` or `ToolOperation`. The worker image runs admitted script and
profile workloads through the authenticated worker gateway, plus the safe
`memeloop.runtime.health` / `echo` built-ins.
Every successful worker must emit one final `MEMELOOP_RESULT <json>` line;
native Job success without that validated record is treated as failure rather
than silently losing the agent/tool result. Only the last 20 log lines are read,
with a 128 KiB response limit.
Privileged tools still require a purpose-built executor image.
