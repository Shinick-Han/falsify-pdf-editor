// Body-flow regressions for QA finding F2 (2026-10-19): a long edit on a
// one-column page whose surgical commit stays inside the column but wraps
// onto more lines must push the following body text (or continue it on a
// new page) instead of overlapping it, and the saved-PDF check must not
// read the first body line as a moved header. Synthetic mocks run always;
// the real-engine cases run only when a runtime (pinned .runtime or
// FALSIFY_EDITOR_CANDIDATE_MANIFEST) loads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { editPdf } from "../src/editor.mjs";
import { capturePageLayout, edgeGlyphs, repairPageLayout } from "../src/quality.mjs";
import { loadRuntime } from "../src/runtime.mjs";

const TEXT = 1;

// Page 600 x 800, y up. Text objects carry a baseline (matrix f); their
// glyph-tight bounds run from baseline - 3 to baseline + 8. Paragraph boxes
// are font-metric boxes (top = first baseline + 10, bottom = last - 4).
function makeEngine({ bodyLines = [[2, [690, 676]], [3, [630]]], matrix = true, header = "Running title - subtitle - section and some more words" } = {}) {
  let next = 100;
  const objs = [];
  const paras = new Map();
  const add = (para, x, base, w) => {
    const h = next++;
    objs.push({ h, type: TEXT, base, b: { x, y: base - 3, w, h: 11 } });
    paras.get(para).handles.push(h);
    return h;
  };
  const para = (id, x, w, bases, text) => {
    paras.set(id, { handles: [], box: { x, top: bases[0] + 10, w, h: bases[0] - bases[bases.length - 1] + 14 }, lines: bases.map((y) => ({ y })), text });
    for (const y of bases) add(id, x, y, w);
  };
  para(1, 50, 400, [780], header);
  for (const [id, bases] of bodyLines) para(id, 50, 500, bases, `Body paragraph ${id} text`);
  para(9, 290, 20, [30], "7");
  const calls = { moves: [], resizes: [] };
  const M = {
    _FPDFPage_CountObjects: () => objs.length,
    _FPDFPage_GetObject: (_p, i) => objs[i]?.h ?? 0,
    _FPDFPageObj_GetType: (h) => objs.find((o) => o.h === h)?.type ?? 0,
    _FPDFPage_RemoveObject: (_p, h) => {
      const i = objs.findIndex((o) => o.h === h);
      if (i < 0) return 0;
      M._detached = objs.splice(i, 1)[0];
      return 1;
    },
    _FPDFPage_InsertObjectAtIndex: (_p, h, i) => {
      if (M._detached?.h !== h) return 0;
      objs.splice(i, 0, M._detached);
      M._detached = null;
      return 1;
    },
    _FPDFPage_InsertObject: () => {
      objs.push(M._detached);
      M._detached = null;
    },
    HEAPF32: new Float32Array(64),
    _malloc: () => 0,
    _free: () => {},
  };
  if (matrix) {
    M._FPDFPageObj_GetMatrix = (h, p) => {
      const o = objs.find((x) => x.h === h);
      if (!o) return 0;
      M.HEAPF32.set([1, 0, 0, 1, o.b.x, o.base], p >> 2);
      return 1;
    };
  }
  const engine = {
    M, page: 1, pageIndex: 0, pageWidth: 600, pageHeight: 800, _pageDirty: false, calls, objs,
    loadPage(i) { this.pageIndex = i; },
    paragraphObjects: (id) => [...(paras.get(id)?.handles || [])],
    objectBounds: (h) => { const o = objs.find((x) => x.h === h); return o ? { ...o.b } : null; },
    translateObject(h, dx, dy) { const o = objs.find((x) => x.h === h); o.b.x += dx; o.b.y += dy; o.base += dy; this._pageDirty = true; },
    moveParagraph(id, dx, dy) {
      calls.moves.push([id, +dy.toFixed(2)]);
      for (const h of paras.get(id).handles) this.translateObject(h, dx, dy);
      return true;
    },
    // A surgical commit: the paragraph is replaced by `n` new line objects
    // at the 14pt source pitch, appended at the end. The last line has no
    // descender, so its glyph bottom sits 2pt higher than the others.
    surgical(id, n, width = 480) {
      const p = paras.get(id);
      for (const h of p.handles) objs.splice(objs.findIndex((o) => o.h === h), 1);
      p.handles = [];
      const y0 = p.lines[0].y;
      for (let k = 0; k < n; k++) add(id, 50, y0 - 14 * k, width);
      objs[objs.length - 1].b.y += 2;
      objs[objs.length - 1].b.h -= 2;
    },
    // Re-layout into two lines; the first call's ink overshoots by `overshoot`.
    overshoot: 0,
    resizeParagraph(id, width) {
      calls.resizes.push([id, +width.toFixed(2)]);
      const p = paras.get(id);
      for (const h of p.handles) objs.splice(objs.findIndex((o) => o.h === h), 1);
      p.handles = [];
      const y0 = p.lines[0].y;
      const lines = [0, 1].map((k) => ({ y: y0 - 14 * k }));
      const over = calls.resizes.length === 1 ? this.overshoot : 0;
      for (const l of lines) add(id, 50, l.y, width + over);
      return { id, box: { x: 50, top: p.box.top, w: width, h: 28 }, lines };
    },
  };
  const model = [...paras].map(([id, p]) => ({ id, editable: true, box: p.box, lines: p.lines, runs: [{ text: p.text, size: 11 }] }));
  return { engine, model };
}

