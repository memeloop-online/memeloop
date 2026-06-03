import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  completeNoiseXxHandshake,
  generateX25519KeyPairForNoise,
  MEMELOOP_NOISE_PROLOGUE_V1,
} from "memeloop";

import { loadOrCreateNodeKeypair } from "../keypair.js";
import { nodeKeypairToNoiseStaticKeyPair } from "../noiseKeypair.js";

describe("nodeKeypairToNoiseStaticKeyPair", () => {
  it("produces raw 32-byte keys usable by Noise_XX", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noise-kp-"));
    const kp = loadOrCreateNodeKeypair(path.join(dir, "keypair.yaml"));
    const noiseKp = nodeKeypairToNoiseStaticKeyPair(kp);
    expect(noiseKp.publicKey.length).toBe(32);
    expect(noiseKp.secretKey.length).toBe(32);
    const peer = await generateX25519KeyPairForNoise();
    const r = await completeNoiseXxHandshake(noiseKp, peer, MEMELOOP_NOISE_PROLOGUE_V1);
    expect(r.initiatorRemoteStatic.equals(peer.publicKey)).toBe(true);
  });
});
