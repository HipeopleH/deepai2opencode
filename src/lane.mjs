import { randomBytes } from "node:crypto";
import {
  CAPACITY_RETRY_MAX_MS,
  CAPACITY_RETRY_MIN_MS,
  CONTROL_ORIGIN,
  IDLE_TIMEOUT_MS,
  LANE_VERSION,
  MODEL_PREFIX,
  TOTAL_TIMEOUT_MS,
} from "./config.mjs";
import { machineHeader } from "./machine.mjs";
import { appVersion } from "./version.mjs";

const JSON_TIMEOUT_MS = 30_000;

/** Upstream refusal carrying status + parsed body, so the proxy can reshape it. */
export class LaneError extends Error {
  constructor(status, body, code) {
    super(body?.error?.message ?? `DeepAI request failed (${status}).`);
    this.name = "LaneError";
    this.status = status;
    this.body = body;
    this.code = code ?? body?.error?.code ?? `http_${status}`;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    if (signal?.aborted) return cancel();
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

/** Two-stage deadline: silence ceiling plus wall-clock ceiling. */
function watchdog(outerSignal) {
  const controller = new AbortController();
  const signal = outerSignal
    ? AbortSignal.any([outerSignal, controller.signal])
    : controller.signal;

  let idle = null;
  let total = null;
  let closed = false;

  const arm = () => {
    if (closed) return;
    clearTimeout(idle);
    idle = setTimeout(
      () => controller.abort(new Error("watchdog_idle")),
      IDLE_TIMEOUT_MS,
    );
  };

  arm();
  total = setTimeout(
    () => controller.abort(new Error("watchdog_total")),
    TOTAL_TIMEOUT_MS,
  );

  return {
    signal,
    touch: arm,
    dispose() {
      closed = true;
      clearTimeout(idle);
      clearTimeout(total);
    },
  };
}

async function readJson(response) {
  return response.json().catch(() => undefined);
}

/** The lane reports the Theos grant on every liveness ping. */
function parseTheos(body) {
  if (!body || typeof body !== "object") return null;
  const balance = Number(body.balance);
  if (!Number.isFinite(balance)) return null;
  const granted = Number(body.granted);
  return {
    balance,
    granted: Number.isFinite(granted) ? granted : null,
    refreshAt: typeof body.refresh_at === "string" ? body.refresh_at : null,
    enabled: body.enabled === true,
    fetchedAt: Date.now(),
  };
}

export class Lane {
  #base;
  #apiKey;
  #instance = randomBytes(16).toString("hex");
  #machine = {};
  #checkIn = null; // { nonce, seconds, at }
  #theos = null; // { balance, granted, refreshAt, enabled, fetchedAt }
  #settleAt = 0;
  #legacyUntil = 0;
  #checkInFlight = null;
  #catalog = null;
  #catalogAt = 0;

  constructor({ apiKey, base = CONTROL_ORIGIN }) {
    if (!apiKey) throw new Error("Missing DeepAI api key.");
    this.#apiKey = apiKey;
    this.#base = base.replace(/\/+$/, "");
  }

  get base() {
    return this.#base;
  }

  async init() {
    this.#machine = await machineHeader();
    await this.ensureCheckIn().catch(() => {});
    return this;
  }

  #laneHeaders() {
    return {
      "X-DeepAI-Code-Theos": LANE_VERSION,
      "X-DeepAI-Code-Instance": this.#instance,
    };
  }

  #beacon() {
    const parts = [
      `v=${appVersion()}`,
      `up=${Math.floor(process.uptime())}`,
      "pi=1",
      "focus=1",
    ];
    return { "X-DeepAI-Code-Beacon": parts.join(";") };
  }

  #checkInHeaders() {
    return {
      ...(this.#checkIn
        ? { "X-DeepAI-Code-Check-In": this.#checkIn.nonce }
        : {}),
      ...this.#beacon(),
    };
  }

