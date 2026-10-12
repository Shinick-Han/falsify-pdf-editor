#!/usr/bin/env node
// Fixed bridge between the Falsify local companion and editPdf.
// Usage: node src/web-bridge.mjs --capabilities
//        node src/web-bridge.mjs --request ABS --out ABS --report ABS
// The companion passes the candidate manifest through
// FALSIFY_EDITOR_CANDIDATE_MANIFEST (startup configuration, never HTTP).
// Stdout carries exactly one JSON object. Reports and capability output are
// sanitized: no filesystem paths, engine logs, document text or messages
// that could quote document content.
// Exit codes: 0 ok, 1 edit/self-check/runtime failure, 2 usage or request error.
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as editor from "./editor.mjs";
import { CANDIDATE_ENV, loadRuntime } from "./runtime.mjs";

export const ENGINE = "falsify-pdf-editor";
export const REQUEST_SCHEMA = "falsify-web-bridge-request/1";
export const BRIDGE_LIMITS = Object.freeze({ maxFileBytes: 25 * 1024 * 1024, maxEdits: 12, maxTextChars: 4000, maxRequestBytes: 512 * 1024 });
const REQUEST_KEYS = ["schema", "input", "inputSha256", "edits", "reflow"];
const EDIT_KEYS = ["id", "pageIndex", "before", "after"];
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const LOWER_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const STATUS_RE = /^[a-z][a-z-]{0,40}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export class BridgeError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const match = (v, re) => (typeof v === "string" && re.test(v) ? v : undefined);
const int = (v) => (Number.isInteger(v) ? v : null);
const hex = (v, re = HEX64) => match(v, re) ?? null;

function packageInfo() {
  const pkg = JSON.parse(readFileSync(join(MODULE_ROOT, "package.json"), "utf8"));
  const url = typeof pkg.repository?.url === "string" ? pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "") : null;
  return { version: String(pkg.version), sourceUrl: url && /^https:\/\/\S+$/.test(url) ? url : null };
}

// Until editor.mjs exports EDITOR_CAPABILITIES, report reflow true and
// pagination false; pagination is never inferred from fixture success.
// Each capability may be a boolean or a descriptor; a descriptor counts only
// when .supported === true (never truthiness).
const flag = (v, fallback) => (typeof v === "boolean" ? v : v && typeof v === "object" ? v.supported === true : fallback);
export function editorCapabilities(mod = editor) {
  const caps = mod?.EDITOR_CAPABILITIES;
  const style = caps?.continuationStyle;
  return {
    reflow: flag(caps?.reflow, true), pagination: flag(caps?.pagination, false),
    ...(style?.supported === true && style.policy === "source-number-suffix" ? {
      continuationStyle: {
        supported: true, policy: "source-number-suffix",
        scope: "text-only source-style header/footer; standalone Arabic source number plus decimal suffix; originals unchanged",
      },
    } : {}),
  };
}

export function sanitizeRuntime(info) {
  if (!info || typeof info !== "object") return null;
  const out = {
    engine: ENGINE,
    build: info.build == null ? null : String(info.build).slice(0, 80),
    wasmSha256: hex(info.wasmSha256),
    jsSha256: hex(info.jsSha256),
    bentopdfCommit: hex(info.bentopdfCommit, HEX40),
    engineCommit: hex(info.engineCommit, HEX40),
    runtimeKind: info.candidate ? "candidate" : "pinned",
  };
  if (info.candidate) {
    out.manifestSha256 = hex(info.candidate.manifestSha256);
    out.sourcePatches = Array.isArray(info.candidate.sourcePatches)
      ? info.candidate.sourcePatches.slice(0, 32).map((p) => ({ name: match(p?.name, /^[A-Za-z0-9._-]{1,80}$/) ?? null, sha256: hex(p?.sha256) }))
      : [];
  }
  return out;
}

function requireCandidate(env) {
  const v = env[CANDIDATE_ENV];
  if (typeof v !== "string" || !isAbsolute(v)) throw new BridgeError("CANDIDATE_REQUIRED", "The patched candidate manifest is not configured", 1);
}

