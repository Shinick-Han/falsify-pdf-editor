// Inline edit fixes: style mapping across runs (F6) and source line retention
// for re-laid-out short edits (F3). Synthetic data only. Real-engine cases
// run when a runtime loads (module .runtime, FALSIFY_EDITOR_CANDIDATE_MANIFEST,
// or the test-only FALSIFY_EDITOR_RUNTIME_DIR) and are skipped otherwise.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { editPdf, planPageEdits, rebuildRuns } from "../src/editor.mjs";
import { commitRetainingLines, planInlineChange, sourceLinePlan } from "../src/inline-preservation.mjs";
import { loadRuntime } from "../src/runtime.mjs";

const REG = { family: "Helvetica", bold: false, size: 11, rgba: 255 };
const BOLD = { ...REG, bold: true };
const mixedPara = () => ({
  id: 1,
  editable: true,
  box: { x: 72, top: 700, w: 300, h: 12 },
  format: {},
  lines: [{ y: 690, x: 72, off: 0 }],
  runs: [{ ...REG, text: "Plain words then " }, { ...BOLD, text: "bold words" }, { ...REG, text: " then plain words." }],
});
const rebuilt = (paras, edit) => {
  const r = planPageEdits(paras, [{ id: "e", pageIndex: 0, ...edit }]);
  if (r.failures.length) return r.failures;
  const [[pi, { del, inserts }]] = [...r.perPara.entries()];
  return rebuildRuns(paras[pi], del, inserts).map((x) => [x.text, !!x.bold]);
};

// ---------- F6: style mapping ----------

test("cross-run replacement keeps unchanged tokens in their own run (then bold -> and bold)", () => {
  assert.deepEqual(rebuilt([mixedPara()], { before: "then bold", after: "and bold" }), [
    ["Plain words and ", false], ["bold words", true], [" then plain words.", false],
  ]);
});

test("a replaced token inherits the style of the run it replaces", () => {
  assert.deepEqual(rebuilt([mixedPara()], { before: "bold words", after: "dark words" })[1], ["dark words", true]);
  assert.deepEqual(rebuilt([mixedPara()], { before: "words then plain", after: "words now plain" })[2], [" now plain words.", false]);
});

test("several replaced styles map word to word only when the token shape agrees", () => {
  assert.deepEqual(rebuilt([mixedPara()], { before: "then bold", after: "so dark" }), [
    ["Plain words so ", false], ["dark words", true], [" then plain words.", false],
  ]);
  for (const after of ["so dark big", "sodark", "so  dark"]) {
    const f = rebuilt([mixedPara()], { before: "then bold", after });
    assert.equal(f[0].code, "AMBIGUOUS_STYLE", after);
    assert.ok(!JSON.stringify(f).includes("dark"));
  }
});

test("insertions inherit matching neighbour style; differing neighbours are ambiguous", () => {
  assert.deepEqual(rebuilt([mixedPara()], { before: "bold words", after: "bold big words" })[1], ["bold big words", true]);
  assert.deepEqual(rebuilt([mixedPara()], { before: "Plain words", after: "Plain small words" })[0], ["Plain small words then ", false]);
  assert.equal(rebuilt([mixedPara()], { before: "then bold", after: "then very bold" })[0].code, "AMBIGUOUS_STYLE");
  assert.deepEqual(rebuilt([mixedPara()], { before: "bold words", after: "bold" })[1], ["bold", true]);
});

test("whitespace facing a source line break is kept when After uses a plain space", () => {
  const p = mixedPara();
  p.runs = [{ ...REG, text: "end of line\nnext line" }];
  assert.deepEqual(rebuilt([p], { before: "line next", after: "line first" }), [["end of line\nfirst line", false]]);
  assert.deepEqual(rebuilt([p], { before: "line next", after: "line - next" }), [["end of line\n- next line", false]]);
  // Whitespace-only differences stay a noop, as before.
  assert.equal(planPageEdits([p], [{ id: "n", pageIndex: 0, before: "line next", after: "line\n\nnext" }]).plans[0].noop, true);
});

