/**
 * Engine CLI: the schematic engine under Node, for the server.
 *
 *   node engine-cli.mjs < request.json > response.json
 *
 * Reads one JSON request on stdin (`EngineRequest`: a project context and the
 * sheets of one or more drawings) and writes one JSON response on stdout
 * (`EngineResponse`: index and DRC per sheet, or that sheet's error). Exit code
 * 0 whenever a response was written; 2 with a message on stderr when the
 * request itself could not be read.
 *
 * Bundled to a single self-contained file by `npm run build:engine`
 * (`dist-engine/engine-cli.mjs`); it has no runtime dependencies.
 */
import { runEngineRequest, type EngineRequest } from "./engineRequest";

// The app is type-checked without Node's typings; these are the few globals the CLI uses.
declare const process: {
  stdin: { setEncoding(encoding: string): void; [Symbol.asyncIterator](): AsyncIterator<string> };
  stdout: { write(chunk: string, callback?: () => void): boolean };
  stderr: { write(chunk: string): boolean };
  exitCode?: number;
};

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(): Promise<void> {
  let request: EngineRequest;
  try {
    request = JSON.parse(await readStdin()) as EngineRequest;
  } catch (error) {
    process.stderr.write(`engine-cli: request is not valid JSON: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(JSON.stringify(runEngineRequest(request)));
  } catch (error) {
    process.stderr.write(`engine-cli: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

void main();
