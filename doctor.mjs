import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Lane } from "./src/lane.mjs";
import { CONTROL_ORIGIN } from "./src/config.mjs";
import { secretPath } from "./src/paths.mjs";
import { appVersion, appVersionSource } from "./src/version.mjs";
import { machineIdDigest } from "./src/machine.mjs";

const root = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const file = join(root, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    if (process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

function secrets() {
  for (const file of [secretPath(), join(root, ".secrets.json")]) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed?.apiKey === "string" && parsed.apiKey) return parsed;
    } catch {
      /* try the next location */
    }
  }
  return null;
}

const out = (label, value) => console.log(`${label.padEnd(14)} ${value}`);

async function main() {
  loadEnv();
  const apiKey = process.env.DEEPAI_API_KEY ?? secrets()?.apiKey;
  if (!apiKey) throw new Error("No api key. Run `npm run auth`.");

  const base = process.env.DEEPAI_BASE ?? CONTROL_ORIGIN;
  const lane = new Lane({ apiKey, base });

  const started = Date.now();
  await lane.init();
  out("check-in", `ok in ${Date.now() - started}ms`);
  out("lane", base);
  out("account", secrets()?.username || (secrets()?.isPro ? "pro" : "unknown"));
  out("beacon", `v=${appVersion()} (${appVersionSource()})`);
  const digest = await machineIdDigest();
  out("machine", digest ?? "not detected — set DEEPAI_MACHINE_ID to the SMBIOS UUID");

  const catalog = await lane.catalog(true);
  out("catalog", `${catalog.length} models`);
  for (const model of catalog) {
    const price = lane.metered(model.id) ? `costs ${model.theosPerRequest ?? "?"}` : "free";
    out("  model", `${model.id}  ctx=${model.contextWindow}  out=${model.maxTokens}  ${price}${model.reasoning ? "  reasoning" : ""}`);
  }

  if (process.argv.includes("--chat")) {
    // Prefer a free model so the preflight never spends Theos by accident.
    const target = catalog.find((model) => !lane.metered(model.id)) ?? catalog[0];
    out("turn", `${target.id} (${lane.metered(target.id) ? "metered" : "free"})`);
    const started = Date.now();

    // The lane occasionally refuses one request right after a check-in with a
    // generic "cannot be accepted" 400; a single retry clears it. Auth and
    // quota refusals are not retried.
    const transient = new Set([429, 500, 502, 503, 504]);
    let payload;
    for (let attempt = 1; ; attempt += 1) {
      try {
        payload = await lane.json("/chat/completions", {
          body: {
            model: target.id,
            messages: [
              // The lane refuses a turn with no system message.
              { role: "system", content: "You are a helpful assistant." },
              { role: "user", content: "Reply with the single word: ok" },
            ],
            max_tokens: 64,
            stream: false,
          },
        });
        break;
      } catch (error) {
        const retryable =
          transient.has(error?.status) ||
          (error?.status === 400 && error?.body?.error?.code === "invalid_request_error");
        if (attempt >= 3 || !retryable) throw error;
        out("retry", `${error.status} ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    }

    const text = payload?.choices?.[0]?.message?.content ?? JSON.stringify(payload).slice(0, 200);
    out("completion", `${Date.now() - started}ms  ${JSON.stringify(text).slice(0, 120)}`);
  } else {
    out("completion", "skipped (pass --chat to spend one tiny turn)");
  }
}

main().catch((error) => {
  console.error(`doctor failed: ${error?.message ?? error}`);
  if (error?.body) console.error(JSON.stringify(error.body).slice(0, 800));
  process.exit(1);
});