const touched = (model, id) => {
  const p = model.find((q) => q.id === id);
  return [{ id, sourceBox: p.box, sourceLines: p.lines, sourceFormat: {} }];
};

test("a nine-word running header inside the top band is edge content, not body", () => {
  const { engine, model } = makeEngine();
  const role = Object.fromEntries(capturePageLayout(engine, 0, model).paras.map((q) => [q.id, q.role]));
  assert.equal(role[1], "header_uncertain");
  assert.equal(role[2], "body");
  assert.equal(role[9], "page_number");
});

test("F2: a surgical commit that wraps onto more lines pushes the next paragraph by its baseline growth", () => {
  const { engine, model } = makeEngine();
  const ctx = capturePageLayout(engine, 0, model);
  engine.surgical(2, 6);
  const r = repairPageLayout(engine, 0, ctx, touched(model, 2));
  const rec = r.repairs.find((x) => x.kind === "paragraph");
  assert.equal(rec.action, "kept_surgical");
  assert.deepEqual(rec.grown, { by: 56, from: "baselines" });
  assert.deepEqual(engine.calls.resizes, []);
  // Exactly four 14pt lines, not the glyph-bottom difference (which the
  // descender-free last line would shrink).
  assert.deepEqual(engine.calls.moves, [[3, -56]]);
  assert.ok(r.repairs.some((x) => x.kind === "cascade" && x.action === "shifted"));
  assert.ok(!r.warnings.some((w) => w.severity === "error"), JSON.stringify(r.warnings));
});

test("surgical growth falls back to bounds when text matrices are unavailable", () => {
  const { engine, model } = makeEngine({ matrix: false });
  const ctx = capturePageLayout(engine, 0, model);
  engine.surgical(2, 3);
  const r = repairPageLayout(engine, 0, ctx, touched(model, 2));
  const rec = r.repairs.find((x) => x.kind === "paragraph");
  assert.equal(rec.grown.from, "bounds");
  assert.equal(engine.calls.moves.length, 1);
  assert.equal(engine.calls.moves[0][0], 3);
});

test("a surgical commit with the same line count moves nothing", () => {
  const { engine, model } = makeEngine();
  const ctx = capturePageLayout(engine, 0, model);
  engine.surgical(2, 2);
  const r = repairPageLayout(engine, 0, ctx, touched(model, 2));
  assert.equal(r.repairs.find((x) => x.kind === "paragraph").grown, undefined);
  assert.deepEqual(engine.calls.moves, []);
});

test("body text is never cascaded into the footer edge band; it is paginated or reported", () => {
  // Footer box bottom 26 -> band floor 26 + 80 = 106. Paragraph 3 (box
  // bottom 126) fits a 14pt push (112) but not a 28pt one (98), although 98
  // is still above the footer top + 2 (42).
  const lines = [[2, [190, 176]], [3, [130]]];
  const fits = makeEngine({ bodyLines: lines });
  let ctx = capturePageLayout(fits.engine, 0, fits.model);
  fits.engine.surgical(2, 3);
  let r = repairPageLayout(fits.engine, 0, ctx, touched(fits.model, 2));
  assert.deepEqual(fits.engine.calls.moves, [[3, -14]]);
  assert.equal(r.repairs.find((x) => x.kind === "cascade").floor, 106);

  const over = makeEngine({ bodyLines: lines });
  ctx = capturePageLayout(over.engine, 0, over.model);
  over.engine.surgical(2, 4);
  r = repairPageLayout(over.engine, 0, ctx, touched(over.model, 2));
  assert.deepEqual(over.engine.calls.moves, []);
  assert.ok(r.warnings.some((w) => w.code === "pagination_unsupported" && w.severity === "error" && w.floor === 106));

  const paged = makeEngine({ bodyLines: lines });
  ctx = capturePageLayout(paged.engine, 0, paged.model);
  paged.engine.surgical(2, 4);
  let seen = null;
  r = repairPageLayout(paged.engine, 0, ctx, touched(paged.model, 2), {
    paginate: (_e, _c, grown, info) => {
      seen = { grown: grown.map((g) => [g.id, +g.delta.toFixed(2)]), floor: info.floor };
      return { ok: true, warnings: [], repairs: [], added: 1, lineCounts: [1], keptLines: 4, bodyTop: 790, floor: info.floor };
    },
  });
  assert.deepEqual(seen, { grown: [[2, 28]], floor: 106 });
  assert.equal(r.pagination.added, 1);
});

