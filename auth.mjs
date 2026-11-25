import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { CONTROL_ORIGIN, MODEL_PREFIX } from "./src/config.mjs";
import { secretDir, secretPath } from "./src/paths.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

function openBrowser(url) {
  const command =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(command[0], command[1], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

const state = randomBytes(32).toString("hex");
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/auth-callback") {
    res.writeHead(404).end("Not found.");
    return;
  }

  const code = url.searchParams.get("code");
  const returned = url.searchParams.get("state");
  if (req.method !== "GET" || !code || !returned || !same(returned, state)) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid sign-in callback.");
    return;
  }

  (async () => {
    const response = await fetch(`${CONTROL_ORIGIN}${MODEL_PREFIX}/desktop_auth/exchange/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier }),
      redirect: "error",
    });
    const payload = await response.json().catch(() => undefined);

    if (!response.ok || typeof payload?.api_key !== "string" || !payload.api_key) {
      res
        .writeHead(400, { "Content-Type": "text/plain" })
        .end("DeepAI rejected the sign-in. Start it again.");
      console.error("exchange failed:", response.status, payload);
      server.close();
      process.exitCode = 1;
      return;
    }

    const file = secretPath();
    mkdirSync(secretDir(), { recursive: true, mode: 0o700 });
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          apiKey: payload.api_key,
          username: typeof payload.username === "string" ? payload.username : "",
          isPro: payload.is_pro === true,
          savedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end("<h2>Signed in to DeepAI</h2><p>You can close this tab.</p>");

    console.log(
      `signed in${payload.username ? ` as ${payload.username}` : ""}${payload.is_pro ? " (pro)" : ""}`,
    );
    console.log(`key saved to ${file}`);
    server.close();
  })().catch((error) => {
    console.error("sign-in failed:", error?.message ?? error);
    server.close();
    process.exitCode = 1;
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const url = new URL(`${CONTROL_ORIGIN}${MODEL_PREFIX}/desktop_auth/`);
  url.search = new URLSearchParams({
    state,
    port: String(port),
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  console.log("open this to authorize:");
  console.log(url.href);
  openBrowser(url.href);
});
