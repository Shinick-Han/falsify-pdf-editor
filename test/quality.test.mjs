// Synthetic tests for src/quality.mjs. The engine is a small in-memory mock
// of the PdfEngine/PDFium surface the quality layer uses; no PDF or WASM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { capturePageLayout, repairPageLayout, inspectSavedPdf, expectedPageText } from "../src/quality.mjs";

const TEXT = 1, PATH = 2;

// Page 600 x 800, y up. Body column x 50..550, lines 14pt apart at 24pt pitch.
function makeEngine({ room = true, interleave = false, extraObject = false } = {}) {
  let next = 100;
  const objs = [];
  const paras = new Map();
  const add = (type, b, para) => {
    const h = next++;
    objs.push({ h, type, b: { ...b } });
    if (para !== undefined) paras.get(para).handles.push(h);
    return h;
  };
  const para = (id, x, top, w, lines, text, size = 12) => {
    paras.set(id, { handles: [], box: { x, top, w, h: lines * 24 - 10 }, lines: Array.from({ length: lines }, (_, k) => ({ y: top - 10 - k * 24 })), text, size });
  };
  const bodyTop = room ? 700 : 170;
  para(1, 270, 780, 60, 1, "Header");
  para(2, 50, bodyTop, 500, 1, "First body line");
  para(3, 50, bodyTop - 24, 500, 1, "Second body line");
  para(4, 50, bodyTop - 48, 500, 1, "Third body line");
  para(5, 50, bodyTop - 72, 500, 1, "Fourth body line");
  para(6, 290, 40, 20, 1, "7");
  add(TEXT, { x: 270, y: 770, w: 60, h: 12 }, 1);
  add(PATH, { x: 40, y: 100, w: 520, h: 1 });
  for (const id of [2, 3, 4, 5]) {
    const p = paras.get(id);
    add(TEXT, { x: 50, y: p.lines[0].y - 2, w: 250, h: 12 }, id);
    if (interleave && id === 3) add(PATH, { x: 50, y: p.lines[0].y, w: 10, h: 1 });
    add(TEXT, { x: 300, y: p.lines[0].y - 2, w: 250, h: 12 }, id);
  }
  add(PATH, { x: 40, y: 60, w: 520, h: 1 });
  add(TEXT, { x: 290, y: 30, w: 20, h: 12 }, 6);
  const calls = { moves: [], resizes: [], inserts: 0 };
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
      calls.inserts++;
      return 1;
    },
    _FPDFPage_InsertObject: (_p, h) => {
      objs.push(M._detached);
      M._detached = null;
    },
  };
  const engine = {
    M, page: 1, pageIndex: 0, pageWidth: 600, pageHeight: 800, _pageDirty: false, calls, objs, paras,
    loadPage(i) { this.pageIndex = i; },
    paragraphObjects: (id) => [...(paras.get(id)?.handles || [])],
    objectBounds: (h) => { const o = objs.find((x) => x.h === h); return o ? { ...o.b } : null; },
    translateObject(h, dx, dy) { const o = objs.find((x) => x.h === h); o.b.x += dx; o.b.y += dy; this._pageDirty = true; },
    moveParagraph(id, dx, dy) {
      calls.moves.push([id, dy]);
      for (const h of paras.get(id).handles) this.translateObject(h, dx, dy);
      return true;
    },
    // Simulate a widened commit: the paragraph objects are replaced by new
    // objects appended at the end of the content stream, one long line.
    widen(id) {
      const p = paras.get(id);
      for (const h of p.handles) objs.splice(objs.findIndex((o) => o.h === h), 1);
      p.handles = [];
      add(TEXT, { x: 50, y: p.lines[0].y - 2, w: 900, h: 12 }, id);
      if (extraObject) add(TEXT, { x: 60, y: 300, w: 5, h: 5 });
    },
    // Re-layout at the given width into three lines at the engine default
    // 14.4pt pitch; new objects are again appended at the end.
    resizeParagraph(id, width) {
      calls.resizes.push([id, width]);
      const p = paras.get(id);
      for (const h of p.handles) objs.splice(objs.findIndex((o) => o.h === h), 1);
      p.handles = [];
      const y0 = p.lines[0].y;
      const lines = [0, 1, 2].map((k) => ({ y: y0 - k * 14.4 }));
      for (const l of lines) add(TEXT, { x: 50, y: l.y - 2, w: width, h: 12 }, id);
      return { id, box: { x: 50, top: p.box.top, w: width, h: 14 + 2 * 14.4 }, lines };
    },
  };
  const model = [...paras].map(([id, p]) => ({ id, editable: true, box: p.box, lines: p.lines, runs: [{ text: p.text, size: p.size }] }));
  return { engine, model };
}

