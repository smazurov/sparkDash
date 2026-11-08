import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LlmDailyStore } from "../LlmDaily.js";
import { extractSample } from "../../metrics/historySample.js";
import { llmKey } from "../../metrics/historyTiers.js";
import { renderPrometheusMetrics, unitMetricJson } from "../../prometheus.js";
import { LlmProbe } from "../LlmProbe.js";
import { readServerGenerationTokens } from "../LlmStreaming.js";

// Sanitized Halogen 0.20.0 /health, /v1/models, /slots and Prometheus contracts.
// See peonist-ai/halogen-flash-server docs/codex.md#observability. All counters
// describe completed GPU requests; /slots contains capacity, not live progress.
const defaults = {
  "llamacpp:prompt_tokens_total": 10000,
  "llamacpp:prompt_seconds_total": 10,
  "llamacpp:tokens_predicted_total": 1000,
  "llamacpp:tokens_predicted_seconds_total": 20,
  "llamacpp:prompt_tokens_seconds": 99999,
  "llamacpp:predicted_tokens_seconds": 99999,
  "llamacpp:requests_processing": 0,
  "llamacpp:requests_deferred": 0,
  "llamacpp:kv_cache_tokens": 262144,
  "llamacpp:kv_cache_usage_ratio": 0.5,
  "halogen:prompt_tokens_cached_total": 40000,
  "halogen:kv_pool_positions": 524288,
  "halogen:kv_pool_reserved_tokens": 500000,
  "halogen:draft_tokens_total": 1000,
  "halogen:draft_tokens_accepted_total": 800,
  "halogen:engine_up": 1,
};
const exposition = (values) => Object.entries(values).filter(([, v]) => v !== undefined)
  .map(([k, v]) => `${k} ${v}`).join("\n");
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => body,
});
function setup(t) {
  let clock = 100000;
  t.mock.method(Date, "now", () => clock);
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8731);
  const state = {
    health: { status: "ok", model: "gpu-model", context: 262144, slot_ctx: 262144,
      slots: 4, in_flight: 0, queued: 0, busy_for_s: 0,
      version: { api: "0.20.0", engine: "0.20.0", match: true },
      engine: { responds: true }, npu: { status: "ok", queued: 10 } },
    models: [{ id: "gpu-model", owned_by: "halogen", context_length: 262144 },
      { id: "npu-model", owned_by: "halogen", backend: "npu", context_length: 8192 }],
    metrics: { ...defaults }, status: {}, calls: [], body: undefined,
  };
  probe._fetch = async (url, _timeout, init) => {
    const path = new URL(url).pathname;
    state.calls.push(path);
    assert.ok(!init?.method || init.method === "GET", "monitoring must never send inference");
    if (state.status[path] === "timeout") throw new Error("timeout");
    const status = state.status[path] ?? 200;
    if (path === "/health") return response(state.health, status);
    if (path === "/slots") return response(Array.from({ length: 4 }, (_, id) => ({ id, n_ctx: 262144 })), status);
    if (path === "/v1/models") return response({ data: state.models }, status);
    if (path === "/metrics") return response(state.body ?? exposition(state.metrics), status);
    return response({}, 404);
  };
  return { probe, state, poll: async (ms = 2000) => { clock += ms; return probe.probe(); } };
}
function finish(state) {
  state.metrics["llamacpp:tokens_predicted_total"] += 500;
  state.metrics["llamacpp:tokens_predicted_seconds_total"] += 10;
  state.metrics["llamacpp:prompt_tokens_total"] += 4000;
  state.metrics["llamacpp:prompt_seconds_total"] += 4;
  state.metrics["halogen:prompt_tokens_cached_total"] += 6000;
}

test("Halogen identity overrides compatibility slots, preserving primary context and all model IDs", async (t) => {
  const { probe, state, poll } = setup(t);
  state.models.reverse(); // the NPU must not receive the GPU engine's counters/context
  const snap = await poll();
  assert.equal(snap.backend, "halogen");
  assert.equal(snap.available, true);
  assert.equal(snap.modelId, "gpu-model");
  assert.deepEqual(snap.models, ["gpu-model", "npu-model"]);
  assert.equal(snap.contextLength, 262144);
  assert.equal(snap.engineVersion, "0.20.0");
  assert.equal(snap.slotsTotal, 4);
  assert.equal(snap.totalOutputTokens, 1000);
  assert.equal(snap.totalPromptTokens, 50000);
  assert.equal(snap.totalCachedTokens, 40000);
  assert.equal(snap.prefixCacheHitRate, 0.8);
  assert.equal(snap.measurementValid, false); // first read seeds, not a lifetime-rate spike
  assert.equal(snap.generationTps, 0);
  state.calls = [];
  probe._lastDetectAt = 0;
  await poll();
  assert.ok(!state.calls.includes("/slots"));
  assert.ok(state.calls.every((p) => ["/health", "/v1/models", "/metrics"].includes(p)));
});

