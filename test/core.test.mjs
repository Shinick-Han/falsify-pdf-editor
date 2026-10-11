// Core module tests. Synthetic data only; the real-engine cases run when the
// pinned sources (module root or FALSIFY_EDITOR_SOURCE_ROOT) and a prepared
// .runtime are available, and are skipped otherwise.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, parse } from "node:path";
import { test } from "node:test";
import { EditError, editPdf, planPageEdits, rebuildRuns, validateRequest } from "../src/editor.mjs";
import { main } from "../src/cli.mjs";
import { MODULE_ROOT, PINS, readVerifiedRuntime, resolveRuntimeDir, resolveSourceRoot, verifyAppSource } from "../src/runtime.mjs";
import { prepareRuntime, validateModuleRoot } from "../scripts/prepare-runtime.mjs";

const SECRET = "Zyxw synthetic sentinel phrase";
const bytes = (s = "%PDF-1.4 synthetic") => new Uint8Array(Buffer.from(s));
const tmp = () => mkdtempSync(join(tmpdir(), "fpe-core-"));
const para = (id, text, extra = {}) => ({ id, editable: true, box: { x: 0, top: 100 - id * 10, w: 50, h: 9 }, lines: [{}], format: { id }, runs: [{ text, rgba: 0 }], ...extra });

// ---------- request validation ----------

test("validateRequest rejects malformed shapes and budgets", () => {
  const ok = { sourceBytes: bytes(), edits: [{ id: "a", pageIndex: 0, before: "x", after: "y" }], reflow: true };
  assert.equal(validateRequest(ok).edits.length, 1);
  const cases = [
    null,
    [],
    { ...ok, extra: 1 },
    { ...ok, sourceBytes: "x" },
    { ...ok, sourceBytes: new Uint8Array() },
    { ...ok, reflow: "yes" },
    { ...ok, reflow: undefined },
    { ...ok, edits: {} },
    { ...ok, edits: [{ id: "a", pageIndex: 0, before: "x", after: "y", page: 1 }] },
    { ...ok, edits: [{ id: "", pageIndex: 0, before: "x", after: "y" }] },
    { ...ok, edits: [{ id: "a b", pageIndex: 0, before: "x", after: "y" }] },
    { ...ok, edits: [{ id: "a", pageIndex: -1, before: "x", after: "y" }] },
    { ...ok, edits: [{ id: "a", pageIndex: 0.5, before: "x", after: "y" }] },
    { ...ok, edits: [{ id: "a", pageIndex: 0, before: "   ", after: "y" }] },
    { ...ok, edits: [{ id: "a", pageIndex: 0, before: "x" }] },
    { ...ok, edits: [ok.edits[0], ok.edits[0]] },
    { ...ok, edits: [{ id: "a", pageIndex: 0, before: "x".repeat(4001), after: "y" }] },
    { ...ok, edits: Array.from({ length: 65 }, (_, i) => ({ id: "e" + i, pageIndex: 0, before: "x", after: "y" })) },
  ];
  for (const c of cases) assert.throws(() => validateRequest(c), (e) => e instanceof EditError && e.code === "INVALID_REQUEST");
  assert.throws(() => validateRequest(ok, { maxFileBytes: 2, maxEdits: 64, maxTextChars: 4000, maxIdChars: 64 }), /exceeds/);
  assert.equal(validateRequest({ ...ok, edits: [] }).edits.length, 0);
});

test("validation errors never echo Before/After text", () => {
  const req = { sourceBytes: bytes(), edits: [{ id: "a", pageIndex: 0, before: SECRET, after: SECRET.repeat(400) }], reflow: true };
  assert.throws(() => validateRequest(req), (e) => !e.message.includes("Zyxw"));
});

// ---------- alignment ----------

test("planPageEdits matches whitespace-normalized text exactly once", () => {
  const paras = [para(1, "Alpha  beta\ngamma."), para(2, "Delta epsilon.")];
  const r = planPageEdits(paras, [{ id: "e", pageIndex: 0, before: "beta gamma", after: "BETA" }]);
  assert.deepEqual(r.failures, []);
  const { del, inserts } = r.perPara.get(0);
  assert.equal(rebuildRuns(paras[0], del, inserts).map((x) => x.text).join(""), "Alpha  BETA.");
});

