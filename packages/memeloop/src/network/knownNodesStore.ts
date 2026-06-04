/**
 * 本地 known_nodes 持久化（计划 §7.5.6），默认 $XDG_DATA_HOME/memeloop/known_nodes.json。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { KnownNodeEntry } from '../protocol/index.js';

export interface KnownNodesFile {
  version: 1;
  entries: KnownNodeEntry[];
}

export function getDefaultKnownNodesPath(dataDir: string): string {
  return path.join(dataDir, 'known_nodes.json');
}

function parseFile(raw: string): KnownNodeEntry[] {
  const parsed = JSON.parse(raw) as KnownNodesFile | KnownNodeEntry[] | null;
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed.filter(isEntry);
  if (parsed.version === 1 && Array.isArray(parsed.entries)) {
    return parsed.entries.filter(isEntry);
  }
  return [];
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

export function loadKnownNodes(filePath: string): KnownNodeEntry[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    return parseFile(raw);
  } catch {
    return [];
  }
}

export function saveKnownNodes(entries: KnownNodeEntry[], filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const payload: KnownNodesFile = { version: 1, entries };
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* ignore */
  }
}

export function upsertKnownNode(entry: KnownNodeEntry, filePath: string): void {
  const current = loadKnownNodes(filePath);
  const index = current.findIndex((e) => e.nodeId === entry.nodeId);
  const next = index >= 0 ? [...current.slice(0, index), entry, ...current.slice(index + 1)] : [...current, entry];
  saveKnownNodes(next, filePath);
}

export function removeKnownNode(nodeId: string, filePath: string): void {
  const current = loadKnownNodes(filePath).filter((e) => e.nodeId !== nodeId);
  saveKnownNodes(current, filePath);
}

/** 若已知 nodeId 存在且公钥不一致则返回 false（SSH host key 变更）。 */
export function trustMatchesStored(nodeId: string, staticPublicKey: string, filePath: string): boolean {
  const e = loadKnownNodes(filePath).find((x) => x.nodeId === nodeId);
  if (!e) return true;
  return e.staticPublicKey === staticPublicKey;
}