  #url(path) {
    return `${this.#base}${MODEL_PREFIX}${path}`;
  }

  /** Single-flight liveness ping. The lane refuses inference without a fresh mark. */
  async ensureCheckIn() {
    if (this.#checkIn) {
      const age = Date.now() - this.#checkIn.at;
      if (age < (this.#checkIn.seconds * 1_000) / 2) return this.#checkIn;
    } else if (Date.now() < this.#legacyUntil) {
      return null;
    }
    return this.#checkInOnce();
  }

  #checkInOnce() {
    this.#checkInFlight ??= this.#doCheckIn().finally(() => {
      this.#checkInFlight = null;
    });
    return this.#checkInFlight;
  }

  async #doCheckIn() {
    const watch = watchdog();
    let response;
    let body;
    try {
      response = await fetch(this.#url("/theos"), {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          ...this.#laneHeaders(),
          ...this.#machine,
          ...this.#checkInHeaders(),
          "api-key": this.#apiKey,
        },
        redirect: "error",
        signal: watch.signal,
      });
      body = await readJson(response);
    } finally {
      watch.dispose();
    }

    const mark = body?.check_in;

    const theos = parseTheos(body);
    if (theos) this.#theos = theos;

    if (
      mark &&
      typeof mark.nonce === "string" &&
      /^[0-9a-f]{32}$/.test(mark.nonce) &&
      typeof mark.seconds === "number" &&
      mark.seconds > 0
    ) {
      this.#checkIn = { nonce: mark.nonce, seconds: mark.seconds, at: Date.now() };
      return this.#checkIn;
    }

    if (response.ok) {
      // Older lane answers without a mark; the client backs off for 30s then.
      this.#legacyUntil = Date.now() + 30_000;
      return null;
    }

    throw new LaneError(response.status, body);
  }

  async catalog(force = false) {
    const fresh = Date.now() - this.#catalogAt < 600_000;
    if (this.#catalog && fresh && !force) return this.#catalog;

    const watch = watchdog();
    try {
      const response = await fetch(this.#url("/models"), {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          ...this.#laneHeaders(),
          ...this.#machine,
          "api-key": this.#apiKey,
        },
        redirect: "error",
        signal: AbortSignal.any([watch.signal, AbortSignal.timeout(JSON_TIMEOUT_MS)]),
      });
      const body = await readJson(response);
      if (!response.ok) throw new LaneError(response.status, body);

      const list = body?.models;
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error("Empty model catalog.");
      }

      this.#catalog = list
        .filter((m) => m && typeof m.id === "string")
        .map((m) => ({
          id: m.id,
          name: typeof m.name === "string" && m.name ? m.name : m.id,
          reasoning: m.reasoning === true,
          input: Array.isArray(m.input) ? m.input : ["text"],
          contextWindow: Number.isSafeInteger(m.contextWindow) ? m.contextWindow : 200_000,
          maxTokens: Number.isSafeInteger(m.maxTokens) ? m.maxTokens : 32_768,
          api: m.api,
          premier: m.premier === true,
          theosPerRequest: typeof m.theosPerRequest === "string" ? m.theosPerRequest : undefined,
        }));
      this.#catalogAt = Date.now();
      return this.#catalog;
    } finally {
      watch.dispose();
    }
  }

  /** Whether a turn spends Theos. Unknown models count as metered, as in the client. */
  metered(id) {
    const entry = this.#catalog?.find((model) => model.id === id);
    if (!entry) return true;
    if (entry.theosPerRequest !== undefined) {
      return /^\d+(\.\d+)?$/.test(entry.theosPerRequest)
        ? /[1-9]/.test(entry.theosPerRequest)
        : entry.premier;
    }
    return entry.premier;
  }

  /** Latest Theos snapshot, refreshed on every liveness ping. */
  get theos() {
    return this.#theos;
  }

  /** Theos spent by one turn, 0 for free models, null when the price is unknown. */
  cost(id) {
    const entry = this.#catalog?.find((model) => model.id === id);
    if (!entry) return null;
    if (!this.metered(id)) return 0;
    const value = Number(entry.theosPerRequest);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /**
   * Re-read the true balance after a metered turn. The catalog's
   * `theosPerRequest` is an admission gauge, not the amount charged: the lane
   * bills a small per-token sum, so guessing it locally would be wrong.
   * Rate-limited so an active session still pings at a sane cadence.
   */
  async settle(id) {
    const min = Number(process.env.BRIDGE_SETTLE_MS ?? 60_000);
    if (this.#settleAt && Date.now() - this.#settleAt < min) return null;
    const previous = this.#theos?.balance ?? null;
    if (previous === null) return null;

    this.#settleAt = Date.now();
    try {
      await this.#checkInOnce();
    } catch {
      return null;
    }
    if (!this.#theos) return null;

    const delta = previous - this.#theos.balance;
    return delta > 0 ? { model: id, theos: delta } : null;
  }

  /** Force a balance read. Rate-limited because it is a real lane ping. */
  async refreshTheos({ minIntervalMs = 20_000 } = {}) {
    if (this.#theos && Date.now() - this.#theos.fetchedAt < minIntervalMs) {
      return this.#theos;
    }
    await this.#checkInOnce();
    return this.#theos;
  }

  /**
   * Inference call. Returns a live fetch Response; the caller owns the body and
   * must call `dispose` when done so the watchdog timers stop.
   */
  async open(path, { body, signal, affinity }) {
    let rechecked = false;
    for (;;) {
      signal?.throwIfAborted?.();
      // The lane can age out the mark mid-session, so renew before every attempt.
      await this.ensureCheckIn();
      const watch = watchdog(signal);
      let response;

      try {
        response = await fetch(this.#url(path), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.#laneHeaders(),
            ...this.#machine,
            "api-key": this.#apiKey,
            ...(affinity && /^[A-Za-z0-9._:-]{1,256}$/.test(affinity)
              ? { "X-Session-Affinity": affinity }
              : {}),
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: watch.signal,
        });
      } catch (error) {
        watch.dispose();
        throw error;
      }

      // 409 session_busy is an admission refusal, not a model run: back off and
      // retry until the wall-clock deadline, exactly like the shipped client.
      if (response.status === 409) {
        let refusal;
        try {
          refusal = await response.clone().json();
        } catch {
          refusal = undefined;
        }
        if (refusal?.error?.code === "session_busy") {
          watch.dispose();
          await response.body?.cancel().catch(() => {});
          const retry = Number(response.headers.get("retry-after") ?? 2);
          const wait = Number.isFinite(retry)
            ? Math.min(CAPACITY_RETRY_MAX_MS, Math.max(CAPACITY_RETRY_MIN_MS, retry * 1_000))
            : 2_000;
          await sleep(wait, signal);
          continue;
        }
      }

      // "This request cannot be accepted." is what the lane says when another
      // client on the same account holds the active instance. Re-check in once,
      // which makes this process the current one, then try again.
      if (response.status === 400 && !rechecked) {
        const refusal = await response.clone().json().catch(() => undefined);
        const message = refusal?.error?.message ?? "";
        if (refusal?.error?.code === "invalid_request_error" && /cannot be accepted/i.test(message)) {
          rechecked = true;
          watch.dispose();
          await response.body?.cancel().catch(() => {});
          this.#checkIn = null;
          await sleep(1_000, signal);
          continue;
        }
      }

      return { response, touch: watch.touch, dispose: watch.dispose };
    }
  }

  /** Convenience wrapper for non-streaming JSON paths. */
  async json(path, { body, signal }) {
    const { response, dispose } = await this.open(path, { body, signal });
    try {
      const payload = await readJson(response);
      if (!response.ok) throw new LaneError(response.status, payload);
      return payload;
    } finally {
      dispose();
    }
  }
}