test("planPageEdits reports ambiguous, missing, overlapping and locked targets without text", () => {
  const paras = [para(1, "same words here and same words there"), para(2, "unique tail", { editable: false })];
  const r = planPageEdits(paras, [
    { id: "amb", pageIndex: 0, before: "same words", after: "x" },
    { id: "miss", pageIndex: 0, before: "absent", after: "x" },
    { id: "first", pageIndex: 0, before: "words here", after: "x" },
    { id: "overlap", pageIndex: 0, before: "here and", after: "x" },
    { id: "locked", pageIndex: 0, before: "unique tail", after: "x" },
  ]);
  const byId = Object.fromEntries(r.failures.map((f) => [f.id, f]));
  assert.equal(byId.amb.code, "AMBIGUOUS_MATCH");
  assert.equal(byId.amb.hits, 2);
  assert.equal(byId.miss.code, "NOT_FOUND");
  assert.equal(byId.overlap.code, "OVERLAPPING_EDITS");
  assert.equal(byId.locked.code, "NOT_EDITABLE");
  assert.equal(byId.first, undefined);
  assert.ok(!JSON.stringify(r.failures).includes("words"));
});

test("planPageEdits keeps run styling, handles cross-paragraph spans and noop", () => {
  const p = para(1, "");
  p.runs = [{ text: "Bold ", rgba: 1, bold: true }, { text: "plain text", rgba: 2 }];
  const q = para(2, "next para");
  const r = planPageEdits([p, q], [
    { id: "mid", pageIndex: 0, before: "plain", after: "simple" },
    { id: "same", pageIndex: 0, before: "next  para", after: "next para" },
  ]);
  assert.deepEqual(r.failures, []);
  assert.equal(r.plans.find((x) => x.edit.id === "same").noop, true);
  assert.ok(!r.perPara.has(1));
  const runs = rebuildRuns(p, r.perPara.get(0).del, r.perPara.get(0).inserts);
  assert.deepEqual(runs.map((x) => [x.text, !!x.bold, x.sourceIndex]), [["Bold ", true, 0], ["simple text", false, 1]]);
  const span = planPageEdits([p, q], [{ id: "x", pageIndex: 0, before: "text next", after: "joined" }]);
  assert.deepEqual(span.failures, []);
  assert.deepEqual(span.plans[0].touched, [0, 1]);
});

// ---------- editPdf orchestration (mock engine/quality) ----------

function mockEngine(pages, { commitResult = (id) => ({ id, surgical: true, lines: [{}] }) } = {}) {
  const calls = [];
  let current = 0;
  let nextId = 1;
  const eng = {
    pageCount: pages.length,
    loadPage: (i) => { current = i; calls.push(["loadPage", i]); },
    normalizeFontsForEdit: () => calls.push(["normalize", current]),
    pageRegenHostile: () => false,
    // Fresh ids on every build, like the engine; geometry stays stable.
    buildModel: () => pages[current].map((t, i) => ({ ...para(nextId++, t), box: { x: 0, top: 700 - i * 20, w: 50, h: 9 } })),
    commitParagraph: (id, runs) => { calls.push(["commit", current, runs.map((r) => r.text).join("")]); return commitResult(id); },
    save: () => { calls.push(["save"]); return bytes("%PDF-edited"); },
    close: () => calls.push(["close"]),
  };
  return { eng, calls, factory: async (b) => { calls.push(["open", b ? b.length : 0]); return eng; } };
}

function mockQuality(calls, { ok = true } = {}) {
  return {
    capturePageLayout: (e, pi, paras) => { calls.push(["capture", pi, paras.length]); return { pi }; },
    repairPageLayout: (e, pi, ctx, touched) => { calls.push(["repair", pi, touched.map((t) => !!t.sourceBox)]); return { repairs: [], warnings: [] }; },
    inspectSavedPdf: async (f, s, o, edits) => { calls.push(["inspect", edits.length]); return { ok, failures: ok ? [] : [{ code: "X" }], warnings: [] }; },
  };
}

