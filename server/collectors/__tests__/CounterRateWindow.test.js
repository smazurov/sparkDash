import test from "node:test";
import assert from "node:assert/strict";
import { CounterRateWindow } from "../CounterRateWindow.js";

const round = (n) => n == null ? null : Math.round(n * 100) / 100;

test("a full observed minute is required; lifetime totals never seed a rate", () => {
  const w = new CounterRateWindow();
  for (let t = 0; t < 60_000; t += 2000) assert.equal(w.observe(380008, t), null);
  assert.equal(w.observe(380008, 60_000), 0);
});

test("four overlapping 80-second requests: 8000 tokens / 60 wall seconds, not 320 request seconds", () => {
  const w = new CounterRateWindow();
  for (let t = 0; t < 80_000; t += 2000) assert.equal(w.observe(1000, t), t < 60_000 ? null : 0);
  assert.equal(round(w.observe(9000, 80_000)), 133.33);
  for (let t = 82_000; t < 140_000; t += 2000) assert.equal(round(w.observe(9000, t)), 133.33);
  assert.equal(w.observe(9000, 140_000), 0, "completion at the left boundary is no longer counted");
});

test("irregular scrape intervals attribute each delta once, without timing interpolation", () => {
  const w = new CounterRateWindow();
  const observations = [];
  let counter = 11000;
  for (let at = 0, i = 0; at <= 240_000; i++, at += [1800, 3400, 2700, 1900][i % 4]) {
    const delta = i === 0 ? 0 : i % 7 === 0 ? 317 : 0;
    counter += delta;
    observations.push({ at, delta });
    const expected = at < 60_000 ? null : observations.filter(s => s.at > at - 60_000).reduce((sum, s) => sum + s.delta, 0) / 60;
    assert.equal(w.observe(counter, at), expected);
    assert.ok(w.samples.length <= 35, "keep only the window and one boundary anchor");
  }
});

for (const event of ["reset", "gap", "clock reversal", "same timestamp", "missing", "negative", "infinite", "clear"]) {
  test(`${event} discards old completions and requires another full warmup`, () => {
    const w = new CounterRateWindow();
    for (let t = 0; t <= 60_000; t += 2000) w.observe(10000 + t, t);
    assert.ok(w.observe(72000, 62_000) > 0);
    let at = 64_000;
    let counter = 73000;
    if (event === "reset") counter = 5;
    if (event === "gap") at = 72_000;
    if (event === "clock reversal") at = 61_000;
    if (event === "same timestamp") at = 62_000;
    if (event === "clear") w.clear();
    if (["missing", "negative", "infinite"].includes(event)) {
      assert.equal(w.observe({ missing: null, negative: -1, infinite: Infinity }[event], at), null);
      at += 2000;
    }
    assert.equal(w.observe(counter, at), null);
    for (let t = at + 2000; t < at + 60_000; t += 2000) assert.equal(w.observe(counter + 600, t), null);
    assert.equal(w.observe(counter + 600, at + 60_000), 10);
  });
}
