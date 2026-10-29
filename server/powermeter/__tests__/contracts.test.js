import test from "node:test";
import assert from "node:assert/strict";
import { DAY_MS, FINE_MS, HOUR_MS, PowerMeterStore } from "../store.js";
import { historyPayload, hourlyRows, liveSummary, monthlyRollup } from "../contracts.js";

const T0 = Date.parse("2026-10-29T20:00:00Z");
const quiet = { warn() {}, log() {}, error() {} };

function storeAt(nowMs) {
  const store = new PowerMeterStore({ now: () => nowMs, logger: quiet });
  store.bindUnit("a", "ka");
  store.bindUnit("b", "kb");
  return store;
}

const fullHour = (start, meanW) =>
  Array.from({ length: 12 }, (_, i) => ({ startMs: start + i * FINE_MS, endMs: start + (i + 1) * FINE_MS, meanW }));

test("fleet figures only count time when every unit was measured", () => {
  const store = storeAt(T0 + 2 * HOUR_MS);
  store.applyMeterPeriods("a", fullHour(T0, 60));
  // b misses the first 5-minute slot of the hour.
  store.applyMeterPeriods("b", fullHour(T0, 40).slice(1));
  const [row] = hourlyRows({ store, unitIds: ["a", "b"], fromMs: T0, toMs: T0 + HOUR_MS, nowMs: T0 + 2 * HOUR_MS });
  assert.equal(row.t, T0);
  assert.equal(row.nodeWh.a, 60);
  assert.equal(row.nodeCoverageMs.b, 11 * FINE_MS);
  assert.equal(row.nodeMeteredMs.a, HOUR_MS);
  assert.equal(row.fleetCoverageMs, 11 * FINE_MS);
  assert.equal(row.fleetEnergyWh, Math.round(((100 * 11) / 12) * 1000) / 1000);
  assert.equal(row.avgWatts, 100);
});

test("an hourly-only unit pairs with the other's coverage conservatively", () => {
  const store = storeAt(T0 + 2 * HOUR_MS);
  store.applyMeterPeriods("a", [{ startMs: T0, endMs: T0 + HOUR_MS, meanW: 60 }]);
  store.addLive("b", T0, T0 + 30 * 60_000, 40);
  const [row] = hourlyRows({ store, unitIds: ["a", "b"], fromMs: T0, toMs: T0 + HOUR_MS, nowMs: T0 + 2 * HOUR_MS });
  assert.equal(row.fleetCoverageMs, 30 * 60_000);
  assert.equal(row.fleetEnergyWh, 30 + 20);
});

test("tokens count toward efficiency only in hours the meter fully covered", () => {
  const store = storeAt(T0 + 3 * HOUR_MS);
  store.applyMeterPeriods("a", [...fullHour(T0, 60), ...fullHour(T0 + HOUR_MS, 60)]);
  store.applyMeterPeriods("b", [...fullHour(T0, 60), ...fullHour(T0 + HOUR_MS, 60).slice(6)]);
  const tokensByHour = new Map([
    [T0, 1000],
    [T0 + HOUR_MS, 500],
  ]);
  const rows = hourlyRows({ store, unitIds: ["a", "b"], fromMs: T0, toMs: T0 + 2 * HOUR_MS, nowMs: T0 + 3 * HOUR_MS, tokensByHour });
  assert.deepEqual(
    rows.map((r) => [r.outputTokens, r.coveredOutputTokens, r.tokenTracked]),
    [
      [1000, 1000, true],
      [500, 0, false],
    ]
  );
});

test("the live summary matches the FleetEnergy contract with metered values", () => {
  const nowMs = T0 + 10 * 60_000;
  const store = storeAt(nowMs);
  for (const id of ["a", "b"]) {
    store.applyMeterPeriods(id, [{ startMs: T0 - 25 * HOUR_MS, endMs: T0 - 24 * HOUR_MS, meanW: 999 }]);
    store.applyMeterPeriods(id, [{ startMs: T0 - HOUR_MS, endMs: T0, meanW: 60 }]);
    store.addLive(id, T0, nowMs, 50);
  }
  const summary = liveSummary({
    store,
    unitIds: ["a", "b"],
    nowMs,
    recentFleet: [
      { atMs: nowMs - 40_000, watts: 1 },
      { atMs: nowMs - 10_000, watts: 100 },
      { atMs: nowMs, watts: 110 },
    ],
    units: [
      { id: "a", fresh: true },
      { id: "b", fresh: false },
    ],
    meters: [],
  });
  assert.equal(summary.estimated, false);
  assert.equal(summary.source, "meter");
  assert.equal(summary.freshNodeCount, 1);
  assert.deepEqual(summary.staleNodeIds, ["b"]);
  assert.equal(summary.currentWatts30s, 105);
  // 24 h window: last hour at 60 W x2 plus 10 min at 50 W x2, the 25 h-old hour excluded.
  assert.equal(summary.energy24hKwh, Math.round(((120 + 2 * 50 * (10 / 60)) / 1000) * 1e4) / 1e4);
  assert.equal(summary.coverage24hWindowMs, DAY_MS);
  assert.equal(summary.hourlyWatts24h.length, 24);
  assert.equal(summary.hourlyWatts24h.at(-1), 100);
  assert.ok(summary.energy31dKwh > summary.energy24hKwh);
});

test("history and monthly payloads keep their contracts", () => {
  const nowMs = Date.parse("2026-10-02T12:00:00Z");
  const store = storeAt(nowMs);
  for (const id of ["a", "b"]) {
    store.applyMeterPeriods(id, [
      { startMs: Date.parse("2026-09-30T23:00:00Z"), endMs: Date.parse("2026-10-01T00:00:00Z"), meanW: 50 },
      { startMs: Date.parse("2026-10-01T00:00:00Z"), endMs: Date.parse("2026-10-01T01:00:00Z"), meanW: 70 },
    ]);
  }
  const history = historyPayload({ store, unitIds: ["a", "b"], nowMs });
  assert.equal(history.estimated, false);
  assert.equal(history.membershipChanged, false);
  assert.deepEqual(history.nodeIds, ["a", "b"]);
  assert.equal(history.hourly.length, 2);

  const monthly = monthlyRollup({ store, unitIds: ["a", "b"], nowMs });
  assert.deepEqual(
    monthly.months.map((m) => [m.month, m.closed, m.totalWh, m.fleetWh, m.nodeIds.join(",")]),
    [
      ["2026-09", true, 100, 100, "a,b"],
      ["2026-10", false, 140, 140, "a,b"],
    ]
  );
  assert.deepEqual(monthly.months[1].nodes.a, { wh: 70, coverageMs: HOUR_MS });
  assert.equal(monthly.months[0].whPerOutputToken, null);
});