test("editPdf validates every page before any commit (all-or-nothing)", async () => {
  const { calls, factory } = mockEngine([["alpha beta"], ["gamma delta"]]);
  const edits = [
    { id: "ok", pageIndex: 0, before: "alpha", after: "ALPHA" },
    { id: "bad", pageIndex: 1, before: SECRET, after: "x" },
  ];
  await assert.rejects(editPdf({ sourceBytes: bytes(), edits, reflow: true }, { engineFactory: factory, quality: mockQuality(calls) }), (e) => {
    assert.equal(e.code, "MATCH_FAILED");
    assert.equal(e.report.edits.find((r) => r.id === "bad").code, "NOT_FOUND");
    assert.ok(!JSON.stringify(e.report).includes("Zyxw") && !e.message.includes("Zyxw"));
    return true;
  });
  assert.ok(!calls.some((c) => c[0] === "commit" || c[0] === "save" || c[0] === "capture"));
  assert.ok(calls.some((c) => c[0] === "close"));
});

test("editPdf rejects out-of-range pages before planning", async () => {
  const { calls, factory } = mockEngine([["alpha"]]);
  await assert.rejects(
    editPdf({ sourceBytes: bytes(), edits: [{ id: "p", pageIndex: 3, before: "alpha", after: "b" }], reflow: true }, { engineFactory: factory, quality: mockQuality(calls) }),
    { code: "PAGE_OUT_OF_RANGE" },
  );
  assert.ok(!calls.some((c) => c[0] === "commit"));
});

test("editPdf orders capture -> commit -> repair -> save -> inspect", async () => {
  const { calls, factory } = mockEngine([["alpha beta"], ["gamma delta"]]);
  const edits = [
    { id: "b", pageIndex: 1, before: "delta", after: "DELTA" },
    { id: "a", pageIndex: 0, before: "alpha", after: "ALPHA" },
  ];
  const { pdf, report } = await editPdf({ sourceBytes: bytes(), edits, reflow: true }, { engineFactory: factory, quality: mockQuality(calls) });
  assert.equal(Buffer.from(pdf).toString(), "%PDF-edited");
  assert.equal(report.ok, true);
  assert.equal(report.status, "self-check-passed");
  assert.equal(report.independentQA.status, "pending");
  assert.deepEqual(report.edits.map((r) => r.status), ["applied", "applied"]);
  const seq = calls.map((c) => c[0]).filter((k) => ["capture", "commit", "repair", "save", "inspect"].includes(k));
  assert.deepEqual(seq, ["capture", "commit", "repair", "capture", "commit", "repair", "save", "inspect"]);
  const commits = calls.filter((c) => c[0] === "commit");
  assert.deepEqual(commits.map((c) => c[2]), ["ALPHA beta", "gamma DELTA"]);
  const firstCommit = calls.findIndex((c) => c[0] === "commit");
  assert.equal(calls.filter((c, i) => c[0] === "normalize" && i < firstCommit).length, 2);
});

test("editPdf with reflow:false skips repair; noop returns source bytes", async () => {
  const m1 = mockEngine([["alpha"]]);
  await editPdf({ sourceBytes: bytes(), edits: [{ id: "a", pageIndex: 0, before: "alpha", after: "b" }], reflow: false }, { engineFactory: m1.factory, quality: mockQuality(m1.calls) });
  assert.ok(!m1.calls.some((c) => c[0] === "repair"));
  const m2 = mockEngine([["alpha"]]);
  const src = bytes("%PDF-source");
  const r = await editPdf({ sourceBytes: src, edits: [{ id: "n", pageIndex: 0, before: "alpha", after: "alpha" }], reflow: true }, { engineFactory: m2.factory, quality: mockQuality(m2.calls) });
  assert.deepEqual(r.pdf, src);
  assert.equal(r.report.edits[0].status, "noop");
  assert.ok(!m2.calls.some((c) => c[0] === "commit" || c[0] === "save"));
  const m3 = mockEngine([["alpha"]]);
  const r3 = await editPdf({ sourceBytes: src, edits: [], reflow: true }, { engineFactory: m3.factory, quality: mockQuality(m3.calls) });
  assert.deepEqual(r3.pdf, src);
});

