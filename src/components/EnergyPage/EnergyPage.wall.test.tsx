import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnergyPage } from "./EnergyPage";
import { MonthlyEnergy } from "./MonthlyEnergy";
import { FleetEnergyCard } from "../OverviewPage/FleetEnergyCard";
import { flush, render } from "../../testing/render";
import type { EnergyHistory, EnergyHistoryRow, FleetEnergy, FleetWallEnergy, MonthlyEnergy as MonthlyEnergyData, SparkSnapshot } from "../../api/types";
import type { PowerMeterStatus } from "../../api/powerMeters";
import { resetPowerMeterStatusCache } from "../../hooks/usePowerMeters";

vi.mock("../../api/client", () => ({
  fetchFleetEnergy: vi.fn(),
  fetchEnergyHistory: vi.fn(),
  fetchMonthlyEnergy: vi.fn(),
  clearFleetEnergy: vi.fn(),
  fetchRestartAvailable: vi.fn().mockResolvedValue({ available: false }),
  restartServer: vi.fn(),
}));
vi.mock("../../api/powerMeters", () => ({ fetchPowerMeterStatus: vi.fn() }));

import { fetchEnergyHistory, fetchFleetEnergy, fetchMonthlyEnergy } from "../../api/client";
import { fetchPowerMeterStatus } from "../../api/powerMeters";

const HOUR = 3_600_000;
const now = Date.now();
const lastHour = Math.floor(now / HOUR) * HOUR - HOUR;
const sparks = [
  { id: "spark-a", name: "Dan", online: true, metrics: { gpu: { power: { draw: 12 } }, cpu: { draw: 6 } } },
  { id: "spark-b", name: "Stepan", online: true, metrics: { gpu: { power: { draw: 11 } }, cpu: { draw: 5 } } },
] as unknown as SparkSnapshot[];

function live(wall?: FleetWallEnergy): FleetEnergy {
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
    ...(wall ? { wall } : {}),
  };
}

const wall: FleetWallEnergy = {
  nodeIds: ["spark-a"],
  freshNodeIds: ["spark-a"],
  filledNodeIds: ["spark-b"],
  staleNodeIds: [],
  ratios: { "spark-a": 1.4, "spark-b": 1.41 },
  ownRatios: { "spark-a": 1.4 },
  fleetRatio: 1.41,
  currentWatts30s: 111,
  currentFilled: true,
  energy24hKwh: 2.9,
  filledEnergy24hKwh: 1.3,
  energy31dKwh: 80,
  whPerOutputToken24h: null,
  coverage24hMs: 86_400_000,
  coverage24hWindowMs: 86_400_000,
  coverage31dMs: 0,
  coverage31dWindowMs: 86_400_000 * 31,
  nodeCoverage24hMs: {},
  nodeCoverage31dMs: {},
  hourlyWatts24h: Array(24).fill(111),
};

const baseRow: EnergyHistoryRow = {
  t: lastHour,
  nodeWh: { "spark-a": 40, "spark-b": 40 },
  nodeCoverageMs: { "spark-a": HOUR, "spark-b": HOUR },
  avgWatts: 80,
  fleetEnergyWh: 80,
  fleetCoverageMs: HOUR,
  outputTokens: 0,
  coveredOutputTokens: 0,
};

function history(metered: boolean): EnergyHistory {
  return {
    estimated: true,
    membershipChanged: false,
    generatedAt: now,
    retentionMs: 31 * 24 * HOUR,
    nodeIds: ["spark-a", "spark-b"],
    ...(metered ? { wallNodeIds: ["spark-a"], wallRatios: { "spark-a": 1.4, "spark-b": 1.41 } } : {}),
    hourly: [
      metered
        ? {
            ...baseRow,
            nodeGpuWh: { "spark-a": 12, "spark-b": 11 },
            nodeCpuWh: { "spark-a": 6, "spark-b": 5 },
            nodePartsCoverageMs: { "spark-a": HOUR, "spark-b": HOUR },
            nodeWallWh: { "spark-a": 56, "spark-b": 0 },
            nodeWallCoverageMs: { "spark-a": HOUR, "spark-b": 0 },
            nodeWallMeteredMs: { "spark-a": HOUR, "spark-b": 0 },
            nodeWallFilledWh: { "spark-a": 0, "spark-b": 56.4 },
            nodeWallFilledMs: { "spark-a": 0, "spark-b": HOUR },
            avgWallWatts: 112.4,
            fleetWallWh: 112.4,
            fleetWallFilledWh: 56.4,
            fleetWallCoverageMs: HOUR,
            wallCoveredOutputTokens: 0,
          }
        : baseRow,
    ],
  };
}

const status: PowerMeterStatus = {
  enabled: true,
  state: "ok",
  configPath: "/etc/sparkdash/power-meters.json",
  pollIntervalMs: 10_000,
  staleAfterMs: 30_000,
  history: { enabled: true, backfillDays: 400 },
  meters: [
    {
      id: "ha",
      type: "homeassistant",
      target: "https://homeassistant.lan",
      health: "ok",
      ok: true,
      error: null,
      lastOkAt: now,
      history: { state: "ok", lastOkAt: now, lastError: null, backfill: null },
    },
  ],
  units: [
    { id: "spark-a", name: "Dan", known: true, recorded: true, meter: "ha", channel: "sensor.p3", sinceMs: null, watts: 55.4, atMs: now, fresh: true, error: null, polledAtMs: now, reconciledThroughMs: lastHour + HOUR },
  ],
};

const monthly = (months: MonthlyEnergyData["months"]): MonthlyEnergyData => ({ estimated: true, generatedAt: now, foldedThroughMs: now, months });

