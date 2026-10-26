// Web-bridge draft protocol. Injected editPdf only; the strict tests in
// web-bridge.test.mjs stay on requests without the draft field.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EditError } from "../src/editor.mjs";
import { CANDIDATE_ENV } from "../src/runtime.mjs";
import { REQUEST_SCHEMA, main } from "../src/web-bridge.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const ENV = { [CANDIDATE_ENV]: join(tmpdir(), "candidate-manifest.json") };
const SOURCE = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const CANDIDATE = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/PieceInfo<</Draft true>>>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\nDraftCandidate\n");

function workspace(edit = (r) => r) {
  const dir = mkdtempSync(join(tmpdir(), "fpe-draft-"));
  writeFileSync(join(dir, "input.bin"), SOURCE);
  const req = edit({
    schema: REQUEST_SCHEMA,
    input: "input.bin",
    inputSha256: sha(SOURCE),
    reflow: true,
    edits: [{ id: "edit-1", pageIndex: 0, before: "alpha", after: "beta" }],
  });
  writeFileSync(join(dir, "request.json"), JSON.stringify(req));
  const argv = ["--request", join(dir, "request.json"), "--out", join(dir, "output.pdf"), "--report", join(dir, "report.json")];
  return { dir, argv, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function run(argv, deps) {
  const lines = [];
  const code = await main(argv, { env: ENV, stdout: (s) => lines.push(s), ...deps });
  assert.equal(lines.length, 1);
  return { code, out: JSON.parse(lines[0]) };
}

function failedReport(failures, status = "applied") {
  return {
    ok: false,
    status: "failed",
    draft: true,
    quality: "failed",
    reflow: true,
    runtime: { wasmSha256: "1".repeat(64), jsSha256: "2".repeat(64), candidate: { manifestSha256: "5".repeat(64) } },
    edits: [{ id: "edit-1", pageIndex: 0, status }],
    selfCheck: { status: "failed", ok: false, method: "same-pdfium-text-geometry", failures, warnings: [] },
    error: { code: "SELF_CHECK_FAILED", message: "Saved-PDF self-check reported failures" },
  };
}

test("draft request writes the failed PDF and an honest report", async () => {
  const ws = workspace((r) => ({ ...r, draft: true }));
  try {
    let seen;
    const { code, out } = await run(ws.argv, {
      editPdf: async (req, options) => {
        seen = { req, options };
        return { pdf: new Uint8Array(CANDIDATE), report: failedReport([{ code: "after_missing", pageIndex: 0, id: "edit-1" }]) };
      },
    });
    assert.equal(code, 1);
    assert.deepEqual(out, { ok: false, code: "SELF_CHECK_FAILED", draft: true });
    assert.equal(seen.options.draft, true);
    assert.equal(seen.req.draft, undefined);
    assert.deepEqual(Buffer.from(seen.req.sourceBytes), SOURCE);
    assert.deepEqual(readFileSync(join(ws.dir, "output.pdf")), CANDIDATE);
    assert.deepEqual(readFileSync(join(ws.dir, "input.bin")), SOURCE);
    const report = JSON.parse(readFileSync(join(ws.dir, "report.json"), "utf8"));
    assert.equal(report.ok, false);
    assert.equal(report.status, "draft");
    assert.equal(report.draft, true);
    assert.equal(report.quality, "failed");
    assert.equal(report.layoutVerified, false);
    assert.equal(report.selfCheck.status, "failed");
    assert.equal(report.edits[0].status, "after-missing");
    assert.equal(report.error.code, "SELF_CHECK_FAILED");
    assert.equal(report.outputSha256, sha(CANDIDATE));
    assert.equal(report.inputSha256, sha(SOURCE));
    assert.equal(report.runtime.wasmSha256, "1".repeat(64));
    assert.equal(JSON.stringify(report).includes("self-check-passed"), false);
    assert.equal(JSON.stringify(report).includes("DraftCandidate"), false);
    assert.deepEqual(readdirSync(ws.dir).sort(), ["input.bin", "output.pdf", "report.json", "request.json"]);
  } finally {
    ws.cleanup();
    assert.equal(existsSync(ws.dir), false);
  }
});

test("draft read-order failure keeps applied but not a passed check", async () => {
  const ws = workspace((r) => ({ ...r, draft: true }));
  try {
    const { code } = await run(ws.argv, {
      editPdf: async () => ({ pdf: new Uint8Array(CANDIDATE), report: failedReport([{ code: "edited_page_text_or_order_mismatch", pageIndex: 0 }]) }),
    });
    assert.equal(code, 1);
    const report = JSON.parse(readFileSync(join(ws.dir, "report.json"), "utf8"));
    assert.equal(report.ok, false);
    assert.equal(report.quality, "failed");
    assert.equal(report.edits[0].status, "applied");
    assert.deepEqual(readFileSync(join(ws.dir, "output.pdf")), CANDIDATE);
    assert.deepEqual(readFileSync(join(ws.dir, "input.bin")), SOURCE);
  } finally {
    ws.cleanup();
  }
});

test("strict request and pre-save failure still write no PDF", async () => {
  const strict = workspace();
  try {
    const { code, out } = await run(strict.argv, {
      editPdf: async (_req, options) => {
        assert.equal(options.draft, false);
        return { pdf: new Uint8Array(CANDIDATE), report: failedReport([{ code: "after_missing", id: "edit-1", pageIndex: 0 }]) };
      },
    });
    assert.equal(code, 1);
    assert.equal(out.draft, undefined);
    assert.equal(out.ok, false);
    assert.equal(existsSync(join(strict.dir, "output.pdf")), false);
  } finally {
    strict.cleanup();
  }
  const early = workspace((r) => ({ ...r, draft: true }));
  try {
    const err = new EditError("MATCH_FAILED", "1 edit(s) could not be matched exactly once");
    err.report = { ok: false, status: "failed", selfCheck: { status: "not-run" } };
    const { code, out } = await run(early.argv, { editPdf: async () => { throw err; } });
    assert.equal(code, 1);
    assert.equal(out.code, "MATCH_FAILED");
    assert.equal(existsSync(join(early.dir, "output.pdf")), false);
  } finally {
    early.cleanup();
  }
});

test("a non-boolean draft is rejected before editPdf", async () => {
  const ws = workspace((r) => ({ ...r, draft: "yes" }));
  try {
    const { code, out } = await run(ws.argv, { editPdf: async () => assert.fail("editPdf called") });
    assert.equal(code, 2);
    assert.equal(out.code, "INVALID_REQUEST");
    assert.equal(existsSync(join(ws.dir, "output.pdf")), false);
  } finally {
    ws.cleanup();
  }
});

test("draft does not keep a payload that is not a PDF", async () => {
  const ws = workspace((r) => ({ ...r, draft: true }));
  try {
    const { code } = await run(ws.argv, {
      editPdf: async () => ({ pdf: new Uint8Array(Buffer.from("not-a-pdf")), report: failedReport([{ code: "after_missing", id: "edit-1", pageIndex: 0 }]) }),
    });
    assert.equal(code, 1);
    assert.equal(existsSync(join(ws.dir, "output.pdf")), false);
  } finally {
    ws.cleanup();
  }
});
