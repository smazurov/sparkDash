import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DAY_MS, FINE_MS, HOUR_MS, PowerMeterStore } from "../store.js";

const T0 = Date.parse("2026-10-29T20:00:00Z");
const quiet = { warn() {}, log() {}, error() {} };

function makeStore({ nowMs = T0 + 2 * HOUR_MS, ...rest } = {}) {
  let now = nowMs;
  const store = new PowerMeterStore({ now: () => now, logger: quiet, ...rest });
  return { store, setNow: (ms) => (now = ms) };
}

test("live energy is split across 5-minute buckets", () => {
  const { store } = makeStore();
  store.bindUnit("a", "ha|homeassistant|sensor.p3");
  // 60 W from 20:04:00 to 20:06:00: one minute in each of two buckets.
  store.addLive("a", T0 + 4 * 60_000, T0 + 6 * 60_000, 60);
  const fine = store.fineBuckets("a", T0, T0 + HOUR_MS);
  assert.deepEqual([...fine.keys()], [T0, T0 + FINE_MS]);
  assert.equal(fine.get(T0).covMs, 60_000);
  assert.equal(fine.get(T0).wh, 1);
  assert.equal(fine.get(T0).src, "live");
  assert.equal(fine.get(T0 + FINE_MS).wh, 1);
  // A bucket never claims more than five minutes of coverage.
  store.addLive("a", T0, T0 + 10 * 60_000, 60);
  assert.equal(store.fineBuckets("a", T0, T0 + 1).get(T0).covMs, FINE_MS);
});

test("the meter's periods replace live buckets and live never overwrites them", () => {
  const { store } = makeStore();
  store.bindUnit("a", "k");
  store.addLive("a", T0, T0 + FINE_MS, 50);
  const applied = store.applyMeterPeriods("a", [
    { startMs: T0, endMs: T0 + FINE_MS, meanW: 60, maxW: 70 },
    { startMs: T0 + 1000, endMs: T0 + 1000 + FINE_MS, meanW: 60 }, // unaligned
    { startMs: T0, endMs: T0 + 2 * FINE_MS, meanW: 60 }, // not a 5-minute or hourly period
    { startMs: T0 + 5 * HOUR_MS, endMs: T0 + 5 * HOUR_MS + FINE_MS, meanW: 60 }, // unfinished
  ]);
  assert.equal(applied, 1);
  const bucket = store.fineBuckets("a", T0, T0 + 1).get(T0);
  assert.deepEqual(bucket, { wh: 5, covMs: FINE_MS, maxW: 70, src: "meter" });
  store.addLive("a", T0, T0 + FINE_MS, 1000);
  assert.equal(store.fineBuckets("a", T0, T0 + 1).get(T0).wh, 5);
});

test("since excludes what the outlet measured before the unit was plugged in", () => {
  const { store } = makeStore();
  store.bindUnit("a", "k");
  const applied = store.applyMeterPeriods(
    "a",
    [
      { startMs: T0 - HOUR_MS, endMs: T0, meanW: 0 },
      { startMs: T0, endMs: T0 + HOUR_MS, meanW: 55 },
    ],
    { sinceMs: T0 }
  );
  assert.equal(applied, 1);
  assert.deepEqual([...store.hours("a", T0 - 2 * HOUR_MS, T0 + 2 * HOUR_MS).keys()], [T0]);
});

test("each hour uses whichever tier covers more of it", () => {
  const { store } = makeStore();
  store.bindUnit("a", "k");
  // Hour 1: only 10 minutes of live data, but the meter's hourly row covers it all.
  store.addLive("a", T0, T0 + 10 * 60_000, 60);
  store.applyMeterPeriods("a", [{ startMs: T0, endMs: T0 + HOUR_MS, meanW: 58 }]);
  // Hour 2: twelve meter 5-minute rows tie with the hourly row; fine wins for its detail.
  const fine = Array.from({ length: 12 }, (_, i) => ({
    startMs: T0 + HOUR_MS + i * FINE_MS,
    endMs: T0 + HOUR_MS + (i + 1) * FINE_MS,
    meanW: 60,
  }));
  store.applyMeterPeriods("a", [...fine, { startMs: T0 + HOUR_MS, endMs: T0 + 2 * HOUR_MS, meanW: 59 }]);
  const hours = store.hours("a", T0, T0 + 2 * HOUR_MS);
  assert.equal(hours.get(T0).wh, 58);
  assert.equal(hours.get(T0).slots, null);
  assert.equal(hours.get(T0).meteredMs, HOUR_MS);
  assert.equal(hours.get(T0 + HOUR_MS).wh, 60);
  assert.equal(hours.get(T0 + HOUR_MS).slots.length, 12);
});

