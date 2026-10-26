// Routing of the line-local recovery after a plain re-layout that changed
// the paragraph's line count (editor.mjs, replaceReflowWithLineLocal).
// Synthetic data only. Real-engine cases run when a runtime loads (module
// .runtime, FALSIFY_EDITOR_CANDIDATE_MANIFEST, or the test-only
// FALSIFY_EDITOR_RUNTIME_DIR) and are skipped otherwise.
//
// Cases marked "mock count change" wrap the real engine so that every
// whole-paragraph commit (history step falsify-inline-edit) reports one line
// more than it laid out; the page itself, the undo history and every
// line-local step stay the real engine's. They show the routing only: they
// are not evidence that a real re-edit on a new native runtime succeeds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { editPdf } from "../src/editor.mjs";
import { loadRuntime } from "../src/runtime.mjs";

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

// The justified fixture of line-local.test.mjs: words in one TJ with fitted
// interword kerns, the second line at a 98% horizontal scale, every line but
// the last spanning WIDTH.
const EDGES = "BT /F1 8 Tf 72 760 Td (SYNTHETIC TEST PAGE - not a paper) Tj ET BT /F1 8 Tf 72 36 Td (Synthetic page 1) Tj ET ";
const P1 = ["Alpha beta gamma delta held steady on the long bench", "The red gear and the green bolt rested on a shelf", "Each toy part was checked once and then set down", "The end."];
// The same paragraph with a long last line, so a longer edit adds a line.
const P3 = [...P1.slice(0, 3), "Then the bell rang and the quiet room was empty."];
const WIDTH = 280;
const justifiedContent = (paras, kerns) => paras.map(({ y, lines }, n) => `BT /F1 11 Tf 15 TL 72 ${y} Td `
  + lines.map((l, k) => `${k === 1 ? 98 : 100} Tz [` + l.split(" ").map((w) => `(${w})`).join(` ${kerns[n][k].toFixed(3)} `) + "] TJ T*").join(" ") + " ET ").join("");
