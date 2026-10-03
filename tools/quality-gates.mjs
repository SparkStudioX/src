// Keep artifact production behind every mandatory gate, including failure paths.
export function runQualityGates(stages, record) {
  for (const stage of stages) {
    const result = stage.run();
    record(result);
    if (!result.passed) throw new Error(`${result.name} failed. Build stopped; diagnostics are in .data/quality.`);
  }
}
