/**
 * Metered energy in the same shapes as the estimated fleet energy, so the Energy page
 * and the Overview card can show either source with one code path:
 *
 *   hourlyRows   → EnergyHistoryRow[]   (GET /api/fleet-energy/history rows)
 *   liveSummary  → FleetEnergy          (GET /api/fleet-energy)
 *   monthlyRollup→ MonthlyEnergy        (GET /api/fleet-energy/monthly)
 *
 * Every payload carries `estimated: false` and `source: "meter"`. Semantics match the
 * estimate: per-node figures count while THAT node was measured, fleet figures only while
 * EVERY node was. Pure functions over a PowerMeterStore.
 */
import { DAY_MS, FINE_MS, HOUR_MS } from "./store.js";

export const HISTORY_WINDOW_MS = 62 * DAY_MS;
const RECENT_WINDOW_MS = 30_000;
/** An hour counts toward Wh/token only when the meter covered nearly all of it. */
const TOKEN_COVERAGE_RATIO = 0.99;

const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const floorTo = (ms, step) => Math.floor(ms / step) * step;

/** Energy and coverage while every unit was measured, from per-unit hour aggregates. */
function fleetForHour(perUnit) {
  if (perUnit.some((h) => !h || h.covMs <= 0)) return { wh: 0, covMs: 0 };
  if (perUnit.every((h) => h.slots)) {
    let wh = 0;
    let covMs = 0;
    for (let k = 0; k < perUnit[0].slots.length; k += 1) {
      const slots = perUnit.map((h) => h.slots[k]);
      if (slots.some((s) => !s || s.covMs <= 0)) continue;
      const common = Math.min(...slots.map((s) => s.covMs));
      covMs += common;
      for (const s of slots) wh += (s.wh * common) / s.covMs;
    }
    return { wh, covMs };
  }
  // One unit only has an hourly figure: assume the overlap is the shortest coverage.
  const common = Math.min(...perUnit.map((h) => h.covMs));
  return { wh: perUnit.reduce((sum, h) => sum + (h.wh * common) / h.covMs, 0), covMs: common };
}

/**
 * Hourly rows for [fromMs, toMs), oldest first; hours nobody measured are omitted.
 * `tokensByHour` (hour start → output tokens, from the estimated tracker's token
 * accounting) is optional; tokens count as covered only in hours the meter covered.
 */
export function hourlyRows({ store, unitIds, fromMs, toMs, nowMs, tokensByHour = null }) {
  const perUnit = unitIds.map((id) => store.hours(id, fromMs, toMs));
  const hours = new Set();
  for (const map of perUnit) for (const t of map.keys()) hours.add(t);
  const currentHour = floorTo(nowMs, HOUR_MS);
  const rows = [];
  for (const t of [...hours].sort((a, b) => a - b)) {
    const aggregates = perUnit.map((map) => map.get(t) ?? null);
    if (aggregates.every((h) => !h || h.covMs <= 0)) continue;
    const nodeWh = {};
    const nodeCoverageMs = {};
    const nodeMeteredMs = {};
    unitIds.forEach((id, i) => {
      nodeWh[id] = round(aggregates[i]?.wh ?? 0);
      nodeCoverageMs[id] = Math.round(aggregates[i]?.covMs ?? 0);
      nodeMeteredMs[id] = Math.round(aggregates[i]?.meteredMs ?? 0);
    });
    const fleet = fleetForHour(aggregates);
    const expectedMs = t === currentHour ? Math.max(1, Math.min(HOUR_MS, nowMs - t)) : HOUR_MS;
    const tokenTracked = tokensByHour?.has?.(t) === true && fleet.covMs >= TOKEN_COVERAGE_RATIO * expectedMs;
    const outputTokens = tokensByHour?.get?.(t) ?? 0;
    rows.push({
      t,
      nodeWh,
      nodeCoverageMs,
      nodeMeteredMs,
      avgWatts: fleet.covMs > 0 ? round(fleet.wh / (fleet.covMs / HOUR_MS), 1) : null,
      fleetEnergyWh: round(fleet.wh),
      fleetCoverageMs: Math.round(fleet.covMs),
      outputTokens,
      coveredOutputTokens: tokenTracked ? outputTokens : 0,
      tokenTracked,
    });
  }
  return rows;
}