test("pruning folds aged 5-minute buckets into hours without beating a better meter hour", () => {
  const { store } = makeStore({ fineRetentionMs: DAY_MS, nowMs: T0 + 3 * DAY_MS });
  store.bindUnit("a", "k");
  // Live-only hour: folded into the coarse tier as live.
  store.addLive("a", T0, T0 + 30 * 60_000, 40);
  // Meter-covered hour with a live gap in its 5-minute tier: the meter hour stays.
  store.applyMeterPeriods("a", [{ startMs: T0 + HOUR_MS, endMs: T0 + 2 * HOUR_MS, meanW: 61 }]);
  store.addLive("a", T0 + HOUR_MS, T0 + HOUR_MS + 5 * 60_000, 500);
  store.prune();
  assert.equal(store.fineBuckets("a", 0, Infinity).size, 0);
  const hours = store.hours("a", T0, T0 + 2 * HOUR_MS);
  assert.equal(hours.get(T0).wh, 20);
  assert.equal(hours.get(T0).covMs, 30 * 60_000);
  assert.equal(hours.get(T0).meteredMs, 0);
  assert.equal(hours.get(T0 + HOUR_MS).wh, 61);
});

test("state round-trips through the file and a new channel discards the old one's history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "power-meter-store-"));
  const filePath = path.join(dir, "power-meter-energy.json");
  try {
    const { store } = makeStore({ filePath });
    store.bindUnit("a", "ha|homeassistant|sensor.p3");
    store.bindUnit("b", "ha|homeassistant|sensor.p4");
    store.addLive("a", T0, T0 + 60_000, 60);
    store.applyMeterPeriods("b", [{ startMs: T0, endMs: T0 + HOUR_MS, meanW: 55.5, maxW: 70 }]);
    store.setWatermark("b", "hour", T0 + HOUR_MS);
    store.markBackfilled("b", "backfill-key");
    store.flush();
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

    const { store: reloaded } = makeStore({ filePath });
    reloaded.load();
    reloaded.bindUnit("a", "ha|homeassistant|sensor.p3");
    reloaded.bindUnit("b", "ha|homeassistant|sensor.p4");
    assert.equal(reloaded.fineBuckets("a", T0, T0 + 1).get(T0).wh, 1);
    assert.equal(reloaded.hours("b", T0, T0 + HOUR_MS).get(T0).wh, 55.5);
    assert.equal(reloaded.watermark("b", "hour"), T0 + HOUR_MS);
    assert.equal(reloaded.backfillDone("b", "backfill-key"), true);
    assert.equal(reloaded.earliest(["a", "b"]), T0);

    reloaded.bindUnit("b", "ha|homeassistant|sensor.p5");
    assert.equal(reloaded.hours("b", T0, T0 + HOUR_MS).size, 0);
    assert.equal(reloaded.backfillDone("b", "backfill-key"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("implausible rows in the file are dropped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "power-meter-store-"));
  const filePath = path.join(dir, "power-meter-energy.json");
  try {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        units: {
          a: {
            key: "k",
            fine: [
              [T0, 5, FINE_MS, 60, 1],
              [T0 + 1, 5, FINE_MS, 60, 1],
              [T0 + FINE_MS, -1, FINE_MS, 60, 1],
              [T0 + 2 * FINE_MS, 5, FINE_MS * 2, 60, 1],
              [T0 + 3 * FINE_MS, 1e9, FINE_MS, 60, 1],
              [T0 + 4 * FINE_MS, 5, FINE_MS, 60, 7],
            ],
          },
        },
      })
    );
    const { store } = makeStore({ filePath });
    store.load();
    store.bindUnit("a", "k");
    assert.deepEqual([...store.fineBuckets("a", 0, Infinity).keys()], [T0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
