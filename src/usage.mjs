/**
 * In-memory activity ledger for the dashboard. Nothing here is persisted: the
 * numbers are for the running process, and the authoritative Theos balance
 * always comes from the lane.
 *
 * `cost` is the price the catalog advertises for a model. It is a gauge, not
 * the amount the lane deducts, so it is never summed into the balance.
 */
export function createUsage({ limit = 80 } = {}) {
  const startedAt = Date.now();
  const events = [];
  const perModel = new Map();
  const inFlight = new Map();
  let nextTicket = 1;

  let turns = 0;
  let failures = 0;

  /** Reserve a row in "running now" so the GUI can show live activity. */
  function begin(info) {
    const ticket = nextTicket++;
    inFlight.set(ticket, { ...info, startedAt: Date.now() });
    return ticket;
  }

  function end(ticket, { status = 0, error } = {}) {
    const started = inFlight.get(ticket);
    if (!started) return;
    inFlight.delete(ticket);

    const finishedAt = Date.now();
    const ok = status >= 200 && status < 400;
    if (!ok) failures += 1;
    turns += 1;

    const bucket = perModel.get(started.real) ?? {
      model: started.real,
      alias: started.model,
      turns: 0,
      ms: 0,
    };
    bucket.turns += 1;
    bucket.ms += finishedAt - started.startedAt;
    perModel.set(started.real, bucket);

    events.unshift({
      at: finishedAt,
      model: started.model,
      real: started.real,
      status,
      ok,
      metered: started.metered,
      cost: started.cost ?? null,
      ms: finishedAt - started.startedAt,
      ...(error ? { error } : {}),
    });
    if (events.length > limit) events.length = limit;
  }

  function snapshot() {
    return {
      startedAt,
      turns,
      failures,
      running: [...inFlight.values()],
      perModel: [...perModel.values()].sort((a, b) => b.turns - a.turns),
      events,
    };
  }

  return { begin, end, snapshot };
}