/** Totals over the trailing window, pro-rating the hour that straddles its start. */
function windowTotals(rows, unitIds, nowMs, windowMs) {
  const startMs = nowMs - windowMs;
  const totals = {
    energyWh: 0,
    fleetCoverageMs: 0,
    nodeCoverageMs: Object.fromEntries(unitIds.map((id) => [id, 0])),
    outputTokens: 0,
    coveredTokens: 0,
    tokenFleetWh: 0,
    observed: false,
  };
  for (const row of rows) {
    const end = row.t + HOUR_MS;
    if (end <= startMs || row.t > nowMs) continue;
    const f = row.t >= startMs ? 1 : (end - startMs) / HOUR_MS;
    for (const id of unitIds) {
      totals.energyWh += (row.nodeWh[id] ?? 0) * f;
      totals.nodeCoverageMs[id] += (row.nodeCoverageMs[id] ?? 0) * f;
      if ((row.nodeCoverageMs[id] ?? 0) > 0) totals.observed = true;
    }
    totals.fleetCoverageMs += row.fleetCoverageMs * f;
    totals.outputTokens += row.outputTokens * f;
    if (row.tokenTracked) {
      totals.coveredTokens += row.coveredOutputTokens * f;
      totals.tokenFleetWh += row.fleetEnergyWh * f;
    }
  }
  for (const id of unitIds) totals.nodeCoverageMs[id] = Math.round(totals.nodeCoverageMs[id]);
  return totals;
}

/** Rolling 24 one-hour fleet averages ending now, from 5-minute buckets. */
function hourlyWatts24h(store, unitIds, nowMs) {
  const graphEnd = floorTo(nowMs, FINE_MS);
  const graphStart = graphEnd - DAY_MS;
  const maps = unitIds.map((id) => store.fineBuckets(id, graphStart, graphEnd));
  const agg = Array.from({ length: 24 }, () => ({ wh: 0, covMs: 0 }));
  for (let s = graphStart; s < graphEnd; s += FINE_MS) {
    const buckets = maps.map((m) => m.get(s));
    if (!buckets.length || buckets.some((b) => !b || b.covMs <= 0)) continue;
    const common = Math.min(...buckets.map((b) => b.covMs));
    const slot = agg[Math.floor((s - graphStart) / HOUR_MS)];
    slot.covMs += common;
    for (const b of buckets) slot.wh += (b.wh * common) / b.covMs;
  }
  return agg.map(({ wh, covMs }) => (covMs > 0 ? round(wh / (covMs / HOUR_MS), 1) : null));
}

/**
 * Live summary in the FleetEnergy shape, plus `units` and `meters` describing each
 * reading and meter. `recentFleet` holds full-fleet samples ({ atMs, watts }).
 */
export function liveSummary({ store, unitIds, nowMs, recentFleet, units, meters, tokensByHour = null }) {
  const rows = hourlyRows({
    store,
    unitIds,
    fromMs: nowMs - 31 * DAY_MS - HOUR_MS,
    toMs: nowMs + 1,
    nowMs,
    tokensByHour,
  });
  const last24h = windowTotals(rows, unitIds, nowMs, DAY_MS);
  const last31d = windowTotals(rows, unitIds, nowMs, 31 * DAY_MS);
  const recent = recentFleet.filter((s) => nowMs - s.atMs <= RECENT_WINDOW_MS && s.atMs <= nowMs);
  const fresh = units.filter((u) => u.fresh).map((u) => u.id);
  return {
    estimated: false,
    source: "meter",
    membershipChanged: false,
    restartRequired: false,
    trackedNodeIds: [...unitIds],
    currentNodeIds: [...unitIds],
    freshNodeCount: fresh.length,
    staleNodeIds: unitIds.filter((id) => !fresh.includes(id)),
    currentWatts30s: recent.length ? round(recent.reduce((sum, s) => sum + s.watts, 0) / recent.length, 1) : null,
    energy24hKwh: last24h.observed ? round(last24h.energyWh / 1000, 4) : null,
    energy31dKwh: last31d.observed ? round(last31d.energyWh / 1000, 4) : null,
    whPerOutputToken24h:
      last24h.tokenFleetWh > 0 && last24h.coveredTokens > 0 ? last24h.tokenFleetWh / last24h.coveredTokens : null,
    outputTokens24h: Math.round(last24h.outputTokens),
    coverage24hMs: Math.round(last24h.fleetCoverageMs),
    coverage24hWindowMs: DAY_MS,
    coverage31dMs: Math.round(last31d.fleetCoverageMs),
    coverage31dWindowMs: 31 * DAY_MS,
    nodeCoverage24hMs: last24h.nodeCoverageMs,
    nodeCoverage31dMs: last31d.nodeCoverageMs,
    hourlyWatts24h: hourlyWatts24h(store, unitIds, nowMs),
    units,
    meters,
  };
}