test("editPdf refuses an ambiguous style mapping before any commit", async () => {
  const calls = [];
  const eng = {
    pageCount: 1,
    loadPage() {},
    normalizeFontsForEdit() {},
    pageRegenHostile: () => false,
    buildModel: () => [mixedPara()],
    commitParagraph: () => calls.push("commit"),
    save: () => calls.push("save"),
    close() {},
  };
  const quality = { capturePageLayout() {}, repairPageLayout() {}, inspectSavedPdf() {} };
  await assert.rejects(
    editPdf({ sourceBytes: new Uint8Array([1]), edits: [{ id: "x", pageIndex: 0, before: "then bold", after: "then very bold" }], reflow: true }, { engineFactory: async () => eng, quality }),
    (e) => e.code === "STYLE_AMBIGUOUS" && e.report.edits[0].code === "AMBIGUOUS_STYLE" && !JSON.stringify(e.report).includes("very"),
  );
  assert.deepEqual(calls, []);
});

// ---------- F3: source line plan ----------

const threeLines = () => ({
  id: 7,
  editable: true,
  box: { x: 72, top: 710, w: 260, h: 45 },
  format: {},
  lines: [{ y: 700, x: 72, off: 0 }, { y: 685, x: 72, off: 12 }, { y: 670, x: 72, off: 23 }],
  runs: [{ ...REG, text: "Alpha gamma Beta delta Gamma end." }],
});

test("sourceLinePlan turns soft breaks into hard breaks and marks edited lines", () => {
  const p = threeLines();
  const r = planPageEdits([p], [{ id: "e", pageIndex: 0, before: "gamma", after: "quiz" }]);
  const { del, inserts } = r.perPara.get(0);
  const lp = sourceLinePlan(p, del, inserts);
  assert.deepEqual([...lp.breaks], ["0:11", "0:22"]);
  assert.deepEqual([...lp.edited], [0]);
  assert.equal(rebuildRuns(p, del, inserts, lp.breaks)[0].text, "Alpha quiz\nBeta delta\nGamma end.");
  // Insertion at a line start touches that line and the end of the previous one.
  const q = planPageEdits([p], [{ id: "e", pageIndex: 0, before: "gamma Beta", after: "gamma New Beta" }]).perPara.get(0);
  assert.deepEqual([...sourceLinePlan(p, q.del, q.inserts).edited].sort(), [0, 1]);
});

test("sourceLinePlan declines line retention it cannot justify", () => {
  const p = threeLines();
  const cross = planPageEdits([p], [{ id: "e", pageIndex: 0, before: "gamma Beta", after: "quiz" }]).perPara.get(0);
  assert.deepEqual(sourceLinePlan(p, cross.del, cross.inserts), { reason: "edit_crosses_line" });
  const hyph = { ...threeLines(), runs: [{ ...REG, text: "Alpha gammaBeta delta Gamma end." }] };
  assert.equal(sourceLinePlan(hyph, new Set(), []).reason, "break_inside_word");
  assert.equal(sourceLinePlan({ ...p, lines: [{}] }, new Set(), []), null);
});

test("commitRetainingLines keeps the plain commit without engine support", () => {
  const p = threeLines();
  const eng = { commitParagraph: (id) => ({ id, surgical: false, lines: [{}, {}, {}] }) };
  assert.deepEqual(commitRetainingLines(eng, p, p.runs, null).lines, null);
  const lp = sourceLinePlan(p, new Set(["0:6"]), []);
  assert.deepEqual(commitRetainingLines(eng, p, p.runs, lp).lines, { status: "reflowed", reason: "engine_capability_missing" });
  assert.deepEqual(commitRetainingLines(eng, p, p.runs, { reason: "break_inside_word" }).lines, { status: "reflowed", reason: "break_inside_word" });
});

// ---------- real engine ----------

function pdf(content, fonts) {
  const res = Object.entries(fonts).map(([k, v], i) => `/${k} ${5 + i} 0 R`).join(" ");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << ${res} >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...Object.values(fonts).map((f) => `<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`),
  ];
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

// Header and footer come first in the stream: the pinned baseline engine
// appends re-laid-out objects at the stream end (docs/STREAM_ORDER.md), which
// is not what these cases test.
const EDGES = "BT /F1 8 Tf 72 760 Td (SYNTHETIC TEST PAGE - not a paper) Tj ET BT /F1 8 Tf 72 36 Td (Synthetic page 1) Tj ET ";
const LINES = ["Alpha beta gamma delta held steady on the bench.", "The red gear and the green bolt rested on the shelf.", "Each toy part was checked once and then set down."];
const paragraphPdf = () => pdf(EDGES + "BT /F1 11 Tf 15 TL 72 700 Td " + LINES.map((l) => `(${l}) Tj T*`).join(" ") + " ET", { F1: "Helvetica" });
const mixedPdf = () => pdf(EDGES + "BT /F1 11 Tf 15 TL 72 700 Td (The toy widget was placed on the bench before noon.) Tj T* "
  + "(Plain words then ) Tj /F2 11 Tf (bold words) Tj /F1 11 Tf ( then plain words.) Tj T* (The paragraph only gives the editor neighbours.) Tj ET",
{ F1: "Helvetica", F2: "Helvetica-Bold" });

