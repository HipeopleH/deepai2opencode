import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readAutostart, writeAutostart, launcher, hiddenLauncher } from "./autostart.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(here, "..", "ui");

const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

export function isUiPath(pathName) {
  return ASSETS.has(pathName) || pathName === "/favicon.ico" || pathName.startsWith("/_bridge/");
}

function send(res, status, type, body) {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function json(res, status, payload) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        resolve({});
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/**
 * Control plane for the browser UI. Everything here lives under `/_bridge/`
 * and is same-origin only; the inference routes keep refusing browsers.
 */
export function createDashboard({
  lane,
  usage,
  toAlias,
  host,
  port,
  version,
  versionSource,
  secrets,
  logFile,
  startedAt,
  onShutdown,
  log,
}) {
  async function state() {
    const catalog = await lane.catalog().catch(() => []);
    const models = catalog.map((model) => {
      const alias = toAlias(model.id);
      const metered = lane.metered(model.id);
      const cost = lane.cost(model.id);
      return {
        id: model.id,
        alias,
        name: model.name,
        context: model.contextWindow,
        maxOutput: model.maxTokens,
        reasoning: model.reasoning,
        metered,
        cost,
        price: metered ? (cost === null ? "metered" : `${cost} Theos`) : "free",
      };
    });

    const metered = models.filter((model) => model.metered);
    const theos = lane.theos;
    const defaultModel =
      models.find((model) => !model.metered && /flash/.test(model.id))?.alias ??
      models[0]?.alias ??
      null;

    return {
      ok: true,
      bridge: {
        host,
        port,
        url: `http://${host}:${port}`,
        apiBase: `http://${host}:${port}/v1`,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        startedAt,
        version,
        versionSource,
        account: secrets?.username ?? null,
        plan: secrets?.isPro ? "pro" : "free",
        keyFile: secrets?.file ?? null,
        logFile,
        launcher: launcher(),
        defaultModel,
      },
      theos: theos
        ? {
            ...theos,
            used: theos.granted === null ? null : Math.max(0, theos.granted - theos.balance),
            ageSeconds: Math.round((Date.now() - theos.fetchedAt) / 1000),
            fraction: theos.granted ? Math.min(1, theos.balance / theos.granted) : null,
          }
        : null,
      usage: usage.snapshot(),
      autostart: await readAutostart(),
      counts: {
        total: models.length,
        free: models.length - metered.length,
        metered: metered.length,
        affordable: models.filter((model) => model.cost === null || model.cost === 0 || !theos || model.cost <= theos.balance).length,
      },
      models,
    };
  }

  async function handle(req, res, pathName, url) {
    if (pathName === "/favicon.ico") {
      res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
      res.end();
      return true;
    }

    const asset = ASSETS.get(pathName);
    if (asset) {
      const [file, type] = asset;
      try {
        send(res, 200, type, await readFile(join(uiRoot, file), "utf8"));
      } catch (error) {
        json(res, 500, { error: { message: `UI asset missing: ${file}`, code: "ui_missing" }, detail: error.message });
      }
      return true;
    }

    if (!pathName.startsWith("/_bridge/")) return false;

    if (req.method === "GET" && pathName === "/_bridge/state") {
      try {
        json(res, 200, await state());
      } catch (error) {
        json(res, 500, { error: { message: error.message, code: "state_failed" } });
      }
      return true;
    }

    // Unsafe verbs need the custom header, so a page cannot drive the control
    // plane through a plain form post.
    if (req.headers["x-bridge-control"] !== "1") {
      json(res, 403, { error: { message: "Missing control header.", code: "forbidden" } });
      return true;
    }

    if (req.method === "POST" && pathName === "/_bridge/refresh") {
      await lane.catalog(true).catch((error) => log?.(`refresh failed: ${error.message}`));
      await lane.refreshTheos({ minIntervalMs: 0 }).catch((error) => log?.(`theos refresh failed: ${error.message}`));
      json(res, 200, await state());
      return true;
    }

    if (req.method === "POST" && pathName === "/_bridge/autostart") {
      const body = await readJson(req);
      try {
        const next = await writeAutostart(body.enabled === true);
        log?.(`autostart ${next.enabled ? "enabled" : "disabled"}`);
        json(res, 200, { ok: true, autostart: next });
      } catch (error) {
        json(res, 500, { error: { message: error.message, code: "autostart_failed" } });
      }
      return true;
    }

    if (req.method === "POST" && pathName === "/_bridge/shutdown") {
      json(res, 200, { ok: true });
      // Let the reply flush before the listener closes.
      setTimeout(() => onShutdown?.(), 150);
      return true;
    }

    json(res, 404, { error: { message: `Unknown control route: ${pathName}`, code: "not_found" } });
    return true;
  }

  return { state, handle, hiddenLauncher };
}
