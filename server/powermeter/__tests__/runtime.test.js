import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createPowerMeterRuntime } from "../runtime.js";
import { validatePowerMeterConfig } from "../config.js";
import { FINE_MS, HOUR_MS } from "../store.js";

const quiet = { warn() {}, log() {}, error() {} };
const T0 = Date.parse("2026-10-29T20:00:00Z");

function okConfig(overrides = {}) {
  const { config, error } = validatePowerMeterConfig({
    meters: { strip: { type: "homeassistant", url: "https://ha.lan" } },
    units: {
      "spark-a": { meter: "strip", channel: "sensor.p3", since: "2026-10-29T00:00:00Z" },
      "spark-b": { meter: "strip", channel: "sensor.p4" },
    },
    ...overrides,
  });
  assert.equal(error, undefined);
  return { status: "ok", filePath: "/test/power-meters.json", config };
}

/** A scriptable provider standing in for any meter. */
function fakeProvider({ withHistory = true } = {}) {
  const provider = {
    type: "fake",
    readings: new Map(),
    history: { "5minute": new Map(), hour: new Map() },
    historyCalls: [],
    describe: () => ({ type: "fake", target: "fake://strip" }),
    async readPower(channels) {
      return new Map(channels.map((c) => [c, provider.readings.get(c) ?? { watts: null, atMs: null, error: "no data" }]));
    },
  };
  if (withHistory) {
    provider.historyPeriods = ["5minute", "hour"];
    provider.readHistory = async (channels, { fromMs, toMs, period }) => {
      provider.historyCalls.push({ period, fromMs, toMs });
      return new Map(
        channels.map((c) => [c, (provider.history[period].get(c) ?? []).filter((p) => p.startMs >= fromMs && p.endMs <= toMs)])
      );
    };
  }
  return provider;
}

function harness({ provider = fakeProvider(), configResult = okConfig(), energyFilePath = null, createProviderFn } = {}) {
  let now = T0 + 2 * HOUR_MS + 10_000;
  const runtime = createPowerMeterRuntime({
    configResult,
    energyFilePath,
    now: () => now,
    listUnits: () => [{ id: "spark-a", name: "Dan" }, { id: "spark-b", name: "Stepan" }],
    createProviderFn: createProviderFn ?? (() => provider),
    logger: quiet,
  });
  return { runtime, provider, advance: (ms) => (now += ms), at: () => now };
}

async function serve(runtime) {
  const app = express();
  app.use(express.json());
  runtime.register(app);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { get: (p) => fetch(base + p), post: (p) => fetch(base + p, { method: "POST" }), close: () => new Promise((r) => server.close(r)) };
}

test("without a config file the runtime is inert and says so", async (t) => {
  let created = 0;
  const runtime = createPowerMeterRuntime({
    configResult: { status: "absent" },
    createProviderFn: () => created++,
    logger: quiet,
  });
  assert.equal(runtime.enabled, false);
  runtime.start();
  assert.equal(created, 0);
  assert.equal(runtime.renderPrometheus(), "");
  const http = await serve(runtime);
  t.after(http.close);
  assert.deepEqual(await (await http.get("/api/power-meters")).json(), { enabled: false, state: "absent" });
  for (const p of ["/api/power-meters/energy", "/api/power-meters/energy/history", "/api/power-meters/energy/monthly"]) {
    const res = await http.get(p);
    assert.equal(res.status, 404, p);
    assert.match((await res.json()).error, /not configured/);
  }
  assert.equal((await http.post("/api/power-meters/reconcile")).status, 404);
});

test("an invalid file keeps the feature off and reports why", () => {
  const runtime = createPowerMeterRuntime({ configResult: { status: "invalid", error: "units must map…" }, logger: quiet });
  assert.deepEqual(runtime.status(), { enabled: false, state: "invalid", error: "units must map…" });
});

test("fresh polls integrate live energy; stale or missing readings do not", async () => {
  const { runtime, provider, advance, at } = harness();
  provider.readings.set("sensor.p3", { watts: 60, atMs: at() - 2_000 });
  provider.readings.set("sensor.p4", { watts: 40, atMs: at() - 2_000 });
  await runtime.pollOnce();
  advance(10_000);
  provider.readings.set("sensor.p3", { watts: 60, atMs: at() - 1_000 });
  // b's meter stopped reporting 5 minutes ago: stale, so nothing is integrated for it.
  provider.readings.set("sensor.p4", { watts: 40, atMs: at() - 5 * 60_000 });
  await runtime.pollOnce();
  const bucketStart = Math.floor(at() / FINE_MS) * FINE_MS;
  assert.equal(runtime.store.fineBuckets("spark-a", bucketStart - FINE_MS, bucketStart + FINE_MS).size > 0, true);
  const aWh = [...runtime.store.fineBuckets("spark-a", 0, Infinity).values()].reduce((s, b) => s + b.wh, 0);
  assert.ok(Math.abs(aWh - (60 * 10) / 3600) < 1e-9);
  assert.equal(runtime.store.fineBuckets("spark-b", 0, Infinity).size, 0);

  const status = runtime.status();
  assert.equal(status.enabled, true);
  const [a, b] = status.units;
  assert.deepEqual([a.name, a.fresh, a.watts], ["Dan", true, 60]);
  assert.deepEqual([b.fresh, b.error], [false, "reading is stale"]);
  assert.match(status.meters[0].error, /spark-b: reading is stale/);
  assert.match(runtime.renderPrometheus(), /sparkdash_wall_power_watts\{unit="spark-a",meter="strip"\} 60\n/);
  assert.doesNotMatch(runtime.renderPrometheus(), /spark-b/);
  // Full-fleet samples only while every unit is fresh.
  assert.equal(runtime.live().currentWatts30s, 100);
});

