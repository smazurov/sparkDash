import type { PowerMeterMeterStatus, PowerMeterStatus } from "../../api/powerMeters";
import type { FleetWallEnergy } from "../../api/types";
import { activeTimeZone } from "../../shared/timeZone";
import { Tag, type TagTone } from "../ui/Tag";
import { formatRatio } from "./wallStats";

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: activeTimeZone() });
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", timeZone: activeTimeZone() });
}

export function meterName(type: string): string {
  return type === "homeassistant" ? "Home Assistant" : type;
}

const HEALTH: Record<PowerMeterMeterStatus["health"], { tone: TagTone; label: string }> = {
  ok: { tone: "good", label: "Connected" },
  error: { tone: "bad", label: "Not reading" },
  pending: { tone: "neutral", label: "Connecting" },
  unavailable: { tone: "bad", label: "Unavailable" },
};

/** One sentence on where a meter's own history stands. */
export function describeHistory(meter: PowerMeterMeterStatus, reconciledThroughMs: number | null): string {
  const h = meter.history;
  switch (h.state) {
    case "backfilling":
      return h.backfill ? `loading history, through ${day(h.backfill.throughMs)}` : "loading history";
    case "ok":
      return reconciledThroughMs != null ? `meter record through ${clock(reconciledThroughMs)}` : "history loaded";
    case "error":
      return `history failed (${h.lastError ?? "unknown error"}); live readings continue`;
    case "unsupported":
      return "live readings only; this meter keeps no history";
    case "off":
      return "history off; live readings only";
    case "unavailable":
      return "not started";
    default:
      return "waiting for history";
  }
}

/**
 * Whether wall power is configured and working: each meter's connection and history, each
 * unit's current reading, and the ratio used where a unit has no reading (or no meter).
 */
export function MeterStatusPanel({
  status,
  wall,
  nameOf,
}: {
  status: PowerMeterStatus | null;
  wall?: FleetWallEnergy;
  nameOf: (id: string) => string;
}) {
  if (!status) return null;
  if (!status.enabled) {
    if (status.state !== "invalid") return null;
    return (
      <p className="en-banner en-banner--warn" role="alert">
        <b>Power meters are off:</b> {status.error}
      </p>
    );
  }
  const metered = new Set(status.units.map((u) => u.id));
  const unmetered = Object.keys(wall?.ratios ?? {}).filter((id) => !metered.has(id));
  return (
    <section className="panel en-meters" aria-label="Power meters">
      {status.meters.map((m) => {
        const units = status.units.filter((u) => u.meter === m.id);
        const marks = units.map((u) => u.reconciledThroughMs).filter((v): v is number => v != null);
        const health = HEALTH[m.health] ?? HEALTH.pending;
        return (
          <div key={m.id} className="en-meters__meter">
            <div className="en-meters__head">
              <Tag tone={health.tone} title={m.error ?? undefined}>{health.label}</Tag>
              <b>{meterName(m.type)}</b>
              {m.target ? <span className="mono en-meters__target">{m.target}</span> : null}
              <span className="en-meters__note">
                every {Math.round(status.pollIntervalMs / 1000)} s · {describeHistory(m, marks.length ? Math.min(...marks) : null)}
              </span>
            </div>
            {m.health === "error" || m.health === "unavailable" ? <p className="en-meters__error">{m.error}</p> : null}
            <div className="en-meters__units">
              {units.map((u) => {
                const ratio = wall?.ratios?.[u.id] ?? null;
                const label = u.fresh && u.watts != null
                  ? `${Math.round(u.watts)} W`
                  : ratio != null
                    ? `no reading, estimated at ${formatRatio(ratio)}`
                    : "no reading";
                return (
                  <Tag key={u.id} tone={u.fresh ? "good" : "warn"} title={`${u.channel}${u.error ? `: ${u.error}` : ""}`}>
                    {nameOf(u.id)} {label}
                  </Tag>
                );
              })}
              {unmetered.map((id) => (
                <Tag key={id} tone="neutral" title="No meter: wall power is the estimate times the fleet's measured ratio">
                  {nameOf(id)} no meter, estimated at {formatRatio(wall?.ratios?.[id])}
                </Tag>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