async function justifiedPdf(paras) {
  let kerns = paras.map(({ lines }) => lines.map(() => -278));
  const make = () => pdf(EDGES + justifiedContent(paras, kerns));
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

// Per glyph of the saved page: character, origin, font, size and matrix.
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
      const matrix = Array.from({ length: 6 }, (_, j) => +M.HEAPF32[((b + 160) >> 2) + j].toFixed(4));
      out.push({ ch: String.fromCharCode(u), x: M.HEAPF64[b >> 3], y: M.HEAPF64[(b + 8) >> 3], font, size: M._FPDFText_GetFontSize(tp, i), matrix });
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
// Glyph for glyph: characters, fonts, sizes, matrices and origins.
const exact = (gs) => gs.map((g) => [g.ch, g.font, g.size.toFixed(3), g.x.toFixed(3), g.y.toFixed(3), g.matrix.join(",")]);
function assertSameLine(src, out, y) {
  assert.ok(onLine(src, y).length > 0, `source line ${y} present`);
  assert.deepEqual(exact(onLine(out, y)), exact(onLine(src, y)), `line ${y}`);
}

const run = (src, edits, engineFactory = rt.engineFactory) => editPdf({ sourceBytes: src, edits, reflow: true }, { engineFactory, runtimeInfo: rt.info });
// The plain re-layout alone: without historyNoteMatrix no line-local commit
// is tried.
const plain = (factory) => async (bytes) => {
  const e = await factory(bytes);
  e.historyNoteMatrix = undefined;
  return e;
};
// Mock count change (see above): the engine's own result, with one line more.
const countChanged = (factory) => async (bytes) => {
  const e = await factory(bytes);
  const begin = e.historyBeginStep.bind(e), end = e.historyEndStep.bind(e), commit = e.commitParagraph.bind(e);
  let label = null;
  e.historyBeginStep = (l) => {
    label = l;
    return begin(l);
  };
  e.historyEndStep = () => {
    label = null;
    return end();
  };
  e.commitParagraph = (id, runs, fmt) => {
    const u = commit(id, runs, fmt);
    return label === "falsify-inline-edit" && u?.lines?.length ? { ...u, lines: [...u.lines, u.lines.at(-1)] } : u;
  };
  return e;
};
const rt0 = (bytes) => rt.engineFactory(bytes);
// A report row as the plain re-layout reports it: no line-local decline.
const withoutLocal = ({ lineLocal, ...row }) => row;
const ONE = [{ y: 500, lines: P1 }];
const GREY = [{ id: "g", pageIndex: 0, before: "green bolt", after: "grey bolt" }];

test("mock count change: an edit inside one line reaches the verified line-local commit", { skip }, async () => {
  const src = await justifiedPdf(ONE);
  // Without line-local the mocked commit is reported as a line count change.
  const base = await run(src, GREY, countChanged(plain(rt0)));
  assert.deepEqual(base.report.pages[0].paragraphs[0].lineRetention, { status: "reflowed", reason: "line_count_changed" });
  const { pdf: out, report } = await run(src, GREY, countChanged(rt0));
  assert.equal(report.ok, true, JSON.stringify(report.selfCheck?.failures));
  const row = report.pages[0].paragraphs[0];
  assert.equal(row.lineLocal, undefined);
  assert.deepEqual({ ...row.lineRetention, wordSpacing: undefined }, { status: "line_local", line: 1, lines: 4, kept: 3, justified: true, wordSpacing: undefined, hScale: 0.98, maxKeptShift: 0 });
  assert.equal(row.committedLines, 4);
  assert.ok(!report.warnings.some((w) => w.code === "source_lines_reflowed"));
  const [s, o] = [await glyphsOf(src), await glyphsOf(out)];
  for (const y of [500, 470, 455, 760, 36]) assertSameLine(s, o, y);
  assert.equal(lineText(o, 485), "Theredgearandthegreyboltrestedonashelf");
  assert.ok(onLine(o, 485).every((g) => Math.abs(g.matrix[0] - 0.98) <= 1e-3 && Math.abs(g.size - 11) <= 0.01));
  // The same pages as the line-local commit reached without the mock.
  const direct = await run(src, GREY);
  assert.equal(direct.report.pages[0].paragraphs[0].lineRetention.status, "line_local");
  assert.deepEqual(exact(o), exact(await glyphsOf(direct.pdf)));
});

test("real engine: a longer edit that adds a line keeps the prefix and reflows the suffix", { skip }, async () => {
  const src = await justifiedPdf([{ y: 500, lines: P3 }]);
  const edits = [{ id: "y", pageIndex: 0, before: "green bolt", after: "green and yellow bolt" }];
  const { pdf: out, report } = await run(src, edits);
  assert.equal(report.ok, true, JSON.stringify(report.selfCheck?.failures));
  const row = report.pages[0].paragraphs[0];
  assert.equal(row.lineLocal, undefined);
  assert.equal(row.lineRetention.status, "reflowed");
  assert.equal(row.lineRetention.reason, "edited_line_overflows");
  assert.equal(row.lineRetention.prefixKept, 1);
  assert.equal(row.lineRetention.suffixReflow, true);
  assert.equal(row.lineRetention.lines, 5);
  assert.equal(row.committedLines, 5);
  assert.ok(report.warnings.some((w) => w.code === "source_lines_reflowed" && w.reason === "edited_line_overflows"));
  const [s, o] = [await glyphsOf(src), await glyphsOf(out)];
  assertSameLine(s, o, 500);
  const body = o.filter((g) => g.y > 400 && g.y < 520);
  assert.equal(new Set(body.map((g) => g.y.toFixed(1))).size, 5);
  assert.ok(body.every((g) => Math.abs(g.size - 11) <= 0.01));
  assert.ok(body.map((g) => g.ch).join("").includes("greenandyellowbolt"));
});

test("real engine: an edit across source lines that adds a line keeps the plain re-layout", { skip }, async () => {
  const src = await justifiedPdf([{ y: 500, lines: P3 }]);
  const edits = [
    { id: "a", pageIndex: 0, before: "Alpha beta", after: "Alpha zeta" },
    { id: "y", pageIndex: 0, before: "green bolt", after: "green and yellow bolt" },
  ];
  const { pdf: out, report } = await run(src, edits);
  const row = report.pages[0].paragraphs[0];
  assert.deepEqual(row.lineRetention, { status: "reflowed", reason: "line_count_changed" });
  assert.deepEqual(row.lineLocal, { status: "declined", reason: "edit_spans_lines" });
  const p = await run(src, edits, plain(rt0));
  assert.deepEqual(p.report.pages[0].paragraphs[0], withoutLocal(row));
  assert.deepEqual(exact(await glyphsOf(out)), exact(await glyphsOf(p.pdf)));
});

test("mock count change: a page whose model build re-creates objects skips line-local", { skip }, async () => {
  // Tw word spacing: the engine re-creates these text objects on every model
  // build, so undo steps by handle are unsafe.
  const lines = P1.slice(0, 3);
  const probe = await rt.engineFactory(pdf(EDGES + "BT /F1 11 Tf 15 TL 72 500 Td " + lines.map((l) => `(${l}) Tj T*`).join(" ") + " (The end.) Tj ET"));
  probe.loadPage(0);
  const widths = probe.buildModel().find((p) => p.lines.length === 4).lines.map((l) => l.w);
  probe.close();
  const src = pdf(EDGES + "BT /F1 11 Tf 15 TL 72 500 Td " + lines.map((l, k) => `${((WIDTH - widths[k]) / (l.split(" ").length - 1)).toFixed(4)} Tw (${l}) Tj T*`).join(" ") + " 0 Tw (The end.) Tj ET");
  const { pdf: out, report } = await run(src, GREY, countChanged(rt0));
  assert.equal(report.ok, true);
  const row = report.pages[0].paragraphs[0];
  assert.deepEqual(row.lineLocal, { status: "declined", reason: "page_model_unstable" });
  assert.deepEqual(row.lineRetention, { status: "reflowed", reason: "line_count_changed" });
  const p = await run(src, GREY, countChanged(plain(rt0)));
  assert.deepEqual(p.report.pages[0].paragraphs[0], withoutLocal(row));
  assert.deepEqual(exact(await glyphsOf(out)), exact(await glyphsOf(p.pdf)));
});

test("mock count change: an undo that does not restore the page fails closed with STATE_DRIFT", { skip }, async () => {
  const src = await justifiedPdf(ONE);
  // Once the line has been isolated, undo reports success but does nothing.
  const broken = async (bytes) => {
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
  // Too long for its justified line, so line-local undoes its steps.
  const edits = [{ id: "w", pageIndex: 0, before: "the green", after: "the very green" }];
  await assert.rejects(run(src, edits, countChanged(broken)), (e) => e.code === "STATE_DRIFT" && e.report.status === "failed" && !e.pdf);
});
