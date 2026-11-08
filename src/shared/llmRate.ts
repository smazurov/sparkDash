import type { LlmMetrics } from "../api/types";

/**
 * The live decode rate of an engine, or null when there is none to show: no engine, or one that
 * answered but whose stats could not be read (its rate is unknown, not zero).
 * Completed-request windows belong on explicitly labelled tiles, never live widgets.
 */
export function measuredGenerationTps(llm: Pick<LlmMetrics, "generationTps" | "measurementValid" | "generationMeasurementValid" | "generationTpsSource"> | null | undefined): number | null {
  if (!llm || llm.measurementValid === false || llm.generationMeasurementValid === false ||
    llm.generationTpsSource === "completed" || !Number.isFinite(llm.generationTps)) return null;
  return llm.generationTps;
}
