// Offline regression test: a fake DeepAI lane plus the real proxy, no network.
// Run with `npm test`. It pins both halves of the contract — the fingerprint the
// lane sees, and the OpenAI surface OpenCode consumes — so a refactor cannot
// quietly break either.
import http from "node:http";
import assert from "node:assert/strict";
import { Lane } from "../src/lane.mjs";
import { createProxy } from "../src/proxy.mjs";
import { createUsage } from "../src/usage.mjs";
import { createDashboard } from "../src/dashboard.mjs";
import { appVersion } from "../src/version.mjs";

// Tests must see the balance immediately after each turn, not 60s later.
process.env.BRIDGE_SETTLE_MS = "0";

const FREE = {
  id: "glm-5.3-flash",
  name: "GLM 5.3 Flash",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 320_000,
  maxTokens: 131_072,
  premier: false,
  theosPerRequest: "0",
};

const PREMIUM = {
  id: "glm-5.3",
  name: "GLM 5.3",
  reasoning: true,
  input: ["text"],
  contextWindow: 320_000,
  maxTokens: 131_072,
  premier: true,
  theosPerRequest: "3",
};

const SLOW_MS = 120;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const seen = {
  checkIns: 0,
  theosHeaders: [],
  catalog: 0,
  chat: [],
  headers: [],
  active: 0,
  maxActive: 0,
  staleRefusals: 0,
};

let laneBalance = 20;

const lane = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");

  if (url.pathname.endsWith("/theos")) {
    seen.checkIns += 1;
    seen.theosHeaders.push(req.headers);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        enabled: true,
        balance: laneBalance.toFixed(5),
        granted: "20.00000",
        refresh_at: "2026-11-25T00:00:00+00:00",
        lane_version: 7,
        check_in: { nonce: "a".repeat(32), seconds: 300 },
      }),
    );
    return;
  }

  if (url.pathname.endsWith("/models")) {
    seen.catalog += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models: [FREE, PREMIUM] }));
    return;
  }

  if (url.pathname.endsWith("/chat/completions")) {
    seen.headers.push(req.headers);
    const sent = JSON.parse(await readBody(req));
    seen.chat.push(sent);

    if (sent.model === "theos_exhausted") {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Out of Theos.", code: "theos_exhausted" } }));
      return;
    }

    if (sent.model === "busy_elsewhere" || sent.model === "always_refused") {
      const refused = sent.model === "always_refused" ? true : seen.staleRefusals++ === 0;
      if (refused) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "This request cannot be accepted.",
              type: "invalid_request_error",
              code: "invalid_request_error",
            },
          }),
        );
        return;
      }
    }

    seen.active += 1;
    seen.maxActive = Math.max(seen.maxActive, seen.active);
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    seen.active -= 1;
    if (sent.model === "glm-5.3") laneBalance -= 3;
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    res.write('data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  res.writeHead(404).end();
});

const lanePort = await listen(lane);

const bridge = new Lane({ apiKey: "test-key", base: `http://127.0.0.1:${lanePort}` });
await bridge.init();

const usage = createUsage();
const dashboard = createDashboard({
  lane: bridge,
  usage,
  toAlias: (id) => `${id}`,
  host: "127.0.0.1",
  port: 0,
  version: appVersion(),
  versionSource: "test",
  secrets: { username: "tester", isPro: false, file: null },
  logFile: null,
  startedAt: Date.now(),
  onShutdown: () => {},
  log: () => {},
});

const { server } = createProxy({ lane: bridge, suffix: "", log: () => {}, usage, dashboard });
const port = await listen(server);
const base = `http://127.0.0.1:${port}`;

const results = [];
const check = async (name, run) => {
  try {
    await run();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
};

const turn = (model) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hello" }] }),
  });

