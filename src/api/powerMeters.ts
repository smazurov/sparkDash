/**
 * Optional power meters (server/powermeter, docs/POWER-METERS.md). The energy payloads
 * share the estimated contracts — FleetEnergy, EnergyHistory, MonthlyEnergy — with
 * `estimated: false`, so the Energy page renders either source with the same code.
 */
import { apiFetch } from "./client";
import type { EnergyHistory, EnergyHistoryRow, FleetEnergy, MonthlyEnergy } from "./types";

export interface PowerMeterUnitStatus {
  id: string;
  name: string;
  /** False when the id in power-meters.json is not a registered unit. */
  known: boolean;
  meter: string;
  channel: string;
  sinceMs: number | null;
  watts: number | null;
  /** When the meter itself last reported. */
  atMs: number | null;
  fresh: boolean;
  error: string | null;
  polledAtMs: number | null;
  /** End of the newest period the meter's own record has confirmed. */
  reconciledThroughMs: number | null;
}

export type PowerMeterHistoryState =
  | "pending"
  | "backfilling"
  | "ok"
  | "error"
  | "unsupported"
  | "unavailable"
  | "off";

export interface PowerMeterMeterStatus {
  id: string;
  type: string;
  /** Display target (a URL or host), never a credential. */
  target: string | null;
  ok: boolean;
  error: string | null;
  lastOkAt: number | null;
  history: {
    state: PowerMeterHistoryState;
    lastOkAt: number | null;
    lastError: string | null;
    backfill: { fromMs: number; throughMs: number; startedAt: number; doneAt?: number } | null;
  };
}

export type PowerMeterStatus =
  | { enabled: false; state: "absent" | "disabled" | "invalid"; error?: string }
  | {
      enabled: true;
      state: "ok";
      configPath: string;
      pollIntervalMs: number;
      staleAfterMs: number;
      history: { enabled: boolean; backfillDays: number };
      meters: PowerMeterMeterStatus[];
      units: PowerMeterUnitStatus[];
    };

export interface MeteredFleetEnergy extends FleetEnergy {
  source: "meter";
  units: PowerMeterUnitStatus[];
  meters: PowerMeterMeterStatus[];
}

export interface MeteredEnergyHistoryRow extends EnergyHistoryRow {
  /** Per node, the part of its coverage confirmed by the meter's own record. */
  nodeMeteredMs: Record<string, number>;
}

export interface MeteredEnergyHistory extends EnergyHistory {
  source: "meter";
  hourly: MeteredEnergyHistoryRow[];
}

export function fetchPowerMeterStatus(): Promise<PowerMeterStatus> {
  return apiFetch("/api/power-meters");
}

export function fetchMeteredEnergy(): Promise<MeteredFleetEnergy> {
  return apiFetch("/api/power-meters/energy");
}

export function fetchMeteredEnergyHistory(): Promise<MeteredEnergyHistory> {
  return apiFetch("/api/power-meters/energy/history");
}

export function fetchMeteredMonthlyEnergy(): Promise<MonthlyEnergy> {
  return apiFetch("/api/power-meters/energy/monthly");
}