const order = (e) => e.objs.map((o) => o.h);
const touched = (model, id) => {
  const p = model.find((q) => q.id === id);
  return [{ id, sourceBox: p.box, sourceLines: p.lines, sourceFormat: { lineSpacing: 1.2 } }];
};

test("capture classifies page number and header as fixed edge content", () => {
  const { engine, model } = makeEngine();
  const ctx = capturePageLayout(engine, 0, model);
  const role = Object.fromEntries(ctx.paras.map((q) => [q.id, q.role]));
  assert.equal(role[6], "page_number");
  assert.equal(role[1], "header_uncertain");
  assert.equal(role[3], "body");
});

test("surgical edit that stays in the column is kept untouched", () => {
  const { engine, model } = makeEngine();
  const ctx = capturePageLayout(engine, 0, model);
  const before = order(engine);
  const r = repairPageLayout(engine, 0, ctx, touched(model, 3));
  assert.equal(r.repairs[0].action, "kept_surgical");
  assert.deepEqual(engine.calls.resizes, []);
  assert.deepEqual(engine.calls.moves, []);
  assert.deepEqual(order(engine), before);
  assert.equal(engine._pageDirty, false);
});

test("widened edit is resized, restored to its source object slot, followers shift, footer stays", () => {
  const { engine, model } = makeEngine();
  const ctx = capturePageLayout(engine, 0, model);
  const src = order(engine);
  const nonText = src.filter((h) => engine.objs.find((o) => o.h === h).type !== TEXT);
  const footer = engine.paras.get(6).handles.map((h) => engine.objectBounds(h));
  engine.widen(3);
  const r = repairPageLayout(engine, 0, ctx, touched(model, 3));
  assert.deepEqual(engine.calls.resizes, [[3, 500]]);
  const para = r.repairs.find((x) => x.id === 3);
  assert.equal(para.action, "resized");
  assert.equal(para.pitch.value, 24);
  // Lines re-spaced to the source 24pt pitch.
  const ys = engine.paras.get(3).handles.map((h) => engine.objectBounds(h).y);
  assert.deepEqual(ys.map((y, i) => i && +(ys[i - 1] - y).toFixed(2)).slice(1), [24, 24]);
  // Only the following body paragraphs of the same column moved, by 48pt.
  assert.deepEqual(engine.calls.moves.map(([id, dy]) => [id, +dy.toFixed(2)]), [[4, -48], [5, -48]]);
  assert.deepEqual(engine.paras.get(6).handles.map((h) => engine.objectBounds(h)), footer);
  // New objects sit where the source paragraph objects were.
  const now = order(engine);
  const slot = src.indexOf(ctx.paras.find((q) => q.id === 3).handles[0]);
  assert.deepEqual(now.slice(slot, slot + 3), engine.paras.get(3).handles);
  assert.deepEqual(now.filter((h) => engine.objs.find((o) => o.h === h).type !== TEXT), nonText);
  assert.equal(r.repairs.find((x) => x.kind === "reading_order").action, "index_only_stream_order_unresolved");
  assert.equal(engine._pageDirty, true);
  // Object index order is restored in the mock only; the serialized stream
  // order is unknown here, so the result stays unresolved and carries a
  // warning that requires the saved text/order check.
  assert.deepEqual(r.warnings.filter((w) => w.severity === "error"), []);
  const append = r.warnings.find((w) => w.code === "content_stream_append_order");
  assert.equal(append.severity, "warning");
  assert.equal(append.verification, "saved_text_order_required");
  assert.deepEqual(append.paragraphs, [3]);
});

test("surgical replacement with new handles is a warning, not a pre-save error", () => {
  const { engine, model } = makeEngine();
  const ctx = capturePageLayout(engine, 0, model);
  // Same-width replacement: new handles, no resize, nothing moved.
  const p = engine.paras.get(3);
  const ys = p.handles.map((h) => engine.objectBounds(h));
  for (const h of p.handles) engine.objs.splice(engine.objs.findIndex((o) => o.h === h), 1);
  p.handles = [];
  const next = Math.max(...engine.objs.map((o) => o.h)) + 1;
  ys.forEach((b, i) => { engine.objs.push({ h: next + i, type: TEXT, b }); p.handles.push(next + i); });
  const r = repairPageLayout(engine, 0, ctx, touched(model, 3));
  assert.equal(r.repairs.find((x) => x.id === 3)?.action, "kept_surgical");
  assert.deepEqual(r.warnings.filter((w) => w.severity === "error"), []);
  assert.equal(r.warnings.find((w) => w.code === "content_stream_append_order")?.severity, "warning");
  assert.equal(r.repairs.find((x) => x.kind === "reading_order").action, "index_only_stream_order_unresolved");
});

