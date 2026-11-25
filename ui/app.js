const $ = (id) => document.getElementById(id);

const ui = {
  state: null,
  filter: "all",
  search: "",
  misses: 0,
  stopped: false,
};

const fmtNum = (value) => {
  if (value === null || value === undefined) return "—";
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
};

const fmtCtx = (value) => {
  if (!value) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
};

const fmtUptime = (seconds) => {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour12: false });

const fmtAge = (seconds) => {
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
};

function toast(message, bad = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("bad", bad);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  toast(`Copied ${text}`);
}

function control(method, path, body) {
  return fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Control": "1",
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
    return payload;
  });
}

function setStatus(online) {
  const pill = $("status-pill");
  pill.classList.toggle("off", !online);
  $("status-text").textContent = online ? "Online" : "Offline";
}

function renderBridge(state) {
  const bridge = state.bridge;
  $("subtitle").textContent = `${bridge.account ?? "unknown account"} · ${bridge.plan} plan · port ${bridge.port}`;
  const link = $("bridge-url");
  link.textContent = bridge.url;
  link.href = bridge.url;
  $("api-base").textContent = bridge.apiBase;
  $("uptime").textContent = fmtUptime(bridge.uptimeSeconds);
  $("version").textContent = `${bridge.version} (${bridge.versionSource})`;
  $("account").textContent = bridge.account ?? "—";
  $("default-model").textContent = bridge.defaultModel ?? "—";
  $("key-hint").textContent = bridge.keyFile ? `Key: ${bridge.keyFile}` : "";
  $("key-hint").title = bridge.keyFile ?? "";
  $("log-path").textContent = bridge.logFile ? `Log: ${bridge.logFile}` : "";
  $("log-path").title = bridge.logFile ?? "";
}

function renderTheos(state) {
  const theos = state.theos;
  if (!theos) {
    $("theos-balance").textContent = "—";
    $("theos-granted").textContent = "No grant reported by the lane";
    $("theos-tag").textContent = "unknown";
    $("theos-bar").style.width = "0%";
    return;
  }

  $("theos-balance").textContent = fmtNum(theos.balance);
  $("theos-granted").textContent = theos.granted ? `of ${fmtNum(theos.granted)} granted today` : "";
  $("theos-tag").textContent = theos.enabled ? "active" : "disabled";
  const fraction = theos.fraction ?? (theos.granted ? theos.balance / theos.granted : 0);
  $("theos-bar").style.width = `${Math.max(0, Math.min(100, fraction * 100))}%`;
  $("theos-used").textContent = theos.used === null || theos.used === undefined ? "—" : fmtNum(theos.used);
  $("theos-reset").textContent = theos.refreshAt ? new Date(theos.refreshAt).toLocaleString() : "—";
  $("theos-age").textContent = `at ${fmtAge(theos.ageSeconds)}`;
}

function renderActivity(state) {
  const usage = state.usage;
  $("stat-turns").textContent = usage.turns;
  $("stat-failures").textContent = usage.failures;
  $("stat-running").textContent = usage.running.length;

  const running = $("running-list");
  running.textContent = "";
  for (const item of usage.running) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span class="spinner"></span><span>${item.model}</span>`;
    running.append(row);
  }

  const c = state.counts;
  $("counts").textContent = `${c.total} total · ${c.free} free · ${c.metered} paid`;
  $("autostart-state").textContent = state.autostart.enabled ? "enabled" : "off";
}

function renderAutostart(state) {
  const toggle = $("autostart");
  toggle.checked = state.autostart.enabled;
  toggle.disabled = !state.autostart.supported;
  $("autostart-path").textContent = state.autostart.supported
    ? state.autostart.command ?? "No logon entry yet."
    : "Only supported on Windows.";
}

function renderModels(state) {
  const balance = state.theos?.balance ?? null;
  const body = $("models");
  body.textContent = "";

  const term = ui.search.trim().toLowerCase();
  const rows = state.models.filter((model) => {
    if (ui.filter === "free" && model.metered) return false;
    if (ui.filter === "paid" && !model.metered) return false;
    if (!term) return true;
    return `${model.alias} ${model.id} ${model.name}`.toLowerCase().includes(term);
  });

  $("model-count").textContent = `${rows.length}/${state.models.length}`;

  for (const model of rows) {
    const tr = document.createElement("tr");
    const affordable = !model.metered || balance === null || (model.cost ?? 0) <= balance;
    if (!affordable) tr.style.opacity = "0.5";

    const id = document.createElement("td");
    id.className = "id";
    id.textContent = model.alias;
    id.title = "Click to copy";
    id.addEventListener("click", () => copy(model.alias));

    const name = document.createElement("td");
    name.className = "name";
    name.textContent = model.name;

    const cost = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge ${model.metered ? "paid" : "free"}`;
    badge.textContent = model.metered ? (model.cost === null ? "metered" : `${fmtNum(model.cost)} Theos`) : "free";
    cost.append(badge);

    const ctx = document.createElement("td");
    ctx.className = "num";
    ctx.textContent = fmtCtx(model.context);

    const type = document.createElement("td");
    type.className = "num";
    type.textContent = model.reasoning ? "reasoning" : "—";

    tr.append(id, name, cost, ctx, type);
    body.append(tr);
  }
}

