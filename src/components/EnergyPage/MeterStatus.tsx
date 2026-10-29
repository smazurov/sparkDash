import type { MeteredFleetEnergy, PowerMeterMeterStatus } from "../../api/powerMeters";
import { activeTimeZone } from "../../shared/timeZone";
import { Tag } from "../ui/Tag";

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: activeTimeZone() });
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", timeZone: activeTimeZone() });
}

/** One sentence on where a meter's history stands. */
export function describeMeterHistory(meter: PowerMeterMeterStatus, reconciledThroughMs: number | null): string {
  const h = meter.history;
  switch (h.state) {
    case "backfilling":
      return h.backfill
        ? `${meter.id}: loading history, through ${day(h.backfill.throughMs)}`
        : `${meter.id}: loading history`;
    case "ok":
      return reconciledThroughMs != null
        ? `${meter.id}: meter record through ${clock(reconciledThroughMs)}`
        : `${meter.id}: history loaded`;
    case "error":
      return `${meter.id}: history failed (${h.lastError ?? "unknown error"}); showing live readings`;
    case "unsupported":
      return `${meter.id}: live readings only, this meter keeps no history`;
    case "unavailable":
      return `${meter.id}: unavailable (${meter.error ?? "not started"})`;
    case "off":
      return `${meter.id}: history off, live readings only`;
    default:
      return `${meter.id}: waiting for history`;
  }
}

/** Per-unit wall power right now, plus each meter's reconciliation state. */
export function MeterStatusLine({ live }: { live: MeteredFleetEnergy }) {
  return (
    <span className="en-meter-status">
      {live.units.map((u) => (
        <Tag
          key={u.id}
          tone={u.fresh ? "good" : "warn"}
          title={u.error ? `${u.channel}: ${u.error}` : `${u.meter} · ${u.channel}`}
        >
          {u.name} {u.fresh && u.watts != null ? `${Math.round(u.watts)} W` : "no reading"}
        </Tag>
      ))}
      {live.meters.map((m) => {
        const marks = live.units
          .filter((u) => u.meter === m.id)
          .map((u) => u.reconciledThroughMs)
          .filter((v): v is number => v != null);
        const through = marks.length ? Math.min(...marks) : null;
        return (
          <span key={m.id} className="en-meter-status__meter" title={m.target ?? undefined}>
            {describeMeterHistory(m, through)}
          </span>
        );
      })}
    </span>
  );
}