test("replaced last paragraph in source order is reported as restored", () => {
  const { engine, model } = makeEngine();
  const ctx = capturePageLayout(engine, 0, model);
  engine.widen(6);
  const r = repairPageLayout(engine, 0, ctx, []);
  assert.equal(r.repairs.find((x) => x.kind === "reading_order").action, "unchanged");
  assert.ok(!r.warnings.some((w) => w.code === "content_stream_append_order"));
});

test("source slot interleaved with a graphic is reported, not reordered", () => {
  const { engine, model } = makeEngine({ interleave: true });
  const ctx = capturePageLayout(engine, 0, model);
  engine.widen(3);
  const r = repairPageLayout(engine, 0, ctx, touched(model, 3));
  assert.ok(r.warnings.some((w) => w.code === "interleaved_source_slot"));
  assert.equal(r.repairs.find((x) => x.kind === "reading_order").action, "skipped");
  assert.equal(engine.calls.inserts, 0);
});

test("unmapped new object makes the order repair a diagnostic", () => {
  const { engine, model } = makeEngine({ extraObject: true });
  const ctx = capturePageLayout(engine, 0, model);
  engine.widen(3);
  const r = repairPageLayout(engine, 0, ctx, touched(model, 3));
  assert.ok(r.warnings.some((w) => w.code === "unmapped_new_objects"));
  assert.equal(engine.calls.inserts, 0);
});

test("no room above the footer: footer is not moved and pagination is reported", () => {
  const { engine, model } = makeEngine({ room: false });
  const ctx = capturePageLayout(engine, 0, model);
  engine.widen(5);
  const r = repairPageLayout(engine, 0, ctx, touched(model, 5));
  assert.ok(r.warnings.some((w) => w.code === "pagination_unsupported" && w.severity === "error"));
  assert.deepEqual(engine.calls.moves, []);
});

// ---------- inspectSavedPdf ----------

// glyph pages: arrays of [char, x, y]; spaces are generated text only.
// models (optional): bytes -> per-page paragraph models for buildModel.
function pdfEngineFor(pages, models) {
  return async () => {
    const heap = new Float64Array(8);
    let doc = null, model = null;
    const e = {
      pageCount: 0, page: 0, pageIndex: -1,
      open(bytes) { doc = pages.get(bytes); model = models?.get(bytes) ?? null; this.pageCount = doc.length; },
      close() {},
      loadPage(i) { this.pageIndex = i; this.page = i + 1; },
      M: {
        HEAPF64: heap,
        _malloc: () => 0,
        _free() {},
        _FPDF_GetPageWidthF: () => 600,
        _FPDF_GetPageHeightF: () => 800,
        _FPDFText_LoadPage: (p) => p,
        _FPDFText_ClosePage() {},
        _FPDFText_CountChars: (p) => doc[p - 1].length,
        _FPDFText_GetUnicode: (p, i) => doc[p - 1][i][0].charCodeAt(0),
        _FPDFText_GetCharBox: (p, i) => {
          const [, x, y] = doc[p - 1][i];
          heap[0] = x; heap[1] = x + 6; heap[2] = y; heap[3] = y + 10;
          return 1;
        },
      },
    };
    if (models) e.buildModel = () => model?.[e.pageIndex] ?? [];
    return e;
  };
}
const line = (s, x, y) => [...s].map((c, i) => [c, x + i * 7, y]);
const page = (body, footer = line("7", 297, 30)) => [...line("Title", 270, 770), [" ", 0, 0], ...body, [" ", 0, 0], ...footer];

function setup(outPages) {
  const src = new Uint8Array([1]), out = new Uint8Array([2]);
  const map = new Map([[src, [page([...line("alpha beta", 50, 600), [" ", 0, 0], ...line("gamma", 50, 576)]), page(line("other page", 50, 600))]], [out, outPages]]);
  return { factory: pdfEngineFor(map), src, out };
}
const edit = [{ id: "e1", pageIndex: 0, before: "beta", after: "delta" }];

test("inspect passes the exact expected replacement and order", async () => {
  const { factory, src, out } = setup([page([...line("alpha delta", 50, 600), [" ", 0, 0], ...line("gamma", 50, 576)]), page(line("other page", 50, 600))]);
  const r = await inspectSavedPdf(factory, src, out, edit);
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.equal(r.independent, false);
});

test("inspect rejects reading order changes even with the same words", async () => {
  const { factory, src, out } = setup([page([...line("gamma", 50, 576), [" ", 0, 0], ...line("alpha delta", 50, 600)]), page(line("other page", 50, 600))]);
  const r = await inspectSavedPdf(factory, src, out, edit);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === "edited_page_text_or_order_mismatch"));
});