function renderEvents(state) {
  const body = $("events");
  body.textContent = "";
  const events = state.usage.events;
  $("log-count").textContent = String(events.length);
  $("events-empty").hidden = events.length > 0;

  for (const event of events) {
    const tr = document.createElement("tr");

    const time = document.createElement("td");
    time.className = "num";
    time.textContent = fmtClock(event.at);

    const model = document.createElement("td");
    model.className = "id";
    model.textContent = event.model;

    const status = document.createElement("td");
    const badge = document.createElement("span");
    const ok = event.ok;
    badge.className = `status ${ok ? "ok" : event.status === 429 ? "warn" : "bad"}`;
    badge.textContent = event.status || "err";
    status.append(badge);

    const price = document.createElement("td");
    price.className = "num";
    if (event.metered) {
      const badge = document.createElement("span");
      badge.className = "badge paid";
      badge.textContent = event.cost === null ? "metered" : `${fmtNum(event.cost)} Theos`;
      price.append(badge);
    } else {
      const badge = document.createElement("span");
      badge.className = "badge free";
      badge.textContent = "free";
      price.append(badge);
    }

    const ms = document.createElement("td");
    ms.className = "num";
    ms.textContent = `${event.ms}ms`;

    tr.append(time, model, status, price, ms);
    if (event.error) tr.title = event.error;
    body.append(tr);
  }
}

function render() {
  const state = ui.state;
  if (!state) return;
  renderBridge(state);
  renderTheos(state);
  renderActivity(state);
  renderAutostart(state);
  renderModels(state);
  renderEvents(state);
}

async function poll() {
  try {
    const response = await fetch("/_bridge/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    ui.state = await response.json();
    ui.misses = 0;
    if (!ui.stopped) $("offline").hidden = true;
    setStatus(true);
    render();
  } catch {
    ui.misses += 1;
    if (ui.misses >= 2) {
      setStatus(false);
      $("offline").hidden = false;
    }
  }
}

$("refresh").addEventListener("click", async () => {
  $("refresh").disabled = true;
  try {
    const state = await control("POST", "/_bridge/refresh");
    ui.state = state;
    render();
    toast("Catalog and balance refreshed");
  } catch (error) {
    toast(error.message, true);
  } finally {
    $("refresh").disabled = false;
  }
});

$("shutdown").addEventListener("click", async () => {
  if (!confirm("Stop the bridge? OpenCode will lose DeepAI models until you start it again.")) return;
  ui.stopped = true;
  try {
    await control("POST", "/_bridge/shutdown");
  } catch {
    /* the reply can race the close */
  }
  setStatus(false);
  $("offline").hidden = false;
});

$("autostart").addEventListener("change", async (event) => {
  const enabled = event.target.checked;
  event.target.disabled = true;
  try {
    const payload = await control("POST", "/_bridge/autostart", { enabled });
    ui.state.autostart = payload.autostart;
    renderAutostart(ui.state);
    toast(enabled ? "Will start with Windows" : "Autostart turned off");
  } catch (error) {
    event.target.checked = !enabled;
    toast(error.message, true);
  } finally {
    event.target.disabled = false;
  }
});

$("search").addEventListener("input", (event) => {
  ui.search = event.target.value;
  if (ui.state) renderModels(ui.state);
});

$("filter").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  ui.filter = button.dataset.filter;
  for (const other of $("filter").querySelectorAll("button")) {
    other.classList.toggle("active", other === button);
  }
  if (ui.state) renderModels(ui.state);
});

$("copy-base").addEventListener("click", () => {
  if (ui.state) copy(ui.state.bridge.apiBase);
});

$("copy-model").addEventListener("click", () => {
  const preferred = ui.state?.models.find((model) => !model.metered && /flash/.test(model.alias));
  copy(preferred?.alias ?? ui.state?.models?.[0]?.alias ?? "glm-5.3-flash");
});

$("retry").addEventListener("click", () => {
  ui.stopped = false;
  poll();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) poll();
});

poll();
setInterval(poll, 2000);