test("missing primary context never borrows an NPU model limit", async (t) => {
  const { state, poll } = setup(t);
  state.models.reverse();
  delete state.health.slot_ctx;
  delete state.health.context;
  assert.equal((await poll()).contextLength, null);
});

test("exact owned_by classification needs no heuristic probes", async (t) => {
  const { probe, state } = setup(t);
  assert.equal(await probe._classifyOpenAIBackend("Halogen"), "halogen");
  assert.deepEqual(state.calls, []);
});

test("ordinary llama.cpp slots are not reclassified from a model name or catch-all JSON", async (t) => {
  const { probe, state } = setup(t);
  for (const models of [[{ id: "halogen", owned_by: "llamacpp" }], [{ id: "halogen", owned_by: "someone/halogen" }], []]) {
    state.models = models;
    await probe._detectServerType();
    assert.equal(probe.backendType, "llama.cpp");
  }
});

test("Halogen still detects when /slots is disabled", async (t) => {
  const { state, poll } = setup(t);
  state.status["/slots"] = 404;
  assert.equal((await poll()).backend, "halogen");
});

test("prefill uses engine time while completed output stays a total, never aggregate TPS", async (t) => {
  const { state, poll } = setup(t);
  await poll();
  finish(state);
  const snap = await poll(); // 500 tokens in 10 engine seconds, NOT 500 / 2 scrape seconds
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.generationMeasurementValid, false);
  assert.equal(snap.prefillTps, 1000);
  assert.equal(snap.generationTpsSource, null);
  assert.equal(snap.prefillTpsSource, "completed-computed");
  assert.equal(snap.cachedPrefillTps, null); // cache timing isn't measured
  assert.equal(snap.uncachedPrefillTps, null);
  assert.equal(snap.totalPromptTokens, 60000);
  assert.equal(snap.totalCachedTokens, 46000);
  const idle = await poll();
  assert.equal(idle.generationTps, 0);
  assert.equal(idle.generationMeasurementValid, false);
  assert.equal(idle.generationMeasuredAt, snap.generationMeasuredAt);
  assert.equal(idle.prefillTps, 1000);
  assert.equal(idle.prefillTpsSource, "completed-computed");
  assert.equal(idle.prefillMeasurementValid, true);
  assert.equal(idle.prefillMeasuredAt, snap.prefillMeasuredAt);
});

test("concurrent completions never become aggregate TPS or a substituted per-stream statistic", async (t) => {
  const { state, poll } = setup(t);
  await poll();
  // Four overlapping requests: summed decode durations are not elapsed wall time.
  for (const running of [4, 2, 0]) {
    state.metrics["llamacpp:requests_processing"] = running;
    state.metrics["llamacpp:tokens_predicted_total"] += 7343;
    state.metrics["llamacpp:tokens_predicted_seconds_total"] += 291;
    const snap = await poll();
    assert.equal(snap.measurementValid, true);
    assert.equal(snap.generationMeasurementValid, false);
    assert.equal(snap.generationTps, 0); // unmeasured sentinel, never exported/charted
    assert.equal(snap.generationTpsSource, null);
    assert.equal(snap.perStreamTps, null); // do not relocate the rejected statistic
    assert.equal(snap.decodeActive, false);
    assert.equal(snap.totalOutputTokens, state.metrics["llamacpp:tokens_predicted_total"]);
  }
});

test("completed output advances activity without creating aggregate throughput", async (t) => {
  const { state, poll } = setup(t);
  await poll();
  state.metrics["llamacpp:tokens_predicted_total"] += 2;
  state.metrics["llamacpp:tokens_predicted_seconds_total"] += 0.0319;
  const first = await poll();
  assert.equal(first.generationMeasurementValid, false);
  assert.equal(first.generationMeasuredAt, 104000);
  for (let i = 0; i < 13; i++) {
    const snap = await poll(5000);
    assert.equal(snap.generationMeasurementValid, false);
    assert.equal(snap.generationMeasuredAt, first.generationMeasuredAt);
  }
});

