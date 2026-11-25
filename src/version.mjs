import { closeSync, openSync, readSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_VERSION } from "./config.mjs";

const VERSION_RE = /\b(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)\b/i;

function installRoot() {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(base, "Programs", "deepai-code-desktop");
}

/** Read `version` out of an Electron asar without unpacking it. */
function versionFromAsar(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonSize = head.readUInt32LE(12);
    if (!headerSize || !jsonSize || jsonSize > 8_000_000) return null;

    const json = Buffer.alloc(jsonSize);
    readSync(fd, json, 0, jsonSize, 16);
    const directory = JSON.parse(json.toString("utf8"));
    const entry = directory?.files?.["package.json"];
    if (!entry || typeof entry.offset !== "string" || !Number.isFinite(entry.size)) return null;

    const dataStart = 8 + headerSize + Number(entry.offset);
    const body = Buffer.alloc(entry.size);
    readSync(fd, body, 0, entry.size, dataStart);
    const parsed = JSON.parse(body.toString("utf8"));
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** The updater keeps the next build as `DeepAI-Code-<version>-<arch>.exe`. */
function versionFromUpdater() {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const dirs = [
    join(base, "deepai-code-desktop-updater"),
    join(base, "deepai-code-desktop-updater", "pending"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = /^DeepAI-Code-(\d+\.\d+\.\d+[^.]*)-/i.exec(name);
      if (match) return match[1];
    }
  }
  return null;
}

let resolved;

/**
 * The version the lane should hear in the beacon. The desktop app updates often
 * (several times a day), so this is read from the installed build at startup
 * instead of being pinned. `DEEPAI_APP_VERSION` overrides.
 */
export function appVersion() {
  if (resolved !== undefined) return resolved;

  if (process.env.DEEPAI_APP_VERSION) {
    resolved = process.env.DEEPAI_APP_VERSION;
    return resolved;
  }

  const asar = join(installRoot(), "resources", "app.asar");
  if (existsSync(asar)) {
    const version = versionFromAsar(asar);
    if (version) {
      resolved = version;
      return resolved;
    }
  }

  resolved = versionFromUpdater() ?? APP_VERSION;
  return resolved;
}

/** Where the version came from, for the startup log. */
export function appVersionSource() {
  if (process.env.DEEPAI_APP_VERSION) return "DEEPAI_APP_VERSION";
  const asar = join(installRoot(), "resources", "app.asar");
  try {
    if (existsSync(asar) && statSync(asar).size > 0 && versionFromAsar(asar)) return asar;
  } catch {
    /* fall through */
  }
  return versionFromUpdater() ? "updater cache" : "built-in fallback";
}
