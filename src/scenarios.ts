import fs from "node:fs";
import path from "node:path";
import type { Scenario } from "./types.js";

const SCENARIOS_DIR = path.resolve(import.meta.dirname, "../scenarios");

/**
 * Load all scenario JSON files from scenarios/
 */
export function loadScenarios(filter?: string[]): Scenario[] {
  const files = fs
    .readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith(".json"));

  const scenarios: Scenario[] = files.map((f) => {
    const raw = fs.readFileSync(path.join(SCENARIOS_DIR, f), "utf-8");
    return JSON.parse(raw) as Scenario;
  });

  if (filter && filter.length > 0) {
    return scenarios.filter((s) => filter.includes(s.id));
  }

  return scenarios;
}

/**
 * Load instruction file contents if specified by scenario.
 * Returns null if no instructions.
 */
export function loadInstructions(scenario: Scenario): string | null {
  if (!scenario.instructions) return null;

  const instrPath = path.resolve(import.meta.dirname, "..", scenario.instructions);
  if (!fs.existsSync(instrPath)) {
    console.warn(`  Warning: instructions file not found: ${instrPath}`);
    return null;
  }

  return fs.readFileSync(instrPath, "utf-8");
}
