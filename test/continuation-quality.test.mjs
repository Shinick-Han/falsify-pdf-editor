// Saved-PDF self-check of continuation pages that carry copied source
// header/footer content and a source-number decimal suffix. The engine is a
// mock of the PDFium text-page surface (char boxes, origins, loose boxes,
// font/colour/matrix/render mode and owning text object); no PDF or WASM.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capturePageLayout, inspectSavedPdf, normalizePageMap, repairPageLayout, validContinuationStyle } from "../src/quality.mjs";

const STYLE = { version: 1, policy: "source-number-suffix", applied: true };

// Page 600 x 800. Every char is { u, x, y, obj?, font?, size?, fill?, render? };
// tight box [x, x+5] x [y, y+10], advance (loose) box [x, x+6], origin (x, y).
function factoryFor(docs, { styled = true } = {}) {
  return async () => {
    const buf = new ArrayBuffer(8192);
    const F64 = new Float64Array(buf), F32 = new Float32Array(buf), U32 = new Uint32Array(buf), I32 = new Int32Array(buf);
    let doc = null, brk = 8, fontName = "";
    const render = new Map();
    const ch = (p, i) => doc[p - 1][i];
    const M = {
      HEAPF64: F64, HEAPF32: F32, HEAPU32: U32, HEAP32: I32,
      _malloc: (n) => { const a = brk; brk += (n + 7) & ~7; return a; },
      _free() {},
      _FPDF_GetPageWidthF: () => 600, _FPDF_GetPageHeightF: () => 800,
      _FPDFText_LoadPage: (p) => p, _FPDFText_ClosePage() {},
      _FPDFText_CountChars: (p) => doc[p - 1].length,
      _FPDFText_GetUnicode: (p, i) => ch(p, i).u.charCodeAt(0),
      _FPDFText_GetCharBox: (p, i, l, r, b, t) => {
        const c = ch(p, i);
        F64[l >> 3] = c.x; F64[r >> 3] = c.x + 5; F64[b >> 3] = c.y; F64[t >> 3] = c.y + 10;
        return 1;
      },
    };
    if (styled) Object.assign(M, {
      UTF8ToString: () => fontName,
      _FPDFText_GetFontInfo: (p, i, _b, _n, flags) => { fontName = ch(p, i).font ?? "Helvetica"; I32[flags >> 2] = 32; return fontName.length + 1; },
      _FPDFText_GetFontSize: (p, i) => ch(p, i).size ?? 10,
      _FPDFText_GetFillColor: (p, i, ...at) => { const c = ch(p, i).fill ?? [0, 0, 0, 255]; at.forEach((a, k) => { U32[a >> 2] = c[k]; }); return 1; },
      _FPDFText_GetStrokeColor: () => 0,
      _FPDFText_GetMatrix: (_p, _i, m) => { [1, 0, 0, 1, 0, 0].forEach((v, k) => { F32[(m >> 2) + k] = v; }); return 1; },
      _FPDFText_GetCharOrigin: (p, i, x, y) => { const c = ch(p, i); F64[x >> 3] = c.x; F64[y >> 3] = c.y; return 1; },
      _FPDFText_GetLooseCharBox: (p, i, r) => { const c = ch(p, i); [c.x, c.y + 11, c.x + 6, c.y - 2].forEach((v, k) => { F32[(r >> 2) + k] = v; }); return 1; },
      _FPDFText_GetTextObject: (p, i) => { const c = ch(p, i); const h = p * 1000 + (c.obj ?? 999); render.set(h, c.render ?? 0); return h; },
      _FPDFTextObj_GetTextRenderMode: (h) => render.get(h),
    });
    return {
      pageCount: 0, page: 0, pageIndex: -1, M,
      open(b) { doc = docs.get(b); this.pageCount = doc.length; },
      close() {},
      loadPage(i) { this.pageIndex = i; this.page = i + 1; },
    };
  };
}

