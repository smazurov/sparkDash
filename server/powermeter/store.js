/**
 * Metered energy per unit, in two tiers:
 *
 *   fine    5-minute buckets, kept FINE_RETENTION_MS (35 days)
 *   coarse  1-hour buckets, kept COARSE_RETENTION_MS (about five years)
 *
 * Each bucket remembers where it came from. `live` buckets are integrated from this
 * process's own polls and appear first; `meter` buckets are the meter's own record
 * (a Home Assistant statistics row, say) and replace live ones when they arrive. Live
 * data never overwrites a meter bucket. When fine buckets age out they are folded into
 * the coarse tier unless the meter already supplied a better hour, so live-only meters
 * keep their history too.
 *
 * A unit is bound to a channel key (meter id, type, channel). If the configuration later
 * points the unit at another outlet, its stored history belongs to a different device and
 * is dropped; meters that keep history backfill it again.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import { writeStateAtomically } from "../energy/atomicWrite.js";

export const FINE_MS = 5 * 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const FINE_RETENTION_MS = 35 * DAY_MS;
export const COARSE_RETENTION_MS = 5 * 366 * DAY_MS;
/** Plausibility ceiling for one unit (a stored bucket above it is treated as corrupt). */
const MAX_UNIT_WATTS = 20_000;
const FILE_VERSION = 1;
const SOURCE_CODES = { live: 0, meter: 1 };
const SOURCE_NAMES = ["live", "meter"];

export const POWER_METER_ENERGY_JSON_PATH =
  process.env.POWER_METER_ENERGY_JSON_PATH || path.join(ROOT, "config", "power-meter-energy.json");

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
const floorTo = (ms, step) => Math.floor(ms / step) * step;

function emptyUnit(key) {
  return { key, fine: new Map(), coarse: new Map(), watermarks: {}, backfill: null };
}

function restoreBuckets(rows, step) {
  const out = new Map();
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const [start, wh, covMs, maxW, code] = row;
    if (!Number.isSafeInteger(start) || start % step !== 0) continue;
    if (!Number.isFinite(wh) || wh < 0 || !Number.isFinite(covMs) || covMs <= 0 || covMs > step) continue;
    if (wh > (MAX_UNIT_WATTS * covMs) / HOUR_MS) continue;
    const src = SOURCE_NAMES[code];
    if (!src) continue;
    out.set(start, { wh, covMs, maxW: Number.isFinite(maxW) ? maxW : null, src });
  }
  return out;
}

function serializeBuckets(map) {
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, b]) => [start, round(b.wh, 4), Math.round(b.covMs), b.maxW == null ? null : round(b.maxW, 2), SOURCE_CODES[b.src]]);
}

export class PowerMeterStore {
  constructor({
    filePath = null,
    now = () => Date.now(),
    fileSystem = fs,
    writeState = writeStateAtomically,
    fineRetentionMs = FINE_RETENTION_MS,
    coarseRetentionMs = COARSE_RETENTION_MS,
    logger = console,
  } = {}) {
    this.filePath = filePath;
    this._now = now;
    this._fs = fileSystem;
    this._writeState = writeState;
    this.fineRetentionMs = fineRetentionMs;
    this.coarseRetentionMs = coarseRetentionMs;
    this._logger = logger;
    /** @type {Map<string, ReturnType<typeof emptyUnit>>} */
    this._units = new Map();
    this._dirty = false;
  }

  load() {
    if (!this.filePath) return;
    let raw;
    try {
      raw = JSON.parse(this._fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this._logger.warn?.(`[powerMeters] ignoring unreadable ${this.filePath}: ${error.message}`);
      }
      return;
    }
    if (raw?.version !== FILE_VERSION || raw.units == null || typeof raw.units !== "object") {
      this._logger.warn?.(`[powerMeters] ignoring ${this.filePath}: unknown format`);
      return;
    }
    for (const [unitId, stored] of Object.entries(raw.units)) {
      if (typeof stored?.key !== "string") continue;
      const unit = emptyUnit(stored.key);
      unit.fine = restoreBuckets(stored.fine, FINE_MS);
      unit.coarse = restoreBuckets(stored.coarse, HOUR_MS);
      for (const [period, ms] of Object.entries(stored.watermarks ?? {})) {
        if (Number.isSafeInteger(ms)) unit.watermarks[period] = ms;
      }
      if (typeof stored.backfill?.key === "string" && Number.isSafeInteger(stored.backfill.doneAtMs)) {
        unit.backfill = { key: stored.backfill.key, doneAtMs: stored.backfill.doneAtMs };
      }
      this._units.set(unitId, unit);
    }
  }

