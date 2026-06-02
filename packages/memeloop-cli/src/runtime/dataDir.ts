/**
 * dataDir.ts — Unified data directory resolution.
 *
 * Priority:
 * 1. MEMELOOP_DATA_DIR env var (explicit override)
 * 2. MEMELOOP_TEST=1 or NODE_ENV=test → ./userdata-test in CWD
 * 3. Default: XDG_DATA_HOME or ~/.local/share/memeloop (platform standard)
 */
import os from "node:os";
import path from "node:path";

/**
 * Resolve the memeloop data directory path (does not create it).
 */
export function getDataDir(): string {
  // 1. Explicit env override
  if (process.env.MEMELOOP_DATA_DIR) {
    return path.resolve(process.env.MEMELOOP_DATA_DIR);
  }

  // 2. Test mode: use userdata-test in CWD
  if (process.env.MEMELOOP_TEST === "1" || process.env.NODE_ENV === "test") {
    return path.resolve(process.cwd(), "userdata-test");
  }

  // 3. Platform-standard user data directory
  const dataHome =
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "memeloop");
}
