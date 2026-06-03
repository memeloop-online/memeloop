import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import { afterEach, describe, expect, it } from "vitest";

import {
  getDefaultKeypairPath,
  loadNodeKeypair,
  loadOrCreateNodeKeypair,
  nodeIdFromX25519PublicKey,
  saveNodeKeypair,
} from "../keypair.js";

describe("keypair", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("returns keypair path under data dir", () => {
    const p = getDefaultKeypairPath("/home/u/.local/share/memeloop");
    expect(p).toBe(path.join("/home/u/.local/share/memeloop", "keypair.yaml"));
  });

  it("loadOrCreate creates then reuses same keypair", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memeloop-keypair-"));
    tmpDirs.push(dir);
    const kpPath = path.join(dir, "keypair.yaml");
    const k1 = loadOrCreateNodeKeypair(kpPath);
    const k2 = loadOrCreateNodeKeypair(kpPath);
    expect(k2.nodeId).toBe(k1.nodeId);
    expect(k2.x25519PublicKey).toBe(k1.x25519PublicKey);
  });

  it("loadNodeKeypair backfills nodeId when missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memeloop-keypair-"));
    tmpDirs.push(dir);
    const kpPath = path.join(dir, "keypair.yaml");
    const created = loadOrCreateNodeKeypair(kpPath);
    const noId = { ...created } as any;
    delete noId.nodeId;
    fs.writeFileSync(kpPath, yaml.dump(noId), "utf8");
    const loaded = loadNodeKeypair(kpPath)!;
    expect(loaded.nodeId).toBe(nodeIdFromX25519PublicKey(created.x25519PublicKey));
  });

  it("saveNodeKeypair writes readable yaml", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memeloop-keypair-"));
    tmpDirs.push(dir);
    const kpPath = path.join(dir, "keypair.yaml");
    const created = loadOrCreateNodeKeypair(kpPath);
    saveNodeKeypair(created, kpPath);
    const loaded = yaml.load(fs.readFileSync(kpPath, "utf8")) as { nodeId: string };
    expect(loaded.nodeId).toBe(created.nodeId);
  });
});

