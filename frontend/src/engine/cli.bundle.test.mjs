/**
 * Browser/server parity of the engine.
 *
 * Builds the CLI bundle exactly as `npm run build:engine` does, runs it under
 * Node as the API does (JSON on stdin, JSON on stdout), and compares with the
 * same request computed in this process, where a DOM is present as in the
 * browser. The request and the expected response are also kept as
 * `testdata/engine-parity.json`, which the backend's real-engine test replays
 * against a database; regenerate it with `UPDATE_ENGINE_PARITY=1 npm test`.
 *
 * Plain JavaScript: the app is type-checked without Node's typings.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { env, execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runEngineRequest } from "./engineRequest";
import { parityRequest } from "./parityFixture";

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, "../..");
const goldenPath = join(here, "testdata", "engine-parity.json");

let outDir = "";
let bundle = "";

function runCli(input) {
  return spawnSync(execPath, [bundle], { input, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
}

/** What JSON transport keeps of a value (drops undefined, as the CLI's stdout does). */
function wire(value) {
  return JSON.parse(JSON.stringify(value));
}

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "fsdp-engine-"));
  await build({ root: frontendRoot, configFile: join(frontendRoot, "vite.engine.config.ts"), logLevel: "error", build: { outDir, emptyOutDir: true } });
  bundle = join(outDir, "engine-cli.mjs");
}, 60_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("engine CLI bundle", () => {
  it("is one self-contained file", () => {
    const source = readFileSync(bundle, "utf8");
    expect(source).not.toMatch(/^\s*import\s.*from\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it("computes under Node what the browser computes", () => {
    // jsdom provides the DOM parser here, as a browser does; Node has none.
    expect(typeof DOMParser).toBe("function");
    const request = parityRequest();
    const expected = wire(runEngineRequest(request));
    expect(expected.results.every((result) => result.ok)).toBe(true);

    const run = runCli(JSON.stringify(request));
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(expected);

    const golden = { request: wire(request), response: expected };
    if (env.UPDATE_ENGINE_PARITY || !existsSync(goldenPath)) writeFileSync(goldenPath, `${JSON.stringify(golden, null, 1)}\n`);
    // A change to the engine's output must be deliberate: regenerate with UPDATE_ENGINE_PARITY=1.
    expect(JSON.parse(readFileSync(goldenPath, "utf8"))).toEqual(golden);
  });

  it("reports a broken sheet in its result and still exits 0", () => {
    const request = wire(parityRequest());
    request.drawings[0].sheets[1].document = { items: [] };
    const run = runCli(JSON.stringify(request));
    expect(run.status).toBe(0);
    const results = JSON.parse(run.stdout).results;
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(results[1].error).toMatch(/document/);
  });

  it("exits 2 with a message on stderr when the request is not JSON", () => {
    const run = runCli("not json");
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/not valid JSON/);
  });
});