await check("catalog exposes plain model ids with real windows", async () => {
  const body = await (await fetch(`${base}/v1/models`)).json();
  assert.equal(body.object, "list");
  assert.deepEqual(
    body.data.map((m) => m.id),
    ["glm-5.3-flash", "glm-5.3"],
  );
  assert.equal(body.data[0].context_window, 320_000);
});

await check("single model lookup resolves the alias", async () => {
  const model = await (await fetch(`${base}/v1/models/glm-5.3-flash`)).json();
  assert.equal(model.id, "glm-5.3-flash");
});

await check("unknown model is a clean 404", async () => {
  const response = await fetch(`${base}/v1/models/nope`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "model_not_found");
});

await check("streaming turn passes through and strips the alias", async () => {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Affinity": "ses-1" },
    body: JSON.stringify({
      model: "glm-5.3-flash",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /hi/);
  assert.match(text, /\[DONE\]/);

  const sent = seen.chat.at(-1);
  assert.equal(sent.model, FREE.id, "upstream must see the bare model id");
  assert.equal(sent.messages[0].role, "system", "a system turn is prepended when none is sent");
  assert.equal(sent.messages[1].content, "hello");

  const headers = Object.fromEntries(
    Object.entries(seen.headers.at(-1)).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]),
  );
  assert.equal(headers["api-key"], "test-key");
  assert.equal(headers["x-deepai-code-theos"], "7");
  assert.match(headers["x-deepai-code-instance"] ?? "<missing>", /^[0-9a-f]{32}$/);
  assert.match(headers["x-deepai-code-machine"] ?? "<missing>", /^[0-9a-f]{64}$/);
  assert.equal(headers["x-session-affinity"], "ses-1");
  assert.equal(
    headers["x-deepai-code-beacon"],
    undefined,
    "the beacon belongs on the liveness ping only",
  );
});

await check("a caller system message is forwarded untouched", async () => {
  const messages = [
    { role: "system", content: "be terse" },
    { role: "user", content: "hello" },
  ];
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3-flash", stream: true, messages }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(seen.chat.at(-1).messages, messages);
});

await check("check-in carries the app's beacon and nonce", async () => {
  const headers = seen.theosHeaders.at(-1);
  assert.equal(seen.checkIns, 1, "reused across turns");
  assert.equal(headers["x-deepai-code-check-in"], undefined, "first ping has no mark yet");
  const parts = String(headers["x-deepai-code-beacon"] ?? "").split(";");
  assert.equal(parts[0], `v=${appVersion()}`);
  assert.match(parts[1] ?? "", /^up=\d+$/);
  assert.equal(parts[2], "pi=1");
  assert.equal(parts[3], "focus=1");
});

await check("free models run concurrently", async () => {
  seen.maxActive = 0;
  await Promise.all([turn("glm-5.3-flash"), turn("glm-5.3-flash"), turn("glm-5.3-flash")]);
  assert.ok(seen.maxActive >= 2, `free turns were serialized (max ${seen.maxActive})`);
});

await check("metered models take one slot at a time", async () => {
  seen.maxActive = 0;
  await Promise.all([turn("glm-5.3"), turn("glm-5.3")]);
  assert.equal(seen.maxActive, 1);
});

await check("a lane refusal reaches the caller verbatim", async () => {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "theos_exhausted", messages: [] }),
  });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "theos_exhausted");
});

await check("a generic refusal re-checks in and retries once", async () => {
  const before = seen.checkIns;
  const response = await turn("busy_elsewhere");
  assert.equal(response.status, 200);
  assert.equal(seen.checkIns, before + 1, "the retry must be backed by a fresh check-in");
  await response.text();
});

await check("a refusal that keeps coming back is passed through", async () => {
  const before = seen.chat.length;
  const response = await turn("always_refused");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_request_error");
  assert.equal(seen.chat.length - before, 2, "exactly one retry, never a loop");
});

