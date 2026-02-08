import fs from "node:fs";
import path from "node:path";
import { loadScenarios } from "./scenarios.js";
import type { RunSummary } from "./types.js";

const RUNS_DIR = path.resolve(import.meta.dirname, "../runs");

interface AcceptanceSummary {
  final_status: "pass" | "fail";
  completion: {
    total_scenarios: number;
    completed: number;
    errored: number;
  };
  totals: {
    warnings: number;
    failures: number;
  };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function findLatestRun(): string {
  const entries = fs
    .readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  if (entries.length === 0) {
    fail("No runs found in runs/ directory. Run `npm run eval` first.");
  }

  return entries[entries.length - 1]!;
}

function countByTag(tag: string): number {
  return loadScenarios().filter((s) => s.tags.includes(tag)).length;
}

function main() {
  const allScenarios = loadScenarios();
  const expectedCount = allScenarios.length;

  const runId = findLatestRun();
  const runDir = path.join(RUNS_DIR, runId);

  const summaryPath = path.join(runDir, "summary.json");
  const acceptancePath = path.join(runDir, "acceptance-summary.json");

  if (!fs.existsSync(summaryPath)) {
    fail(`summary.json not found for run ${runId}. Run \`npm run eval\` first.`);
  }
  if (!fs.existsSync(acceptancePath)) {
    fail(`acceptance-summary.json not found for run ${runId}. Run \`npm run accept -- ${runId}\` first.`);
  }

  const summary = readJson<RunSummary>(summaryPath);
  const acceptance = readJson<AcceptanceSummary>(acceptancePath);

  const checks: Array<{ label: string; pass: boolean; detail: string }> = [];

  // 1. All scenarios completed
  checks.push({
    label: "Scenarios",
    pass: summary.completed === expectedCount && summary.errored === 0,
    detail: `${summary.completed}/${expectedCount} completed${summary.errored > 0 ? `, ${summary.errored} errored` : ""}`,
  });

  // 2. Acceptance passed
  checks.push({
    label: "Acceptance",
    pass: acceptance.final_status === "pass",
    detail: `${acceptance.final_status} (${acceptance.totals.failures} failures, ${acceptance.totals.warnings} warnings)`,
  });

  // 3. Tag-based coverage
  const happyPathCount = countByTag("happy-path");
  const negativeCount = countByTag("negative");
  const adversarialCount = countByTag("adversarial");

  const happyPathCompleted = summary.scenarios.filter(
    (s) => s.status === "ok" && allScenarios.find((sc) => sc.id === s.id)?.tags.includes("happy-path")
  ).length;
  const negativeCompleted = summary.scenarios.filter(
    (s) => s.status === "ok" && allScenarios.find((sc) => sc.id === s.id)?.tags.includes("negative")
  ).length;
  const adversarialCompleted = summary.scenarios.filter(
    (s) => s.status === "ok" && allScenarios.find((sc) => sc.id === s.id)?.tags.includes("adversarial")
  ).length;

  checks.push({
    label: "Happy-path coverage",
    pass: happyPathCompleted === happyPathCount,
    detail: `${happyPathCompleted}/${happyPathCount}`,
  });

  checks.push({
    label: "Negative coverage",
    pass: negativeCompleted === negativeCount,
    detail: `${negativeCompleted}/${negativeCount}`,
  });

  checks.push({
    label: "Adversarial coverage",
    pass: adversarialCompleted === adversarialCount,
    detail: `${adversarialCompleted}/${adversarialCount}`,
  });

  // Print checklist
  console.log(`Pre-submission check (run: ${runId})`);
  let allPass = true;
  for (const check of checks) {
    const icon = check.pass ? "\u2713" : "\u2717";
    console.log(`${icon} ${check.label}: ${check.detail}`);
    if (!check.pass) allPass = false;
  }

  console.log();
  if (allPass) {
    console.log("RESULT: PASS \u2014 ready for submission");
    process.exit(0);
  } else {
    console.log("RESULT: FAIL \u2014 not ready for submission");
    process.exit(1);
  }
}

main();
