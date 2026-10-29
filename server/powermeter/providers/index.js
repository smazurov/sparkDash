/**
 * Power-meter providers.
 *
 * A provider reads one meter: a smart power strip, a PDU, a home-automation hub that
 * already polls one. A unit is attached to one *channel* of a meter, a provider-specific
 * string naming one outlet's power reading (a Home Assistant entity id, a Shelly switch
 * id, a PDU outlet number…). Adding hardware means adding one module here; nothing else
 * in sparkDash knows which providers exist.
 *
 * Module contract (`PROVIDER_TYPES[type]`):
 *
 *   validate(spec) → string[]                  problems with the meter's config entry
 *   validateChannel?(channel) → string | null   problem with one unit's channel string
 *   create(spec, { env, fetchImpl }) → Provider throws when the meter cannot be used
 *
 * Provider instance:
 *
 *   type: string
 *   describe() → { type, target }   safe to show in the UI: never a credential
 *   readPower(channels, { signal }) → Promise<Map<channel, PowerReading>>
 *     PowerReading = { watts: number | null, atMs: number | null, error?: string }
 *     `atMs` is when the meter itself last reported, not when it was asked. A channel
 *     that cannot be read gets `watts: null` and an `error`, never a fabricated 0.
 *
 *   Optional, for meters that keep their own record:
 *   historyPeriods: Array<"5minute" | "hour">
 *   readHistory(channels, { fromMs, toMs, period, signal }) → Promise<Map<channel, Period[]>>
 *     Period = { startMs, endMs, meanW, maxW? }   time-weighted mean over the period
 *     Periods the meter has no data for are simply absent.
 *
 *   close?()                         release sockets on shutdown
 */
import { homeAssistantProvider } from "./homeassistant.js";

export const PROVIDER_TYPES = Object.freeze({
  homeassistant: homeAssistantProvider,
});

/** Build a provider instance from a validated meter entry. */
export function createProvider(spec, options = {}) {
  const module = PROVIDER_TYPES[spec?.type];
  if (!module) throw new Error(`unknown power-meter type "${spec?.type}"`);
  return module.create(spec, options);
}