test("reconciliation backfills from since, then replaces live buckets with the meter's", async () => {
  const { runtime, provider, advance, at } = harness();
  const since = Date.parse("2026-10-29T00:00:00Z");
  const hourRows = (channel, w) =>
    Array.from({ length: 22 }, (_, i) => ({ startMs: since + i * HOUR_MS, endMs: since + (i + 1) * HOUR_MS, meanW: w }));
  provider.history.hour.set("sensor.p3", [{ startMs: since - HOUR_MS, endMs: since, meanW: 0 }, ...hourRows("sensor.p3", 55)]);
  provider.history.hour.set("sensor.p4", hourRows("sensor.p4", 45));

  // Live data for the current 5-minute bucket first.
  provider.readings.set("sensor.p3", { watts: 80, atMs: at() });
  provider.readings.set("sensor.p4", { watts: 80, atMs: at() });
  await runtime.pollOnce();
  advance(10_000);
  provider.readings.set("sensor.p3", { watts: 80, atMs: at() });
  provider.readings.set("sensor.p4", { watts: 80, atMs: at() });
  await runtime.pollOnce();
  const liveStart = T0 + 2 * HOUR_MS;
  assert.equal(runtime.store.fineBuckets("spark-a", 0, Infinity).get(liveStart)?.src, "live");

  await runtime.reconcileOnce();
  const hourCall = provider.historyCalls.find((c) => c.period === "hour");
  // Backfill starts at the earliest unit's since (b has none, so the backfill window bounds it).
  assert.ok(hourCall.fromMs <= since);
  const hours = runtime.store.hours("spark-a", since - HOUR_MS, since + 22 * HOUR_MS);
  assert.equal(hours.has(since - HOUR_MS), false, "since filters the outlet's earlier readings");
  assert.equal(hours.get(since).wh, 55);
  assert.equal(runtime.status().meters[0].history.state, "ok");

  // The meter's 5-minute row for the live bucket arrives and wins.
  advance(5 * 60_000);
  provider.history["5minute"].set("sensor.p3", [{ startMs: liveStart, endMs: liveStart + FINE_MS, meanW: 70 }]);
  provider.historyCalls.length = 0;
  await runtime.reconcileOnce();
  const bucket = runtime.store.fineBuckets("spark-a", liveStart, liveStart + 1).get(liveStart);
  assert.deepEqual([bucket.src, bucket.wh], ["meter", (70 * 5) / 60]);
  assert.equal(runtime.status().units[0].reconciledThroughMs, liveStart + FINE_MS);
  // Steady state: no second backfill, and no hourly fetch within the same hour.
  assert.ok(provider.historyCalls.every((c) => c.period === "5minute"));
  assert.ok(provider.historyCalls.every((c) => c.fromMs >= at() - 6 * HOUR_MS - FINE_MS));
});

test("a meter without history stays live-only", async () => {
  const provider = fakeProvider({ withHistory: false });
  const { runtime } = harness({ provider });
  await runtime.reconcileOnce();
  assert.equal(runtime.status().meters[0].history.state, "unsupported");
});

test("a meter that cannot start marks its units, without stopping the rest", async () => {
  const { runtime } = harness({
    createProviderFn: () => {
      throw new Error("environment variable HOME_ASSISTANT_TOKEN is not set");
    },
  });
  await runtime.pollOnce();
  await runtime.reconcileOnce();
  const status = runtime.status();
  assert.equal(status.meters[0].ok, false);
  assert.match(status.meters[0].error, /HOME_ASSISTANT_TOKEN/);
  assert.equal(status.meters[0].history.state, "unavailable");
  assert.equal(status.units[0].error, "environment variable HOME_ASSISTANT_TOKEN is not set");
  assert.equal(runtime.live().freshNodeCount, 0);
});

test("routes serve the metered contracts and stop() persists the store", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "power-meter-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const energyFilePath = path.join(dir, "power-meter-energy.json");
  const { runtime, provider, advance, at } = harness({ energyFilePath });
  for (let i = 0; i < 3; i += 1) {
    provider.readings.set("sensor.p3", { watts: 60, atMs: at() });
    provider.readings.set("sensor.p4", { watts: 40, atMs: at() });
    await runtime.pollOnce();
    advance(10_000);
  }
  const http = await serve(runtime);
  t.after(http.close);
  const live = await (await http.get("/api/power-meters/energy")).json();
  assert.equal(live.estimated, false);
  assert.equal(live.source, "meter");
  assert.deepEqual(live.trackedNodeIds, ["spark-a", "spark-b"]);
  const history = await (await http.get("/api/power-meters/energy/history")).json();
  assert.equal(history.hourly.length, 1);
  assert.ok(history.hourly[0].fleetEnergyWh > 0);
  const monthly = await (await http.get("/api/power-meters/energy/monthly")).json();
  assert.equal(monthly.months.length, 1);
  const reconcile = await http.post("/api/power-meters/reconcile");
  assert.equal(reconcile.status, 200);

  assert.equal(runtime.stop(), true);
  const saved = JSON.parse(fs.readFileSync(energyFilePath, "utf8"));
  assert.deepEqual(Object.keys(saved.units).sort(), ["spark-a", "spark-b"]);
  assert.equal(saved.units["spark-a"].key, "strip|homeassistant|sensor.p3");
});
