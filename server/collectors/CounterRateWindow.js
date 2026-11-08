/**
 * A completion-attributed counter rate over a fixed wall-clock window.
 * Deltas belong to the scrape that first observes them; no token emission times
 * are inferred between scrapes. A full observed window is required before even
 * a zero is publishable. Resets, clock reversal and polling gaps restart warmup.
 */
export class CounterRateWindow {
  constructor(windowMs = 60_000, maxGapMs = 10_000) {
    this.windowMs = windowMs;
    this.maxGapMs = maxGapMs;
    this.samples = [];
  }

  clear() {
    this.samples = [];
  }

  observe(value, at) {
    if (!Number.isFinite(value) || value < 0 || !Number.isFinite(at)) {
      this.clear();
      return null;
    }
    const last = this.samples.at(-1);
    if (last && (at <= last.at || at - last.at >= this.maxGapMs || value < last.value)) this.clear();
    this.samples.push({ value, at });
    const cutoff = at - this.windowMs;
    // Keep the last observed counter at/before the left boundary. Its value is
    // the baseline, not a completion to be counted again. Memory stays bounded
    // by the window plus one anchor, even when the endpoint is idle for days.
    while (this.samples.length > 1 && this.samples[1].at <= cutoff) this.samples.shift();
    const base = this.samples[0];
    if (base.at > cutoff) return null;
    return (value - base.value) / (this.windowMs / 1000);
  }
}
