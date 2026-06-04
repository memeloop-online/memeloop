import { promises as fs } from "node:fs";
import path from "node:path";

import {
  parseKnownNodesFile,
  serializeKnownNodesFile,
  type KnownNodesRepository,
  type KnownNodeEntry,
} from "memeloop";

export function getDefaultKnownNodesPath(dataDir: string): string {
  return path.join(dataDir, "known_nodes.json");
}

export class KnownNodesFileRepository implements KnownNodesRepository {
  constructor(private readonly filePath: string) {}

  async load(): Promise<KnownNodeEntry[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return parseKnownNodesFile(raw);
    } catch {
      return [];
    }
  }

  async save(entries: KnownNodeEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, serializeKnownNodesFile(entries), { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    try {
      await fs.chmod(this.filePath, 0o600);
    } catch {
      // Best effort on platforms that ignore chmod.
    }
  }
}