const run = (s, x, y, extra = {}) => [...s].map((u, k) => ({ u, x: x + 6 * k, y, ...extra }));
const br = { u: " ", x: 0, y: 0 };
const header = (extra = {}) => run("Annual Report", 250, 770, { obj: 1, ...extra });
const number = (s, x, extra = {}) => run(s, x, 30, { obj: 2, ...extra });
const body = (rows) => rows.flatMap((r, i) => [...run(r, 50, 700 - 24 * i, { obj: 10 + i }), br]);
// "7" spans the advance box [297, 303]: centred on the page (centre 300).
const srcPage = [...header(), ...body(["alpha beta", "gamma", "delta"]), ...number("7", 297)];
const outPage = [...header(), ...body(["alpha beta", "long words", "gamma"]), ...number("7", 297)];
const other = run("other page", 50, 700);
const edit = [{ id: "e1", pageIndex: 0, before: "beta", after: "beta long words" }];

function mapFor(conts = 1, lineCounts = [1], style = STYLE) {
  const continuationPageIndices = Array.from({ length: conts }, (_, k) => k + 1);
  return [
    { sourcePageIndex: 0, outputPageIndex: 0, continuationPageIndices, bodyTop: 712, floor: 600, lineCounts, ...(style ? { continuationStyle: style } : {}) },
    { sourcePageIndex: 1, outputPageIndex: conts + 1, continuationPageIndices: [] },
  ];
}

async function inspect(contPages, { map = mapFor(contPages.length, contPages.map(() => 1)), source = srcPage, first = outPage, styled = true } = {}) {
  const src = new Uint8Array([1]), out = new Uint8Array([2]);
  const docs = new Map([[src, [source, other]], [out, [first, ...contPages, other]]]);
  return inspectSavedPdf(factoryFor(docs, { styled }), src, out, edit, { sourcePageMap: map });
}
const codes = (r) => r.failures.map((f) => f.code);

// "7.1" is 18pt wide; centred on 300 it starts at 291.
const goodCont = () => [...header(), ...body(["delta"]), ...number("7.1", 291)];

test("copied header and centred suffixed number on the continuation page pass", async () => {
  const r = await inspect([goodCont()]);
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  const c = r.pages[0].continuation[0];
  assert.deepEqual(c.lines, { planned: 1, measured: 1 });
  assert.deepEqual(c.edges.page_numbers, [{ source: "7", expected: "7.1", output: "7.1", anchor: "center" }]);
  assert.equal(r.pages[0].text_equal, true);
});

test("ordinal follows the continuation index from the source number", async () => {
  const conts = [
    [...header(), ...body(["delta"]), ...number("7.1", 291)],
    [...header(), ...body(["epsilon"]), ...number("7.2", 291)],
  ];
  const source = [...header(), ...body(["alpha beta", "gamma", "delta", "epsilon"]), ...number("7", 297)];
  let r = await inspect(conts, { source });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  r = await inspect([conts[0], [...header(), ...body(["epsilon"]), ...number("7.1", 291)]], { source });
  assert.deepEqual(codes(r), ["continuation_page_number_mismatch"]);
});

test("changed, missing or unsuffixed page numbers are rejected", async () => {
  for (const n of [number("8.1", 291), number("7.2", 291), number("7", 297), number("7.1.1", 285), []]) {
    const r = await inspect([[...header(), ...body(["delta"]), ...n]]);
    assert.ok(codes(r).includes("continuation_page_number_mismatch"), JSON.stringify(n.map((c) => c.u)));
  }
});

test("a moved or re-anchored page number is rejected", async () => {
  for (const n of [number("7.1", 297), number("7.1", 279)]) {
    const r = await inspect([[...header(), ...body(["delta"]), ...n]]);
    assert.ok(codes(r).includes("continuation_page_number_moved"), JSON.stringify(codes(r)));
  }
  // Off the source baseline: no number at the expected baseline, extra text elsewhere.
  let r = await inspect([[...header(), ...body(["delta"]), ...number("7.1", 291).map((c) => ({ ...c, y: 32 }))]]);
  assert.deepEqual(codes(r), ["continuation_page_number_mismatch", "continuation_edge_extra"]);
  // Suffix detached from the number by extra spacing.
  const spaced = number("7.1", 288).map((c, k) => (k ? { ...c, x: c.x + 3 } : c));
  r = await inspect([[...header(), ...body(["delta"]), ...spaced]]);
  assert.ok(codes(r).includes("continuation_page_number_moved"));
});