  /**
   * Attach a unit to its channel. A different stored key means another outlet: that
   * history is discarded rather than presented as this unit's.
   */
  bindUnit(unitId, key) {
    const existing = this._units.get(unitId);
    if (existing && existing.key === key) return existing;
    if (existing) {
      this._logger.warn?.(`[powerMeters] ${unitId} now reads ${key}; discarding its history from ${existing.key}`);
    }
    const unit = emptyUnit(key);
    this._units.set(unitId, unit);
    this._dirty = true;
    return unit;
  }

  unit(unitId) {
    return this._units.get(unitId) ?? null;
  }

  /** Integrate a constant `watts` over [fromMs, toMs) into live fine buckets. */
  addLive(unitId, fromMs, toMs, watts) {
    const unit = this._units.get(unitId);
    if (!unit || !(toMs > fromMs) || !Number.isFinite(watts) || watts < 0 || watts > MAX_UNIT_WATTS) return;
    let t = fromMs;
    while (t < toMs) {
      const start = floorTo(t, FINE_MS);
      const end = Math.min(toMs, start + FINE_MS);
      let bucket = unit.fine.get(start);
      if (bucket?.src !== "meter") {
        if (!bucket) {
          bucket = { wh: 0, covMs: 0, maxW: null, src: "live" };
          unit.fine.set(start, bucket);
        }
        const ms = Math.min(end - t, FINE_MS - bucket.covMs);
        if (ms > 0) {
          bucket.wh += (watts * ms) / HOUR_MS;
          bucket.covMs += ms;
          bucket.maxW = bucket.maxW == null ? watts : Math.max(bucket.maxW, watts);
          this._dirty = true;
        }
      }
      t = end;
    }
  }

  /**
   * Apply the meter's own periods. 5-minute periods land in the fine tier and hourly ones
   * in the coarse tier; anything else, unaligned, before `sinceMs`, unfinished or outside
   * retention is ignored. Returns how many periods were applied.
   */
  applyMeterPeriods(unitId, periods, { sinceMs = null } = {}) {
    const unit = this._units.get(unitId);
    if (!unit || !Array.isArray(periods)) return 0;
    const nowMs = this._now();
    let applied = 0;
    for (const p of periods) {
      const duration = p.endMs - p.startMs;
      const tier = duration === FINE_MS ? "fine" : duration === HOUR_MS ? "coarse" : null;
      if (!tier || p.startMs % duration !== 0 || p.endMs > nowMs) continue;
      if (sinceMs != null && p.startMs < sinceMs) continue;
      const retention = tier === "fine" ? this.fineRetentionMs : this.coarseRetentionMs;
      if (p.startMs < nowMs - retention) continue;
      if (!Number.isFinite(p.meanW) || p.meanW < 0 || p.meanW > MAX_UNIT_WATTS) continue;
      const maxW = Number.isFinite(p.maxW) ? p.maxW : p.meanW;
      unit[tier].set(p.startMs, { wh: (p.meanW * duration) / HOUR_MS, covMs: duration, maxW, src: "meter" });
      applied += 1;
    }
    if (applied) this._dirty = true;
    return applied;
  }

  watermark(unitId, period) {
    return this._units.get(unitId)?.watermarks[period] ?? null;
  }

  setWatermark(unitId, period, ms) {
    const unit = this._units.get(unitId);
    if (!unit || !Number.isSafeInteger(ms)) return;
    if ((unit.watermarks[period] ?? -Infinity) >= ms) return;
    unit.watermarks[period] = ms;
    this._dirty = true;
  }

  backfillDone(unitId, key) {
    return this._units.get(unitId)?.backfill?.key === key;
  }

  markBackfilled(unitId, key) {
    const unit = this._units.get(unitId);
    if (!unit) return;
    unit.backfill = { key, doneAtMs: Math.floor(this._now()) };
    this._dirty = true;
  }

