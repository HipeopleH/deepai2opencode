// Regenerates the OpenCode provider block from the live DeepAI catalog, so the
// model list, context windows, and Theos prices never drift.
//
//   node scripts/gen-config.mjs            → writes ./opencode.json
//   node scripts/gen-config.mjs --global   → merges into ~/.config/opencode/opencode.json
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Lane } from "../src/lane.mjs";
import { CONTROL_ORIGIN } from "../src/config.mjs";
import { secretPath } from "../src/paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const globalMode = process.argv.includes("--global");

function readSecrets() {
  for (const file of [secretPath(), join(root, ".secrets.json")]) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed?.apiKey === "string" && parsed.apiKey) return parsed;
    } catch {
      /* next */
    }
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function targetPath() {
  if (globalMode) {
    const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    return join(base, "opencode", "opencode.json");
  }
  return join(root, "opencode.json");
}

const priceLabel = (metered, cost) => {
  if (!metered) return "free";
  if (cost === null) return "metered";
  return `${cost} Theos`;
};

const secrets = readSecrets();
if (!secrets?.apiKey) {
  console.error("No api key. Run `npm run auth` first.");
  process.exit(1);
}

const suffix = process.env.MODEL_SUFFIX ?? "";
const toAlias = (id) => `${id}${suffix}`;
const baseURL = process.env.BRIDGE_PUBLIC_URL ?? `http://127.0.0.1:${process.env.BRIDGE_PORT ?? 8788}/v1`;

const lane = new Lane({ apiKey: secrets.apiKey, base: process.env.DEEPAI_BASE ?? CONTROL_ORIGIN });
await lane.init();
const catalog = await lane.catalog(true);

if (!catalog?.length) {
  console.error("The lane returned an empty catalog; nothing written.");
  process.exit(1);
}

const models = {};
let free = 0;
let paid = 0;

for (const model of catalog) {
  const metered = lane.metered(model.id);
  const cost = lane.cost(model.id);
  if (metered) paid += 1;
  else free += 1;

  models[toAlias(model.id)] = {
    name: `${model.name} · ${priceLabel(metered, cost)}`,
    capabilities: {
      tools: true,
      input: Array.isArray(model.input) && model.input.length ? model.input : ["text"],
      output: ["text"],
    },
    limit: { context: model.contextWindow, output: model.maxTokens },
  };
}

const provider = {
  name: "DeepAI",
  package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL, apiKey: "loopback" },
  models,
};

const file = targetPath();
const existing = readJson(file) ?? {};
const defaultAlias =
  catalog.find((model) => !lane.metered(model.id) && /flash/.test(model.id))
    ?.id ?? catalog[0].id;

const defaultId = `deepai/${toAlias(defaultAlias)}`;

// Keep the existing default only if that model still exists under its current id.
const keepModel =
  typeof existing.model === "string" &&
  existing.model.startsWith("deepai/") &&
  Object.hasOwn(models, existing.model.slice("deepai/".length));

let next;
if (globalMode) {
  next = {
    ...existing,
    model: keepModel ? existing.model : defaultId,
    providers: { ...(existing.providers ?? {}), deepai: provider },
  };
} else {
  next = {
    $schema: "https://opencode.ai/config.json",
    model: defaultId,
    providers: { deepai: provider },
  };
}

mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");

console.log(`wrote ${file}`);
console.log(`  ${free} free, ${paid} paid (Theos) models`);
console.log(`  default deepai/${toAlias(defaultAlias)}`);
console.log(`  base ${baseURL}`);
for (const [id, entry] of Object.entries(models)) {
  console.log(`  ${id.padEnd(34)} ${entry.name}`);
}