test("wrong style on copied header or number is rejected", async () => {
  const tampered = [
    [...header({ size: 11 }), ...body(["delta"]), ...number("7.1", 291)],
    [...header({ fill: [255, 0, 0, 255] }), ...body(["delta"]), ...number("7.1", 291)],
    [...header({ font: "Times-Roman" }), ...body(["delta"]), ...number("7.1", 291)],
    [...header({ render: 3 }), ...body(["delta"]), ...number("7.1", 291)],
    [...header(), ...body(["delta"]), ...number("7.1", 291, { font: "Courier" })],
  ];
  for (const page of tampered) {
    const r = await inspect([page]);
    assert.ok(codes(r).includes("continuation_edge_style_mismatch"), JSON.stringify(codes(r)));
  }
});

test("missing, changed, moved or extra edge text is rejected", async () => {
  const cases = [
    [[...body(["delta"]), ...number("7.1", 291)], ["continuation_edge_missing"]],
    [[...run("Annual Rapport", 250, 770, { obj: 1 }), ...body(["delta"]), ...number("7.1", 291)], ["continuation_edge_missing", "continuation_edge_extra"]],
    [[...run("Annual Report", 252, 770, { obj: 1 }), ...body(["delta"]), ...number("7.1", 291)], ["continuation_edge_missing", "continuation_edge_extra"]],
    [[...header(), ...run("DRAFT", 50, 780, { obj: 5 }), ...body(["delta"]), ...number("7.1", 291)], ["continuation_edge_extra"]],
  ];
  for (const [page, want] of cases) {
    const r = await inspect([page]);
    for (const w of want) assert.ok(codes(r).includes(w), `${w} in ${JSON.stringify(codes(r))}`);
    assert.equal(r.ok, false);
  }
});

test("body text hidden outside the band is extra edge content and breaks the flow", async () => {
  const page = [...header(), ...run("delta", 50, 760, { obj: 10 }), br, ...number("7.1", 291)];
  const r = await inspect([page]);
  assert.ok(codes(r).includes("continuation_edge_extra"));
  assert.ok(codes(r).includes("edited_flow_text_or_order_mismatch"));
});

test("continued flow compares body bands only, in order", async () => {
  const r = await inspect([[...header(), ...body(["delta", "gamma"]), ...number("7.1", 291)]], { first: [...header(), ...body(["alpha beta", "long words"]), ...number("7", 297)] });
  assert.ok(codes(r).includes("edited_flow_text_or_order_mismatch"));
  assert.ok(!codes(r).some((c) => c.startsWith("continuation_edge") || c.startsWith("continuation_page_number")));
});

test("line counts use body glyphs only", async () => {
  const r = await inspect([goodCont()], { map: mapFor(1, [3]) });
  assert.deepEqual(r.pages[0].continuation[0].lines, { planned: 3, measured: 1 });
  assert.ok(codes(r).includes("continuation_line_count_mismatch"));
});

test("continuation body stays inside the source columns", async () => {
  const r = await inspect([[...header(), ...run("delta", 10, 700, { obj: 10 }), br, ...number("7.1", 291)]]);
  assert.deepEqual(codes(r), ["text_outside_source_columns"]);
});

test("original page edges keep source position and style", async () => {
  for (const first of [
    [...header({ fill: [0, 0, 255, 255] }), ...body(["alpha beta", "long words", "gamma"]), ...number("7", 297)],
    [...header(), ...body(["alpha beta", "long words", "gamma"]), ...number("7.0", 294)],
  ]) {
    const r = await inspect([goodCont()], { first });
    assert.ok(codes(r).includes("header_footer_moved"), JSON.stringify(codes(r)));
  }
});

test("ambiguous source numbers and unstyled runtimes fail closed", async () => {
  const source = [...header(), ...run("3", 50, 770, { obj: 3 }), ...body(["alpha beta", "gamma", "delta"]), ...number("7", 297)];
  const first = [...header(), ...run("3", 50, 770, { obj: 3 }), ...body(["alpha beta", "long words", "gamma"]), ...number("7", 297)];
  let r = await inspect([goodCont()], { source, first });
  assert.ok(codes(r).includes("continuation_page_number_ambiguous"));
  r = await inspect([goodCont()], { styled: false });
  assert.ok(codes(r).includes("continuation_edge_style_unverifiable"));
});