  /**
   * Per-hour totals for one unit over [fromMs, toMs), choosing for each hour whichever tier
   * covers more of it (fine on a tie, since it carries the 5-minute detail).
   * @returns {Map<number, { wh: number, covMs: number, meteredMs: number, maxW: number | null,
   *   slots: Array<{ wh: number, covMs: number } | null> | null }>}
   */
  hours(unitId, fromMs, toMs) {
    const unit = this._units.get(unitId);
    const out = new Map();
    if (!unit) return out;
    const from = floorTo(fromMs, HOUR_MS);
    const fineByHour = new Map();
    for (const [start, b] of unit.fine) {
      if (start < from || start >= toMs) continue;
      const hour = floorTo(start, HOUR_MS);
      let agg = fineByHour.get(hour);
      if (!agg) {
        agg = { wh: 0, covMs: 0, meteredMs: 0, maxW: null, slots: Array(HOUR_MS / FINE_MS).fill(null) };
        fineByHour.set(hour, agg);
      }
      agg.wh += b.wh;
      agg.covMs += b.covMs;
      if (b.src === "meter") agg.meteredMs += b.covMs;
      if (b.maxW != null) agg.maxW = agg.maxW == null ? b.maxW : Math.max(agg.maxW, b.maxW);
      agg.slots[(start - hour) / FINE_MS] = { wh: b.wh, covMs: b.covMs };
    }
    for (const [hour, agg] of fineByHour) out.set(hour, agg);
    for (const [hour, b] of unit.coarse) {
      if (hour < from || hour >= toMs) continue;
      const fine = out.get(hour);
      if (fine && fine.covMs >= b.covMs) continue;
      out.set(hour, { wh: b.wh, covMs: b.covMs, meteredMs: b.src === "meter" ? b.covMs : 0, maxW: b.maxW, slots: null });
    }
    return out;
  }

  /** Fine buckets for one unit over [fromMs, toMs), for sub-hour views. */
  fineBuckets(unitId, fromMs, toMs) {
    const unit = this._units.get(unitId);
    const out = new Map();
    if (!unit) return out;
    for (const [start, b] of unit.fine) if (start >= fromMs && start < toMs) out.set(start, b);
    return out;
  }

  /** Earliest stored hour across the given units, or null. */
  earliest(unitIds) {
    let min = null;
    for (const id of unitIds) {
      const unit = this._units.get(id);
      if (!unit) continue;
      for (const map of [unit.fine, unit.coarse]) {
        for (const start of map.keys()) if (min == null || start < min) min = start;
      }
    }
    return min == null ? null : floorTo(min, HOUR_MS);
  }

  /** Fold aged fine buckets into hours and drop what is past retention. */
  prune(nowMs = this._now()) {
    const fineCutoff = floorTo(nowMs - this.fineRetentionMs, HOUR_MS);
    const coarseCutoff = nowMs - this.coarseRetentionMs;
    for (const unit of this._units.values()) {
      const folded = new Map();
      for (const [start, b] of unit.fine) {
        if (start >= fineCutoff) continue;
        const hour = floorTo(start, HOUR_MS);
        const agg = folded.get(hour) ?? { wh: 0, covMs: 0, maxW: null, allMeter: true };
        agg.wh += b.wh;
        agg.covMs += b.covMs;
        if (b.maxW != null) agg.maxW = agg.maxW == null ? b.maxW : Math.max(agg.maxW, b.maxW);
        if (b.src !== "meter") agg.allMeter = false;
        folded.set(hour, agg);
        unit.fine.delete(start);
        this._dirty = true;
      }
      for (const [hour, agg] of folded) {
        const existing = unit.coarse.get(hour);
        if (existing && existing.covMs >= agg.covMs) continue;
        unit.coarse.set(hour, {
          wh: agg.wh,
          covMs: Math.min(HOUR_MS, agg.covMs),
          maxW: agg.maxW,
          src: agg.allMeter && agg.covMs >= HOUR_MS ? "meter" : "live",
        });
      }
      for (const hour of unit.coarse.keys()) {
        if (hour < coarseCutoff) {
          unit.coarse.delete(hour);
          this._dirty = true;
        }
      }
    }
  }

  flush() {
    if (!this.filePath || !this._dirty) return true;
    const units = {};
    for (const [unitId, unit] of this._units) {
      units[unitId] = {
        key: unit.key,
        fine: serializeBuckets(unit.fine),
        coarse: serializeBuckets(unit.coarse),
        watermarks: unit.watermarks,
        backfill: unit.backfill,
      };
    }
    this._writeState(
      this.filePath,
      JSON.stringify({ version: FILE_VERSION, savedAt: Math.floor(this._now()), units }),
      this._fs
    );
    this._dirty = false;
    return true;
  }
}
