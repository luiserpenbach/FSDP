// Plain .mjs (like cli.bundle.test.mjs): it reads and writes files, and the app's
// TypeScript project has no Node types.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildTestStandDemo } from "./testStandPid";

// The seed (backend/app/seed.py) loads this file; it must stay what the builder produces.
const SEED_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../backend/app/demo/test_stand_pid.json");

it("the seeded demo drawing is what the builder produces", () => {
  const expected = `${JSON.stringify(buildTestStandDemo(), null, 1)}\n`;
  if (env.UPDATE_DEMO_PID) writeFileSync(SEED_FILE, expected);
  expect(existsSync(SEED_FILE), "run UPDATE_DEMO_PID=1 npm test to create the seed file").toBe(true);
  expect(readFileSync(SEED_FILE, "utf8") === expected, "run UPDATE_DEMO_PID=1 npm test to refresh the seed file").toBe(true);
});
