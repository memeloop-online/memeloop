import type { ParsedHandshake } from "memeloop";
import type { WsAuthOptions } from "../network/nodeServerImpl.js";

import type { NodeConfig } from "../config";
import { loadConfig, saveConfig } from "../config";

/**
 * Build wsAuth verifier for LAN PIN mode with exponential backoff persisted in YAML config.
 * Returns undefined when ws auth is disabled or pin not configured.
 */
export function createLanPinWsAuth(
  config: NodeConfig,
  configPath: string,
): WsAuthOptions | undefined {
  const wsCfg = config.auth?.ws ?? {};
  // Default enabled unless explicitly disabled.
  if (wsCfg.enabled === false) return undefined;
  const mode = wsCfg.mode ?? "lan-pin";
  if (mode !== "lan-pin") return undefined;
  const pin = wsCfg.pin;
  if (!pin) return undefined;

  return {
    async verify(h: ParsedHandshake): Promise<boolean> {
      // Always reload latest config so external YAML edits (by Agent/admin) take effect immediately.
      const latest = loadConfig(configPath);
      const latestWsCfg = latest.auth?.ws ?? wsCfg;
      if (latestWsCfg.enabled === false) return false;
      const latestMode = latestWsCfg.mode ?? "lan-pin";
      if (latestMode !== "lan-pin") return false;
      const latestPin = latestWsCfg.pin ?? pin;
      if (!latestPin) return false;
      if (h.authType !== "pin") return false;
      const now = Date.now();
      const state = latest.auth?.lanPinState ?? { failCount: 0, nextAllowedAt: 0 };
      const nextAllowedAt = state.nextAllowedAt ?? 0;
      if (nextAllowedAt && now < nextAllowedAt) {
        return false;
      }

      if (h.credential !== latestPin) {
        const previousFailCount = state.failCount ?? 0;
        const failCount = previousFailCount + 1;
        const base = 2_000;
        const max = 300_000;
        const backoff = Math.min(max, base * 2 ** (failCount - 1));
        const newNextAllowedAt = now + backoff;

        latest.auth = {
          ...latest.auth,
          ws: { enabled: latestWsCfg.enabled ?? true, mode: latestMode, pin: latestPin },
          lanPinState: { failCount, nextAllowedAt: newNextAllowedAt },
        };
        saveConfig(latest, configPath);
        return false;
      }

      // Success: reset failure state.
      latest.auth = {
        ...latest.auth,
        ws: { enabled: latestWsCfg.enabled ?? true, mode: latestMode, pin: latestPin },
        lanPinState: { failCount: 0, nextAllowedAt: 0 },
      };
      saveConfig(latest, configPath);
      return true;
    },
  };
}
