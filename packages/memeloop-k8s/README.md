# memeloop-k8s

Optional Kubernetes/K3s implementation of MemeLoop's external-orchestrator
driver. It uses the Kubernetes REST API directly and does not add a Kubernetes
SDK to `memeloop` or the default CLI.

Build and publish the worker image first:

```sh
docker build -t registry.example/memeloop/worker-runtime:0.0.1 packages/memeloop-worker-runtime
docker push registry.example/memeloop/worker-runtime:0.0.1
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
      "defaultWorkloadImage": "registry.example/memeloop/worker-runtime:0.0.1",
      "defaultToolImage": "registry.example/memeloop/worker-runtime:0.0.1"
    }
  }
}
```

Use a dedicated ServiceAccount with only Job, Deployment, and Pod permissions
in the configured namespace. File-backed credentials keep tokens out of the
driver manifest. Workload pods disable service-account token mounting, service
links, privilege escalation, writable root filesystems, and Linux capabilities.

Set `spec.placement.orchestrator` to the manifest name (`k8s`) on an
`AgentWorkload` or `ToolOperation`. The minimal worker image runs admitted
script workloads and the safe `memeloop.runtime.health` / `echo` built-ins.
Profile/model workloads and privileged tools fail closed until an authenticated
worker bootstrap or purpose-built executor image is configured.