test("editPdf fails on commit rejection and on self-check failure", async () => {
  const m1 = mockEngine([["alpha"]], { commitResult: () => null });
  await assert.rejects(editPdf({ sourceBytes: bytes(), edits: [{ id: "a", pageIndex: 0, before: "alpha", after: "b" }], reflow: true }, { engineFactory: m1.factory, quality: mockQuality(m1.calls) }), { code: "COMMIT_FAILED" });
  assert.ok(!m1.calls.some((c) => c[0] === "save"));
  const m2 = mockEngine([["alpha"]]);
  await assert.rejects(editPdf({ sourceBytes: bytes(), edits: [{ id: "a", pageIndex: 0, before: "alpha", after: "b" }], reflow: true }, { engineFactory: m2.factory, quality: mockQuality(m2.calls, { ok: false }) }), (e) => e.code === "SELF_CHECK_FAILED" && e.report.selfCheck.status === "failed");
});

test("editPdf detects model drift between planning and commit", async () => {
  const m = mockEngine([["alpha"]]);
  let builds = 0;
  const orig = m.eng.buildModel;
  m.eng.buildModel = () => (builds++ === 0 ? orig() : [para(99, "changed")]);
  await assert.rejects(editPdf({ sourceBytes: bytes(), edits: [{ id: "a", pageIndex: 0, before: "alpha", after: "b" }], reflow: true }, { engineFactory: m.factory, quality: mockQuality(m.calls) }), { code: "STATE_DRIFT" });
  assert.ok(!m.calls.some((c) => c[0] === "commit"));
});

test("editPdf rejects an incomplete quality module", async () => {
  const m = mockEngine([["alpha"]]);
  await assert.rejects(editPdf({ sourceBytes: bytes(), edits: [], reflow: true }, { engineFactory: m.factory, quality: { capturePageLayout() {} } }), { code: "QUALITY_UNAVAILABLE" });
});

test("editPdf treats repair severity:error as failure before save; warnings pass", async () => {
  const edit = [{ id: "a", pageIndex: 0, before: "alpha", after: "b" }];
  const withWarnings = (warnings) => {
    const m = mockEngine([["alpha"]]);
    const q = mockQuality(m.calls);
    q.repairPageLayout = () => ({ repairs: [], warnings });
    return { m, run: () => editPdf({ sourceBytes: bytes(), edits: edit, reflow: true }, { engineFactory: m.factory, quality: q }) };
  };
  const p = withWarnings([{ code: "pagination_unsupported", severity: "error" }]);
  await assert.rejects(p.run(), (e) => e.code === "LAYOUT_UNSUPPORTED" && e.report.warnings[0].code === "pagination_unsupported" && e.report.ok === false);
  assert.ok(!p.m.calls.some((c) => c[0] === "save" || c[0] === "inspect"));
  const f = withWarnings([{ code: "move_failed", severity: "error" }, { code: "line_pitch_unknown", severity: "warning" }]);
  await assert.rejects(f.run(), (e) => e.code === "REPAIR_FAILED" && e.details.codes.join() === "move_failed");
  assert.ok(!f.m.calls.some((c) => c[0] === "save"));
  const t = withWarnings([]);
  t.m.eng.commitParagraph = () => ({ id: 1 });
  const thrower = mockQuality(t.m.calls);
  thrower.repairPageLayout = () => { throw new Error(SECRET); };
  await assert.rejects(editPdf({ sourceBytes: bytes(), edits: edit, reflow: true }, { engineFactory: t.m.factory, quality: thrower }), (e) => e.code === "REPAIR_FAILED" && !JSON.stringify(e.details).includes("Zyxw"));
  const w = withWarnings([{ code: "line_pitch_unknown", severity: "warning" }, { code: "moved_edited_paragraph", severity: "info" }]);
  const ok = await w.run();
  assert.equal(ok.report.ok, true);
  assert.equal(ok.report.warnings.length, 2);
});

test("editPdf rejects a quality module missing exports", async () => {
  const m = mockEngine([["alpha"]]);
  await assert.rejects(editPdf({ sourceBytes: bytes(), edits: [], reflow: true }, { engineFactory: m.factory, quality: { capturePageLayout() {} } }), { code: "QUALITY_UNAVAILABLE" });
});

// ---------- CLI ----------