test("saved stream that appends the edited paragraph after its followers still fails", async () => {
  // The pre-save append-order diagnosis is only a warning; the saved check
  // must still reject an output whose edited text is serialized last.
  const { factory, src, out } = setup([page([...line("gamma", 50, 576), [" ", 0, 0], ...line("alpha delta", 50, 600)]), page(line("other page", 50, 600))]);
  const r = await inspectSavedPdf(factory, src, out, edit);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures.map((f) => f.code), ["edited_page_text_or_order_mismatch"]);
});

test("inspect rejects off-page glyphs, moved footer and changed unedited pages", async () => {
  const wide = line("alpha delta" + " x".repeat(60), 50, 600);
  const { factory, src, out } = setup([page([...wide, [" ", 0, 0], ...line("gamma", 50, 576)], line("7", 297, 10)), page(line("other pag", 50, 600))]);
  const r = await inspectSavedPdf(factory, src, out, [{ ...edit[0], after: "delta" + " x".repeat(60) }]);
  const codes = r.failures.map((f) => f.code);
  assert.ok(codes.includes("glyphs_off_page"));
  assert.ok(codes.includes("header_footer_moved"));
  assert.ok(codes.includes("unedited_page_text_changed"));
});

test("inspect rejects overlapping text", async () => {
  const { factory, src, out } = setup([page([...line("alpha delta", 50, 600), [" ", 0, 0], ...line("gamma", 50, 596)]), page(line("other page", 50, 600))]);
  const r = await inspectSavedPdf(factory, src, out, edit);
  assert.ok(r.failures.some((f) => f.code === "glyph_overlap_increased"));
});

test("ambiguous expected text is a failure, not a guess", () => {
  assert.equal(expectedPageText("a b a b", [{ id: "x", before: "a b", after: "c" }]).ok, false);
  assert.equal(expectedPageText("one  two\nthree", [{ id: "x", before: "two three", after: "2 3" }]).text, "one 2 3");
});

// A dense page whose body paragraph ends inside the bottom edge band: its
// last line "gamma" (centre y 95) is edge-band text that belongs to body.
function setupEdgeBody(outPages, outModel) {
  const src = new Uint8Array([3]), out = new Uint8Array([4]);
  const body = (x = 50, first = "alpha delta") => [...line(first, 50, 114), [" ", 0, 0], ...line("gamma", x, 90)];
  const model = (title = 780) => [[
    { id: 1, box: { x: 270, top: title, w: 35, h: 10 }, lines: [{ y: title - 10 }], runs: [{ text: "Title" }] },
    { id: 2, box: { x: 50, top: 124, w: 76, h: 34 }, lines: [{ y: 114 }, { y: 90 }], runs: [{ text: "alpha beta gamma" }] },
    { id: 3, box: { x: 297, top: 40, w: 6, h: 10 }, lines: [{ y: 30 }], runs: [{ text: "7" }] },
  ]];
  const pages = new Map([[src, [page(body(50, "alpha beta"))]], [out, outPages(body)]]);
  const models = new Map([[src, model()], [out, outModel(model)]]);
  return { factory: pdfEngineFor(pages, models), src, out };
}

test("body movement inside an edge band stays a failure with its own code", async () => {
  // The split identifies "gamma" as body text, which names the failure; it
  // is no proof the movement was authorized, so the check must not pass.
  const { factory, src, out } = setupEdgeBody((body) => [page(body(53))], (model) => model());
  const r = await inspectSavedPdf(factory, src, out, edit);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures.map((f) => f.code), ["edge_band_body_changed"]);
  assert.equal(r.failures[0].count, 10);
  assert.ok(!r.warnings.some((w) => w.code === "edge_band_body_changed"));
  assert.deepEqual(r.pages[0].edge_split, { bodyChanged: 10, edgeMissing: 0, edgeAdded: 0 });
});

test("a moved header still fails as header_footer_moved when a page model exists", async () => {
  const moved = (body) => [[...line("Title", 270, 760), [" ", 0, 0], ...body(), [" ", 0, 0], ...line("7", 297, 30)]];
  const { factory, src, out } = setupEdgeBody(moved, (model) => model(770));
  const r = await inspectSavedPdf(factory, src, out, edit);
  assert.equal(r.ok, false);
  const f = r.failures.find((x) => x.code === "header_footer_moved");
  assert.ok(f, JSON.stringify(r.failures));
  assert.equal(f.edgeMissing, 5);
  assert.equal(f.edgeAdded, 5);
  assert.ok(!r.failures.some((x) => x.code === "edge_band_body_changed"));
});

test("an unchanged edge band with a page model passes", async () => {
  const { factory, src, out } = setupEdgeBody((body) => [page(body())], (model) => model());
  const r = await inspectSavedPdf(factory, src, out, edit);
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.equal(r.pages[0].edge_stable, true);
});
