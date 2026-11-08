import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { LlmPanel } from "./LlmPanel";

vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));

function halogen(overrides: Record<string, unknown> = {}) {
  return { ...makeSpark().metrics.llm[0], backend: "halogen" as const,
    engineVersion: "0.20.0", modelId: "gpu-model", models: ["gpu-model", "npu-model"],
    contextLength: 262144, slotsActive: 2, slotsTotal: 4,
    requestsRunning: 2, requestsWaiting: 1, kvCacheUsage: 0.5,
    generationTps: 50, generationTpsSource: "completed" as const,
    prefillTps: 1000, prefillTpsSource: "completed-computed" as const,
    mtpAcceptanceRate: 0.8, perStreamTps: null, ...overrides };
}

describe("Halogen monitoring", () => {
  it("shows the engine/version and completed GPU rates, never cache-inclusive live rates", () => {
    const { container } = render(<LlmPanel llm={halogen()} sparkId="fixture" llmPort={8731} />);
    expect(container.textContent).toContain("Halogen · :8731 · v0.20.0");
    expect(container.textContent).toContain("Decode · last 60s");
    expect(container.textContent).toContain("Prefill · last 60s");
    expect(container.textContent).toContain("Computed tokens only");
    expect(container.textContent).toContain("NPU activity is not included");
    expect(container.textContent).not.toContain("includes cached tokens");
    expect(container.textContent).toContain("50.0");
    expect(container.textContent).toContain("1,000");
    expect(container.textContent).toContain("2 / 4");
    expect(container.textContent).toContain("2 / 1");
    expect(container.textContent).toContain("50%");
    expect(container.textContent).toContain("0.80");
    expect(container.textContent).toContain("262,144");
  });

  it("does not call a running or queued engine idle when no request has finished", () => {
    const quiet = { generationTps: 0, prefillTps: 0, prefillTpsSource: null };
    const { container, root } = render(<LlmPanel llm={halogen(quiet)} sparkId="fixture" llmPort={8731} />);
    expect([...container.querySelectorAll(".sp-big-lg")].map((e) => e.textContent)).toEqual(["—", "—"]);
    expect(container.querySelector("[data-llm-idle]")).toBeNull();
    act(() => root.render(<LlmPanel llm={halogen({ ...quiet, requestsRunning: 0, requestsWaiting: 1 })} sparkId="fixture" llmPort={8731} />));
    expect(container.querySelector("[data-llm-idle]")).toBeNull();
    act(() => root.render(<LlmPanel llm={halogen({ ...quiet, requestsRunning: null, requestsWaiting: null })} sparkId="fixture" llmPort={8731} />));
    expect(container.querySelector("[data-llm-idle]")).toBeNull();
    act(() => root.render(<LlmPanel llm={halogen({ ...quiet, slotsActive: 0, requestsRunning: 0, requestsWaiting: 0 })} sparkId="fixture" llmPort={8731} />));
    expect(container.querySelector("[data-llm-idle]")?.textContent).toMatch(/^Idle/);
  });

  it("keeps recent prefill visible while idle and shows a gap when the window expires", () => {
    const held = halogen({ generationTps: 0, slotsActive: 0, requestsRunning: 0, requestsWaiting: 0,
      prefillMeasurementValid: true, prefillMeasuredAt: Date.now() - 20_000 });
    const { container, root } = render(<LlmPanel llm={held} sparkId="fixture" llmPort={8731} />);
    expect(container.textContent).toContain("Prefill · last 60s");
    expect(container.textContent).toContain("1,000");
    expect(container.querySelector("[data-llm-idle]")?.textContent).toMatch(/^Idle/);
    act(() => root.render(<LlmPanel llm={{ ...held, prefillTps: 0, prefillTpsSource: null,
      prefillMeasurementValid: false, prefillMeasuredAt: null }} sparkId="fixture" llmPort={8731} />));
    expect([...container.querySelectorAll(".sp-big-lg")].map((e) => e.textContent)).toEqual(["—", "—"]);
    expect(container.querySelector("[data-llm-idle]")?.textContent).toMatch(/^Idle/);
  });

  it("holds completed decode while idle, then hides an expired measurement independently of prefill", () => {
    const held = halogen({ generationMeasurementValid: true, generationMeasuredAt: Date.now() - 20_000,
      requestsRunning: 0, requestsWaiting: 0, slotsActive: 0 });
    const { container, root } = render(<LlmPanel llm={held} sparkId="fixture" llmPort={8731} />);
    expect(container.querySelector("[data-llm-idle]")?.textContent).toMatch(/^Idle/);
    expect([...container.querySelectorAll(".sp-big-lg")][0].textContent).toContain("50.0");
    act(() => root.render(<LlmPanel llm={{ ...held, generationMeasurementValid: false,
      generationTpsSource: null, generationMeasuredAt: null }} sparkId="fixture" llmPort={8731} />));
    expect([...container.querySelectorAll(".sp-big-lg")][0].textContent).toBe("—");
    expect([...container.querySelectorAll(".sp-big-lg")][1].textContent).toContain("1,000");
  });

  it("leaves unreadable rates unmeasured rather than reporting healthy zeroes", () => {
    const { container } = render(<LlmPanel llm={halogen({ measurementValid: false,
      measurementError: "no recent Halogen counter baseline" })} sparkId="fixture" llmPort={8731} />);
    expect([...container.querySelectorAll(".sp-big-lg")].map((e) => e.textContent)).toEqual(["—", "—"]);
    expect(container.textContent).toContain("no recent Halogen counter baseline");
  });
});