function cliFixture() {
  const dir = tmp();
  mkdirSync(join(dir, "in"));
  writeFileSync(join(dir, "in", "paper.pdf"), "%PDF-source");
  const req = join(dir, "in", "request.json");
  writeFileSync(req, JSON.stringify({ input: "paper.pdf", reflow: true, edits: [{ id: "a", pageIndex: 0, before: "x", after: "y" }] }));
  return { dir, req };
}
const quiet = { stdout: () => {}, stderr: () => {} };

test("CLI rejects malformed requests and usage", async () => {
  const { dir, req } = cliFixture();
  assert.equal(await main([req], quiet), 2);
  assert.equal(await main([req, "--out", join(dir, "o.pdf"), "--report", join(dir, "o.pdf")], quiet), 2);
  writeFileSync(join(dir, "bad.json"), "{not json");
  assert.equal(await main([join(dir, "bad.json"), "--out", join(dir, "o.pdf"), "--report", join(dir, "r.json")], quiet), 2);
  writeFileSync(join(dir, "extra.json"), JSON.stringify({ input: "in/paper.pdf", edits: [], reflow: true, select: "auto" }));
  assert.equal(await main([join(dir, "extra.json"), "--out", join(dir, "o.pdf"), "--report", join(dir, "r.json")], quiet), 2);
  writeFileSync(join(dir, "missing.json"), JSON.stringify({ input: "nope.pdf", edits: [], reflow: true }));
  assert.equal(await main([join(dir, "missing.json"), "--out", join(dir, "o.pdf"), "--report", join(dir, "r.json")], quiet), 2);
  assert.ok(!existsSync(join(dir, "o.pdf")));
});

test("CLI never overwrites the source or an existing output", async () => {
  const { dir, req } = cliFixture();
  const src = join(dir, "in", "paper.pdf");
  const editStub = async () => ({ pdf: bytes("%PDF-new"), report: { ok: true, selfCheck: { status: "passed" } } });
  assert.equal(await main([req, "--out", src, "--report", join(dir, "r.json")], { ...quiet, editPdf: editStub }), 2);
  assert.equal(await main([req, "--out", join(dir, "in", ".", "PAPER.pdf"), "--report", join(dir, "r.json")], { ...quiet, editPdf: editStub }), process.platform === "win32" || process.platform === "darwin" ? 2 : 0);
  assert.equal(await main([req, "--out", join(dir, "o.pdf"), "--report", src], { ...quiet, editPdf: editStub }), 2);
  assert.equal(readFileSync(src, "utf8"), "%PDF-source");
  writeFileSync(join(dir, "exists.pdf"), "keep");
  assert.equal(await main([req, "--out", join(dir, "exists.pdf"), "--report", join(dir, "r.json")], { ...quiet, editPdf: editStub }), 2);
  assert.equal(readFileSync(join(dir, "exists.pdf"), "utf8"), "keep");
});

test("CLI resolves input relative to the request and writes output only after self-check", async () => {
  const { dir, req } = cliFixture();
  let seen;
  const okStub = async (r) => { seen = Buffer.from(r.sourceBytes).toString(); return { pdf: bytes("%PDF-new"), report: { ok: true, selfCheck: { status: "passed" } } }; };
  const out = [];
  assert.equal(await main([req, "--out", join(dir, "out", "o.pdf"), "--report", join(dir, "out", "r.json")], { stdout: (s) => out.push(s), stderr: () => {}, editPdf: okStub }), 0);
  assert.equal(seen, "%PDF-source");
  assert.equal(readFileSync(join(dir, "out", "o.pdf"), "utf8"), "%PDF-new");
  assert.equal(JSON.parse(out[0]).independentQA, "pending");

  const failStub = async () => { const e = new EditError("SELF_CHECK_FAILED", "Saved-PDF self-check reported failures"); e.report = { ok: false }; throw e; };
  assert.equal(await main([req, "--out", join(dir, "f.pdf"), "--report", join(dir, "f.json")], { ...quiet, editPdf: failStub }), 1);
  assert.ok(!existsSync(join(dir, "f.pdf")));
  assert.equal(JSON.parse(readFileSync(join(dir, "f.json"), "utf8")).error.code, "SELF_CHECK_FAILED");

  const notOk = async () => ({ pdf: bytes("%PDF-new"), report: { ok: false, selfCheck: { status: "failed" } } });
  assert.equal(await main([req, "--out", join(dir, "g.pdf"), "--report", join(dir, "g.json")], { ...quiet, editPdf: notOk }), 1);
  assert.ok(!existsSync(join(dir, "g.pdf")));
});

