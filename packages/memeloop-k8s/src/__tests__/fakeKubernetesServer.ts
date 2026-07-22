import http from 'node:http';
import type { AddressInfo } from 'node:net';

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

/**
 * In-memory fake of the Kubernetes API endpoints used by
 * `KubernetesOrchestrationDriver` (plan 24.62 item 2). Plain HTTP (no TLS),
 * no external deps — the Kubernetes API `Status` error shape, label-selector
 * filtering, and Job/Deployment/Pod state are emulated so tests can assert
 * on recorded requests and drive lifecycle transitions directly.
 */

export interface FakeKubernetesRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body?: any;
}

interface FakeObject {
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  spec?: any;
  status?: any;
}

export interface FakeKubernetesServer {
  url: string;
  namespace: string;
  /** All requests the driver issued, in order. */
  requests: FakeKubernetesRequest[];
  jobs: Map<string, FakeObject>;
  deployments: Map<string, FakeObject>;
  pods: FakeObject[];
  /** Make the next request whose path includes `pathFragment` fail with a Status object. */
  failNext(status: number, reason: string, message: string, pathFragment?: string): void;
  /** Set a Job's status conditions/active count (e.g. Complete/Failed/Running). */
  setJobStatus(name: string, status: any): void;
  /** Set a Deployment's status (e.g. readyReplicas/Available condition). */
  setDeploymentStatus(name: string, status: any): void;
  close(): Promise<void>;
}

function statusBody(reason: string, message: string, code: number) {
  return { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason, message, code };
}

/** Parse `key=value,key2=value2` label selectors (the only form the driver uses). */
function matchesSelector(labels: Record<string, string> | undefined, selector: string | null): boolean {
  if (!selector) return true;
  return selector.split(',').every((term) => {
    const [key, value] = term.split('=');
    return labels?.[key] === value;
  });
}

export async function createFakeKubernetesServer(namespace = 'default'): Promise<FakeKubernetesServer> {
  const jobs = new Map<string, FakeObject>();
  const deployments = new Map<string, FakeObject>();
  const pods: FakeObject[] = [];
  const requests: FakeKubernetesRequest[] = [];
  const pendingFailures: Array<{ status: number; reason: string; message: string; pathFragment?: string }> = [];

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://fake-k8s');
      const path = url.pathname;
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text.length > 0 ? JSON.parse(text) : undefined;
      requests.push({ method: request.method ?? 'GET', path, query: url.searchParams, headers: request.headers, body });

      const failureIndex = pendingFailures.findIndex((f) => !f.pathFragment || path.includes(f.pathFragment));
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (failureIndex >= 0) {
        const [failure] = pendingFailures.splice(failureIndex, 1);
        json(failure.status, statusBody(failure.reason, failure.message, failure.status));
        return;
      }
      const notFound = (message: string) => {
        json(404, statusBody('NotFound', message, 404));
      };

      if (request.method === 'GET' && path === '/healthz') {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('ok');
        return;
      }
      if (request.method === 'GET' && path === '/version') {
        json(200, { gitVersion: 'v1.30.0-fake' });
        return;
      }
      if (request.method === 'GET' && path === '/apis/batch/v1') {
        json(200, { groupVersion: 'batch/v1' });
        return;
      }
      if (request.method === 'GET' && path === '/apis/apps/v1') {
        json(200, { groupVersion: 'apps/v1' });
        return;
      }

      const jobsPath = `/apis/batch/v1/namespaces/${namespace}/jobs`;
      const deploymentsPath = `/apis/apps/v1/namespaces/${namespace}/deployments`;
      const podsPath = `/api/v1/namespaces/${namespace}/pods`;

      if (request.method === 'POST' && path === jobsPath) {
        const name: string = body?.metadata?.name ?? 'unnamed';
        if (jobs.has(name)) {
          json(409, statusBody('AlreadyExists', `jobs "${name}" already exists`, 409));
          return;
        }
        const job: FakeObject = { metadata: body.metadata, spec: body.spec, status: {} };
        jobs.set(name, job);
        json(201, job);
        return;
      }
      if (request.method === 'POST' && path === deploymentsPath) {
        const name: string = body?.metadata?.name ?? 'unnamed';
        if (deployments.has(name)) {
          json(409, statusBody('AlreadyExists', `deployments "${name}" already exists`, 409));
          return;
        }
        const deployment: FakeObject = { metadata: body.metadata, spec: body.spec, status: {} };
        deployments.set(name, deployment);
        json(201, deployment);
        return;
      }
      if (request.method === 'GET' && path === jobsPath) {
        const selector = url.searchParams.get('labelSelector');
        json(200, { items: [...jobs.values()].filter((job) => matchesSelector(job.metadata.labels, selector)) });
        return;
      }
      if (request.method === 'GET' && path === deploymentsPath) {
        const selector = url.searchParams.get('labelSelector');
        json(200, { items: [...deployments.values()].filter((deployment) => matchesSelector(deployment.metadata.labels, selector)) });
        return;
      }
      if (request.method === 'GET' && path === podsPath) {
        const selector = url.searchParams.get('labelSelector');
        json(200, { items: pods.filter((pod) => matchesSelector(pod.metadata.labels, selector)) });
        return;
      }

      const jobMatch = new RegExp(`^${jobsPath}/([^/]+)$`).exec(path);
      if (jobMatch) {
        const name = decodeURIComponent(jobMatch[1]);
        const job = jobs.get(name);
        if (request.method === 'GET') {
          if (!job) {
            notFound(`jobs.batch "${name}" not found`);
            return;
          }
          json(200, job);
          return;
        }
        if (request.method === 'DELETE') {
          if (!job) {
            notFound(`jobs.batch "${name}" not found`);
            return;
          }
          jobs.delete(name);
          json(200, statusBody('Success', `jobs.batch "${name}" deleted`, 200));
          return;
        }
      }
      const deploymentMatch = new RegExp(`^${deploymentsPath}/([^/]+)$`).exec(path);
      if (deploymentMatch) {
        const name = decodeURIComponent(deploymentMatch[1]);
        const deployment = deployments.get(name);
        if (request.method === 'GET') {
          if (!deployment) {
            notFound(`deployments.apps "${name}" not found`);
            return;
          }
          json(200, deployment);
          return;
        }
        if (request.method === 'DELETE') {
          if (!deployment) {
            notFound(`deployments.apps "${name}" not found`);
            return;
          }
          deployments.delete(name);
          json(200, statusBody('Success', `deployments.apps "${name}" deleted`, 200));
          return;
        }
      }

      notFound(`unhandled fake endpoint: ${request.method} ${path}`);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    namespace,
    requests,
    jobs,
    deployments,
    pods,
    failNext(status, reason, message, pathFragment) {
      pendingFailures.push({ status, reason, message, pathFragment });
    },
    setJobStatus(name, status) {
      const job = jobs.get(name);
      if (job) job.status = status;
    },
    setDeploymentStatus(name, status) {
      const deployment = deployments.get(name);
      if (deployment) deployment.status = status;
    },
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        })
      ),
  };
}
