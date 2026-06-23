/**
 * dataDir.ts — Unified cross-platform data directory resolution.
 *
 * Priority:
 * 1. MEMELOOP_DATA_DIR env var (explicit override)
 * 2. MEMELOOP_TEST=1 or NODE_ENV=test → ./userdata-test in CWD
 * 3. Platform default:
 *    - Windows: %LOCALAPPDATA%/memeloop
 *    - macOS:   ~/Library/Application Support/memeloop
 *    - Linux:   $XDG_DATA_HOME/memeloop  (default ~/.local/share/memeloop)
 */
import os from 'node:os';
import path from 'node:path';

function platformDataHome(): string {
  if (process.platform === 'win32') {
    // %LOCALAPPDATA% → C:\Users\<user>\AppData\Local
    return process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  }
  if (process.platform === 'darwin') {
    // ~/Library/Application Support
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  // Linux / other Unix
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
}

/**
 * Resolve the memeloop data directory path (does not create it).
 */
export function getDataDirectory(): string {
  // 1. Explicit env override
  if (process.env.MEMELOOP_DATA_DIR) {
    return path.resolve(process.env.MEMELOOP_DATA_DIR);
  }

  // 2. Test mode: use userdata-test in CWD
  if (process.env.MEMELOOP_TEST === '1' || process.env.NODE_ENV === 'test') {
    return path.resolve(process.cwd(), 'userdata-test');
  }

  // 3. Platform-standard user data directory
  return path.join(platformDataHome(), 'memeloop');
}