test("CLI never overwrites an existing report without --overwrite and edits nothing", async () => {
  const { dir, req } = cliFixture();
  const report = join(dir, "r.json");
  writeFileSync(report, "keep-report");
  let calls = 0;
  const okStub = async () => { calls++; return { pdf: bytes("%PDF-new"), report: { ok: true, selfCheck: { status: "passed" } } }; };
  const failStub = async () => { calls++; throw new EditError("SELF_CHECK_FAILED", "fail"); };
  assert.equal(await main([req, "--out", join(dir, "o.pdf"), "--report", report], { ...quiet, editPdf: okStub }), 2);
  assert.equal(await main([req, "--out", join(dir, "o.pdf"), "--report", report], { ...quiet, editPdf: failStub }), 2);
  assert.equal(calls, 0);
  assert.equal(readFileSync(report, "utf8"), "keep-report");
  assert.ok(!existsSync(join(dir, "o.pdf")));
  // Existing output rejected: report destination is untouched too.
  writeFileSync(join(dir, "exists.pdf"), "keep");
  assert.equal(await main([req, "--out", join(dir, "exists.pdf"), "--report", join(dir, "new.json")], { ...quiet, editPdf: okStub }), 2);
  assert.equal(calls, 0);
  assert.ok(!existsSync(join(dir, "new.json")));
});

test("CLI --overwrite keeps source protections and replaces the intended report and output", async () => {
  const { dir, req } = cliFixture();
  const src = join(dir, "in", "paper.pdf");
  const okStub = async () => ({ pdf: bytes("%PDF-new"), report: { ok: true, selfCheck: { status: "passed" } } });
  assert.equal(await main([req, "--out", src, "--report", join(dir, "r.json"), "--overwrite"], { ...quiet, editPdf: okStub }), 2);
  assert.equal(await main([req, "--out", join(dir, "o.pdf"), "--report", src, "--overwrite"], { ...quiet, editPdf: okStub }), 2);
  assert.equal(await main([req, "--out", join(dir, "o.pdf"), "--report", req, "--overwrite"], { ...quiet, editPdf: okStub }), 2);
  assert.equal(readFileSync(src, "utf8"), "%PDF-source");
  assert.ok(readFileSync(req, "utf8").includes("paper.pdf"));
  assert.ok(!existsSync(join(dir, "o.pdf")) && !existsSync(join(dir, "r.json")));
  writeFileSync(join(dir, "o.pdf"), "old-out");
  writeFileSync(join(dir, "r.json"), "old-report");
  assert.equal(await main([req, "--out", join(dir, "o.pdf"), "--report", join(dir, "r.json"), "--overwrite"], { ...quiet, editPdf: okStub }), 0);
  assert.equal(readFileSync(join(dir, "o.pdf"), "utf8"), "%PDF-new");
  assert.equal(JSON.parse(readFileSync(join(dir, "r.json"), "utf8")).selfCheck.status, "passed");
  const failStub = async () => { const e = new EditError("SELF_CHECK_FAILED", "fail"); e.report = { ok: false }; throw e; };
  assert.equal(await main([req, "--out", join(dir, "o.pdf"), "--report", join(dir, "r.json"), "--overwrite"], { ...quiet, editPdf: failStub }), 1);
  assert.equal(readFileSync(join(dir, "o.pdf"), "utf8"), "%PDF-new");
  assert.equal(JSON.parse(readFileSync(join(dir, "r.json"), "utf8")).error.code, "SELF_CHECK_FAILED");
});

