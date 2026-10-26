// Line-local commit (inline-preservation commitLineLocal and its editor
// wiring): the edited source line alone is re-laid out. Synthetic data only.
// Real-engine cases run when a runtime loads (module .runtime,
// FALSIFY_EDITOR_CANDIDATE_MANIFEST, or the test-only
// FALSIFY_EDITOR_RUNTIME_DIR) and are skipped otherwise.
import assert from "node:assert/strict";
import { test } from "node:test";
import { editPdf, planPageEdits } from "../src/editor.mjs";
import { editedLineSpan } from "../src/inline-preservation.mjs";
import { loadRuntime } from "../src/runtime.mjs";

// ---------- editedLineSpan ----------

const REG = { family: "Helvetica", bold: false, size: 11, rgba: 255 };
// "Alpha gamma " | "Beta delta " | "Gamma end." (offsets 0, 12, 23)
const threeLines = () => ({
  id: 1,
  editable: true,
  box: { x: 72, top: 710, w: 200, h: 40 },
  format: { align: 3 },
  lines: [{ y: 700, x: 72, w: 200, off: 0 }, { y: 685, x: 72, w: 200, off: 12 }, { y: 670, x: 72, w: 60, off: 23 }],
  runs: [{ ...REG, text: "Alpha gamma " }, { ...REG, text: "Beta delta Gamma end." }],
});
const spanOf = (p, before, after) => {
  const r = planPageEdits([p], [{ id: "e", pageIndex: 0, before, after }]);
  assert.deepEqual(r.failures, []);
  const { del, inserts } = r.perPara.get(0);
  return editedLineSpan(p, del, inserts);
};

test("editedLineSpan gives the edited line as offsets without its trailing space", () => {
  const p = threeLines();
  assert.deepEqual(spanOf(p, "gamma", "quiz"), { k: 0, start: 0, end: 11 });
  // A line spread over two runs, cut at the line start.
  assert.deepEqual(spanOf(p, "delta", "omega"), { k: 1, start: 12, end: 22 });
  assert.deepEqual(spanOf(p, "Beta delta", "Beta omega"), { k: 1, start: 12, end: 22 });
  assert.deepEqual(spanOf(p, "end.", "stop."), { k: 2, start: 23, end: 33 });
  // Insertion at the very end of a line stays on that line.
  assert.deepEqual(spanOf(p, "Gamma end.", "Gamma end now."), { k: 2, start: 23, end: 33 });
  assert.deepEqual(spanOf(p, "Alpha gamma", "Alpha gamma ray"), { k: 0, start: 0, end: 11 });
});

test("editedLineSpan refuses edits across or at a line break", () => {
  const p = threeLines();
  assert.deepEqual(spanOf(p, "gamma Beta", "quiz"), { reason: "edit_spans_lines" });
  // An insertion at a line start also touches the end of the previous line.
  assert.deepEqual(spanOf(p, "gamma Beta", "gamma New Beta"), { reason: "edit_spans_lines" });
  // So does replacing the first word of a line (its new text is inserted at
  // the line start): declined, not guessed.
  assert.deepEqual(spanOf(p, "Beta", "Zeta"), { reason: "edit_spans_lines" });
  // Removing the break space itself, with both sides kept.
  const del = new Set(["0:11"]);
  assert.deepEqual(editedLineSpan(p, del, []), { reason: "edit_crosses_line" });
  // An insertion inside the trailing whitespace of a line.
  assert.deepEqual(editedLineSpan(p, new Set(), [{ ri: 0, o: 12, text: "x" }]), { reason: "edit_spans_lines" });
  const q = { ...threeLines(), runs: [{ ...REG, text: "Alpha gamma  " }, { ...REG, text: "Beta delta Gamma end." }], lines: [{ y: 700, x: 72, w: 200, off: 0 }, { y: 685, x: 72, w: 200, off: 13 }, { y: 670, x: 72, w: 60, off: 24 }] };
  assert.deepEqual(editedLineSpan(q, new Set(), [{ ri: 0, o: 12, text: "x" }]), { reason: "edit_crosses_line" });
});

