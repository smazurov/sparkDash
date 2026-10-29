/**
 * Owner of the optional power-meter feature: polls live readings, reconciles them with
 * the meter's own history, persists the result and serves it.
 *
 * Opt-in: without a config file the runtime is inert (no timers, no network, one status
 * route that says so). See docs/POWER-METERS.md.
 *
 * Reconciliation. Live polls (every pollIntervalMs) are integrated into 5-minute buckets
 * marked `live`, so energy appears at once. For meters that keep history, a reconcile
 * pass shortly after every 5-minute boundary fetches the meter's 5-minute statistics and
 * overwrites those buckets with the meter's own figures; once an hour it also fetches
 * hourly statistics. The first pass after start backfills hourly history (back to each
 * unit's `since`, at most history.backfillDays) and catches up any time sparkDash was down.
 */
import { loadPowerMeterConfig } from "./config.js";
import { createProvider } from "./providers/index.js";
import { DAY_MS, FINE_MS, HOUR_MS, POWER_METER_ENERGY_JSON_PATH, PowerMeterStore } from "./store.js";
import { historyPayload, liveSummary, monthlyRollup } from "./contracts.js";
import { registerPowerMeterRoutes } from "./routes.js";

const RECENT_WINDOW_MS = 30_000;
/** A meter clock this far ahead of ours still counts as fresh. */
const CLOCK_SKEW_MS = 60_000;
const RECONCILE_OFFSET_MS = 45_000;
const FLUSH_INTERVAL_MS = 60_000;
const HISTORY_REQUEST_TIMEOUT_MS = 120_000;
const CHUNK_MS = { "5minute": 5 * DAY_MS, hour: 30 * DAY_MS };
/** Steady-state lookback, so periods the meter compiles late are still picked up. */
const LOOKBACK_MS = { "5minute": 6 * HOUR_MS, hour: 2 * DAY_MS };

const floorTo = (ms, step) => Math.floor(ms / step) * step;