test("CLI publication never touches a pre-existing .tmp-PID staging file or symlink", async (t) => {
  const { dir, req } = cliFixture();
  const out = join(dir, "o.pdf");
  const report = join(dir, "r.json");
  const decoy = `${out}.tmp-${process.pid}`;
  writeFileSync(decoy, "decoy");
  const target = join(dir, "victim.txt");
  writeFileSync(target, "victim");
  const link = `${report}.tmp-${process.pid}`;
  let haveLink = "file";
  try {
    symlinkSync(target, link, "file");
  } catch {
    // Unprivileged Windows: a directory junction is still a link at the staging path.
    mkdirSync(join(dir, "victim-dir"));
    writeFileSync(join(dir, "victim-dir", "keep.txt"), "victim");
    symlinkSync(join(dir, "victim-dir"), link, "junction");
    haveLink = "junction";
  }
  const okStub = async () => ({ pdf: bytes("%PDF-new"), report: { ok: true, selfCheck: { status: "passed" } } });
  assert.equal(await main([req, "--out", out, "--report", report], { ...quiet, editPdf: okStub }), 0);
  assert.equal(readFileSync(out, "utf8"), "%PDF-new");
  assert.equal(JSON.parse(readFileSync(report, "utf8")).ok, true);
  assert.equal(readFileSync(decoy, "utf8"), "decoy");
  assert.equal(readFileSync(target, "utf8"), "victim");
  assert.ok(lstatSync(link).isSymbolicLink());
  const entries = ["in", "o.pdf", "o.pdf.tmp-" + process.pid, "r.json", "r.json.tmp-" + process.pid, "victim.txt"];
  if (haveLink === "junction") {
    entries.push("victim-dir");
    assert.deepEqual(readdirSync(join(dir, "victim-dir")), ["keep.txt"]);
    t.diagnostic("file symlinks not permitted; used a directory junction at the staging path");
  }
  assert.deepEqual(readdirSync(dir).sort(), entries.sort());
});

// ---------- runtime preparation safety ----------

function fakeModuleRoot(name = "falsify-pdf-editor") {
  const dir = tmp();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
  return dir;
}

test("prepareRuntime refuses hostile module roots", () => {
  const unsafe = (moduleRoot) => assert.throws(() => prepareRuntime({ moduleRoot }), { code: "UNSAFE_OUTPUT" });
  unsafe(parse(tmpdir()).root);
  unsafe(homedir());
  unsafe(tmp());
  unsafe(fakeModuleRoot("someone-else"));
  unsafe(join(tmp(), "does-not-exist"));
  const file = join(tmp(), "file");
  writeFileSync(file, "x");
  unsafe(file);
  const real = fakeModuleRoot();
  const link = join(tmp(), "link");
  try {
    symlinkSync(real, link, "junction");
  } catch {
    return;
  }
  unsafe(link);
  assert.equal(validateModuleRoot(real).length > 0, true);
});

test("prepareRuntime leaves pre-existing user files and siblings untouched", () => {
  const root = fakeModuleRoot();
  mkdirSync(join(root, ".runtime"));
  writeFileSync(join(root, ".runtime", "notes.txt"), "user data");
  mkdirSync(join(root, ".runtime-staging-keep"));
  writeFileSync(join(root, ".runtime-staging-keep", "x"), "sibling");
  assert.throws(() => prepareRuntime({ moduleRoot: root }), { code: "UNSAFE_OUTPUT" });
  assert.equal(readFileSync(join(root, ".runtime", "notes.txt"), "utf8"), "user data");
  assert.equal(readFileSync(join(root, ".runtime-staging-keep", "x"), "utf8"), "sibling");
  const root2 = fakeModuleRoot();
  writeFileSync(join(root2, ".runtime"), "a file, not a dir");
  assert.throws(() => prepareRuntime({ moduleRoot: root2 }), { code: "UNSAFE_OUTPUT" });
  assert.equal(readFileSync(join(root2, ".runtime"), "utf8"), "a file, not a dir");
});

test("readVerifiedRuntime rejects missing and tampered runtime files", () => {
  const dir = tmp();
  assert.throws(() => readVerifiedRuntime(dir), { code: "RUNTIME_MISSING" });
  writeFileSync(join(dir, "editcore.js"), "export default 1");
  writeFileSync(join(dir, "editcore.wasm"), "not wasm");
  assert.throws(() => readVerifiedRuntime(dir), { code: "RUNTIME_HASH_MISMATCH" });
});

const SOURCE_ROOT = resolveSourceRoot();
const hasSource = existsSync(join(SOURCE_ROOT, PINS.bentopdf.path, "src", "js", "editcore", "core.js")) && existsSync(join(SOURCE_ROOT, PINS.engine.path, "packages"));

