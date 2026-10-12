// Web bridge tests. Synthetic non-PDF bytes and an injected editPdf only; no
// PDF is created or edited. The real-runtime capability case loads the
// patched candidate manifest when FALSIFY_EDITOR_CANDIDATE_MANIFEST and the
// pinned app source (FALSIFY_EDITOR_SOURCE_ROOT) are available.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EditError } from "../src/editor.mjs";
import { CANDIDATE_ENV } from "../src/runtime.mjs";
import { BRIDGE_LIMITS, REQUEST_SCHEMA, capabilities, editorCapabilities, main, parseArgs, sanitizeReport } from "../src/web-bridge.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const ENV = { [CANDIDATE_ENV]: join(tmpdir(), "candidate-manifest.json") };
const BYTES = Buffer.from("synthetic source bytes, not a PDF");

function workspace(edit = (r) => r) {
  const dir = mkdtempSync(join(tmpdir(), "fpe-bridge-"));
  writeFileSync(join(dir, "input.bin"), BYTES);
  const req = edit({ schema: REQUEST_SCHEMA, input: "input.bin", inputSha256: sha(BYTES), reflow: true, edits: [{ id: "edit-1", pageIndex: 0, before: "a b", after: "a c" }] });
  writeFileSync(join(dir, "request.json"), JSON.stringify(req));
  const argv = ["--request", join(dir, "request.json"), "--out", join(dir, "output.bin"), "--report", join(dir, "report.json")];
  return { dir, argv, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function run(argv, deps) {
  const lines = [];
  const code = await main(argv, { env: ENV, stdout: (s) => lines.push(s), ...deps });
  assert.equal(lines.length, 1, "exactly one stdout JSON object");
  return { code, out: JSON.parse(lines[0]) };
}

const passing = {
  ok: true,
  status: "self-check-passed",
  reflow: true,
  runtime: { build: "b", wasmSha256: "1".repeat(64), jsSha256: "2".repeat(64), bentopdfCommit: "3".repeat(40), engineCommit: "4".repeat(40), candidate: { manifestPath: "C:\\private\\candidate-manifest.json", manifestSha256: "5".repeat(64), sourcePatches: [{ name: "x.patch", sha256: "6".repeat(64) }] } },
  edits: [{ id: "edit-1", pageIndex: 0, status: "applied", paragraphIndices: [1] }],
  pages: [{ pageIndex: 0, paragraphs: [{ index: 1 }], regenHostile: false }],
  repairs: [{ pageIndex: 0, repairs: [{ text: "secret paragraph" }] }],
  warnings: [{ pageIndex: 0, code: "edge_edit_unverified", message: "quote: secret paragraph" }],
  selfCheck: { status: "passed", ok: true, method: "same-pdfium-text-geometry", page_count: { source: 3, output: 3 }, failures: [], warnings: [{ code: "self_check_not_independent", detail: "x" }], pages: [{ text: "secret" }] },
  engineLog: ["secret paragraph"],
};

test("parseArgs accepts only the fixed shapes", () => {
  assert.deepEqual(parseArgs(["--capabilities"]), { mode: "capabilities" });
  const abs = (n) => join(tmpdir(), n);
  assert.equal(parseArgs(["--request", abs("r.json"), "--out", abs("o"), "--report", abs("p")]).mode, "edit");
  for (const bad of [[], ["--capabilities", "--x"], ["--request", "r.json", "--out", abs("o"), "--report", abs("p")], ["--request", abs("r"), "--out", abs("o")], ["--request", abs("r"), "--request", abs("r"), "--out", abs("o"), "--report", abs("p")], ["--overwrite"]]) {
    assert.throws(() => parseArgs(bad), (e) => e.code === "USAGE", JSON.stringify(bad));
  }
});

test("editor capabilities default to reflow true, pagination false until exported", () => {
  assert.deepEqual(editorCapabilities({}), { reflow: true, pagination: false });
  assert.deepEqual(editorCapabilities({ EDITOR_CAPABILITIES: { reflow: true, pagination: true } }), { reflow: true, pagination: true });
  assert.deepEqual(editorCapabilities({ EDITOR_CAPABILITIES: { pagination: "yes" } }), { reflow: true, pagination: false });
  assert.deepEqual(editorCapabilities({ EDITOR_CAPABILITIES: { pagination: { supported: true, maxPages: 2 } } }), { reflow: true, pagination: true });
  assert.deepEqual(editorCapabilities({ EDITOR_CAPABILITIES: { pagination: { supported: "true" }, reflow: { supported: false } } }), { reflow: false, pagination: false });
  assert.deepEqual(editorCapabilities({ EDITOR_CAPABILITIES: { pagination: { enabled: true } } }), { reflow: true, pagination: false });
});

test("sanitizeReport keeps codes and digests, drops text, logs and paths", () => {
  const r = sanitizeReport(passing, { outputSha256: "7".repeat(64) });
  const raw = JSON.stringify(r);
  assert.ok(!raw.includes("secret") && !raw.includes("private") && !raw.includes("manifestPath"));
  assert.equal(r.runtime.wasmSha256, "1".repeat(64));
  assert.equal(r.runtime.runtimeKind, "candidate");
  assert.deepEqual(r.pageCount, { source: 3, output: 3 });
  assert.equal(r.sourcePageMap, null);
  assert.equal(r.wrappedLines, null, "never invented");
  assert.equal(r.layoutVerified, true);
  assert.equal(r.selfCheck.independent, false);
  assert.deepEqual(r.repairs, [{ pageIndex: 0, count: 1 }]);
});

test("layoutVerified, wrappedLines and sourcePageMap follow the editor report only", () => {
  assert.equal(sanitizeReport({ ...passing, warnings: [{ code: "x", severity: "error" }] }).layoutVerified, false);
  assert.equal(sanitizeReport({ ...passing, selfCheck: { ...passing.selfCheck, failures: [{ code: "after_missing" }] } }).layoutVerified, false);
  assert.equal(sanitizeReport({ ...passing, selfCheck: { ...passing.selfCheck, ok: false } }).layoutVerified, false);
  assert.equal(sanitizeReport({ ...passing, ok: false }).layoutVerified, false);
  assert.equal(sanitizeReport({ ...passing, reflow: { enabled: true, wrappedLines: 2 } }).wrappedLines, 2);
  assert.equal(sanitizeReport({ ...passing, wrappedLines: -1 }).wrappedLines, null);
  const pagination = {
    pages: { source: 2, output: 3 },
    addedPages: 1,
    sourcePageMap: [
      { sourcePageIndex: 0, outputPageIndex: 0, continuationPageIndices: [1], text: "secret", digest: "f".repeat(64) },
      { sourcePageIndex: 1, outputPageIndex: 2, continuationPageIndices: [] },
    ],
    flow: [{ digest: "e".repeat(64), lines: 4, text: "secret" }],
  };
  const s = sanitizeReport({ ...passing, pagination });
  assert.deepEqual(s.sourcePageMap, [
    { sourcePageIndex: 0, outputPageIndex: 0, continuationPageIndices: [1] },
    { sourcePageIndex: 1, outputPageIndex: 2, continuationPageIndices: [] },
  ]);
  assert.equal(s.addedPages, 1);
  assert.ok(!JSON.stringify(s).includes("secret") && !JSON.stringify(s).includes("e".repeat(64)) && !JSON.stringify(s).includes('"flow"'));
  assert.equal(sanitizeReport({ ...passing, pagination: { sourcePageMap: [{ sourcePageIndex: 0, outputPageIndex: "C:\\x" }] } }).sourcePageMap, null);
  assert.equal(sanitizeReport({ ...passing, pagination: { sourcePageMap: [0, 1] } }).sourcePageMap, null);
});

test("successful edit writes output and sanitized report", async () => {
  const ws = workspace();
  try {
    let seen;
    const { code, out } = await run(ws.argv, { editPdf: async (req) => ((seen = req), { pdf: new Uint8Array([1, 2, 3]), report: passing }) });
    assert.equal(code, 0);
    assert.deepEqual(out, { ok: true, code: "OK" });
    assert.deepEqual(Buffer.from(seen.sourceBytes), BYTES);
    assert.deepEqual(seen.edits, [{ id: "edit-1", pageIndex: 0, before: "a b", after: "a c" }]);
    assert.deepEqual([...readFileSync(join(ws.dir, "output.bin"))], [1, 2, 3]);
    const report = JSON.parse(readFileSync(join(ws.dir, "report.json"), "utf8"));
    assert.equal(report.outputSha256, sha(Buffer.from([1, 2, 3])));
    assert.deepEqual(report.capabilities, { reflow: true, pagination: false });
    assert.deepEqual(readFileSync(join(ws.dir, "input.bin")), BYTES, "source untouched");
  } finally {
    ws.cleanup();
  }
});

test("edit failure writes only the report with a sanitized error", async () => {
  const ws = workspace();
  try {
    const err = new EditError("MATCH_FAILED", "1 edit(s) could not be matched exactly once", { failures: [{ text: "secret" }] });
    err.report = { ...passing, ok: false, status: "failed", selfCheck: { status: "not-run" } };
    const { code, out } = await run(ws.argv, { editPdf: async () => { throw err; } });
    assert.equal(code, 1);
    assert.deepEqual(out, { ok: false, code: "MATCH_FAILED" });
    assert.ok(!existsSync(join(ws.dir, "output.bin")));
    const report = JSON.parse(readFileSync(join(ws.dir, "report.json"), "utf8"));
    assert.equal(report.error.code, "MATCH_FAILED");
    assert.ok(!JSON.stringify(report).includes("secret"));
  } finally {
    ws.cleanup();
  }
});

test("self-check not passed never writes output", async () => {
  const ws = workspace();
  try {
    const { code, out } = await run(ws.argv, { editPdf: async () => ({ pdf: new Uint8Array([1]), report: { ...passing, selfCheck: { status: "failed" } } }) });
    assert.equal(code, 1);
    assert.equal(out.code, "SELF_CHECK_FAILED");
    assert.ok(!existsSync(join(ws.dir, "output.bin")));
  } finally {
    ws.cleanup();
  }
});

test("runtime errors are reported without paths", async () => {
  const ws = workspace();
  try {
    const err = Object.assign(new Error("Candidate C:\\secret\\editcore.wasm has sha256 x"), { code: "CANDIDATE_HASH_MISMATCH" });
    const { code, out } = await run(ws.argv, { editPdf: async () => { throw err; } });
    assert.equal(code, 1);
    assert.equal(out.code, "CANDIDATE_HASH_MISMATCH");
    const report = readFileSync(join(ws.dir, "report.json"), "utf8");
    assert.ok(!report.includes("secret"));
  } finally {
    ws.cleanup();
  }
});

test("malformed requests are rejected before editPdf runs", async () => {
  const cases = [
    ["unknown field", (r) => ({ ...r, outputPath: "x" }), "INVALID_REQUEST"],
    ["schema", (r) => ({ ...r, schema: "other" }), "INVALID_REQUEST"],
    ["input path", (r) => ({ ...r, input: "..\\input.bin" }), "INVALID_REQUEST"],
    ["input absolute", (r) => ({ ...r, input: join(tmpdir(), "input.bin") }), "INVALID_REQUEST"],
    ["hash", (r) => ({ ...r, inputSha256: "0".repeat(64) }), "INPUT_HASH_MISMATCH"],
    ["edit field", (r) => ({ ...r, edits: [{ ...r.edits[0], rationale: "x" }] }), "INVALID_REQUEST"],
    ["too many", (r) => ({ ...r, edits: Array.from({ length: BRIDGE_LIMITS.maxEdits + 1 }, (_, i) => ({ ...r.edits[0], id: `edit-${i + 1}` })) }), "INVALID_REQUEST"],
    ["empty", (r) => ({ ...r, edits: [] }), "INVALID_REQUEST"],
    ["reflow", (r) => ({ ...r, reflow: "yes" }), "INVALID_REQUEST"],
  ];
  for (const [name, edit, expected] of cases) {
    const ws = workspace(edit);
    try {
      const { code, out } = await run(ws.argv, { editPdf: async () => assert.fail(`editPdf called for ${name}`) });
      assert.equal(code, 2, name);
      assert.equal(out.code, expected, name);
      assert.ok(!existsSync(join(ws.dir, "output.bin")), name);
    } finally {
      ws.cleanup();
    }
  }
});

test("output paths outside the request directory or already present are refused", async () => {
  const ws = workspace();
  const other = mkdtempSync(join(tmpdir(), "fpe-other-"));
  try {
    const argv = [...ws.argv];
    argv[3] = join(other, "output.bin");
    assert.equal((await run(argv, { editPdf: async () => assert.fail() })).out.code, "INVALID_REQUEST");
    writeFileSync(join(ws.dir, "report.json"), "{}");
    assert.equal((await run(ws.argv, { editPdf: async () => assert.fail() })).out.code, "OUTPUT_EXISTS");
  } finally {
    ws.cleanup();
    rmSync(other, { recursive: true, force: true });
  }
});

test("missing candidate configuration fails clearly", async () => {
  const ws = workspace();
  try {
    const lines = [];
    const code = await main(ws.argv, { env: {}, stdout: (s) => lines.push(s), editPdf: async () => assert.fail() });
    assert.equal(code, 1);
    assert.equal(JSON.parse(lines[0]).code, "CANDIDATE_REQUIRED");
    const caps = [];
    assert.equal(await main(["--capabilities"], { env: {}, stdout: (s) => caps.push(s) }), 1);
    assert.equal(JSON.parse(caps[0]).code, "CANDIDATE_REQUIRED");
  } finally {
    ws.cleanup();
  }
});

test("capabilities with an injected runtime are sanitized", async () => {
  let closed = false;
  const load = async () => ({ engineFactory: async () => ({ close: () => (closed = true) }), info: passing.runtime });
  const caps = await capabilities({ env: ENV, load });
  assert.ok(closed);
  assert.equal(caps.engine, "falsify-pdf-editor");
  assert.equal(caps.wasmSha256, "1".repeat(64));
  assert.equal(caps.pagination, false);
  assert.ok(!JSON.stringify(caps).includes("private"));
});

const manifest = process.env[CANDIDATE_ENV];
test("capabilities load the real patched candidate manifest", { skip: !manifest || !existsSync(manifest) ? "FALSIFY_EDITOR_CANDIDATE_MANIFEST not set" : false }, async () => {
  const caps = await capabilities({ env: process.env });
  assert.equal(caps.ok, true);
  assert.equal(caps.runtime.runtimeKind, "candidate");
  assert.match(caps.wasmSha256, /^[0-9a-f]{64}$/);
  if (process.env.FALSIFY_EXPECT_WASM_SHA256) assert.equal(caps.wasmSha256, process.env.FALSIFY_EXPECT_WASM_SHA256);
  assert.equal(caps.reflow, true);
  assert.equal(caps.pagination, false);
  assert.ok(!JSON.stringify(caps).includes(":\\") && !JSON.stringify(caps).includes("manifestPath"));
});