// Runtime messages can carry paths or git output; they are replaced by fixed text.
const RUNTIME_MESSAGES = {
  SOURCE_MISSING: "Pinned editor app source is not available",
  SOURCE_MODIFIED: "Pinned editor app source was modified",
  PIN_MISMATCH: "Pinned editor app source is at a different commit",
  GIT_UNAVAILABLE: "git is required to verify the pinned editor app source",
  RUNTIME_MISSING: "Editor runtime files are missing",
  RUNTIME_HASH_MISMATCH: "Editor runtime files do not match their pinned digests",
  CANDIDATE_MISSING: "Candidate manifest or artifact is missing",
  CANDIDATE_INVALID: "Candidate manifest is invalid",
  CANDIDATE_CONFLICT: "Candidate manifest conflicts with another runtime option",
  CANDIDATE_PIN_MISMATCH: "Candidate manifest pins do not match this module",
  CANDIDATE_HASH_MISMATCH: "Candidate artifacts do not match the manifest digests",
  CANDIDATE_REQUIRED: "The patched candidate manifest is not configured",
  QUALITY_UNAVAILABLE: "Editor quality module is unavailable",
};

export function sanitizeError(e) {
  const c = match(e?.code, CODE_RE) ?? "ERROR";
  const own = e instanceof BridgeError || e instanceof editor.EditError;
  return { code: c, message: RUNTIME_MESSAGES[c] ?? (own ? String(e.message).slice(0, 300) : "Editor failed") };
}

export async function capabilities({ env = process.env, load = loadRuntime, mod = editor } = {}) {
  requireCandidate(env);
  const rt = await (load ?? loadRuntime)({});
  // Instantiate the verified WASM once without opening any document.
  const engine = await rt.engineFactory();
  try {
    engine?.close?.();
  } catch {}
  const runtime = sanitizeRuntime(rt.info);
  const pkg = packageInfo();
  const m = mod ?? editor;
  return {
    ok: true,
    engine: ENGINE,
    version: pkg.version,
    wasmSha256: runtime?.wasmSha256 ?? null,
    runtime,
    ...editorCapabilities(m),
    limits: { ...BRIDGE_LIMITS, editorMaxFileBytes: m.LIMITS.maxFileBytes, editorMaxEdits: m.LIMITS.maxEdits },
    sourceUrl: pkg.sourceUrl,
  };
}

export function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--capabilities") return { mode: "capabilities" };
  const args = { mode: "edit" };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!["--request", "--out", "--report"].includes(k)) throw new BridgeError("USAGE", "Unknown or misplaced argument");
    const name = k.slice(2);
    if (args[name] !== undefined) throw new BridgeError("USAGE", `Duplicate ${k}`);
    if (typeof v !== "string" || !isAbsolute(v) || v.startsWith("--")) throw new BridgeError("USAGE", `${k} requires an absolute path`);
    args[name] = resolve(v);
  }
  if (!args.request || !args.out || !args.report) throw new BridgeError("USAGE", "Usage: web-bridge.mjs --capabilities | --request ABS --out ABS --report ABS");
  return args;
}

