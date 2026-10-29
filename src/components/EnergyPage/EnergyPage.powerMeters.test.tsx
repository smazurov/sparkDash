import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnergyPage } from "./EnergyPage";
import { FleetEnergyCard } from "../OverviewPage/FleetEnergyCard";
import { flush, render } from "../../testing/render";
import type { EnergyHistory, FleetEnergy, MonthlyEnergy, SparkSnapshot } from "../../api/types";
import type { MeteredEnergyHistory, MeteredFleetEnergy, PowerMeterStatus } from "../../api/powerMeters";
import { resetPowerMeterStatusCache } from "../../hooks/usePowerMeters";

vi.mock("../../api/client", () => ({
  fetchFleetEnergy: vi.fn(),
  fetchEnergyHistory: vi.fn(),
  fetchMonthlyEnergy: vi.fn(),
  clearFleetEnergy: vi.fn(),
  fetchRestartAvailable: vi.fn().mockResolvedValue({ available: false }),
  restartServer: vi.fn(),
}));
vi.mock("../../api/powerMeters", () => ({
  fetchPowerMeterStatus: vi.fn(),
  fetchMeteredEnergy: vi.fn(),
  fetchMeteredEnergyHistory: vi.fn(),
  fetchMeteredMonthlyEnergy: vi.fn(),
}));

import { fetchEnergyHistory, fetchFleetEnergy, fetchMonthlyEnergy } from "../../api/client";
import {
  fetchMeteredEnergy,
  fetchMeteredEnergyHistory,
  fetchMeteredMonthlyEnergy,
  fetchPowerMeterStatus,
} from "../../api/powerMeters";

const HOUR = 3_600_000;
const now = Date.now();
const lastHour = Math.floor(now / HOUR) * HOUR - HOUR;
const sparks = [
  { id: "spark-a", name: "Dan" },
  { id: "spark-b", name: "Stepan" },
] as unknown as SparkSnapshot[];

function live(overrides: Partial<FleetEnergy> = {}): FleetEnergy {
  return {
    estimated: true,
    membershipChanged: false,
    restartRequired: false,
    trackedNodeIds: ["spark-a", "spark-b"],
    currentNodeIds: ["spark-a", "spark-b"],
    freshNodeCount: 2,
    currentWatts30s: 80,
    energy24hKwh: 1.9,
    energy31dKwh: 30,
    whPerOutputToken24h: null,
    outputTokens24h: 0,
    coverage24hMs: 86_400_000,
    coverage24hWindowMs: 86_400_000,
    coverage31dMs: 0,
    coverage31dWindowMs: 86_400_000 * 31,
    nodeCoverage24hMs: {},
    nodeCoverage31dMs: {},
    hourlyWatts24h: Array(24).fill(80),
    ...overrides,
  };
}

function history(estimated: boolean, watts: number): EnergyHistory {
  return {
    estimated,
    membershipChanged: false,
    generatedAt: now,
    retentionMs: 31 * 24 * HOUR,
    nodeIds: ["spark-a", "spark-b"],
    hourly: [
      {
        t: lastHour,
        nodeWh: { "spark-a": watts / 2, "spark-b": watts / 2 },
        nodeCoverageMs: { "spark-a": HOUR, "spark-b": HOUR },
        avgWatts: watts,
        fleetEnergyWh: watts,
        fleetCoverageMs: HOUR,
        outputTokens: 0,
        coveredOutputTokens: 0,
      },
    ],
  };
}

const monthly = (estimated: boolean): MonthlyEnergy => ({ estimated, generatedAt: now, foldedThroughMs: now, months: [] });

const enabledStatus: PowerMeterStatus = {
  enabled: true,
  state: "ok",
  configPath: "/etc/sparkdash/power-meters.json",
  pollIntervalMs: 10_000,
  staleAfterMs: 30_000,
  history: { enabled: true, backfillDays: 400 },
  meters: [],
  units: [],
};

