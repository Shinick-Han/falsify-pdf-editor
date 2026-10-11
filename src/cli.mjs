#!/usr/bin/env node
// Usage: node src/cli.mjs request.json --out output.pdf --report report.json
//        [--overwrite] [--engine-log]
// Exit codes: 0 self-check passed (independent QA still pending),
// 1 definite edit/self-check failure, 2 usage, request or I/O error.
import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EditError, LIMITS, editPdf } from "./editor.mjs";

const MAX_REQUEST_BYTES = 1024 * 1024;
const REQUEST_KEYS = new Set(["input", "edits", "reflow"]);

export class CliError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function parseArgs(argv) {
  const args = { overwrite: false, engineLog: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a === "--report") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new CliError("USAGE", `${a} requires a path`);
      args[a.slice(2)] = v;
    } else if (a === "--overwrite") args.overwrite = true;
    else if (a === "--engine-log") args.engineLog = true;
    else if (a.startsWith("--")) throw new CliError("USAGE", `Unknown option ${a}`);
    else if (!args.request) args.request = a;
    else throw new CliError("USAGE", "Only one request file may be given");
  }
  if (!args.request || !args.out || !args.report) throw new CliError("USAGE", "Usage: cli.mjs request.json --out output.pdf --report report.json");
  return args;
}

// Canonical identity of a path that may not exist yet.
function canonical(path) {
  const abs = resolve(path);
  let real = abs;
  try {
    real = realpathSync.native(abs);
  } catch {
    try {
      real = resolve(realpathSync.native(dirname(abs)), abs.slice(dirname(abs).length + 1));
    } catch {}
  }
  return process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real;
}

// True for any directory entry, including dangling symlinks.
function occupied(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function loadRequest(requestPath) {
  const abs = resolve(requestPath);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new CliError("REQUEST_UNREADABLE", "Request file cannot be read");
  }
  if (!st.isFile() || st.size > MAX_REQUEST_BYTES) throw new CliError("INVALID_REQUEST", `Request must be a file of at most ${MAX_REQUEST_BYTES} bytes`);
  let req;
  try {
    req = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    throw new CliError("INVALID_REQUEST", "Request file is not valid JSON");
  }
  if (!req || typeof req !== "object" || Array.isArray(req)) throw new CliError("INVALID_REQUEST", "Request must be a JSON object");
  for (const k of Object.keys(req)) if (!REQUEST_KEYS.has(k)) throw new CliError("INVALID_REQUEST", `Unknown request field: ${k}`);
  if (typeof req.input !== "string" || !req.input.trim()) throw new CliError("INVALID_REQUEST", "input must be a non-empty path string");
  return { requestPath: abs, inputPath: resolve(dirname(abs), req.input), edits: req.edits, reflow: req.reflow };
}

export function checkPaths({ requestPath, inputPath, out, report, overwrite }) {
  const ids = { request: canonical(requestPath), input: canonical(inputPath), out: canonical(out), report: canonical(report) };
  if (ids.out === ids.input) throw new CliError("OUTPUT_IS_SOURCE", "Output path must differ from the input PDF");
  if (ids.report === ids.input) throw new CliError("OUTPUT_IS_SOURCE", "Report path must differ from the input PDF");
  if (ids.out === ids.request || ids.report === ids.request) throw new CliError("OUTPUT_IS_SOURCE", "Output paths must differ from the request file");
  if (ids.out === ids.report) throw new CliError("USAGE", "Output and report paths must differ");
  if (!overwrite && occupied(out)) throw new CliError("OUTPUT_EXISTS", "Output PDF already exists; pass --overwrite to replace it");
  if (!overwrite && occupied(report)) throw new CliError("REPORT_EXISTS", "Report already exists; pass --overwrite to replace it");
}

function writeAtomic(path, bytes) {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  // Exclusively created, unpredictable staging file: never reuses or follows a pre-existing path.
  const tmp = `${abs}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const fd = openSync(tmp, "wx");
  try {
    try {
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, abs);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

export async function main(argv, deps = {}) {
  const edit = deps.editPdf ?? editPdf;
  const out = deps.stdout ?? ((s) => process.stdout.write(s + "\n"));
  const err = deps.stderr ?? ((s) => process.stderr.write(s + "\n"));
  let args;
  try {
    args = parseArgs(argv);
    const req = loadRequest(args.request);
    checkPaths({ ...req, out: args.out, report: args.report, overwrite: args.overwrite });
    let st;
    try {
      st = statSync(req.inputPath);
    } catch {
      throw new CliError("INPUT_UNREADABLE", "Input PDF cannot be read");
    }
    if (!st.isFile()) throw new CliError("INPUT_UNREADABLE", "Input PDF is not a file");
    if (st.size > LIMITS.maxFileBytes) throw new CliError("INVALID_REQUEST", `Input PDF exceeds ${LIMITS.maxFileBytes} bytes`);
    const sourceBytes = new Uint8Array(readFileSync(req.inputPath));

    let result;
    try {
      result = await edit({ sourceBytes, edits: req.edits, reflow: req.reflow }, { includeEngineLog: args.engineLog });
    } catch (e) {
      const report = e.report ?? { ok: false, status: "failed" };
      report.error = { code: e.code ?? "ERROR", message: e.message, details: e.details };
      writeAtomic(args.report, JSON.stringify(report, null, 2) + "\n");
      err(`edit failed: ${e.code ?? "ERROR"}: ${e.message}`);
      out(JSON.stringify({ ok: false, code: e.code ?? "ERROR", report: resolve(args.report), output: null }));
      return e instanceof EditError && e.code === "INVALID_REQUEST" ? 2 : 1;
    }
    if (result.report?.ok !== true || result.report?.selfCheck?.status !== "passed") {
      writeAtomic(args.report, JSON.stringify(result.report, null, 2) + "\n");
      err("edit failed: SELF_CHECK_FAILED");
      return 1;
    }
    // Output is written only after the self-check passed.
    writeAtomic(args.out, result.pdf);
    writeAtomic(args.report, JSON.stringify(result.report, null, 2) + "\n");
    out(JSON.stringify({ ok: true, selfCheck: "passed", independentQA: "pending", output: resolve(args.out), report: resolve(args.report) }));
    return 0;
  } catch (e) {
    err(`error: ${e.code ?? "ERROR"}: ${e.message}`);
    return e.exitCode ?? 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