await check("models advertise their Theos price", async () => {
  const body = await (await fetch(`${base}/v1/models`)).json();
  const free = body.data.find((model) => model.id === "glm-5.3-flash");
  const paid = body.data.find((model) => model.id === "glm-5.3");
  assert.equal(free.theos_per_request, 0);
  assert.equal(free.metered, false);
  assert.equal(paid.theos_per_request, 3);
  assert.equal(paid.metered, true);
});

await check("the dashboard is served at the root", async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const html = await response.text();
  assert.match(html, /DeepAI Bridge/);
  assert.match(html, /Theos/);
});

await check("dashboard state exposes prices and the live balance", async () => {
  const state = await (await fetch(`${base}/_bridge/state`)).json();
  assert.equal(state.ok, true);
  assert.equal(state.bridge.account, "tester");
  assert.ok(state.theos.balance > 0 && state.theos.balance <= 20);
  assert.equal(state.theos.granted, 20);

  const paid = state.models.find((model) => model.id === "glm-5.3");
  assert.equal(paid.cost, 3);
  assert.equal(paid.price, "3 Theos");
  assert.equal(paid.alias, "glm-5.3");

  const free = state.models.find((model) => model.id === "glm-5.3-flash");
  assert.equal(free.metered, false);
  assert.equal(free.price, "free");

  assert.equal(state.counts.total, 2);
  assert.equal(state.counts.metered, 1);
  assert.equal(typeof state.autostart.supported, "boolean");
});

await check("a metered turn draws down the Theos meter", async () => {
  const before = (await (await fetch(`${base}/_bridge/state`)).json()).theos.balance;
  const response = await turn("glm-5.3");
  assert.equal(response.status, 200);
  await response.text();

  // The balance is re-read from the lane after the turn, so it lands a moment later.
  let state;
  for (let i = 0; i < 40; i += 1) {
    state = await (await fetch(`${base}/_bridge/state`)).json();
    if (state.theos.balance === before - 3) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(state.theos.balance, before - 3);
  assert.equal(state.theos.used, 20 - state.theos.balance, "used is derived from the lane's own grant");
  assert.equal(state.usage.events[0].model, "glm-5.3");
  assert.equal(state.usage.events[0].cost, 3, "the advertised price is recorded");
  assert.equal(state.usage.events[0].theos, undefined, "no invented charge is stored");
});

await check("a free turn does not touch the meter", async () => {
  const before = (await (await fetch(`${base}/_bridge/state`)).json()).theos.balance;
  const response = await turn("glm-5.3-flash");
  assert.equal(response.status, 200);
  await response.text();
  const after = (await (await fetch(`${base}/_bridge/state`)).json()).theos.balance;
  assert.equal(after, before);
});

await check("the control plane needs its own header", async () => {
  const response = await fetch(`${base}/_bridge/shutdown`, { method: "POST" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "forbidden");
});

await check("the control plane refuses another origin", async () => {
  const response = await fetch(`${base}/_bridge/state`, {
    headers: { Origin: "http://evil.example" },
  });
  assert.equal(response.status, 403);
});

await check("a browser origin is refused", async () => {
  const response = await fetch(`${base}/v1/models`, { headers: { Origin: "http://evil.example" } });
  assert.equal(response.status, 403);
});

await check("offline catalog falls back to the bundled model", async () => {
  await new Promise((resolve) => lane.close(resolve));
  const cold = new Lane({ apiKey: "test-key", base: `http://127.0.0.1:${lanePort}` });
  const { server: coldServer, refreshCatalog } = createProxy({ lane: cold, suffix: "", log: () => {} });
  const coldPort = await listen(coldServer);
  const body = await (await fetch(`http://127.0.0.1:${coldPort}/v1/models`)).json();
  assert.deepEqual(
    body.data.map((m) => m.id),
    ["glm-5.3-flash"],
    "offline fallback should still advertise the bundled model",
  );
  coldServer.close();
});

server.close();
console.log(results.join("\n"));
console.log(process.exitCode ? "\nsome checks failed" : "\nall checks passed");
