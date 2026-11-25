import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where the account key lives. It is deliberately outside the project tree:
 * this folder is often synced (OneDrive, git), and the key must not ride along.
 * `DEEPAI_SECRETS` wins when set.
 */
export function secretPath() {
  if (process.env.DEEPAI_SECRETS) return process.env.DEEPAI_SECRETS;

  if (platform() === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, "deepai-bridge", "secrets.json");
  }

  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "deepai-bridge", "secrets.json");
}

export function secretDir() {
  return dirname(secretPath());
}

/** Hidden-run diagnostics: the launcher starts the bridge with no console. */
export function logPath() {
  return join(secretDir(), "bridge.log");
}