test("a source without a page number expects copied running text only", async () => {
  const source = [...header(), ...body(["alpha beta", "gamma", "delta"])];
  const first = [...header(), ...body(["alpha beta", "long words", "gamma"])];
  let r = await inspect([[...header(), ...body(["delta"])]], { source, first });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  r = await inspect([[...header(), ...body(["delta"]), ...number("1", 297)]], { source, first });
  assert.deepEqual(codes(r), ["continuation_edge_extra"]);
});

test("body-only maps still reject any content outside the band", async () => {
  let r = await inspect([goodCont()], { map: mapFor(1, [1], null) });
  assert.ok(codes(r).includes("continuation_outside_body_band"));
  r = await inspect([[...body(["delta"])]], { map: mapFor(1, [1], null) });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  r = await inspect([[...body(["delta"])]], { map: mapFor(1, [1], null), styled: false });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test("continuationStyle schema is exact and only on continued entries", () => {
  assert.equal(validContinuationStyle(STYLE), true);
  for (const bad of [null, [], {}, "x", { ...STYLE, applied: false }, { ...STYLE, version: 2 }, { ...STYLE, policy: "copy" }, { ...STYLE, extra: 1 }, { version: 1, policy: "source-number-suffix" }]) {
    assert.equal(validContinuationStyle(bad), false, JSON.stringify(bad));
    const map = mapFor(1, [1], null);
    map[0].continuationStyle = bad;
    assert.equal(normalizePageMap(map, 2), null, JSON.stringify(bad));
  }
  assert.ok(normalizePageMap(mapFor(), 2));
  assert.ok(normalizePageMap(mapFor(1, [1], null), 2));
  const onPlain = mapFor();
  onPlain[1] = { ...onPlain[1], continuationStyle: STYLE };
  assert.equal(normalizePageMap(onPlain, 2), null);
});

test("a malformed map style fails inspection instead of relaxing edge checks", async () => {
  const r = await inspect([goodCont()], { map: mapFor(1, [1], { ...STYLE, applied: "yes" }) });
  assert.ok(codes(r).includes("page_map_invalid"));
  assert.equal(r.ok, false);
});

// ---------- repairPageLayout forwards the paginator's continuation style ----------

function overflowEngine() {
  const objs = [{ h: 100, b: { x: 50, y: 186, w: 500, h: 14 } }];
  const M = {
    _FPDFPage_CountObjects: () => objs.length,
    _FPDFPage_GetObject: (_p, i) => objs[i]?.h ?? 0,
    _FPDFPageObj_GetType: () => 1,
  };
  const engine = {
    M, page: 1, pageIndex: 0, pageWidth: 600, pageHeight: 800,
    loadPage(i) { this.pageIndex = i; },
    paragraphObjects: () => [100],
    objectBounds: (h) => ({ ...objs.find((o) => o.h === h).b }),
    resizeParagraph: () => ({ box: { x: 50, top: 200, w: 500, h: 60 }, lines: [{}] }),
  };
  const model = [{ id: 2, editable: true, box: { x: 50, top: 200, w: 500, h: 14 }, lines: [{ y: 188 }], runs: [{ text: "body", size: 10 }] }];
  return { engine, model, objs };
}

function repairWith(result) {
  const { engine, model, objs } = overflowEngine();
  const ctx = capturePageLayout(engine, 0, model);
  objs[0].b.w = 900;
  const t = [{ id: 2, sourceBox: model[0].box, sourceLines: model[0].lines }];
  return repairPageLayout(engine, 0, ctx, t, { paginate: () => ({ ok: true, added: 1, lineCounts: [2], keptLines: 1, bodyTop: 200, floor: 186, repairs: [], warnings: [], ...result }) });
}

test("repairPageLayout forwards a valid continuation style and rejects a malformed one", () => {
  let r = repairWith({ continuationStyle: { ...STYLE } });
  assert.deepEqual(r.pagination, { added: 1, lineCounts: [2], keptLines: 1, bodyTop: 200, floor: 186, continuationStyle: STYLE });
  r = repairWith({});
  assert.equal("continuationStyle" in r.pagination, false);
  r = repairWith({ continuationStyle: { ...STYLE, applied: false } });
  assert.equal(r.pagination, null);
  assert.ok(r.warnings.some((w) => w.code === "continuation_style_invalid" && w.severity === "error"));
});