test("editedLineSpan declines without valid line geometry", () => {
  const p = threeLines();
  const del = new Set(["0:6"]);
  assert.equal(editedLineSpan({ ...p, lines: [] }, del, []), null);
  assert.equal(editedLineSpan({ ...p, lines: [{ y: 700, x: 72, off: 0 }] }, del, []), null);
  assert.deepEqual(editedLineSpan({ ...p, lines: p.lines.map((l, k) => ({ ...l, off: k ? l.off : 1 })) }, del, []), { reason: "line_offsets_invalid" });
  assert.deepEqual(editedLineSpan({ ...p, lines: [p.lines[0], p.lines[2], p.lines[1]] }, del, []), { reason: "line_offsets_invalid" });
  assert.deepEqual(editedLineSpan({ ...p, lines: [p.lines[0], { ...p.lines[1], off: 99 }] }, del, []), { reason: "line_offsets_invalid" });
});

// ---------- real engine ----------

function pdf(content) {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

const RUNTIME_DIR = process.env.FALSIFY_EDITOR_RUNTIME_DIR;
let rt = null;
try {
  rt = await loadRuntime(RUNTIME_DIR ? { runtimeDir: RUNTIME_DIR } : {});
} catch {}
const skip = !rt && "runtime not available";

// Paragraphs are placed mid-page, clear of the header/footer edge bands.
const EDGES = "BT /F1 8 Tf 72 760 Td (SYNTHETIC TEST PAGE - not a paper) Tj ET BT /F1 8 Tf 72 36 Td (Synthetic page 1) Tj ET ";
const P1 = ["Alpha beta gamma delta held steady on the long bench", "The red gear and the green bolt rested on a shelf", "Each toy part was checked once and then set down", "The end."];
const P2 = ["Zinc wire and copper tape were laid on the table", "Two small lamps glowed while the old clock ticked", "Nobody moved the box until the bell rang twice", "Then quiet."];
const WIDTH = 280;
// LaTeX-like justified lines: words in one TJ with interword kerns (no space
// characters) and, on the second line, a 98% horizontal scale standing in
// for microtype font expansion. The kerns are fitted with the engine so
// every line but the last spans WIDTH. With a page scale s the paragraphs
// sit in a uniform "s 0 0 s 0 0 cm" with font size and coordinates divided
// by s, so the page shows the same lines with glyph matrices [s,0,0,s].
const num = (v) => +v.toFixed(4);
const justifiedContent = (paras, kerns, s = 1) => (s === 1 ? "" : `q ${s} 0 0 ${s} 0 0 cm `) + paras.map(({ y, lines }, n) => `BT /F1 ${num(11 / s)} Tf ${num(15 / s)} TL ${num(72 / s)} ${num(y / s)} Td `
  + lines.map((l, k) => `${k === 1 ? 98 : 100} Tz [` + l.split(" ").map((w) => `(${w})`).join(` ${kerns[n][k].toFixed(3)} `) + "] TJ T*").join(" ") + " ET ").join("") + (s === 1 ? "" : "Q ");
async function justifiedPdf(paras, extra = "", s = 1) {
  let kerns = paras.map(({ lines }) => lines.map(() => -278));
  const make = () => pdf(EDGES + justifiedContent(paras, kerns, s) + extra);
  for (let it = 0; it < 4; it++) {
    const e = await rt.engineFactory(make());
    try {
      e.loadPage(0);
      const model = e.buildModel().filter((p) => p.lines.length === 4);
      kerns = kerns.map((ks, n) => ks.map((v, k) => {
        if (k === 3) return v;
        const gaps = paras[n].lines[k].split(" ").length - 1;
        return v - ((WIDTH - model[n].lines[k].w) / gaps / (11 * (k === 1 ? 0.98 : 1))) * 1000;
      }));
    } finally {
      e.close();
    }
  }
  return make();
}

// Per glyph of the saved page: character, origin, font, size, the glyph
// matrix and the right edge of its box.
async function glyphsOf(bytes) {
  const e = await rt.engineFactory(bytes);
  try {
    e.loadPage(0);
    const M = e.M;
    const tp = M._FPDFText_LoadPage(e.page);
    const n = M._FPDFText_CountChars(tp);
    const b = M._malloc(256);
    const out = [];
    for (let i = 0; i < n; i++) {
      const u = M._FPDFText_GetUnicode(tp, i);
      if (u <= 32 || !M._FPDFText_GetCharOrigin(tp, i, b, b + 8)) continue;
      M._FPDFText_GetFontInfo(tp, i, b + 16, 128, b + 144);
      const font = M.UTF8ToString(b + 16, 128);
      M._FPDFText_GetMatrix(tp, i, b + 160);
      const matrix = Array.from({ length: 6 }, (_, j) => M.HEAPF32[((b + 160) >> 2) + j]);
      M._FPDFText_GetCharBox(tp, i, b + 192, b + 200, b + 208, b + 216);
      out.push({ ch: String.fromCharCode(u), x: M.HEAPF64[b >> 3], y: M.HEAPF64[(b + 8) >> 3], font, size: M._FPDFText_GetFontSize(tp, i), matrix, right: M.HEAPF64[(b + 200) >> 3] });
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
// Exact source line: same characters, fonts, sizes, matrices and origins.
function assertSameLine(src, out, y) {
  const [a, b] = [onLine(src, y), onLine(out, y)];
  assert.ok(a.length > 0, `source line ${y} present`);
  assert.equal(b.length, a.length, `glyph count on ${y}`);
  a.forEach((g, i) => {
    const h = b[i];
    assert.equal(h.ch, g.ch, `char ${i} on ${y}`);
    assert.equal(h.font, g.font, `font ${i} on ${y}`);
    assert.ok(Math.abs(h.size - g.size) <= 0.01, `size ${i} on ${y}`);
    assert.ok(Math.abs(h.x - g.x) <= 0.02 && Math.abs(h.y - g.y) <= 0.02, `origin ${i} on ${y}`);
    h.matrix.forEach((v, j) => assert.ok(Math.abs(v - g.matrix[j]) <= 1e-3, `matrix ${i}[${j}] on ${y}`));
  });
}
const run = (src, edits, engineFactory = rt.engineFactory) => editPdf({ sourceBytes: src, edits, reflow: true }, { engineFactory, runtimeInfo: rt.info });
// The pre-line-local behaviour: without historyNoteMatrix no line-local
// commit is tried.
const plainFactory = async (bytes) => {
  const e = await rt.engineFactory(bytes);
  e.historyNoteMatrix = undefined;
  return e;
};
const ONE = [{ y: 500, lines: P1 }];

test("real engine: a justified, scaled line is re-laid out alone; every other line stays glyph for glyph", { skip }, async () => {
  const src = await justifiedPdf(ONE);
  const { pdf: out, report } = await run(src, [{ id: "g", pageIndex: 0, before: "green bolt", after: "grey bolt" }]);
  assert.equal(report.ok, true, JSON.stringify(report.selfCheck?.failures));
  const row = report.pages[0].paragraphs[0];
  assert.equal(row.lineRetention.status, "line_local");
  assert.deepEqual({ ...row.lineRetention, wordSpacing: undefined }, { status: "line_local", line: 1, lines: 4, kept: 3, justified: true, wordSpacing: undefined, hScale: 0.98, maxKeptShift: 0 });
  assert.ok(!report.warnings.some((w) => w.code === "source_lines_reflowed"));
  const [s, o] = [await glyphsOf(src), await glyphsOf(out)];
  for (const y of [500, 470, 455, 760, 36]) assertSameLine(s, o, y);
  // The edited line: source baseline, source start, source right edge and
  // the source horizontal scale on every glyph.
  const [a, b] = [onLine(s, 485), onLine(o, 485)];
  assert.equal(lineText(o, 485), "Theredgearandthegreyboltrestedonashelf");
  assert.ok(b.every((g) => Math.abs(g.y - 485) <= 0.02));
  assert.ok(Math.abs(b[0].x - a[0].x) <= 0.1);
  assert.ok(Math.abs(b.at(-1).right - a.at(-1).right) <= 0.5);
  assert.ok(b.every((g) => Math.abs(g.matrix[0] - 0.98) <= 1e-3 && Math.abs(g.matrix[3] - 1) <= 1e-3), JSON.stringify(b[0].matrix));
  assert.ok(onLine(o, 500).every((g) => Math.abs(g.matrix[0] - 1) <= 1e-3), "unscaled lines stay unscaled");
  // The first word keeps its glyph positions; later words follow the new
  // justified spacing.
  for (let i = 0; i < "The".length; i++) assert.ok(Math.abs(b[i].x - a[i].x) <= 0.1, `first word ${i}`);
});

test("real engine: a last-line edit stays flush left and keeps the justified lines", { skip }, async () => {
  const src = await justifiedPdf(ONE);
  const { pdf: out, report } = await run(src, [{ id: "f", pageIndex: 0, before: "The end.", after: "The finish." }]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.pages[0].paragraphs[0].lineRetention, { status: "line_local", line: 3, lines: 4, kept: 3, justified: false, wordSpacing: 0, hScale: 1, maxKeptShift: 0 });
  const [s, o] = [await glyphsOf(src), await glyphsOf(out)];
  for (const y of [500, 485, 470]) assertSameLine(s, o, y);
  assert.equal(lineText(o, 455), "Thefinish.");
  assert.ok(Math.abs(onLine(o, 455)[0].x - onLine(s, 455)[0].x) <= 0.1);
});

test("real engine: a middle-line overflow pins the prefix and reflows only the suffix", { skip }, async () => {
  const src = await justifiedPdf(ONE);
  // Too long for its justified line. The prefix line stays; the suffix reflows.
  const edits = [{ id: "w", pageIndex: 0, before: "the green", after: "the very green" }];
  const { pdf: out, report } = await run(src, edits);
  assert.equal(report.ok, true, JSON.stringify(report.selfCheck?.failures));
  const row = report.pages[0].paragraphs[0];
  assert.equal(row.lineLocal, undefined);
  assert.equal(row.lineRetention.status, "reflowed");
  assert.equal(row.lineRetention.reason, "edited_line_overflows");
  assert.equal(row.lineRetention.prefixKept, 1);
  assert.equal(row.lineRetention.suffixReflow, true);
  assert.ok(report.warnings.some((w) => w.code === "source_lines_reflowed" && w.reason === "edited_line_overflows"));
  const [s, o] = [await glyphsOf(src), await glyphsOf(out)];
  assertSameLine(s, o, 500);
  assert.ok(o.every((g) => Math.abs(g.size - 11) <= 0.01 || g.y > 700 || g.y < 50));
  assert.ok(lineText(o, 485).includes("very") || o.map((g) => g.ch).join("").includes("theverygreen"));
});

test("real engine: an undo that does not restore the page fails closed with STATE_DRIFT", { skip }, async () => {
  const src = await justifiedPdf(ONE);
  // Once the line has been isolated, undo reports success but does nothing.
  const engineFactory = async (bytes) => {
    const e = await rt.engineFactory(bytes);
    const begin = e.historyBeginStep.bind(e), undo = e.historyUndo.bind(e);
    let isolated = false;
    e.historyBeginStep = (label) => {
      if (label === "falsify-line-isolate") isolated = true;
      return begin(label);
    };
    e.historyUndo = () => (isolated ? true : undo());
    return e;
  };
  await assert.rejects(
    run(src, [{ id: "w", pageIndex: 0, before: "the green", after: "the very green" }], engineFactory),
    (e) => e.code === "STATE_DRIFT" && e.report.status === "failed" && !e.pdf,
  );
});

test("real engine: a page whose model build re-creates objects keeps the plain re-layout", { skip }, async () => {
  // Tw word spacing: the engine re-creates these text objects on every model
  // build, so undo steps by handle are unsafe; line-local must not run.
  const lines = P1.slice(0, 3);
  const probe = await rt.engineFactory(pdf(EDGES + "BT /F1 11 Tf 15 TL 72 500 Td " + lines.map((l) => `(${l}) Tj T*`).join(" ") + " (The end.) Tj ET"));
  probe.loadPage(0);
  const widths = probe.buildModel().find((p) => p.lines.length === 4).lines.map((l) => l.w);
  probe.close();
  const src = pdf(EDGES + "BT /F1 11 Tf 15 TL 72 500 Td " + lines.map((l, k) => `${((WIDTH - widths[k]) / (l.split(" ").length - 1)).toFixed(4)} Tw (${l}) Tj T*`).join(" ") + " 0 Tw (The end.) Tj ET");
  const edits = [{ id: "g", pageIndex: 0, before: "green bolt", after: "grey bolt" }];
  const { pdf: out, report } = await run(src, edits);
  assert.equal(report.ok, true);
  const row = report.pages[0].paragraphs[0];
  assert.deepEqual(row.lineLocal, { status: "declined", reason: "page_model_unstable" });
  assert.equal(row.lineRetention.status, "reflowed");
  const plain = await run(src, edits, plainFactory);
  const [a, b] = [await glyphsOf(plain.pdf), await glyphsOf(out)];
  assert.deepEqual(b.map((g) => [g.ch, g.x.toFixed(3), g.y.toFixed(3)]), a.map((g) => [g.ch, g.x.toFixed(3), g.y.toFixed(3)]));
});

test("real engine: edits in two paragraphs map to their own paragraphs after a line-local commit", { skip }, async () => {
  const note = "BT /F1 11 Tf 100 Tz 72 340 Td (A plain note sits below both paragraphs.) Tj ET";
  const src = await justifiedPdf([{ y: 560, lines: P1 }, { y: 440, lines: P2 }], note);
  const edits = [
    { id: "a", pageIndex: 0, before: "green bolt", after: "grey bolt" },
    { id: "b", pageIndex: 0, before: "lamps glowed", after: "lamps shone" },
    { id: "c", pageIndex: 0, before: "Then quiet.", after: "Then calm." },
  ];
  const { pdf: out, report } = await run(src, edits);
  assert.equal(report.ok, true, JSON.stringify(report.selfCheck?.failures));
  assert.deepEqual(report.edits.map((e) => [e.id, e.status]), [["a", "applied"], ["b", "applied"], ["c", "applied"]]);
  // Both edits of the second paragraph are on different lines: one
  // paragraph commit, which is not line-local.
  const rows = report.pages[0].paragraphs;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].lineRetention.status, "line_local");
  assert.equal(rows[0].lineRetention.line, 1);
  assert.deepEqual(rows.map((r) => r.index), [1, 2]);
  assert.equal(rows[1].lineRetention.status, "reflowed");
  assert.deepEqual(rows[1].lineLocal, { status: "declined", reason: "edit_spans_lines" });
  assert.ok(report.warnings.some((w) => w.code === "source_lines_reflowed" && w.paragraphIndex === 2));
  assert.ok(!report.warnings.some((w) => w.code === "source_lines_reflowed" && w.paragraphIndex === 1));
  const [s, o] = [await glyphsOf(src), await glyphsOf(out)];
  const text = o.map((g) => g.ch).join("");
  for (const t of ["greybolt", "lampsshone", "Thencalm."]) assert.ok(text.includes(t), t);
  for (const t of ["greenbolt", "lampsglowed", "Thenquiet."]) assert.ok(!text.includes(t), t);
  // The first paragraph's other lines, the note and the edges are untouched.
  for (const y of [560, 530, 515, 340, 760, 36]) assertSameLine(s, o, y);
  assert.equal(lineText(o, 545), "Theredgearandthegreyboltrestedonashelf");
});

test("real engine: a line-local commit in a later paragraph follows one in an earlier paragraph", { skip }, async () => {
  const src = await justifiedPdf([{ y: 560, lines: P1 }, { y: 440, lines: P2 }]);
  const edits = [
    { id: "a", pageIndex: 0, before: "green bolt", after: "grey bolt" },
    { id: "b", pageIndex: 0, before: "Then quiet.", after: "Then calm." },
  ];
  const { pdf: out, report } = await run(src, edits);
  assert.equal(report.ok, true, JSON.stringify(report.selfCheck?.failures));
  const rows = report.pages[0].paragraphs;
  assert.deepEqual(rows.map((r) => [r.index, r.lineRetention.status, r.lineRetention.line]), [[1, "line_local", 1], [2, "line_local", 3]]);
  const [s, o] = [await glyphsOf(src), await glyphsOf(out)];
  for (const y of [560, 530, 515, 440, 425, 410, 760, 36]) assertSameLine(s, o, y);
  assert.equal(lineText(o, 545), "Theredgearandthegreyboltrestedonashelf");
  assert.equal(lineText(o, 395), "Thencalm.");
});

// Horizontal over vertical scale of a glyph matrix, and the font size the
// page shows (size times the vertical scale).
const aspectOf = (g) => g.matrix[0] / g.matrix[3];
const shownSize = (g) => g.size * g.matrix[3];
// The edited line keeps the source line's aspect and shown size on every
// glyph, whatever page scale the source glyph matrices also hold.
function assertSourceAspect(src, out, y, aspect) {
  const [a, b] = [onLine(src, y), onLine(out, y)];
  assert.ok(a.length && b.length, `line ${y} present`);
  for (const g of a) assert.ok(Math.abs(aspectOf(g) - aspect) <= 1e-3 && Math.abs(g.matrix[1]) + Math.abs(g.matrix[2]) <= 1e-4, `source aspect ${JSON.stringify(g.matrix)}`);
  for (const g of b) {
    assert.ok(Math.abs(aspectOf(g) - aspect) <= 1e-3, `edited aspect ${JSON.stringify(g.matrix)} on ${y}`);
    assert.ok(Math.abs(shownSize(g) - shownSize(a[0])) <= 0.01, `edited shown size ${g.size} ${JSON.stringify(g.matrix)} on ${y}`);
  }
  // Same glyph, same width: "T" opens the source and the edited line.
  assert.equal(b[0].ch, a[0].ch);
  assert.ok(Math.abs((b[0].right - b[0].x) - (a[0].right - a[0].x)) <= 0.02, `"${a[0].ch}" width ${b[0].right - b[0].x} vs ${a[0].right - a[0].x}`);
}

for (const s of [0.9, 0.97, 1.03]) {
  test(`real engine: under a uniform page scale ${s} a last-line edit keeps the source glyph aspect`, { skip }, async () => {
    const src = await justifiedPdf(ONE, "", s);
    const { pdf: out, report } = await run(src, [{ id: "f", pageIndex: 0, before: "The end.", after: "The finish." }]);
    assert.equal(report.ok, true, JSON.stringify(report.selfCheck?.failures));
    assert.deepEqual(report.pages[0].paragraphs[0].lineRetention, { status: "line_local", line: 3, lines: 4, kept: 3, justified: false, wordSpacing: 0, hScale: 1, maxKeptShift: 0 });
    const [g, o] = [await glyphsOf(src), await glyphsOf(out)];
    for (const y of [500, 485, 470, 760, 36]) assertSameLine(g, o, y);
    assert.equal(lineText(o, 455), "Thefinish.");
    assert.ok(Math.abs(onLine(o, 455)[0].x - onLine(g, 455)[0].x) <= 0.1);
    assertSourceAspect(g, o, 455, 1);
  });

  test(`real engine: under a uniform page scale ${s} a justified 98% line keeps its 98% aspect`, { skip }, async () => {
    const src = await justifiedPdf(ONE, "", s);
    const { pdf: out, report } = await run(src, [{ id: "g", pageIndex: 0, before: "green bolt", after: "grey bolt" }]);
    assert.equal(report.ok, true, JSON.stringify(report.selfCheck?.failures));
    const row = report.pages[0].paragraphs[0];
    assert.deepEqual({ ...row.lineRetention, wordSpacing: undefined }, { status: "line_local", line: 1, lines: 4, kept: 3, justified: true, wordSpacing: undefined, hScale: 0.98, maxKeptShift: 0 });
    const [g, o] = [await glyphsOf(src), await glyphsOf(out)];
    for (const y of [500, 470, 455, 760, 36]) assertSameLine(g, o, y);
    assert.equal(lineText(o, 485), "Theredgearandthegreyboltrestedonashelf");
    const [a, b] = [onLine(g, 485), onLine(o, 485)];
    assert.ok(Math.abs(b[0].x - a[0].x) <= 0.1);
    assert.ok(Math.abs(b.at(-1).right - a.at(-1).right) <= 0.5);
    assertSourceAspect(g, o, 485, 0.98);
  });
}

test("real engine: an edited line committed with another aspect is declined to the plain re-layout", { skip }, async () => {
  // Negative control for the edited-line aspect check: the line-local
  // commit gets the raw glyph matrix scale (0.9 page scale times the line's
  // own), as before the aspect was taken relative to the vertical scale.
  const s = 0.9;
  const src = await justifiedPdf(ONE, "", s);
  const engineFactory = async (bytes) => {
    const e = await rt.engineFactory(bytes);
    const begin = e.historyBeginStep.bind(e), commit = e.commitParagraph.bind(e);
    let label = null;
    e.historyBeginStep = (l) => {
      label = l;
      return begin(l);
    };
    e.commitParagraph = (id, runs, fmt) => commit(id, label === "falsify-line-local" ? runs.map((r) => ({ ...r, hScale: (r.hScale ?? 1) * s })) : runs, fmt);
    return e;
  };
  const edits = [{ id: "f", pageIndex: 0, before: "The end.", after: "The finish." }];
  const { pdf: out, report } = await run(src, edits, engineFactory);
  const row = report.pages[0].paragraphs[0];
  assert.deepEqual(row.lineLocal, { status: "declined", reason: "edited_line_aspect_changed" });
  assert.equal(row.lineRetention.status, "reflowed");
  const plain = await run(src, edits, plainFactory);
  assert.equal(plain.report.ok, report.ok);
  assert.deepEqual(plain.report.pages[0].paragraphs[0].lineRetention, row.lineRetention);
  const [a, b] = [await glyphsOf(plain.pdf), await glyphsOf(out)];
  assert.deepEqual(b.map((g) => [g.ch, g.font, g.x.toFixed(3), g.y.toFixed(3), g.matrix.map((v) => v.toFixed(4))]), a.map((g) => [g.ch, g.font, g.x.toFixed(3), g.y.toFixed(3), g.matrix.map((v) => v.toFixed(4))]));
  assert.ok(!onLine(b, 455).some((g) => Math.abs(aspectOf(g) - s) <= 1e-3), "no condensed glyph is left behind");
});

test("real engine: a line whose glyph aspect cannot be read is declined to the plain re-layout", { skip }, async () => {
  const src = await justifiedPdf(ONE, "", 0.9);
  // No glyph matrix is readable while the edit is committed: the source
  // aspect is unknown, so no line-local commit is tried.
  const engineFactory = async (bytes) => {
    const e = await rt.engineFactory(bytes);
    e.M._FPDFText_GetMatrix = () => 0;
    return e;
  };
  const edits = [{ id: "f", pageIndex: 0, before: "The end.", after: "The finish." }];
  const { report } = await run(src, edits, engineFactory);
  const row = report.pages[0].paragraphs[0];
  assert.deepEqual(row.lineLocal, { status: "declined", reason: "line_aspect_unsupported" });
  assert.equal(row.lineRetention.status, "reflowed");
  const plain = await run(src, edits, plainFactory);
  assert.deepEqual(plain.report.pages[0].paragraphs[0].lineRetention, row.lineRetention);
});
