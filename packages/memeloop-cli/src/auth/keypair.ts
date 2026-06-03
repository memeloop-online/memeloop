import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

import { getDataDir } from "../runtime/dataDir.js";

export interface NodeKeypair {
  nodeId: string;
  x25519PublicKey: string;
  x25519PrivateKey: string;
  ed25519PublicKey: string;
  ed25519PrivateKey: string;
  createdAt: number;
}

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromBase64Url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function getDefaultKeypairPath(dataDir?: string): string {
  const dir = dataDir ?? getDataDir();
  return path.join(dir, "keypair.yaml");
}

export function nodeIdFromX25519PublicKey(x25519PublicKey: string): string {
  return toBase64Url(createHash("sha256").update(fromBase64Url(x25519PublicKey)).digest());
}

function generateNodeKeypair(): NodeKeypair {
  const x = generateKeyPairSync("x25519");
  const e = generateKeyPairSync("ed25519");
  const xPub = x.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const xPriv = x.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const ePub = e.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const ePriv = e.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const x25519PublicKey = toBase64Url(xPub);
  return {
    nodeId: nodeIdFromX25519PublicKey(x25519PublicKey),
    x25519PublicKey,
    x25519PrivateKey: toBase64Url(xPriv),
    ed25519PublicKey: toBase64Url(ePub),
    ed25519PrivateKey: toBase64Url(ePriv),
    createdAt: Date.now(),
  };
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function saveNodeKeypair(keypair: NodeKeypair, keypairPath = getDefaultKeypairPath()): void {
  ensureParentDir(keypairPath);
  fs.writeFileSync(keypairPath, yaml.dump(keypair, { indent: 2 }), { mode: 0o600 });
  try {
    fs.chmodSync(keypairPath, 0o600);
  } catch {
    // Best effort on platforms that may not support chmod.
  }
}

export function loadNodeKeypair(keypairPath = getDefaultKeypairPath()): NodeKeypair | null {
  if (!fs.existsSync(keypairPath)) return null;
  const raw = fs.readFileSync(keypairPath, "utf8");
  const parsed = yaml.load(raw) as Partial<NodeKeypair>;
  if (
    !parsed ||
    typeof parsed.x25519PublicKey !== "string" ||
    typeof parsed.x25519PrivateKey !== "string" ||
    typeof parsed.ed25519PublicKey !== "string" ||
    typeof parsed.ed25519PrivateKey !== "string"
  ) {
    return null;
  }
  const nodeId = parsed.nodeId && typeof parsed.nodeId === "string"
    ? parsed.nodeId
    : nodeIdFromX25519PublicKey(parsed.x25519PublicKey);
  return {
    nodeId,
    x25519PublicKey: parsed.x25519PublicKey,
    x25519PrivateKey: parsed.x25519PrivateKey,
    ed25519PublicKey: parsed.ed25519PublicKey,
    ed25519PrivateKey: parsed.ed25519PrivateKey,
    createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
  };
}

export function loadOrCreateNodeKeypair(keypairPath = getDefaultKeypairPath()): NodeKeypair {
  const loaded = loadNodeKeypair(keypairPath);
  if (loaded) return loaded;
  const created = generateNodeKeypair();
  saveNodeKeypair(created, keypairPath);
  return created;
}

