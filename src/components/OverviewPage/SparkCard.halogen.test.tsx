import { describe, expect, it, vi } from "vitest";
import { SparkCard } from "./SparkCard";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

vi.mock("../../api/client", () => ({
  fetchLaunchers: () => new Promise(() => {}), runLauncher: vi.fn(), wakeSpark: vi.fn(),
}));
function halogen(overrides: Record<string, unknown> = {}) {
  const spark = makeSpark();
  Object.assign(spark.metrics.llm[0], { backend: "halogen", generationTps: 0, generationMeasurementValid: false,
    generationTpsSource: null, prefillTps: 1000, prefillTpsSource: "completed-computed",
    models: ["gpu-model", "npu-model"], contextLength: 262144, perStreamTps: null, ...overrides });
  return spark;
}

describe("Halogen overview", () => {
  it("keeps aggregate decode unavailable and labels computed-only prefill", () => {
    const { container } = render(<SparkCard spark={halogen()} temperatureUnit="celsius" />);
    expect(container.querySelector('[title*="Halogen"]')).not.toBeNull();
    expect(container.textContent).toContain("Decode · total");
    expect([...container.querySelectorAll(".ov-tps__num")][0].textContent).toBe("—");
    expect(container.textContent).toContain("Prefill · last 60s");
    expect(container.textContent).toContain("Computed tokens only");
    expect(container.textContent).not.toContain("incl. cached tokens");
    expect(container.textContent).toContain("256k ctx");
    const metrics = [...container.querySelectorAll(".ov-tps > div")];
    expect(metrics[0].getAttribute("title")).toContain("not live throughput");
    expect(metrics[1].getAttribute("title")).toContain("NPU activity is not included");
  });
  it("keeps unsupported decode unavailable while requests are running", () => {
    const { container } = render(<SparkCard spark={halogen({ generationTps: 0,
      prefillTps: 0, prefillTpsSource: null, requestsRunning: 1 })} temperatureUnit="celsius" />);
    expect([...container.querySelectorAll(".ov-tps__num")].map((e) => e.textContent)).toEqual(["—", "—"]);
  });
});