function occupied(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

const same = (a, b) => (process.platform === "win32" || process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b);

// Request, input, output and report all live in one directory the caller
// owns; output and report must not exist yet and are created exclusively.
export function loadRequest(args) {
  let st;
  try {
    st = lstatSync(args.request);
  } catch {
    throw new BridgeError("REQUEST_UNREADABLE", "Request file cannot be read");
  }
  if (!st.isFile() || st.size > BRIDGE_LIMITS.maxRequestBytes) throw new BridgeError("INVALID_REQUEST", "Request must be a regular file within the size budget");
  const dir = realpathSync.native(dirname(args.request));
  for (const p of [args.out, args.report]) {
    let parent;
    try {
      parent = realpathSync.native(dirname(p));
    } catch {
      throw new BridgeError("INVALID_REQUEST", "Output and report must be in the request directory");
    }
    if (!same(parent, dir)) throw new BridgeError("INVALID_REQUEST", "Output and report must be in the request directory");
    if (occupied(p)) throw new BridgeError("OUTPUT_EXISTS", "Output or report path already exists");
  }
  const names = [basename(args.request), basename(args.out), basename(args.report)];
  if (same(names[0], names[1]) || same(names[0], names[2]) || same(names[1], names[2])) throw new BridgeError("USAGE", "Request, output and report must differ");
  let req;
  try {
    req = JSON.parse(readFileSync(args.request, "utf8"));
  } catch {
    throw new BridgeError("INVALID_REQUEST", "Request file is not valid JSON");
  }
  const bad = (m) => {
    throw new BridgeError("INVALID_REQUEST", m);
  };
  if (!req || typeof req !== "object" || Array.isArray(req)) bad("Request must be a JSON object");
  for (const k of Object.keys(req)) if (!REQUEST_KEYS.includes(k)) bad(`Unknown request field: ${k}`);
  if (req.schema !== REQUEST_SCHEMA) bad(`schema must be ${REQUEST_SCHEMA}`);
  if (!match(req.input, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)) bad("input must be a plain file name in the request directory");
  if (names.some((n) => same(n, req.input))) bad("input must differ from request, output and report");
  if (!match(req.inputSha256, HEX64)) bad("inputSha256 must be a lowercase sha256");
  if (typeof req.reflow !== "boolean") bad("reflow must be a boolean");
  if (!Array.isArray(req.edits) || req.edits.length < 1 || req.edits.length > BRIDGE_LIMITS.maxEdits) bad(`edits must hold 1-${BRIDGE_LIMITS.maxEdits} entries`);
  req.edits.forEach((e, i) => {
    if (!e || typeof e !== "object" || Array.isArray(e)) bad(`Edit #${i} must be an object`);
    for (const k of Object.keys(e)) if (!EDIT_KEYS.includes(k)) bad(`Edit #${i} has unknown field: ${k}`);
    if (typeof e.before !== "string" || typeof e.after !== "string" || Math.max(e.before.length, e.after.length) > BRIDGE_LIMITS.maxTextChars) bad(`Edit #${i} text is invalid`);
  });
  const inputPath = join(dir, req.input);
  let ist;
  try {
    ist = lstatSync(inputPath);
  } catch {
    throw new BridgeError("INPUT_UNREADABLE", "Input PDF cannot be read");
  }
  if (!ist.isFile() || ist.size < 1 || ist.size > BRIDGE_LIMITS.maxFileBytes) throw new BridgeError("INVALID_REQUEST", "Input PDF must be a regular file within the size budget");
  const sourceBytes = new Uint8Array(readFileSync(inputPath));
  if (sha256(sourceBytes) !== req.inputSha256) throw new BridgeError("INPUT_HASH_MISMATCH", "Input PDF does not match inputSha256");
  return { sourceBytes, edits: req.edits.map((e) => ({ id: e.id, pageIndex: e.pageIndex, before: e.before, after: e.after })), reflow: req.reflow };
}

const list = (v, pick) => (Array.isArray(v) ? v.slice(0, 256).map(pick) : []);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

// Wrapped-line count only when the editor reports one; never derived.
function wrappedLines(r) {
  for (const v of [r.reflow?.wrappedLines, r.layout?.wrappedLines, r.wrappedLines]) if (count(v) !== null) return v;
  return null;
}

// report.pagination.sourcePageMap (long-edit worker contract): entries
// {sourcePageIndex, outputPageIndex, continuationPageIndices, ...}. Only those
// indices survive; flow digests, counts and any text are dropped. A malformed
// entry drops the whole map.
function sourcePageMap(r) {
  const m = r.pagination?.sourcePageMap;
  if (!Array.isArray(m) || m.length === 0 || m.length > 10000) return null;
  const entry = (v) => {
    if (!v || typeof v !== "object" || count(v.sourcePageIndex) === null || count(v.outputPageIndex) === null) return undefined;
    const cont = v.continuationPageIndices ?? [];
    if (!Array.isArray(cont) || cont.length > 64 || !cont.every((x) => count(x) !== null)) return undefined;
    return { sourcePageIndex: v.sourcePageIndex, outputPageIndex: v.outputPageIndex, continuationPageIndices: [...cont] };
  };
  const out = m.map(entry);
  return out.every((v) => v !== undefined) ? out : null;
}

// Only codes, indices, counts and runtime digests survive; free-form engine
// text, logs, details and paths are dropped.
export function sanitizeReport(report, extra = {}) {
  const r = report && typeof report === "object" ? report : {};
  const sc = r.selfCheck && typeof r.selfCheck === "object" ? r.selfCheck : {};
  const pc = sc.page_count && typeof sc.page_count === "object" ? sc.page_count : null;
  const warnings = Array.isArray(r.warnings) ? r.warnings : [];
  // Layout verified only when the mandatory saved-file text/layout self-check
  // passed with no failures and no error-severity repair warnings.
  const layoutVerified =
    r.ok === true && sc.status === "passed" && sc.ok === true && Array.isArray(sc.failures) && sc.failures.length === 0 && !warnings.some((w) => w?.severity === "error");
  return {
    ok: r.ok === true,
    status: match(r.status, STATUS_RE) ?? "failed",
    reflow: r.reflow === true || r.reflow?.enabled === true,
    wrappedLines: wrappedLines(r),
    layoutVerified,
    runtime: sanitizeRuntime(r.runtime),
    edits: list(r.edits, (e) => ({
      id: match(e?.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/) ?? null,
      pageIndex: int(e?.pageIndex),
      status: match(e?.status, STATUS_RE) ?? "unknown",
      ...(match(e?.code, /^[A-Za-z][A-Za-z0-9_]{0,63}$/) ? { code: e.code } : {}),
    })),
    pages: list(r.pages, (p) => ({ pageIndex: int(p?.pageIndex), paragraphs: Array.isArray(p?.paragraphs) ? p.paragraphs.length : 0, regenHostile: p?.regenHostile === true })),
    repairs: list(r.repairs, (p) => ({ pageIndex: int(p?.pageIndex), count: Array.isArray(p?.repairs) ? p.repairs.length : 0 })),
    warnings: list(r.warnings, (w) => ({
      pageIndex: int(w?.pageIndex),
      code: match(w?.code, /^[A-Za-z][A-Za-z0-9_]{0,63}$/) ?? "warning",
      ...(["error", "warning", "info"].includes(w?.severity) ? { severity: w.severity } : {}),
    })),
    selfCheck: {
      status: ["passed", "failed", "error", "not-run"].includes(sc.status) ? sc.status : "not-run",
      independent: false,
      method: match(sc.method, STATUS_RE) ?? null,
      failures: list(sc.failures, (f) => ({ code: match(f?.code, LOWER_CODE_RE) ?? "failure", pageIndex: int(f?.pageIndex) })),
      warnings: list(sc.warnings, (f) => ({ code: match(f?.code, LOWER_CODE_RE) ?? "warning", pageIndex: int(f?.pageIndex) })),
    },
    pageCount: pc ? { source: int(pc.source), output: int(pc.output) } : null,
    addedPages: count(r.pagination?.addedPages),
    sourcePageMap: sourcePageMap(r),
    ...(layoutVerified && r.pagination?.continuationStyle?.applied === true &&
      r.pagination.continuationStyle.policy === "source-number-suffix" &&
      count(r.pagination.continuationStyle.copiedPages) !== null &&
      r.pagination.continuationStyle.copiedPages > 0 &&
      r.pagination.continuationStyle.copiedPages <= 32 &&
      r.pagination.continuationStyle.copiedPages === r.pagination.addedPages ? {
        continuationStyle: {policy: "source-number-suffix", applied: true, copiedPages: r.pagination.continuationStyle.copiedPages},
      } : {}),
    independentQA: { status: "pending", note: "Same-engine self-check only; independent QA is still required." },
    ...extra,
  };
}

function writeExclusive(path, bytes) {
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? ((s) => process.stdout.write(s + "\n"));
  try {
    const args = parseArgs(argv);
    if (args.mode === "capabilities") {
      out(JSON.stringify(await capabilities({ env, load: deps.loadRuntime, mod: deps.editor })));
      return 0;
    }
    const req = loadRequest(args);
    requireCandidate(env);
    const edit = deps.editPdf ?? editor.editPdf;
    const caps = editorCapabilities(deps.editor);
    let result;
    try {
      result = await edit(req, {});
    } catch (e) {
      const report = sanitizeReport(e?.report, { error: sanitizeError(e), capabilities: caps });
      writeExclusive(args.report, JSON.stringify(report) + "\n");
      out(JSON.stringify({ ok: false, code: report.error.code }));
      return e instanceof editor.EditError && e.code === "INVALID_REQUEST" ? 2 : 1;
    }
    if (result?.report?.ok !== true || result?.report?.selfCheck?.status !== "passed" || !(result.pdf instanceof Uint8Array) || result.pdf.length === 0) {
      const report = sanitizeReport(result?.report, { error: { code: "SELF_CHECK_FAILED", message: "Saved-PDF self-check did not pass" }, capabilities: caps });
      writeExclusive(args.report, JSON.stringify(report) + "\n");
      out(JSON.stringify({ ok: false, code: "SELF_CHECK_FAILED" }));
      return 1;
    }
    // Output is written only after the self-check passed.
    writeExclusive(args.out, result.pdf);
    writeExclusive(args.report, JSON.stringify(sanitizeReport(result.report, { outputSha256: sha256(result.pdf), capabilities: caps })) + "\n");
    out(JSON.stringify({ ok: true, code: "OK" }));
    return 0;
  } catch (e) {
    out(JSON.stringify({ ok: false, ...sanitizeError(e) }));
    return e?.exitCode ?? (RUNTIME_MESSAGES[e?.code] ? 1 : 2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