test("prefill window sums tokens/time, holds across polls and expires samples at 60 seconds", async (t) => {
  const { state, poll } = setup(t);
  assert.equal((await poll()).prefillMeasurementValid, false);
  finish(state); // 4000 / 4s = 1000 tok/s, at 104000
  const first = await poll();
  assert.equal(first.prefillMeasuredAt, 104000);
  const held = await poll();
  assert.equal(held.prefillTps, 1000);
  assert.equal(held.prefillMeasuredAt, first.prefillMeasuredAt);
  state.metrics["llamacpp:prompt_tokens_total"] += 1000;
  state.metrics["llamacpp:prompt_seconds_total"] += 2;
  const second = await poll(); // at 108000: (4000 + 1000) / (4 + 2), NOT mean(1000, 500)
  assert.equal(second.prefillTps, 833.33);
  assert.equal(second.prefillMeasuredAt, 108000);
  for (let i = 0; i < 11; i++) assert.equal((await poll(5000)).prefillTps, 833.33);
  assert.equal((await poll(1000)).prefillTps, 500); // first window exactly 60s old
  const expired = await poll(4000);
  assert.equal(expired.available, true);
  assert.equal(expired.measurementValid, true); // KV/load/totals remain usable
  assert.equal(expired.prefillMeasurementValid, false);
  assert.equal(expired.prefillTpsSource, null);
  assert.equal(expired.prefillMeasuredAt, null);
});

test("decode-only and cache-only completions do not refresh or dilute the prefill window", async (t) => {
  const { state, poll } = setup(t);
  await poll();
  finish(state);
  const first = await poll();
  for (let i = 0; i < 11; i++) {
    state.metrics["llamacpp:tokens_predicted_total"] += 100;
    state.metrics["llamacpp:tokens_predicted_seconds_total"] += 2;
    state.metrics["halogen:prompt_tokens_cached_total"] += 50000;
    state.metrics["llamacpp:prompt_seconds_total"] += 0.01;
    const held = await poll(5000);
    assert.equal(held.prefillTps, 1000);
    assert.equal(held.prefillMeasuredAt, first.prefillMeasuredAt);
  }
  assert.equal((await poll(5000)).prefillMeasurementValid, false);
});

test("sub-50ms prefill windows stay unmeasured until enough timed work completes", async (t) => {
  const { state, poll } = setup(t);
  await poll();
  state.metrics["llamacpp:prompt_tokens_total"] += 10;
  state.metrics["llamacpp:prompt_seconds_total"] += 0.01;
  assert.equal((await poll()).prefillMeasurementValid, false);
  state.metrics["llamacpp:prompt_tokens_total"] += 50;
  state.metrics["llamacpp:prompt_seconds_total"] += 0.05;
  const measured = await poll();
  assert.equal(measured.prefillMeasurementValid, true);
  assert.equal(measured.prefillTps, 1000);
});

