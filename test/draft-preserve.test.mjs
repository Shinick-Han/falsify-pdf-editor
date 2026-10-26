// Draft preservation. Mock engine only: a failed self-check must keep the
// already-saved PDF bytes when draft is exactly true, and must still throw
// them away otherwise. No WASM, network, or real document text.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { editPdf } from "../src/editor.mjs";
import { loadRequest, main } from "../src/cli.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");

function minimalPdf(text) {
  const stream = `BT /F1 12 Tf 72 72 Td (${text}) Tj ET`;
  const objects = [
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
    "2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n",
    `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }
  const xrefAt = body.length;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  body += `${xref}trailer<</Size 6/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body));
}

const CANDIDATE = minimalPdf("DraftCandidate");
const SOURCE = minimalPdf("SourcePage");

function mockEngine(saved) {
  const calls = [];
  let current = 0;
  const eng = {
    pageCount: 1,
    loadPage: (i) => { current = i; calls.push(["loadPage", i]); },
    normalizeFontsForEdit: () => calls.push(["normalize"]),
    pageRegenHostile: () => false,
    buildModel: () => [{ id: 1, editable: true, box: { x: 0, top: 100, w: 50, h: 9 }, lines: [{}], format: { id: 1 }, runs: [{ text: "alpha", rgba: 0 }] }],
    commitParagraph: () => { calls.push(["commit", current]); return { id: 1, surgical: true, lines: [{}] }; },
    save: () => { calls.push(["save"]); return saved; },
    close: () => calls.push(["close"]),
  };
  return { calls, factory: async () => { calls.push(["open"]); return eng; } };
}

function quality(check) {
  return {
    capturePageLayout: () => ({ pi: 0 }),
    repairPageLayout: () => ({ repairs: [], warnings: [] }),
    inspectSavedPdf: async () => check,
  };
}

const edit = { id: "a", pageIndex: 0, before: "alpha", after: "beta" };
const request = () => ({ sourceBytes: new Uint8Array(SOURCE), edits: [{ ...edit }], reflow: true });

test("strict self-check failure still throws the saved PDF away", async () => {
  const engine = mockEngine(CANDIDATE);
  const source = request();
  const before = Buffer.from(source.sourceBytes);
  await assert.rejects(
    editPdf(source, { engineFactory: engine.factory, quality: quality({ ok: false, failures: [{ code: "after_missing", pageIndex: 0, id: "a" }], warnings: [] }) }),
    (e) => e.code === "SELF_CHECK_FAILED" && e.report.selfCheck.status === "failed" && e.report.ok !== true && e.pdf === undefined,
  );
  assert.ok(engine.calls.some((c) => c[0] === "save"), "bytes were generated before the throw");
  assert.deepEqual(Buffer.from(source.sourceBytes), before);
  assert.equal(JSON.stringify(source).includes("DraftCandidate"), false);
});

test("draft mode preserves a readable PDF when After is missing", async () => {
  const engine = mockEngine(CANDIDATE);
  const source = request();
  const before = Buffer.from(source.sourceBytes);
  const { pdf, report } = await editPdf(source, {
    draft: true,
    engineFactory: engine.factory,
    quality: quality({ ok: false, failures: [{ code: "after_missing", pageIndex: 0, id: "a" }], warnings: [] }),
  });
  assert.deepEqual(pdf, CANDIDATE);
  assert.equal(report.ok, false);
  assert.equal(report.status, "draft");
  assert.equal(report.draft, true);
  assert.equal(report.quality, "failed");
  assert.equal(report.selfCheck.status, "failed");
  assert.notEqual(report.selfCheck.ok, true);
  assert.equal(report.status === "self-check-passed", false);
  assert.equal(report.edits[0].status, "after-missing");
  assert.equal(report.error.code, "SELF_CHECK_FAILED");
  assert.equal(report.outputSha256, sha(pdf));
  assert.equal(report.inputSha256, sha(source.sourceBytes));
  assert.deepEqual(Buffer.from(source.sourceBytes), before);
  assert.equal(JSON.stringify(report).includes("DraftCandidate"), false);
  assert.equal(JSON.stringify(report).includes("SourcePage"), false);
});

test("draft mode preserves a read-order failure without a success label", async () => {
  const engine = mockEngine(CANDIDATE);
  const { pdf, report } = await editPdf(request(), {
    draft: true,
    engineFactory: engine.factory,
    quality: quality({ ok: false, failures: [{ code: "edited_page_text_or_order_mismatch", pageIndex: 0 }], warnings: [] }),
  });
  assert.deepEqual(pdf, CANDIDATE);
  assert.equal(report.ok, false);
  assert.equal(report.quality, "failed");
  assert.equal(report.selfCheck.status, "failed");
  assert.equal(report.edits[0].status, "applied");
  assert.equal(report.outputSha256, sha(CANDIDATE));
});

test("draft does not opt in from a non-boolean and does not keep a non-PDF", async () => {
  const missing = mockEngine(CANDIDATE);
  await assert.rejects(
    editPdf(request(), { draft: "yes", engineFactory: missing.factory, quality: quality({ ok: false, failures: [{ code: "after_missing", id: "a", pageIndex: 0 }], warnings: [] }) }),
    (e) => e.code === "SELF_CHECK_FAILED" && e.pdf === undefined,
  );
  const junk = new Uint8Array(Buffer.from("not-a-pdf"));
  const engine = mockEngine(junk);
  await assert.rejects(
    editPdf(request(), { draft: true, engineFactory: engine.factory, quality: quality({ ok: false, failures: [{ code: "after_missing", id: "a", pageIndex: 0 }], warnings: [] }) }),
    (e) => e.code === "SELF_CHECK_FAILED" && e.pdf === undefined,
  );
});

test("draft preserves bytes when the self-check itself errors", async () => {
  const engine = mockEngine(CANDIDATE);
  const { pdf, report } = await editPdf(request(), {
    draft: true,
    engineFactory: engine.factory,
    quality: {
      capturePageLayout: () => ({ pi: 0 }),
      repairPageLayout: () => ({ repairs: [], warnings: [] }),
      inspectSavedPdf: async () => { throw new Error("inspect failed"); },
    },
  });
  assert.deepEqual(pdf, CANDIDATE);
  assert.equal(report.ok, false);
  assert.equal(report.quality, "error");
  assert.equal(report.selfCheck.status, "error");
  assert.equal(report.error.code, "SELF_CHECK_FAILED");
  assert.notEqual(report.selfCheck.status, "passed");
});

test("CLI stays strict and rejects the web draft field", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fpe-draft-cli-"));
  try {
    writeFileSync(join(dir, "in.pdf"), SOURCE);
    const req = join(dir, "request.json");
    writeFileSync(req, JSON.stringify({ input: "in.pdf", edits: [edit], reflow: true, draft: true }));
    assert.throws(() => loadRequest(req), (e) => e.code === "INVALID_REQUEST");
    writeFileSync(req, JSON.stringify({ input: "in.pdf", edits: [edit], reflow: true }));
    const out = join(dir, "out.pdf");
    const report = join(dir, "report.json");
    const code = await main([req, "--out", out, "--report", report], {
      stdout: () => {},
      stderr: () => {},
      editPdf: async () => ({ pdf: CANDIDATE, report: { ok: false, selfCheck: { status: "failed" } } }),
    });
    assert.equal(code, 1);
    assert.equal(readFileSync(join(dir, "in.pdf")).equals(Buffer.from(SOURCE)), true);
    let wrote = false;
    try { readFileSync(out); wrote = true; } catch {}
    assert.equal(wrote, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