test("prepareRuntime rejects pinned hash and app pin mismatches", { skip: !hasSource && "pinned submodules unavailable" }, () => {
  const root = fakeModuleRoot();
  const wrongHash = { ...PINS, engine: { ...PINS.engine, wasm: { ...PINS.engine.wasm, sha256: "0".repeat(64) } } };
  assert.throws(() => prepareRuntime({ moduleRoot: root, sourceRoot: SOURCE_ROOT, pins: wrongHash }), { code: "RUNTIME_HASH_MISMATCH" });
  assert.deepEqual(readdirSync(root), ["package.json"]);
  const wrongPin = { ...PINS, bentopdf: { ...PINS.bentopdf, commit: "0".repeat(40) } };
  assert.throws(() => prepareRuntime({ moduleRoot: root, sourceRoot: SOURCE_ROOT, pins: wrongPin }), { code: "PIN_MISMATCH" });
  assert.throws(() => verifyAppSource(SOURCE_ROOT, wrongPin), { code: "PIN_MISMATCH" });
  assert.deepEqual(readdirSync(root), ["package.json"]);
});

test("prepareRuntime writes verified blobs and replaces only its own output", { skip: !hasSource && "pinned submodules unavailable" }, () => {
  const root = fakeModuleRoot();
  writeFileSync(join(root, ".runtime-backup-user"), "sibling file");
  prepareRuntime({ moduleRoot: root, sourceRoot: SOURCE_ROOT });
  prepareRuntime({ moduleRoot: root, sourceRoot: SOURCE_ROOT });
  assert.equal(readVerifiedRuntime(join(root, ".runtime")).wasm.sha256, PINS.engine.wasm.sha256);
  assert.deepEqual(readdirSync(root).sort(), [".runtime", ".runtime-backup-user", "package.json"]);
  assert.equal(readFileSync(join(root, ".runtime-backup-user"), "utf8"), "sibling file");
});

// ---------- real engine (synthetic PDF) ----------

function syntheticPdf(lines) {
  const content = "BT /F1 12 Tf 14 TL 72 720 Td " + lines.map((l) => `(${l}) Tj T*`).join(" ") + " ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

const hasRuntime = hasSource && existsSync(join(resolveRuntimeDir(), "editcore.wasm"));
const passQuality = {
  capturePageLayout: () => ({}),
  repairPageLayout: () => ({ repairs: [], warnings: [] }),
  inspectSavedPdf: async () => ({ ok: true, failures: [], warnings: [], note: "test stub" }),
};

test("real engine: ambiguous Before is rejected without mutation", { skip: !hasRuntime && "runtime not prepared" }, async () => {
  const src = syntheticPdf(["Repeat token here.", "Repeat token here."]);
  await assert.rejects(editPdf({ sourceBytes: src, edits: [{ id: "amb", pageIndex: 0, before: "Repeat token", after: "Once" }], reflow: true }, { quality: passQuality }), (e) => e.code === "MATCH_FAILED" && e.report.edits[0].code === "AMBIGUOUS_MATCH");
});

test("real engine: short edit commits and the saved text changes", { skip: !hasRuntime && "runtime not prepared" }, async () => {
  const src = syntheticPdf(["Synthetic first line of text.", "Second line stays the same."]);
  let seen;
  const quality = { ...passQuality, inspectSavedPdf: async (factory, s, o) => {
    const eng = await factory(o);
    eng.loadPage(0);
    seen = eng.buildModel().map((p) => p.runs.map((r) => r.text).join("")).join(" ");
    eng.close();
    return { ok: true, failures: [], warnings: [] };
  } };
  const { pdf, report } = await editPdf({ sourceBytes: src, edits: [{ id: "s", pageIndex: 0, before: "first line", after: "opening line" }], reflow: true }, { quality });
  assert.equal(report.ok, true);
  assert.notDeepEqual(pdf, src);
  assert.match(seen.replace(/\s+/g, " "), /Synthetic opening line of text\./);
  assert.match(seen, /Second line stays the same\./);
  assert.equal(report.edits[0].status, "applied");
});

test("module root default resolves to this package", () => {
  assert.ok(existsSync(join(MODULE_ROOT, "package.json")));
  assert.equal(JSON.parse(readFileSync(join(MODULE_ROOT, "package.json"), "utf8")).license, "AGPL-3.0-only");
});