const RUNTIME_DIR = process.env.FALSIFY_EDITOR_RUNTIME_DIR;
let rt = null;
try {
  rt = await loadRuntime(RUNTIME_DIR ? { runtimeDir: RUNTIME_DIR } : {});
} catch {}
const skip = !rt && "runtime not available";

// Glyph origin, font and size per character of the saved page.
async function glyphsOf(bytes) {
  const e = await rt.engineFactory(bytes);
  try {
    e.loadPage(0);
    const M = e.M;
    const tp = M._FPDFText_LoadPage(e.page);
    const n = M._FPDFText_CountChars(tp);
    const b = M._malloc(160);
    const out = [];
    for (let i = 0; i < n; i++) {
      const u = M._FPDFText_GetUnicode(tp, i);
      if (u <= 32 || !M._FPDFText_GetCharOrigin(tp, i, b, b + 8)) continue;
      M._FPDFText_GetFontInfo(tp, i, b + 16, 128, b + 144);
      out.push({ ch: String.fromCharCode(u), x: M.HEAPF64[b >> 3], y: M.HEAPF64[(b + 8) >> 3], font: M.UTF8ToString(b + 16, 128), size: M._FPDFText_GetFontSize(tp, i) });
    }
    M._free(b);
    M._FPDFText_ClosePage(tp);
    return out;
  } finally {
    e.close();
  }
}
const onLine = (gs, y) => gs.filter((g) => Math.abs(g.y - y) < 1).sort((a, b) => a.x - b.x);
const lineText = (gs, y) => onLine(gs, y).map((g) => g.ch).join("");
const run = (src, edits, options = {}) => editPdf({ sourceBytes: src, edits, reflow: true }, { engineFactory: options.engineFactory ?? rt.engineFactory, runtimeInfo: rt.info });

test("real engine: short edit with new glyphs keeps untouched source lines and baselines (F3)", { skip }, async () => {
  const src = paragraphPdf();
  const { pdf: out, report } = await run(src, [{ id: "q", pageIndex: 0, before: "gamma", after: "quiz" }]);
  assert.equal(report.ok, true);
  const row = report.pages[0].paragraphs[0];
  assert.equal(row.surgical, false, "fixture must exercise the re-layout path");
  assert.equal(row.lineRetention.status, "retained");
  assert.ok(!report.warnings.some((w) => w.code === "source_lines_reflowed"));
  const [s, o] = [await glyphsOf(src), await glyphsOf(out)];
  for (const y of [700, 685, 670]) assert.ok(onLine(o, y).length > 0, `baseline ${y} kept`);
  assert.equal(lineText(o, 700), "Alphabetaquizdeltaheldsteadyonthebench.");
  for (const y of [685, 670]) {
    const [a, b] = [onLine(s, y), onLine(o, y)];
    assert.equal(b.length, a.length);
    a.forEach((g, i) => {
      assert.equal(b[i].ch, g.ch);
      assert.equal(b[i].font, g.font);
      assert.ok(Math.abs(b[i].x - g.x) <= 0.02 && Math.abs(b[i].y - g.y) <= 0.02, `glyph ${i} on ${y}`);
    });
  }
  // The unchanged prefix of the edited line stays put; the tail follows naturally.
  const [a1, b1] = [onLine(s, 700), onLine(o, 700)];
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(b1[i].x - a1[i].x) <= 0.02);
  // Header and footer glyphs are untouched.
  for (const y of [760, 36]) assert.deepEqual(onLine(o, y).map((g) => [g.ch, g.x.toFixed(3)]), onLine(s, y).map((g) => [g.ch, g.x.toFixed(3)]));
});

