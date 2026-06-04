import type { KnownNodeEntry } from '../protocol/index.js';

export interface KnownNodesFile {
  version: 1;
  entries: KnownNodeEntry[];
}

export interface KnownNodesRepository {
  load(): Promise<KnownNodeEntry[]>;
  save(entries: KnownNodeEntry[]): Promise<void>;
}

export class InMemoryKnownNodesRepository implements KnownNodesRepository {
  private entries: KnownNodeEntry[];

  constructor(entries: KnownNodeEntry[] = []) {
    this.entries = [...entries];
  }

  async load(): Promise<KnownNodeEntry[]> {
    return [...this.entries];
  }

  async save(entries: KnownNodeEntry[]): Promise<void> {
    this.entries = [...entries];
  }
}

export class KnownNodesService {
  constructor(private readonly repository: KnownNodesRepository) {}

  async listKnownNodes(): Promise<KnownNodeEntry[]> {
    try {
      return await this.repository.load();
    } catch {
      return [];
    }
  }

  async saveKnownNodes(entries: KnownNodeEntry[]): Promise<void> {
    await this.repository.save(entries);
  }

  async upsertKnownNode(entry: KnownNodeEntry): Promise<void> {
    const current = await this.listKnownNodes();
    const index = current.findIndex((e) => e.nodeId === entry.nodeId);
    const next = index >= 0 ? [...current.slice(0, index), entry, ...current.slice(index + 1)] : [...current, entry];
    await this.repository.save(next);
  }

  async removeKnownNode(nodeId: string): Promise<void> {
    const current = (await this.listKnownNodes()).filter((e) => e.nodeId !== nodeId);
    await this.repository.save(current);
  }

  async trustMatchesStored(nodeId: string, staticPublicKey: string): Promise<boolean> {
    const entry = (await this.listKnownNodes()).find((x) => x.nodeId === nodeId);
    if (!entry) return true;
    return entry.staticPublicKey === staticPublicKey;
  }
}

function isEntry(x: unknown): x is KnownNodeEntry {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.nodeId === 'string' &&
    typeof o.staticPublicKey === 'string' &&
    typeof o.firstSeen === 'number' &&
    typeof o.lastConnected === 'number' &&
    (o.trustSource === 'pin-pairing' || o.trustSource === 'cloud-registry')
  );
}

export function parseKnownNodesFile(raw: string): KnownNodeEntry[] {
  try {
    const parsed = JSON.parse(raw) as KnownNodesFile | KnownNodeEntry[] | null;
    if (!parsed) return [];
    if (Array.isArray(parsed)) return parsed.filter(isEntry);
    if (parsed.version === 1 && Array.isArray(parsed.entries)) {
      return parsed.entries.filter(isEntry);
    }
    return [];
  } catch {
    return [];
  }
}

export function serializeKnownNodesFile(entries: KnownNodeEntry[]): string {
  const payload: KnownNodesFile = { version: 1, entries };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