test("completed-rate history/export is a gap until measured, retained for the window, then a gap again", async (t) => {
  const { state, poll } = setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halogen-prefill-"));
  const file = path.join(dir, "daily.json");
  const daily = new LlmDailyStore(file);
  t.after(() => { clearTimeout(daily._flushTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  const date = new Date("2026-11-08T12:00:00Z");
  const record = (llm) => {
    const unit = { id: "fixture", online: true, llmPorts: [8731], metrics: { llm: [llm] } };
    daily.record(unit.id, 8731, llm, date);
    return { history: extractSample(unit), prom: renderPrometheusMetrics([unit]), compact: unitMetricJson(unit) };
  };
  await poll();
  const unknown = record(await poll());
  assert.equal(unknown.history[llmKey(8731, "genTps")], undefined);
  assert.doesNotMatch(unknown.prom, /^sparkdash_llm_generation_tokens_per_second\{/m);
  assert.equal(unknown.compact.llm[0].generation_tokens_per_second, undefined);
  assert.equal(unknown.history[llmKey(8731, "prefillTps")], undefined);
  assert.equal(unknown.history[llmKey(8731, "kvUsage")], 0.5);
  assert.doesNotMatch(unknown.prom, /^sparkdash_llm_prefill_tokens_per_second\{/m);
  assert.equal(unknown.compact.llm[0].prefill_tokens_per_second, undefined);
  // Live 0.20.0 experiment: 11,820 uncached tokens over 7.2484 engine seconds.
  state.metrics["llamacpp:prompt_tokens_total"] += 11820;
  state.metrics["llamacpp:prompt_seconds_total"] += 7.2484;
  state.metrics["llamacpp:tokens_predicted_total"] += 500;
  state.metrics["llamacpp:tokens_predicted_seconds_total"] += 10;
  let snap = await poll();
  assert.equal(snap.prefillTps, 1630.7);
  for (let i = 0; i < 30; i++) {
    const measured = record(snap);
    assert.equal(measured.history[llmKey(8731, "genTps")], undefined);
    assert.doesNotMatch(measured.prom, /^sparkdash_llm_generation_tokens_per_second\{/m);
    assert.equal(measured.compact.llm[0].generation_tokens_per_second, undefined);
    assert.equal(measured.history[llmKey(8731, "prefillTps")], 1630.7);
    assert.match(measured.prom, /^sparkdash_llm_prefill_tokens_per_second\{[^\n]*\} 1630.7$/m);
    assert.equal(measured.compact.llm[0].prefill_tokens_per_second, 1630.7);
    snap = await poll();
  }
  const expired = record(snap);
  assert.equal(expired.history[llmKey(8731, "genTps")], undefined);
  assert.equal(expired.compact.llm[0].generation_tokens_per_second, undefined);
  assert.doesNotMatch(expired.prom, /^sparkdash_llm_generation_tokens_per_second\{/m);
  assert.equal(expired.history[llmKey(8731, "prefillTps")], undefined);
  assert.equal(expired.history[llmKey(8731, "kvUsage")], 0.5);
  assert.equal(expired.compact.llm[0].prefill_tokens_per_second, undefined);
  assert.doesNotMatch(expired.prom, /^sparkdash_llm_prefill_tokens_per_second\{/m);
  daily.flush();
  const persisted = new LlmDailyStore(file).getSeries("fixture", 8731, { days: 1, now: date });
  assert.equal(persisted.days[0].decodeMax, 0);
  assert.equal(persisted.days[0].decodeAvg, null);
  assert.equal(persisted.days[0].prefillMax, 1630.7);
  assert.equal(persisted.days[0].prefillAvg, 1630.7);
});

test("busy requests expose queue activity, not invented live rates or NPU counts", async (t) => {
  const { state, poll } = setup(t);
  await poll();
  state.health.in_flight = 3;
  state.health.queued = 2;
  state.health.busy_for_s = 30;
  state.metrics["llamacpp:requests_processing"] = 3;
  state.metrics["llamacpp:requests_deferred"] = 2;
  const snap = await poll();
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.prefillTps, 0);
  assert.equal(snap.slotsActive, 3);
  assert.equal(snap.requestsRunning, 3);
  assert.equal(snap.requestsWaiting, 2);
  assert.equal(snap.inFlightSeconds, 30);
  assert.equal(snap.decodeActive, false); // in_flight cannot distinguish prefill from decode
});

test("KV uses occupancy, not reservations; draft acceptance and unknown timings stay honest", async (t) => {
  const { poll } = setup(t);
  const snap = await poll();
  assert.equal(snap.kvCacheUsage, 0.5);
  assert.equal(snap.kvCacheTokens, 524288);
  assert.equal(snap.kvCacheTokensAvailable, 262144);
  assert.equal(snap.mtpAcceptanceRate, 0.8);
  for (const key of ["kvCacheGb", "weightsGb", "kvCacheMemoryBytes", "ttftSeconds", "ttftP95Seconds", "itlP95Seconds", "e2eP95Seconds", "preemptionsTotal"]) assert.equal(snap[key], null, key);
});

test("missing or invalid optional metrics clear old readings, health is the queue fallback", async (t) => {
  const { state, poll } = setup(t);
  await poll();
  state.health.in_flight = 2;
  for (const key of ["llamacpp:requests_processing", "llamacpp:requests_deferred", "halogen:prompt_tokens_cached_total", "halogen:kv_pool_positions"]) delete state.metrics[key];
  state.metrics["llamacpp:kv_cache_usage_ratio"] = 2;
  state.metrics["halogen:draft_tokens_accepted_total"] = -1;
  const snap = await poll();
  assert.equal(snap.requestsRunning, 2);
  assert.equal(snap.requestsWaiting, 0);
  for (const key of ["totalPromptTokens", "totalCachedTokens", "prefixCacheHitRate", "kvCacheUsage", "kvCacheTokens", "kvCacheTokensAvailable", "mtpAcceptanceRate"]) assert.equal(snap[key], null, key);
});

test("restart, model/version changes and clock gaps rebase without rate spikes", async (t) => {
  const { state, poll } = setup(t);
  await poll();
  finish(state);
  assert.equal((await poll()).generationMeasurementValid, false);
  state.metrics = { ...defaults };
  assert.equal((await poll()).measurementValid, false);
  finish(state);
  assert.equal((await poll()).generationMeasurementValid, false);
  for (const gap of [20000, -2000, 0]) {
    finish(state);
    const snap = await poll(gap);
    assert.equal(snap.measurementValid, false);
    assert.equal(snap.generationTps, 0);
    assert.equal(snap.prefillMeasurementValid, false);
    assert.equal(snap.prefillMeasuredAt, null);
    assert.equal(snap.generationMeasurementValid, false);
    assert.equal(snap.generationMeasuredAt, null);
  }
  for (const change of [() => { state.health.model = "replacement"; }, () => { state.health.version.engine = "0.20.1"; }]) {
    change();
    finish(state);
    assert.equal((await poll()).measurementValid, false);
    finish(state);
    assert.equal((await poll()).generationMeasurementValid, false);
  }
});

for (const failure of [500, 401, 403, "timeout", "html", "missing", "negative", "NaN", "Infinity"]) {
  test(`failed metrics (${failure}) cannot retain rates and recovery only seeds`, async (t) => {
    const { state, poll } = setup(t);
    await poll();
    finish(state);
    assert.equal((await poll()).generationMeasurementValid, false);
    if ([500, 401, 403, "timeout"].includes(failure)) state.status["/metrics"] = failure;
    else if (failure === "html") state.body = "<html>not metrics</html>";
    else state.metrics["llamacpp:tokens_predicted_total"] = ({ missing: undefined, negative: -1, NaN: "NaN", Infinity: "+Inf" })[failure];
    const snap = await poll();
    assert.equal(snap.available, false);
    assert.equal(snap.generationTps, 0);
    assert.equal(snap.engineVersion, null);
    if (failure === 401 || failure === 403) assert.equal(snap.posture.auth, "protected");
    state.status = {};
    state.body = undefined;
    state.metrics = { ...defaults };
    finish(state);
    const recovered = await poll();
    assert.equal(recovered.measurementValid, false);
    assert.equal(recovered.prefillMeasurementValid, false);
    assert.equal(recovered.prefillMeasuredAt, null);
    assert.equal(recovered.generationMeasurementValid, false);
    assert.equal(recovered.generationMeasuredAt, null);
    finish(state);
    assert.equal((await poll()).generationMeasurementValid, false);
  });
}

test("health down, protected models, missing version, and endpoint changes do not retain stale state", async (t) => {
  const { probe, state, poll } = setup(t);
  await poll();
  finish(state);
  await poll();
  state.status["/v1/models"] = 401;
  let snap = await poll();
  assert.equal(snap.available, false);
  assert.equal(snap.generationTps, 0);
  state.status = {};
  state.health.engine.responds = false;
  assert.equal((await poll()).available, false);
  state.health.engine.responds = true;
  delete state.health.version;
  assert.equal((await poll()).engineVersion, null);
  probe.setPort(8732);
  assert.equal(probe._halogenBase, null);
  assert.equal((await poll()).generationTps, 0);
});

test("malformed health is unavailable and missing load is not zero occupancy", async (t) => {
  const { state, poll } = setup(t);
  const health = state.health;
  for (const body of [null, {}, { status: "ok" }, { ...health, model: "" }, { ...health, status: "loading" }]) {
    state.health = body;
    assert.equal((await poll()).available, false);
  }
  state.health = { ...health };
  delete state.health.in_flight;
  delete state.health.queued;
  delete state.metrics["llamacpp:requests_processing"];
  delete state.metrics["llamacpp:requests_deferred"];
  const snap = await poll();
  assert.equal(snap.slotsActive, null);
  assert.equal(snap.requestsRunning, null);
  assert.equal(snap.requestsWaiting, null);
});

test("streaming counter reader uses Halogen's completed tokens, including scientific notation", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "http://fixture/metrics");
    return response("llamacpp:tokens_predicted_total 1.25e3\nhalogen:draft_tokens_total 9999\n");
  });
  assert.equal(await readServerGenerationTokens("http://fixture"), 1250);
});
