import http from 'node:http';
import type { AddressInfo } from 'node:net';

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

/**
 * In-memory fake of the Docker Engine API endpoints used by
 * `SwarmOrchestrationDriver`. TCP only (no unix socket), no external deps.
 * Tests assert on the recorded requests and manipulate service/task state
 * directly.
 */
export interface FakeEngineRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: any;
}

interface FakeService {
  ID: string;
  Spec: any;
}

interface FakeTask {
  ID: string;
  ServiceID: string;
  NodeID?: string;
  Status: { State: string; Timestamp: string; Err?: string };
  DesiredState: string;
  Spec: { ContainerSpec: { Labels: Record<string, string> } };
}

export interface FakeEngineServer {
  url: string;
  /** All requests the driver issued, in order. */
  requests: FakeEngineRequest[];
  /** Created services keyed by ID. */
  services: Map<string, FakeService>;
  /** Tasks (one auto-created per service; tests may add/mutate more). */
  tasks: FakeTask[];
  /** Make the next request whose path includes `pathFragment` fail. */
  failNext(status: number, message: string, pathFragment?: string): void;
  /** Change the state of every task belonging to a service. */
  setTaskState(serviceId: string, state: string, error?: string): void;
  close(): Promise<void>;
}

export async function createFakeEngineServer(): Promise<FakeEngineServer> {
  const services = new Map<string, FakeService>();
  const tasks: FakeTask[] = [];
  const requests: FakeEngineRequest[] = [];
  const pendingFailures: Array<{ status: number; message: string; pathFragment?: string }> = [];
  let counter = 0;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://fake-engine');
      const path = url.pathname;
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text.length > 0 ? JSON.parse(text) : undefined;
      requests.push({ method: request.method ?? 'GET', path, query: url.searchParams, body });

      const failureIndex = pendingFailures.findIndex((f) => !f.pathFragment || path.includes(f.pathFragment));
      if (failureIndex >= 0) {
        const [failure] = pendingFailures.splice(failureIndex, 1);
        response.writeHead(failure.status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ message: failure.message }));
        return;
      }

      const json = (status: number, value: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      const notFound = (message: string) => {
        json(404, { message });
      };

      if (request.method === 'GET' && path === '/_ping') {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('OK');
        return;
      }
      if (request.method === 'GET' && path === '/info') {
        json(200, { ID: 'fake-engine', Swarm: { LocalNodeState: 'active', NodeID: 'node-1' } });
        return;
      }
      if (request.method === 'GET' && path === '/version') {
        json(200, { Version: '26.1.4', ApiVersion: '1.49' });
        return;
      }
      if (request.method === 'POST' && path === '/services/create') {
        const name: string = body?.Name ?? 'unnamed';
        for (const existing of services.values()) {
          if (existing.Spec?.Name === name) {
            json(409, { message: `service name ${name} conflicts with an existing service` });
            return;
          }
        }
        counter += 1;
        const id = `svc-${counter}`;
        services.set(id, { ID: id, Spec: body });
        tasks.push({
          ID: `task-${counter}`,
          ServiceID: id,
          NodeID: 'node-1',
          Status: { State: 'running', Timestamp: new Date().toISOString() },
          DesiredState: 'running',
          Spec: { ContainerSpec: { Labels: body?.TaskTemplate?.ContainerSpec?.Labels ?? {} } },
        });
        json(201, { ID: id });
        return;
      }
      const serviceMatch = /^\/services\/([^/]+)$/.exec(path);
      if (serviceMatch) {
        const idOrName = decodeURIComponent(serviceMatch[1]);
        const service = services.get(idOrName) ??
          [...services.values()].find((s) => s.Spec?.Name === idOrName);
        if (!service) {
          notFound(`service ${idOrName} not found`);
          return;
        }
        if (request.method === 'GET') {
          json(200, service);
          return;
        }
        if (request.method === 'DELETE') {
          services.delete(service.ID);
          for (const task of tasks.filter((t) => t.ServiceID === service.ID)) {
            task.DesiredState = 'shutdown';
            task.Status.State = 'shutdown';
          }
          response.writeHead(204);
          response.end();
          return;
        }
      }
      if (request.method === 'GET' && path === '/services') {
        const filters = parseFilters(url.searchParams.get('filters'));
        const labelFilters = asArray(filters.label);
        const result = [...services.values()].filter((service) => labelsMatch(service.Spec?.Labels ?? {}, labelFilters));
        json(200, result);
        return;
      }
      if (request.method === 'GET' && path === '/tasks') {
        const filters = parseFilters(url.searchParams.get('filters'));
        const serviceFilters = asArray(filters.service);
        const labelFilters = asArray(filters.label);
        const result = tasks.filter((task) => {
          if (serviceFilters.length > 0 && !serviceFilters.includes(task.ServiceID)) return false;
          return labelsMatch(task.Spec.ContainerSpec.Labels, labelFilters);
        });
        json(200, result);
        return;
      }
      notFound(`no fake route for ${request.method} ${path}`);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    services,
    tasks,
    failNext(status, message, pathFragment) {
      pendingFailures.push({ status, message, pathFragment });
    },
    setTaskState(serviceId, state, error) {
      for (const task of tasks.filter((t) => t.ServiceID === serviceId)) {
        task.Status.State = state;
        task.Status.Timestamp = new Date().toISOString();
        if (error !== undefined) task.Status.Err = error;
        if (state === 'complete' || state === 'failed' || state === 'shutdown') {
          task.DesiredState = 'shutdown';
        }
      }
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        })
      );
    },
  };
}

function parseFilters(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Engine filters are `{"label":["k=v"]}` or `{"label":{"k=v":true}}`. */
function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>);
  return [];
}

function labelsMatch(labels: Record<string, string>, filters: string[]): boolean {
  return filters.every((filter) => {
    const eq = filter.indexOf('=');
    if (eq < 0) return filter in labels;
    return labels[filter.slice(0, eq)] === filter.slice(eq + 1);
  });
}