test("real engine: an edit that needs more lines still reflows without a retention warning", { skip }, async () => {
  const src = paragraphPdf();
  const { report } = await run(src, [{ id: "l", pageIndex: 0, before: "gamma", after: "quiz ".repeat(12).trim() }]);
  const row = report.pages[0].paragraphs[0];
  assert.equal(row.lineRetention.status, "reflowed");
  assert.equal(row.lineRetention.reason, "line_count_changed");
  assert.ok(row.committedLines > 3);
  assert.ok(!report.warnings.some((w) => w.code === "source_lines_reflowed"));
});

test("real engine: failed kept-line proof restores the plain re-layout and warns", { skip }, async () => {
  const src = paragraphPdf();
  // Perturb every translation so the kept-line proof cannot hold.
  const engineFactory = async (bytes) => {
    const e = await rt.engineFactory(bytes);
    const translate = e.translateObject.bind(e);
    e.translateObject = (h, dx, dy) => translate(h, dx + 0.5, dy);
    return e;
  };
  const { pdf: out, report } = await run(src, [{ id: "q", pageIndex: 0, before: "gamma", after: "quiz" }], { engineFactory });
  const row = report.pages[0].paragraphs[0];
  assert.deepEqual(row.lineRetention, { status: "reflowed", reason: "kept_lines_moved" });
  assert.ok(report.warnings.some((w) => w.code === "source_lines_reflowed" && w.reason === "kept_lines_moved"));
  const text = (await glyphsOf(out)).map((g) => g.ch).join("");
  assert.ok(text.includes("Alphabetaquizdelta") && text.includes("thensetdown.") && !text.includes("gamma"));
});

test("real engine: cross-run edit keeps the bold run bold (F6)", { skip }, async () => {
  const src = mixedPdf();
  const { pdf: out, report } = await run(src, [{ id: "m", pageIndex: 0, before: "then bold", after: "and bold" }]);
  assert.equal(report.ok, true);
  const line = onLine(await glyphsOf(out), 685);
  assert.equal(line.map((g) => g.ch).join(""), "Plainwordsandboldwordsthenplainwords.");
  const fontOf = (word) => {
    const s = line.map((g) => g.ch).join("");
    const i = s.indexOf(word);
    return [...new Set(line.slice(i, i + word.length).map((g) => g.font))];
  };
  assert.deepEqual(fontOf("boldwords"), ["Helvetica-Bold"]);
  assert.deepEqual(fontOf("and"), ["Helvetica"]);
  assert.deepEqual(fontOf("thenplainwords."), ["Helvetica"]);
});

test("real engine: ambiguous cross-style edit is refused without output", { skip }, async () => {
  await assert.rejects(run(mixedPdf(), [{ id: "a", pageIndex: 0, before: "then bold words", after: "so dark" }]), (e) => e.code === "STYLE_AMBIGUOUS" && e.report.status === "failed");
});

// Optional: the private QA fixtures (subset.pdf, mixed.pdf) when a folder is given.
const QA = process.env.FALSIFY_QA_FIXTURES;
const qaSkip = skip || ((!QA || !existsSync(join(QA, "subset.pdf"))) && "QA fixtures not given");
test("real engine: QA subset_missing_glyph and mixed_fonts_across_runs", { skip: qaSkip }, async () => {
  const subset = new Uint8Array(readFileSync(join(QA, "subset.pdf")));
  const a = await run(subset, [{ id: "s", pageIndex: 0, before: "gamma", after: "quiz" }]);
  assert.equal(a.report.pages[0].paragraphs[0].lineRetention.status, "retained");
  const [s, o] = [await glyphsOf(subset), await glyphsOf(a.pdf)];
  for (const y of [726.89, 711.89]) {
    const [a, b] = [onLine(s, y), onLine(o, y)];
    assert.deepEqual(b.map((g) => [g.ch, g.font]), a.map((g) => [g.ch, g.font]));
    a.forEach((g, i) => assert.ok(Math.abs(b[i].x - g.x) <= 0.02 && Math.abs(b[i].y - g.y) <= 0.02));
  }
  assert.ok(onLine(o, 741.89).length > 0);
  const mixed = new Uint8Array(readFileSync(join(QA, "mixed.pdf")));
  const b = await run(mixed, [{ id: "m", pageIndex: 0, before: "then bold", after: "and bold" }]);
  const line = onLine(await glyphsOf(b.pdf), 711.89);
  const str = line.map((g) => g.ch).join("");
  const i = str.indexOf("boldwords");
  assert.deepEqual([...new Set(line.slice(i, i + 9).map((g) => g.font))], ["Helvetica-Bold"]);
});