test("a source body that already reaches into the bottom band keeps its own floor", () => {
  // Paragraph 3 box bottom 86 < band 106: floor = 86, still above footer top + 2.
  const lines = [[2, [190, 176]], [3, [90]]];
  const same = makeEngine({ bodyLines: lines });
  let ctx = capturePageLayout(same.engine, 0, same.model);
  same.engine.surgical(2, 2);
  let r = repairPageLayout(same.engine, 0, ctx, touched(same.model, 2));
  assert.equal(r.repairs.find((x) => x.kind === "cascade"), undefined);
  const grown = makeEngine({ bodyLines: lines });
  ctx = capturePageLayout(grown.engine, 0, grown.model);
  grown.engine.surgical(2, 3);
  r = repairPageLayout(grown.engine, 0, ctx, touched(grown.model, 2));
  assert.ok(r.warnings.some((w) => w.code === "pagination_unsupported" && w.floor === 86));
});

test("a re-layout whose glyph ink overshoots the column is narrowed once", () => {
  const { engine, model } = makeEngine();
  const ctx = capturePageLayout(engine, 0, model);
  engine.surgical(2, 2, 600); // past the column: resize path
  engine.overshoot = 3;
  const r = repairPageLayout(engine, 0, ctx, touched(model, 2));
  const rec = r.repairs.find((x) => x.kind === "paragraph");
  assert.equal(rec.action, "resized");
  assert.equal(engine.calls.resizes.length, 2);
  assert.equal(rec.narrowed, 3);
  assert.equal(rec.width, 497);
  const right = Math.max(...engine.paragraphObjects(2).map((h) => engine.objectBounds(h)).map((b) => b.x + b.w));
  assert.ok(right <= 550 + 1, String(right));
});

// Glyphs for edgeGlyphs: { u, l, r, b, t }, one per character.
const glyphLine = (text, base) => [...text].map((ch, k) => {
  const tall = /[A-Zbdfhklt]/.test(ch);
  return { u: ch.charCodeAt(0), l: 50 + 5 * k, r: 54 + 5 * k, b: base - (/[gpqy]/.test(ch) ? 2 : 0), t: base + (tall ? 8 : 5) };
});

test("edgeGlyphs keeps whole edge lines and never splits a body line at the band boundary", () => {
  // H 800; glyph extent 30..790, band 80: top edge centres >= 710, bottom <= 110.
  const header = glyphLine("Header", 782);
  const straddle = glyphLine("Tall and low", 706); // tall centres 710, short 708.5
  const footer = glyphLine("Footer", 30);
  const body = glyphLine("body", 400);
  const g = { H: 800, glyphs: [...header, ...straddle, ...body, ...footer] };
  const tallIn = straddle.filter((c) => (c.b + c.t) / 2 >= 790 - 80);
  assert.ok(tallIn.length > 0 && tallIn.length < straddle.length, "fixture must straddle the band");
  assert.equal(edgeGlyphs(g).map((c) => String.fromCharCode(c.u)).join(""), "HeaderFooter");
});

// ---------- real engine (F2 fixture geometry) ----------

