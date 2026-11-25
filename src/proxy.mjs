import http from "node:http";
import { MAX_BODY_BYTES, BUNDLED_MODELS } from "./config.mjs";
import { LaneError } from "./lane.mjs";
import { isUiPath } from "./dashboard.mjs";

const OPENAI_ERROR_TYPES = {
  auth_required: "authentication_error",
  social_login_required: "authentication_error",
  email_unverified: "authentication_error",
  check_in_refused: "permission_error",
  machine_required: "permission_error",
  machine_bound: "permission_error",
  network_bound: "permission_error",
  theos_exhausted: "insufficient_quota",
  theos_insufficient: "insufficient_quota",
  pro_required: "permission_error",
  rate_limit_exceeded: "rate_limit_error",
};

function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendError(res, status, message, code, type) {
  sendJson(res, status, {
    error: {
      message,
      type: type ?? OPENAI_ERROR_TYPES[code] ?? (status >= 500 ? "api_error" : "invalid_request_error"),
      code: code ?? (status >= 500 ? "upstream_error" : "invalid_request"),
    },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** One metered turn at a time, FIFO — mirrors the shipped client's admission. */
function createSlot() {
  let tail = Promise.resolve();
  return async (task) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

export function createProxy({ lane, suffix, log, usage, dashboard }) {
  const slot = createSlot();
  let lastCatalog = null;

  const stripPrefix = (id) => String(id ?? "").replace(/^deepai\//, "");

  const toReal = (id) => {
    let value = stripPrefix(id);
    if (suffix && value.endsWith(suffix)) value = value.slice(0, -suffix.length);
    return value;
  };

  const toAlias = (real) => (suffix ? `${real}${suffix}` : real);

  async function listModels() {
    try {
      const catalog = await lane.catalog();
      if (catalog?.length) lastCatalog = catalog;
      return lastCatalog;
    } catch (error) {
      log?.(`catalog unavailable: ${error.message}`);
      // Keep serving the last good inventory so OpenCode does not lose models.
      return lastCatalog ?? BUNDLED_MODELS;
    }
  }

  function modelEntry(model, now) {
    const cost = lane.cost(model.id);
    return {
      id: toAlias(model.id),
      object: "model",
      created: now,
      owned_by: "deepai",
      name: model.name,
      context_window: model.contextWindow,
      max_output_tokens: model.maxTokens,
      // Extra, non-standard fields: harmless to OpenAI clients, useful to ours.
      theos_per_request: cost ?? 0,
      metered: lane.metered(model.id),
    };
  }

  async function handleModels(res) {
    const catalog = await listModels();
    const now = Math.floor(Date.now() / 1000);
    sendJson(res, 200, {
      object: "list",
      data: (catalog ?? []).map((model) => modelEntry(model, now)),
    });
  }

  async function handleModel(res, requested) {
    const catalog = await listModels();
    const id = toReal(requested);
    const model = (catalog ?? []).find((entry) => entry.id === id);
    if (!model) {
      sendError(res, 404, `Unknown model: ${requested}`, "model_not_found");
      return;
    }
    sendJson(res, 200, modelEntry(model, Math.floor(Date.now() / 1000)));
  }

  async function handleInference(req, res, kind) {
    let payload;
    try {
      const raw = await readBody(req);
      payload = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      sendError(res, error.status ?? 400, "Invalid JSON request body.", "invalid_request");
      return;
    }

    if (!payload || typeof payload !== "object" || typeof payload.model !== "string") {
      sendError(res, 400, "Request must include a model.", "invalid_request");
      return;
    }

    const real = toReal(payload.model);
    if (!real) {
      sendError(res, 400, "Request must include a model.", "invalid_request");
      return;
    }

    const body = { ...payload, model: real };

    // The lane refuses any turn without a system message ("This request cannot
    // be accepted"), even when the turn is otherwise well formed. Clients that
    // send their own system message are forwarded untouched; only a turn with
    // no system role at all gets a neutral one prepended.
    if (Array.isArray(body.messages)) {
      const hasSystem = body.messages.some(
        (message) => message && (message.role === "system" || message.role === "developer"),
      );
      if (!hasSystem) {
        body.messages = [
          { role: "system", content: "You are a helpful assistant." },
          ...body.messages,
        ];
      }
    }

    // Prefer an explicit affinity header; otherwise reuse the prompt cache key,
    // which is stable per session and already validated by the lane.
    const affinity =
      req.headers["x-session-affinity"] ??
      (typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined);

    const controller = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    const path = kind === "responses" ? "/responses" : "/chat/completions";
    // Free-tier turns are unlimited upstream; only metered ones share the slot.
    const metered = lane.metered(real);
    const cost = lane.cost(real);

    const ticket = usage?.begin({ model: payload.model, real, metered, cost });
    let status = 0;

    const run = async () => {
      const { response, touch, dispose } = await lane.open(path, {
        body,
        signal: controller.signal,
        affinity,
      });

      status = response.status;

      try {
        const contentType =
          response.headers.get("content-type") ??
          (body.stream ? "text/event-stream; charset=utf-8" : "application/json");

        res.writeHead(response.status, {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          ...(response.headers.has("retry-after")
            ? { "Retry-After": response.headers.get("retry-after") }
            : {}),
        });

        if (!response.body) {
          res.end();
          return;
        }

        // Refusals and successes both stream through untouched, so the caller
        // sees exactly what the lane said.
        for await (const chunk of response.body) {
          touch();
          if (controller.signal.aborted) break;
          if (!res.write(chunk)) {
            await new Promise((resolve) => {
              const done = () => {
                res.off("drain", done);
                res.off("close", done);
                resolve();
              };
              res.once("drain", done);
              res.once("close", done);
            });
          }
        }

        if (!controller.signal.aborted) res.end();
        else res.destroy();
      } finally {
        dispose();
      }
    };

    try {
      if (metered) await slot(run);
      else await run();
    } catch (error) {
      status = error?.status ?? 502;
      if (controller.signal.aborted || res.writableEnded) return;

      if (error instanceof LaneError) {
        sendError(res, error.status, error.message, error.code);
        return;
      }

      sendError(res, status, error?.message ?? "DeepAI request failed.", "upstream_error");
    } finally {
      usage?.end(ticket, { status });

      // Refresh the meter after a metered turn. Fire and forget: accounting must
      // never delay or fail the response.
      if (status >= 200 && status < 400 && metered) {
        lane.settle(real).catch(() => {});
      }
    }
  }

  const sameOrigin = (origin, host) => {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathName = url.pathname.replace(/\/+$/, "") || "/";

    // A browser page must not be able to drive the inference routes; only native
    // clients reach those. The control UI is the single exception, and only
    // from its own origin. Same rule the shipped transport applies to inference.
    const origin = req.headers.origin;
    const ui = isUiPath(pathName);
    if (origin && !(ui && sameOrigin(origin, req.headers.host))) {
      sendError(res, 403, "Model transport is not available to browsers.", "forbidden");
      return;
    }

    if (ui && dashboard) {
      dashboard.handle(req, res, pathName, url).catch((error) => {
        sendError(res, 500, error?.message ?? "Dashboard failed.", "dashboard_error");
      });
      return;
    }

    if (req.method === "GET" && (pathName === "/health" || pathName === "/v1/health")) {
      sendJson(res, 200, { ok: true, lane: lane.base });
      return;
    }

    if (req.method === "GET" && (pathName === "/v1/models" || pathName === "/models")) {
      handleModels(res).catch((error) => {
        sendError(res, 502, error.message, "catalog_unavailable");
      });
      return;
    }

    const modelMatch = /^\/v1\/models\/(.+)$/.exec(pathName);
    if (req.method === "GET" && modelMatch) {
      handleModel(res, decodeURIComponent(modelMatch[1])).catch((error) => {
        sendError(res, 502, error.message, "catalog_unavailable");
      });
      return;
    }

    if (req.method === "POST" && (pathName === "/v1/chat/completions" || pathName === "/chat/completions")) {
      handleInference(req, res, "chat").catch((error) => {
        sendError(res, 502, error.message, "upstream_error");
      });
      return;
    }

    if (req.method === "POST" && (pathName === "/v1/responses" || pathName === "/responses")) {
      handleInference(req, res, "responses").catch((error) => {
        sendError(res, 502, error.message, "upstream_error");
      });
      return;
    }

    sendError(res, 404, `Unsupported route: ${req.method} ${pathName}`, "not_found");
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  return { server, toAlias, toReal, refreshCatalog: listModels };
}
