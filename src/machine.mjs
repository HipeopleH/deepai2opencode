import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Firmware ships these on blank/placeholder boards; the client treats them as
// "no identifier" rather than binding an account to a shared value.
const PLACEHOLDERS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "03000200-0400-0500-0006-000700080009",
]);

async function run(file, args) {
  try {
    const { stdout } = await execFileAsync(file, args, {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return "";
  }
}

function parseSmbiosUuid(stdout) {
  const uuid = UUID_RE.exec(stdout)?.[0]?.toLowerCase() ?? null;
  return uuid && !PLACEHOLDERS.has(uuid) ? uuid : null;
}

function parseWindowsMachineGuid(stdout) {
  const match = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(stdout);
  if (!match || !UUID_RE.test(match[1])) return null;
  const value = match[1].toLowerCase();
  return PLACEHOLDERS.has(value) ? null : value;
}

function parseLinuxMachineId(raw) {
  const value = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(value) || /^0+$/.test(value)) return null;
  return value;
}

function parseIOPlatformUUID(stdout) {
  const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout);
  if (!match || !UUID_RE.test(match[1])) return null;
  return match[1].toLowerCase();
}

/**
 * Same source order as the shipped client, which matters: the account is bound
 * to the digest it sent first. On Windows that is the SMBIOS UUID, with
 * MachineGuid only as a fallback when the firmware ships a placeholder. Hashing
 * MachineGuid first yields a different digest and the lane refuses inference.
 */
async function detectRaw() {
  if (process.platform === "darwin") {
    const uuid = parseIOPlatformUUID(
      await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]),
    );
    if (uuid) return uuid;
  }

  if (process.platform === "win32") {
    const smbios = parseSmbiosUuid(
      await run("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
      ]),
    );
    if (smbios) return smbios;

    const guid = parseWindowsMachineGuid(
      await run("reg", [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
      ]),
    );
    if (guid) return guid;
  }

  if (process.platform === "linux") {
    for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      const id = parseLinuxMachineId(await readFile(file, "utf8").catch(() => ""));
      if (id) return id;
    }
  }

  return null;
}

let pending;

/** sha256 of the lowercase machine identifier, or null when none is readable. */
export function machineIdDigest() {
  pending ??= (async () => {
    if (process.env.DEEPAI_MACHINE_ID) {
      return createHash("sha256")
        .update(process.env.DEEPAI_MACHINE_ID.toLowerCase())
        .digest("hex");
    }
    const raw = await detectRaw();
    return raw ? createHash("sha256").update(raw).digest("hex") : null;
  })();
  return pending;
}

export async function machineHeader() {
  const digest = await machineIdDigest();
  return digest ? { "X-DeepAI-Code-Machine": digest } : {};
}