async function settle() {
  for (let i = 0; i < 5; i += 1) await flush();
}

beforeEach(() => {
  resetPowerMeterStatusCache();
  vi.mocked(fetchMonthlyEnergy).mockResolvedValue(monthly([]));
});

describe("Energy page", () => {
  it("is unchanged without power meters", async () => {
    vi.mocked(fetchPowerMeterStatus).mockResolvedValue({ enabled: false, state: "absent" });
    vi.mocked(fetchFleetEnergy).mockResolvedValue(live());
    vi.mocked(fetchEnergyHistory).mockResolvedValue(history(false));
    const { container } = render(<EnergyPage sparks={sparks} settings={null} />);
    await settle();
    expect(container.textContent).toContain("Estimated, not metered.");
    expect(container.textContent).toContain("Not wall-metered.");
    expect(container.querySelector(".en-meters")).toBeNull();
    expect(container.querySelector('[aria-label="Energy source"]')).toBeNull();
    expect(container.textContent).not.toContain("GPU (measured)");
    expect([...container.querySelectorAll("th")].map((th) => th.textContent)).not.toContain("GPU");
  });

  it("shows wall power as the headline with the estimate, GPU and CPU beside it, and says the meter works", async () => {
    vi.mocked(fetchPowerMeterStatus).mockResolvedValue(status);
    vi.mocked(fetchFleetEnergy).mockResolvedValue(live(wall));
    vi.mocked(fetchEnergyHistory).mockResolvedValue(history(true));
    const { container } = render(<EnergyPage sparks={sparks} settings={null} />);
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("measured at the wall by Home Assistant");
    expect(text).toContain("Measured at the wall.");
    // One dashboard: no source switch.
    expect(container.querySelector('[aria-label="Energy source"]')).toBeNull();
    // HA is configured and working, and says what it reads.
    const meters = container.querySelector(".en-meters")!;
    expect(meters.textContent).toContain("Connected");
    expect(meters.textContent).toContain("Home Assistant");
    expect(meters.textContent).toContain("https://homeassistant.lan");
    expect(meters.textContent).toContain("every 10 s");
    expect(meters.textContent).toContain("meter record through");
    expect(meters.textContent).toContain("Dan 55 W");
    expect(meters.textContent).toContain("Stepan no meter, estimated at 141%");
    // Headline is wall: 111 W now, with the estimate and live parts underneath.
    expect(text).toContain("Current draw at the wall");
    expect(text).toContain("111W");
    expect(text).toContain("estimate 80 W");
    expect(text).toContain("GPU 23 W · CPU 11 W");
    expect(text).toContain("50% of this range");
    // The power chart carries the estimate and its parts as lines.
    expect(text).toContain("Estimate (GPU + CPU + 23 W)");
    expect(text).toContain("GPU (measured)");
    expect(text).toContain("CPU (modelled)");
    // The table adds the estimate and its parts per node.
    const headers = [...container.querySelectorAll("th")].map((th) => th.textContent);
    expect(headers).toEqual(expect.arrayContaining(["Estimate", "GPU", "CPU"]));
    expect(text).toContain("Dan 140%, Stepan 141%");
  });

  it("reports a broken config instead of silently showing the estimate", async () => {
    vi.mocked(fetchPowerMeterStatus).mockResolvedValue({ enabled: false, state: "invalid", error: "units.spark-a.channel: must be a Home Assistant entity id" });
    vi.mocked(fetchFleetEnergy).mockResolvedValue(live());
    vi.mocked(fetchEnergyHistory).mockResolvedValue(history(false));
    const { container } = render(<EnergyPage sparks={sparks} settings={null} />);
    await settle();
    expect(container.textContent).toContain("Power meters are off:");
    expect(container.textContent).toContain("must be a Home Assistant entity id");
  });
});

describe("Monthly history with wall power", () => {
  it("shows a metered month at the wall, with its estimate and filled share", async () => {
    const start = Date.UTC(2026, 9, 1);
    vi.mocked(fetchMonthlyEnergy).mockResolvedValue(
      monthly([
        {
          month: "2026-10",
          startMs: start,
          endMs: Date.UTC(2026, 10, 1),
          closed: false,
          nodeIds: ["spark-a"],
          nodes: { "spark-a": { wh: 40_000, coverageMs: HOUR, wallWh: 45_000, wallCoverageMs: HOUR, wallFilledWh: 5_000, wallFilledMs: HOUR } },
          totalWh: 40_000,
          fleetWh: 40_000,
          fleetCoverageMs: HOUR,
          outputTokens: 0,
          coveredOutputTokens: 0,
          whPerOutputToken: null,
          totalWallWh: 50_000,
          totalWallFilledWh: 5_000,
          fleetWallWh: 50_000,
          fleetWallCoverageMs: HOUR,
        },
      ])
    );
    const { container } = render(<MonthlyEnergy nameOf={(id) => id} price={null} currency="$" />);
    await settle();
    expect(container.textContent).toContain("50.0 kWh");
    expect(container.textContent).toContain("Estimate40.0 kWh");
    expect(container.textContent).toContain("Measured at the wall; 10.0% filled from the estimate");
  });
});

describe("Overview energy card with wall power", () => {
  it("shows wall figures and keeps the estimate in view", async () => {
    vi.mocked(fetchFleetEnergy).mockResolvedValue(live(wall));
    const { container } = render(<FleetEnergyCard nodeCount={2} />);
    await settle();
    expect(container.textContent).toContain("2.90kWh / 24 h");
    expect(container.textContent).toContain("Measured at the wall · estimate 1.90 kWh");
    expect(container.textContent).toContain("111 W");
    expect(container.textContent).toContain("2/2 fresh");
  });
});
