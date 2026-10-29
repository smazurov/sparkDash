# Power meters (wall power)

sparkDash estimates each unit's power from GPU and CPU telemetry. That estimate leaves out
power-supply losses and everything else in the box, and on a DGX Spark it reads roughly 30–40 %
below the wall. If your units sit on metered outlets (a smart power strip, a smart plug, a metered
PDU), sparkDash can read those meters and show **measured** energy instead.

This is opt-in and self-contained:

- **Nothing runs without a config file.** With no `config/power-meters.json` the feature makes no
  network requests, starts no timers and adds nothing to the UI; `GET /api/power-meters` answers
  `{ "enabled": false, "state": "absent" }`.
- **The estimate is untouched.** Metered data lives in its own store
  (`config/power-meter-energy.json`), behind its own routes, and the estimated accounting keeps
  running beside it. The Energy page gets a **Metered / Estimated** switch; the Overview energy
  card shows metered figures while meters are configured.
- **Meters are providers.** A provider reads one kind of meter. Home Assistant is the first one,
  which already covers most smart plugs and strips (Matter, Zigbee, Wi-Fi) and many PDUs through
  their HA integrations. Other meters can be added as providers without touching the rest of
  sparkDash (see [Adding a provider](#adding-a-provider)).

## Configure

Create `config/power-meters.json`, or point `POWER_METERS_CONFIG_PATH` at the file:

```json
{
  "meters": {
    "ha": {
      "type": "homeassistant",
      "url": "https://homeassistant.local:8123",
      "tokenEnv": "HOME_ASSISTANT_TOKEN"
    }
  },
  "units": {
    "spark-6bb0": {
      "meter": "ha",
      "channel": "sensor.living_room_power_strip_power_3",
      "since": "2026-08-13T00:00:00Z"
    },
    "spark-4d48": {
      "meter": "ha",
      "channel": "sensor.living_room_power_strip_power_4",
      "since": "2026-08-13T00:00:00Z"
    }
  }
}
```

| Key | Meaning |
|-----|---------|
| `meters.<id>` | One meter. `<id>` is your name for it; changing it later discards stored metered history. |
| `meters.<id>.type` | Provider: `homeassistant`. |
| `units.<unitId>` | A registered unit's id (as in `sparks.json`) mapped to one meter channel. |
| `units.<unitId>.channel` | The provider's name for that outlet's power reading (for Home Assistant, a power sensor's entity id). |
| `units.<unitId>.since` | Optional ISO time the unit was plugged into that outlet. Meter history from before it is ignored, so readings from whatever used the outlet earlier are not counted. |
| `pollIntervalMs` | Live poll interval, default `10000` (2–300 s). |
| `staleAfterMs` | A reading older than this (by the meter's own timestamp) is not used; default `max(30 s, 3 × poll)`. |
| `history.enabled` | Read the meters' own history, default `true`. |
| `history.backfillDays` | How far back the first start backfills, default `400`. |
| `enabled` | `false` switches the feature off without deleting the file. |

The file holds no credentials. A meter that needs one names the environment variable that
carries it. An invalid file keeps the feature off and logs the reason; `GET /api/power-meters`
returns it as `error`. Restart sparkDash after editing the file.

If a unit's channel or meter changes, the history stored for it came from another outlet, so it
is discarded; a meter with history backfills it again.

### Home Assistant

- **Channel**: any sensor with a power unit (`W`, `kW`, `mW`), such as a plug's or strip
  outlet's power entity. Its `last_reported` time decides freshness, so a device that stops
  reporting goes stale even while HA still shows its last value. `unavailable`/`unknown` is a
  missing reading, never zero.
- **Token**: a long-lived access token in the variable `tokenEnv` names (default
  `HOME_ASSISTANT_TOKEN`). Give sparkDash its own HA user, so the token can be revoked on its own.
  The token can do anything that user can, so a read-only user is enough and safer.
- **History** comes from the recorder's long-term statistics over HA's WebSocket API, so the
  sensor needs a `state_class` (power sensors from integrations normally have
  `measurement`). HA keeps 5-minute statistics for its purge window (10 days by default) and hourly
  statistics indefinitely.
- **TLS**: an HA with a private CA needs that CA trusted by Node:
  `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. Without it the meter reports
  `TLS certificate not trusted`.

## How live and history are reconciled

Live readings appear first. Every poll, each unit's reading is integrated into a 5-minute bucket
marked **live**. Energy shows up on the Energy page within seconds.

The meter's own record follows. For a meter that keeps history, sparkDash runs a reconcile pass
45 s after every 5-minute boundary. It fetches the meter's 5-minute statistics and overwrites the
live buckets they cover with the meter's figures, marked **meter**. Once an hour it also fetches
hourly statistics. Live data never overwrites a meter bucket.

- **First start**: hourly history is backfilled back to each unit's `since` (at most
  `history.backfillDays`), and 5-minute history for as long as the meter keeps it.
- **After downtime**: the first pass after a restart continues from where the last one stopped,
  so time sparkDash was not running is filled from the meter's record.
- **Meters without history** stay live-only; their buckets are kept like any others.

Storage tiers: 5-minute buckets for 35 days, then folded into hourly buckets kept about five
years. Each hour uses whichever tier covers more of it. Each history row carries
`nodeMeteredMs`, the per-unit part of its coverage confirmed by the meter's record.

Coverage and efficiency follow the estimate's rules. Per-unit figures count while that unit was
metered, fleet figures only while every unit was. Wh per token uses the estimate's token counts,
in hours every unit was metered.

## API

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/power-meters` | `enabled`, `state`, meters (type, display target, health, history state) and each unit's current reading |
| GET | `/api/power-meters/energy` | Live summary in the `GET /api/fleet-energy` shape, `estimated: false`, plus `units` and `meters` |
| GET | `/api/power-meters/energy/history` | Hourly rows in the `GET /api/fleet-energy/history` shape for the last 62 days |
| GET | `/api/power-meters/energy/monthly` | Per-UTC-month roll-up in the `GET /api/fleet-energy/monthly` shape |
| POST | `/api/power-meters/reconcile` | Runs a reconcile pass now; returns the status |

Every route sits behind the dashboard's authentication like the rest of the API. While the feature
is off, only the status route answers, and the others return `404`. With Prometheus export on,
`/metrics` adds `sparkdash_wall_power_watts{unit,meter}` for every fresh reading.

## Adding a provider

Providers live in `server/powermeter/providers/` and are listed in `providers/index.js`. That
file documents the contract:

- `validate(spec)` and optionally `validateChannel(channel)` check the config entry.
- `create(spec, { env })` returns an instance.
- `readPower(channels)` returns `{ watts, atMs, error? }` per channel, where `atMs` is when the
  meter last reported.
- Optionally, `readHistory(channels, { fromMs, toMs, period })` returns the meter's time-weighted
  mean watts per `5minute` or `hour` period.

A meter that cannot supply its own timestamp should use the time of the read. Nothing outside
`server/powermeter/` needs to change.