function escapeLabel(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function disabledRuntime(result, logger) {
  if (result.status === "invalid") {
    logger.error?.(`[powerMeters] disabled: ${result.error}`);
  } else if (result.status === "disabled") {
    logger.log?.(`[powerMeters] disabled by "enabled": false in ${result.filePath}`);
  }
  const status = () => ({
    enabled: false,
    state: result.status,
    ...(result.error ? { error: result.error } : {}),
  });
  return {
    enabled: false,
    status,
    register(app) {
      registerPowerMeterRoutes(app, { status });
    },
    renderPrometheus: () => "",
    start() {},
    stop() {
      return true;
    },
  };
}

export function createPowerMeterRuntime({
  configResult,
  loadConfig = loadPowerMeterConfig,
  env = process.env,
  energyFilePath = POWER_METER_ENERGY_JSON_PATH,
  listUnits = () => [],
  tokensByHour = () => null,
  now = () => Date.now(),
  createProviderFn = createProvider,
  storeFactory = (options) => new PowerMeterStore(options),
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  logger = console,
} = {}) {
  const result = configResult ?? loadConfig();
  if (result.status !== "ok") return disabledRuntime(result, logger);
  const cfg = result.config;

  const meters = new Map();
  for (const [id, spec] of Object.entries(cfg.meters)) {
    const meter = {
      id,
      type: spec.type,
      provider: null,
      error: null,
      lastOkAt: null,
      lastError: null,
      history: { state: "pending", lastOkAt: null, lastError: null, backfill: null },
    };
    try {
      meter.provider = createProviderFn(spec, { env, logger });
    } catch (error) {
      meter.error = error.message;
      meter.history.state = "unavailable";
      logger.error?.(`[powerMeters] meter ${id} unavailable: ${error.message}`);
    }
    if (meter.provider && (!cfg.history.enabled || typeof meter.provider.readHistory !== "function")) {
      meter.history.state = cfg.history.enabled ? "unsupported" : "off";
    }
    meters.set(id, meter);
  }

  const store = storeFactory({ filePath: energyFilePath, now, logger });
  store.load();
  const units = new Map();
  for (const [id, spec] of Object.entries(cfg.units)) {
    const key = `${spec.meter}|${cfg.meters[spec.meter].type}|${spec.channel}`;
    store.bindUnit(id, key);
    units.set(id, {
      id,
      meterId: spec.meter,
      channel: spec.channel,
      sinceMs: spec.sinceMs,
      key,
      backfillKey: `${key}|since=${spec.sinceMs ?? ""}|days=${cfg.history.backfillDays}`,
      last: null,
      reading: null,
    });
  }
  const unitIds = [...units.keys()];
  let recentFleet = [];
  let polling = false;
  let reconciling = null;
  let caughtUp = false;
  let lastHourlyRun = null;
  let pollTimer = null;
  let reconcileTimer = null;
  let flushTimer = null;
  let stopped = false;
  const lifecycle = new AbortController();
  const warned = new Map();

  const warnChanged = (key, message) => {
    if (warned.get(key) === message) return;
    warned.set(key, message);
    logger.warn?.(`[powerMeters] ${message}`);
  };

  function ingest(unit, reading, atMs) {
    const ageMs = reading.atMs == null ? Infinity : atMs - reading.atMs;
    const fresh =
      Number.isFinite(reading.watts) && ageMs <= cfg.staleAfterMs && ageMs >= -CLOCK_SKEW_MS;
    const last = unit.last;
    if (fresh && last?.fresh && atMs - last.pollAtMs <= cfg.staleAfterMs) {
      // Trapezoid between the two polls; the meter's own record replaces it later.
      store.addLive(unit.id, last.pollAtMs, atMs, (last.watts + reading.watts) / 2);
    }
    unit.last = { pollAtMs: atMs, watts: reading.watts, fresh };
    unit.reading = {
      watts: Number.isFinite(reading.watts) ? reading.watts : null,
      atMs: reading.atMs ?? null,
      fresh,
      error: reading.error ?? (Number.isFinite(reading.watts) && !fresh ? "reading is stale" : null),
      polledAtMs: atMs,
    };
  }

  async function pollOnce() {
    if (polling || stopped) return;
    polling = true;
    try {
      await Promise.all(
        [...meters.values()].map(async (meter) => {
          const meterUnits = [...units.values()].filter((u) => u.meterId === meter.id);
          if (!meterUnits.length) return;
          const channels = meterUnits.map((u) => u.channel);
          let readings;
          if (!meter.provider) {
            readings = new Map(channels.map((c) => [c, { watts: null, atMs: null, error: meter.error }]));
          } else {
            try {
              readings = await meter.provider.readPower(channels, {
                signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(Math.max(1_000, cfg.pollIntervalMs))]),
              });
            } catch (error) {
              readings = new Map(channels.map((c) => [c, { watts: null, atMs: null, error: error.message }]));
            }
          }
          if (stopped) return;
          const atMs = now();
          let firstError = null;
          let ok = 0;
          for (const unit of meterUnits) {
            const reading = readings?.get?.(unit.channel) ?? { watts: null, atMs: null, error: "no reading returned" };
            ingest(unit, reading, atMs);
            if (unit.reading.fresh) ok += 1;
            else firstError ??= `${unit.id}: ${unit.reading.error ?? "no reading"}`;
          }
          if (ok) meter.lastOkAt = atMs;
          meter.lastError = firstError;
          if (firstError) warnChanged(`poll:${meter.id}`, `meter ${meter.id}: ${firstError}`);
          else warned.delete(`poll:${meter.id}`);
        })
      );
      const atMs = now();
      const all = [...units.values()];
      if (all.length && all.every((u) => u.last?.fresh)) {
        recentFleet.push({ atMs, watts: all.reduce((sum, u) => sum + u.last.watts, 0) });
      }
      recentFleet = recentFleet.filter((s) => atMs - s.atMs <= RECENT_WINDOW_MS);
    } finally {
      polling = false;
    }
  }

  async function fetchAndApply(meter, meterUnits, period, fromMs, toMs) {
    const history = await meter.provider.readHistory(
      meterUnits.map((u) => u.channel),
      {
        fromMs,
        toMs,
        period,
        signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(HISTORY_REQUEST_TIMEOUT_MS)]),
      }
    );
    for (const unit of meterUnits) {
      const periods = history?.get?.(unit.channel) ?? [];
      store.applyMeterPeriods(unit.id, periods, { sinceMs: unit.sinceMs });
      let maxEnd = null;
      for (const p of periods) if (maxEnd == null || p.endMs > maxEnd) maxEnd = p.endMs;
      if (maxEnd != null) store.setWatermark(unit.id, period, maxEnd);
    }
  }

  async function fetchRange(meter, meterUnits, period, fromMs, toMs, onChunk) {
    const step = period === "5minute" ? FINE_MS : HOUR_MS;
    for (let a = floorTo(fromMs, step); a < toMs && !stopped; a += CHUNK_MS[period]) {
      const b = Math.min(toMs, a + CHUNK_MS[period]);
      await fetchAndApply(meter, meterUnits, period, a, b);
      onChunk?.(b);
    }
  }

  async function backfill(meter, meterUnits) {
    const pending = meterUnits.filter((u) => !store.backfillDone(u.id, u.backfillKey));
    if (!pending.length) return;
    const t = now();
    const oldest = t - cfg.history.backfillDays * DAY_MS;
    const fromMs = floorTo(Math.max(oldest, Math.min(...pending.map((u) => u.sinceMs ?? oldest))), HOUR_MS);
    const periods = meter.provider.historyPeriods ?? ["hour"];
    meter.history.state = "backfilling";
    meter.history.backfill = { fromMs, throughMs: fromMs, startedAt: t };
    logger.log?.(
      `[powerMeters] backfilling ${pending.map((u) => u.id).join(", ")} from meter ${meter.id} since ${new Date(fromMs).toISOString()}`
    );
    if (periods.includes("hour")) {
      await fetchRange(meter, pending, "hour", fromMs, t, (through) => {
        meter.history.backfill.throughMs = through;
      });
    }
    if (periods.includes("5minute")) {
      await fetchRange(meter, pending, "5minute", Math.max(fromMs, t - store.fineRetentionMs), t);
    }
    if (stopped) return;
    for (const unit of pending) store.markBackfilled(unit.id, unit.backfillKey);
    meter.history.backfill = { ...meter.history.backfill, throughMs: t, doneAt: now() };
    flushSafe();
  }

  async function catchUp(meter, meterUnits, period, { initial }) {
    if (!(meter.provider.historyPeriods ?? ["hour"]).includes(period)) return;
    const t = now();
    const oldest = period === "5minute" ? t - store.fineRetentionMs : t - cfg.history.backfillDays * DAY_MS;
    const lookbackFrom = t - LOOKBACK_MS[period];
    let fromMs = lookbackFrom;
    for (const unit of meterUnits) {
      const mark = store.watermark(unit.id, period);
      if (mark != null && mark < fromMs) fromMs = initial ? mark : Math.max(mark, lookbackFrom);
    }
    await fetchRange(meter, meterUnits, period, Math.max(fromMs, oldest), t);
  }

  async function reconcileMeter(meter) {
    const meterUnits = [...units.values()].filter((u) => u.meterId === meter.id);
    if (!meterUnits.length) return;
    try {
      await backfill(meter, meterUnits);
      const initial = !caughtUp;
      await catchUp(meter, meterUnits, "5minute", { initial });
      const hour = floorTo(now(), HOUR_MS);
      if (initial || lastHourlyRun !== hour) await catchUp(meter, meterUnits, "hour", { initial });
      meter.history.state = "ok";
      meter.history.lastOkAt = now();
      meter.history.lastError = null;
      warned.delete(`history:${meter.id}`);
    } catch (error) {
      if (stopped) return;
      meter.history.state = "error";
      meter.history.lastError = error.message;
      warnChanged(`history:${meter.id}`, `history from meter ${meter.id} failed: ${error.message}`);
    }
  }

  function reconcileOnce() {
    if (stopped || !cfg.history.enabled) return Promise.resolve();
    if (reconciling) return reconciling;
    reconciling = (async () => {
      try {
        const eligible = [...meters.values()].filter((m) => typeof m.provider?.readHistory === "function");
        for (const meter of eligible) await reconcileMeter(meter);
        lastHourlyRun = floorTo(now(), HOUR_MS);
        caughtUp = true;
      } finally {
        reconciling = null;
      }
    })();
    return reconciling;
  }

  function flushSafe() {
    try {
      store.prune(now());
      store.flush();
      return true;
    } catch (error) {
      logger.error?.(`[powerMeters] could not save ${energyFilePath}: ${error.message}`);
      return false;
    }
  }

  function scheduleReconcile() {
    if (stopped) return;
    const t = now();
    const delay = floorTo(t, FINE_MS) + FINE_MS + RECONCILE_OFFSET_MS - t;
    reconcileTimer = timers.setTimeout(() => {
      reconcileOnce().finally(scheduleReconcile);
    }, delay);
    reconcileTimer?.unref?.();
  }

  const namesById = () => new Map((listUnits() ?? []).map((u) => [u.id, u.name ?? u.id]));

  function unitsStatus() {
    const names = namesById();
    return [...units.values()].map((u) => ({
      id: u.id,
      name: names.get(u.id) ?? u.id,
      known: names.has(u.id),
      meter: u.meterId,
      channel: u.channel,
      sinceMs: u.sinceMs,
      watts: u.reading?.watts ?? null,
      atMs: u.reading?.atMs ?? null,
      fresh: u.reading?.fresh === true,
      error: u.reading?.error ?? null,
      polledAtMs: u.reading?.polledAtMs ?? null,
      reconciledThroughMs: store.watermark(u.id, "5minute"),
    }));
  }

  function metersStatus() {
    return [...meters.values()].map((m) => ({
      id: m.id,
      type: m.type,
      target: m.provider?.describe?.().target ?? null,
      ok: !m.error && m.lastOkAt != null && !m.lastError,
      error: m.error ?? m.lastError,
      lastOkAt: m.lastOkAt,
      history: { ...m.history },
    }));
  }

  const tokens = () => {
    try {
      return tokensByHour();
    } catch {
      return null;
    }
  };

  const status = () => ({
    enabled: true,
    state: "ok",
    configPath: result.filePath,
    pollIntervalMs: cfg.pollIntervalMs,
    staleAfterMs: cfg.staleAfterMs,
    history: { ...cfg.history },
    meters: metersStatus(),
    units: unitsStatus(),
  });

  const runtime = {
    enabled: true,
    store,
    status,
    live: () =>
      liveSummary({
        store,
        unitIds,
        nowMs: now(),
        recentFleet,
        units: unitsStatus(),
        meters: metersStatus(),
        tokensByHour: tokens(),
      }),
    history: () => historyPayload({ store, unitIds, nowMs: now(), tokensByHour: tokens() }),
    monthly: () => monthlyRollup({ store, unitIds, nowMs: now(), tokensByHour: tokens() }),
    pollOnce,
    reconcileOnce,
    flush: flushSafe,

    register(app) {
      registerPowerMeterRoutes(app, { status, runtime });
    },

    renderPrometheus() {
      const lines = [
        "# HELP sparkdash_wall_power_watts Power measured at the wall by an external power meter. Only fresh readings are exported.",
        "# TYPE sparkdash_wall_power_watts gauge",
      ];
      for (const u of units.values()) {
        if (!u.reading?.fresh) continue;
        lines.push(
          `sparkdash_wall_power_watts{unit="${escapeLabel(u.id)}",meter="${escapeLabel(u.meterId)}"} ${u.reading.watts}`
        );
      }
      return `${lines.join("\n")}\n`;
    },

    start() {
      if (stopped || pollTimer) return;
      logger.log?.(
        `[powerMeters] enabled: ${unitIds.length} unit(s) on ${meters.size} meter(s), polling every ${cfg.pollIntervalMs / 1000}s`
      );
      void pollOnce();
      pollTimer = timers.setInterval(() => void pollOnce(), cfg.pollIntervalMs);
      pollTimer?.unref?.();
      flushTimer = timers.setInterval(flushSafe, FLUSH_INTERVAL_MS);
      flushTimer?.unref?.();
      if (cfg.history.enabled) void reconcileOnce().finally(scheduleReconcile);
    },

    stop() {
      if (stopped) return true;
      stopped = true;
      lifecycle.abort();
      for (const [clear, timer] of [
        [timers.clearInterval, pollTimer],
        [timers.clearInterval, flushTimer],
        [timers.clearTimeout, reconcileTimer],
      ]) {
        if (timer) clear(timer);
      }
      for (const meter of meters.values()) {
        try {
          meter.provider?.close?.();
        } catch {
          // Closing is best-effort.
        }
      }
      return flushSafe();
    },
  };
  return runtime;
}
