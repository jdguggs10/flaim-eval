import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReenrichWindow, resolveTraceIds } from "../enrich.js";

test("buildReenrichWindow uses trace duration with lookback/lookahead padding", () => {
  const { start, end } = buildReenrichWindow({
    timestamp_utc: "2026-02-06T18:10:04.000Z",
    duration_ms: 24000,
  });

  assert.equal(start.toISOString(), "2026-02-06T18:07:40.000Z");
  assert.equal(end.toISOString(), "2026-02-06T18:15:04.000Z");
});

test("resolveTraceIds prefers manifest traces and supports explicit trace override", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "flaim-eval-run-"));

  fs.writeFileSync(
    path.join(runDir, "manifest.json"),
    JSON.stringify({
      run_id: "2026-02-06T18-10-04Z",
      traces: [
        { scenario_id: "a", trace_id: "trace_a_000" },
        { scenario_id: "b", trace_id: "trace_b_001" },
      ],
    })
  );
  fs.mkdirSync(path.join(runDir, "trace_c_002"), { recursive: true });

  const fromManifest = resolveTraceIds(runDir);
  assert.deepEqual(fromManifest, ["trace_a_000", "trace_b_001"]);

  const explicit = resolveTraceIds(runDir, "trace_override_999");
  assert.deepEqual(explicit, ["trace_override_999"]);
});

test("resolveTraceIds falls back to trace_* directories when manifest is missing", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "flaim-eval-run-"));
  fs.mkdirSync(path.join(runDir, "trace_b_001"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "trace_a_000"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "other_folder"), { recursive: true });

  assert.deepEqual(resolveTraceIds(runDir), ["trace_a_000", "trace_b_001"]);
});