const meteredLive: MeteredFleetEnergy = {
  ...live({ estimated: false, currentWatts30s: 110 }),
  source: "meter",
  units: [
    { id: "spark-a", name: "Dan", known: true, meter: "ha", channel: "sensor.p3", sinceMs: null, watts: 55.4, atMs: now, fresh: true, error: null, polledAtMs: now, reconciledThroughMs: lastHour + HOUR },
    { id: "spark-b", name: "Stepan", known: true, meter: "ha", channel: "sensor.p4", sinceMs: null, watts: null, atMs: null, fresh: false, error: "entity is unavailable", polledAtMs: now, reconciledThroughMs: lastHour + HOUR },
  ],
  meters: [
    { id: "ha", type: "homeassistant", target: "https://ha.lan", ok: false, error: "spark-b: entity is unavailable", lastOkAt: now, history: { state: "ok", lastOkAt: now, lastError: null, backfill: null } },
  ],
};

beforeEach(() => {
  resetPowerMeterStatusCache();
  vi.mocked(fetchFleetEnergy).mockResolvedValue(live());
  vi.mocked(fetchEnergyHistory).mockResolvedValue(history(true, 80));
  vi.mocked(fetchMonthlyEnergy).mockResolvedValue(monthly(true));
  vi.mocked(fetchMeteredEnergy).mockResolvedValue(meteredLive);
  vi.mocked(fetchMeteredEnergyHistory).mockResolvedValue(history(false, 110) as MeteredEnergyHistory);
  vi.mocked(fetchMeteredMonthlyEnergy).mockResolvedValue(monthly(false));
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await flush();
}

describe("Energy page with power meters", () => {
  it("stays on the estimate, with no source switch, when no meters are configured", async () => {
    vi.mocked(fetchPowerMeterStatus).mockResolvedValue({ enabled: false, state: "absent" });
    const { container } = render(<EnergyPage sparks={sparks} settings={null} />);
    await settle();
    expect(container.querySelector('[aria-label="Energy source"]')).toBeNull();
    expect(container.textContent).toContain("Estimated, not metered.");
    expect(fetchMeteredEnergyHistory).not.toHaveBeenCalled();
    expect(fetchMeteredMonthlyEnergy).not.toHaveBeenCalled();
  });

  it("defaults to metered figures, shows each unit's reading, and can switch back", async () => {
    vi.mocked(fetchPowerMeterStatus).mockResolvedValue(enabledStatus);
    const { container } = render(<EnergyPage sparks={sparks} settings={null} />);
    await settle();
    const group = container.querySelector('[aria-label="Energy source"]')!;
    const [meterBtn, estimateBtn] = [...group.querySelectorAll("button")];
    expect(meterBtn.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("Metered at the wall.");
    expect(container.textContent).toContain("Dan 55 W");
    expect(container.textContent).toContain("Stepan no reading");
    expect(container.textContent).toContain("ha: meter record through");
    expect(container.textContent).not.toContain("Reset…");
    expect(fetchMeteredEnergyHistory).toHaveBeenCalled();
    expect(fetchMeteredMonthlyEnergy).toHaveBeenCalled();

    await act(async () => estimateBtn.click());
    await settle();
    expect(estimateBtn.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("Estimated, not metered.");
    expect(container.textContent).toContain("Reset…");
    expect(fetchEnergyHistory).toHaveBeenCalled();
    expect(fetchMonthlyEnergy).toHaveBeenCalled();
  });
});

describe("Overview energy card with power meters", () => {
  it("reads the meters and says so", async () => {
    vi.mocked(fetchPowerMeterStatus).mockResolvedValue(enabledStatus);
    const { container } = render(<FleetEnergyCard nodeCount={2} />);
    await settle();
    expect(container.textContent).toContain("Metered at the wall");
    expect(container.textContent).toContain("110 W");
    expect(fetchMeteredEnergy).toHaveBeenCalled();
  });
});