// A4, Helvetica 8 header/footer, Times-Bold 13 title, Times-Roman 11 body
// at 14pt leading from y 720.89: the first body line straddles the
// self-check's top edge band, as in the QA fixture long.pdf.
function f2Pdf() {
  const W = 595.2756, H = 841.8898;
  const esc = (s) => s.replace(/[\\()]/g, (c) => "\\" + c);
  const line = (font, size, y, s) => `BT /${font} ${size} Tf 72 ${y.toFixed(2)} Td (${esc(s)}) Tj ET\n`;
  const paras = [
    ["The toy rover rolled across the felt mat while the timer counted. The operator", "wrote down only that it moved and stopped, on a synthetic page with no data."],
    ["A second paragraph keeps the flow honest. It sits below the first one so that", "any added text has to push it down the page and possibly onto a new one."],
    ["The closing paragraph mentions the shelf, the bench and the felt mat once more", "and then ends the toy story."],
  ];
  let c = line("F1", 8, H - 40, "SYNTHETIC QA FIXTURE - not a real paper - long") + line("F1", 8, 36, "Synthetic page 1");
  c += line("F2", 13, H - 100, "Toy flow section");
  let y = H - 121;
  for (const p of paras) {
    for (const s of p) {
      c += line("F3", 11, y, s);
      y -= 14;
    }
    y -= 8;
  }
  const second = line("F1", 8, H - 40, "SYNTHETIC QA FIXTURE - not a real paper - long") + line("F1", 11, H - 100, "The second page stays exactly as it is.") + line("F1", 8, 36, "Synthetic page 2");
  const font = (name) => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
  const res = "<< /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >>";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources ${res} /Contents 7 0 R >>`,
    font("Helvetica"),
    font("Times-Bold"),
    font("Times-Roman"),
    `<< /Length ${c.length} >>\nstream\n${c}endstream`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources ${res} /Contents 9 0 R >>`,
    `<< /Length ${second.length} >>\nstream\n${second}endstream`,
  ];
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

const BEFORE = "The toy rover rolled across the felt mat";
const TAIL = " The toy rover then circled the felt mat a second time, paused beside the wooden shelf, and rolled back toward the bench where the operator waited with a blank card. Nothing about this synthetic sentence reports a measurement; it only adds enough words to force the editor to wrap the paragraph across several new lines.";

let runtimeOk = false;
try {
  await loadRuntime();
  runtimeOk = true;
} catch {}
const real = { skip: !runtimeOk && "runtime not available" };

test("real engine F2: a ~370-char edit wraps in place and pushes the following paragraphs", real, async () => {
  const src = f2Pdf();
  const copy = Buffer.from(src);
  const { report } = await editPdf({ sourceBytes: src, edits: [{ id: "f2", pageIndex: 0, before: BEFORE, after: BEFORE + TAIL }], reflow: true });
  assert.equal(report.ok, true, JSON.stringify(report.selfCheck.failures));
  assert.equal(report.pagination.addedPages, 0);
  const reps = report.repairs[0].repairs;
  const para = reps.find((x) => x.kind === "paragraph");
  assert.ok(para.grown?.by > 0 || para.action === "resized", JSON.stringify(para));
  assert.ok(reps.some((x) => x.kind === "cascade" && x.action === "shifted" && x.moved >= 2), JSON.stringify(reps));
  const p0 = report.selfCheck.pages[0];
  assert.equal(p0.text_equal, true);
  assert.equal(p0.edge_stable, true);
  assert.equal(p0.overlap.output, p0.overlap.source);
  assert.equal(report.selfCheck.pages[1].text_equal, true);
  assert.equal(Buffer.compare(copy, Buffer.from(src)), 0);
});

test("real engine F2: an edit that no longer fits continues on a new page with header/footer copies and stable mapping", real, async () => {
  const src = f2Pdf();
  const { pdf, report } = await editPdf({ sourceBytes: src, edits: [{ id: "f2", pageIndex: 0, before: BEFORE, after: BEFORE + TAIL.repeat(12) }], reflow: true });
  assert.equal(report.ok, true, JSON.stringify(report.selfCheck.failures));
  assert.ok(report.pagination.addedPages >= 1);
  const [m0, m1] = report.pagination.sourcePageMap;
  assert.deepEqual(m0.continuationPageIndices, Array.from({ length: report.pagination.addedPages }, (_, k) => 1 + k));
  assert.equal(m1.outputPageIndex, 1 + report.pagination.addedPages);
  // The body band starts below the running header (copied edge content on
  // the continuation page) and ends above the footer edge band.
  assert.ok(m0.bodyTop < 841.89 - 40, String(m0.bodyTop));
  assert.ok(m0.floor > 36 + 8, String(m0.floor));
  assert.equal(report.pagination.continuationStyle?.applied, true);
  const flow = report.pagination.flow[0];
  assert.equal(flow.textEqual, true);
  assert.ok(flow.measuredLines.every((l) => l.planned === l.measured && l.measured > 0));
  assert.equal(report.selfCheck.pages[1].text_equal, true);
  assert.ok(pdf.length > 0);
});

test("real engine F2: with pagination disabled the overflow is an explicit refusal, not a damaged page", real, async () => {
  const src = f2Pdf();
  await assert.rejects(
    editPdf({ sourceBytes: src, edits: [{ id: "f2", pageIndex: 0, before: BEFORE, after: BEFORE + TAIL.repeat(12) }], reflow: true }, { allowPagination: false }),
    (e) => e.code === "LAYOUT_UNSUPPORTED" && e.details.codes.includes("pagination_unsupported"),
  );
});
