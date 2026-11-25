import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Lane } from "./lane.mjs";
import { createProxy } from "./proxy.mjs";
import { createUsage } from "./usage.mjs";
import { createDashboard } from "./dashboard.mjs";
import { CONTROL_ORIGIN } from "./config.mjs";
import { logPath, secretPath } from "./paths.mjs";
import { appVersion, appVersionSource } from "./version.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** Minimal .env loader; real environment always wins. */
function loadEnv() {
  const file = join(root, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

function readSecrets() {
  // Preferred home is outside the project; the old in-project file still works
  // so an earlier sign-in is not lost.
  for (const file of [secretPath(), join(root, ".secrets.json")]) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed?.apiKey === "string" && parsed.apiKey) return { ...parsed, file };
    } catch {
      /* try the next location */
    }
  }
  return null;
}

/**
 * Console plus a log file. The launcher runs this with no window, so the file
 * is the only way to see why a start failed.
 */
function createLog() {
  const file = logPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size > 2_000_000) {
      renameSync(file, `${file}.1`);
    }
  } catch {
    /* logging must never take the bridge down */
  }

  return (message) => {
    const line = `[bridge] ${message}`;
    process.stdout.write(`${line}\n`);
    try {
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* ignore */
    }
  };
}

async function main() {
  loadEnv();
  const log = createLog();

  // A hidden start has no console: anything that escapes must be written down,
  // or a crash looks like a silent exit.
  process.on("uncaughtException", (error) => {
    log(`fatal: ${error?.stack ?? error}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (error) => {
    log(`fatal rejection: ${error?.stack ?? error}`);
    process.exit(1);
  });
  // The log goes to a file; a broken stdout must never be fatal.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});

  const secrets = readSecrets();
  const apiKey = process.env.DEEPAI_API_KEY ?? secrets?.apiKey;
  if (!apiKey) {
    log("no api key — run `npm run auth` first, or set DEEPAI_API_KEY");
    process.exitCode = 1;
    return;
  }

  const host = process.env.BRIDGE_HOST ?? "127.0.0.1";
  const port = Number(process.env.BRIDGE_PORT ?? 8788);
  const suffix = process.env.MODEL_SUFFIX ?? "";
  const base = process.env.DEEPAI_BASE ?? CONTROL_ORIGIN;

  const startedAt = Date.now();
  const usage = createUsage();
  const lane = new Lane({ apiKey, base });
  await lane.init();

  const toAlias = (real) => (suffix ? `${real}${suffix}` : real);

  let server;
  const shutdown = () => {
    log("shutting down");
    server?.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };

  const dashboard = createDashboard({
    lane,
    usage,
    toAlias,
    host,
    port,
    version: appVersion(),
    versionSource: appVersionSource(),
    secrets,
    logFile: logPath(),
    startedAt,
    onShutdown: shutdown,
    log,
  });

  ({ server } = createProxy({ lane, suffix, log, usage, dashboard }));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  }).catch((error) => {
    if (error?.code === "EADDRINUSE") {
      throw new Error(
        `port ${port} is already in use — another bridge is probably running at http://${host}:${port}/`,
      );
    }
    throw error;
  });

  const catalog = await lane.catalog().catch(() => null);
  log(`listening on http://${host}:${port}/v1`);
  log(`dashboard http://${host}:${port}/`);
  log(`lane ${base}${secrets?.username ? ` as ${secrets.username}` : ""}`);
  log(`beacon v=${appVersion()} (${appVersionSource()})`);
  if (secrets?.file) log(`key from ${secrets.file}`);

  const theos = lane.theos;
  if (theos) {
    log(
      `theos ${theos.balance} of ${theos.granted ?? "?"} remaining` +
        (theos.refreshAt ? `, refresh ${theos.refreshAt}` : ""),
    );
  }

  if (catalog?.length) {
    for (const model of catalog) {
      const price = lane.metered(model.id) ? `costs ${model.theosPerRequest ?? "?"}` : "free";
      log(`model ${toAlias(model.id)} -> ${model.id} (${model.contextWindow} ctx, ${price})`);
    }
  } else {
    log("model catalog unavailable; /v1/models will retry on demand");
  }

  // Keep the advertised catalog and the Theos meter warm without holding the
  // process open. The lane itself refreshes at half-life on real traffic.
  setInterval(() => lane.catalog().catch(() => {}), 600_000).unref();
  setInterval(() => lane.refreshTheos().catch(() => {}), 300_000).unref();

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(`[bridge] fatal: ${error?.stack ?? error}\n`);
  process.exit(1);
});
