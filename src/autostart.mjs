import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "DeepAIBridge";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function run(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
        resolve({ ok: !error, output: stdout ?? "" });
      });
    } catch {
      resolve({ ok: false, output: "" });
    }
  });
}

/** The launcher used by the logon entry: bridge only, no browser window. */
export function hiddenLauncher() {
  return join(root, "start-hidden.vbs");
}

export function launcher() {
  return join(root, "DeepAI Bridge.vbs");
}

function expectedCommand() {
  // wscript keeps the console from flashing at logon.
  return `wscript.exe "${hiddenLauncher()}"`;
}

export async function readAutostart() {
  if (process.platform !== "win32") {
    return { supported: false, enabled: false, command: null, launcher: launcher() };
  }

  const { ok, output } = await run("reg", ["query", RUN_KEY, "/v", VALUE_NAME]);
  if (!ok) {
    return { supported: true, enabled: false, command: null, launcher: launcher() };
  }

  const match = /REG_SZ\s+(.+?)\s*$/i.exec(output);
  return {
    supported: true,
    enabled: true,
    command: match ? match[1] : null,
    launcher: launcher(),
  };
}

export async function writeAutostart(enabled) {
  if (process.platform !== "win32") {
    throw new Error("Autostart is only implemented for Windows.");
  }

  if (!existsSync(hiddenLauncher())) {
    throw new Error(`Launcher missing: ${hiddenLauncher()}`);
  }

  const result = enabled
    ? await run("reg", ["add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", expectedCommand(), "/f"])
    : await run("reg", ["delete", RUN_KEY, "/v", VALUE_NAME, "/f"]);

  // Deleting a value that was never there is success, not failure.
  if (!result.ok && enabled) {
    throw new Error(`Could not update the logon entry. reg said: ${result.output.trim() || "no output"}`);
  }

  return readAutostart();
}

/** Where a double-click launcher would live, for the GUI footer. */
export function homeDir() {
  return homedir();
}