/** Hourly history in the EnergyHistory shape for the last HISTORY_WINDOW_MS. */
export function historyPayload({ store, unitIds, nowMs, tokensByHour = null }) {
  return {
    estimated: false,
    source: "meter",
    membershipChanged: false,
    generatedAt: nowMs,
    retentionMs: HISTORY_WINDOW_MS,
    nodeIds: [...unitIds],
    hourly: hourlyRows({
      store,
      unitIds,
      fromMs: floorTo(nowMs - HISTORY_WINDOW_MS, HOUR_MS),
      toMs: nowMs + 1,
      nowMs,
      tokensByHour,
    }),
  };
}

function monthBounds(ms) {
  const d = new Date(ms);
  const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const endMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { month: new Date(startMs).toISOString().slice(0, 7), startMs, endMs };
}

/** Every stored hour rolled up per UTC month, in the MonthlyEnergy shape. */
export function monthlyRollup({ store, unitIds, nowMs, tokensByHour = null }) {
  const earliest = store.earliest(unitIds);
  const rows =
    earliest == null ? [] : hourlyRows({ store, unitIds, fromMs: earliest, toMs: nowMs + 1, nowMs, tokensByHour });
  const months = new Map();
  for (const row of rows) {
    const bounds = monthBounds(row.t);
    let m = months.get(bounds.month);
    if (!m) {
      m = {
        ...bounds,
        closed: bounds.endMs <= nowMs,
        nodes: Object.fromEntries(unitIds.map((id) => [id, { wh: 0, coverageMs: 0 }])),
        fleetWh: 0,
        fleetCoverageMs: 0,
        outputTokens: 0,
        coveredOutputTokens: 0,
        tokenFleetWh: 0,
      };
      months.set(bounds.month, m);
    }
    for (const id of unitIds) {
      m.nodes[id].wh += row.nodeWh[id] ?? 0;
      m.nodes[id].coverageMs += row.nodeCoverageMs[id] ?? 0;
    }
    m.fleetWh += row.fleetEnergyWh;
    m.fleetCoverageMs += row.fleetCoverageMs;
    m.outputTokens += row.outputTokens;
    if (row.tokenTracked) {
      m.coveredOutputTokens += row.coveredOutputTokens;
      m.tokenFleetWh += row.fleetEnergyWh;
    }
  }
  return {
    estimated: false,
    source: "meter",
    generatedAt: nowMs,
    foldedThroughMs: nowMs,
    months: [...months.values()]
      .sort((a, b) => a.startMs - b.startMs)
      .map(({ tokenFleetWh, ...m }) => {
        const nodeIds = unitIds.filter((id) => m.nodes[id].coverageMs > 0);
        const nodes = Object.fromEntries(
          nodeIds.map((id) => [id, { wh: round(m.nodes[id].wh), coverageMs: Math.round(m.nodes[id].coverageMs) }])
        );
        return {
          ...m,
          nodeIds,
          nodes,
          totalWh: round(nodeIds.reduce((sum, id) => sum + m.nodes[id].wh, 0)),
          fleetWh: round(m.fleetWh),
          fleetCoverageMs: Math.round(m.fleetCoverageMs),
          whPerOutputToken: tokenFleetWh > 0 && m.coveredOutputTokens > 0 ? tokenFleetWh / m.coveredOutputTokens : null,
        };
      }),
  };
}
