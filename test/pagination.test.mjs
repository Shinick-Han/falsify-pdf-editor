// Pagination tests. Pure planners and the page-map contract run on synthetic
// data; the real-engine case runs only when a runtime (pinned .runtime or
// FALSIFY_EDITOR_CANDIDATE_MANIFEST) loads, and is skipped otherwise.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EDITOR_CAPABILITIES, editPdf } from "../src/editor.mjs";
import { PAGINATION_LIMITS, buildFlowPlan, groupLines, planFlow } from "../src/pagination.mjs";
import { countGlyphLines, inspectSavedPdf, joinFlowParts, normalizePageMap } from "../src/quality.mjs";
import { loadRuntime } from "../src/runtime.mjs";

const bytes = (s = "%PDF-1.4 synthetic") => new Uint8Array(Buffer.from(s));
// Lines 20pt tall at a 24pt pitch, tops descending from `top`.
const lines = (n, top = 700) => Array.from({ length: n }, (_, i) => ({ top: top - 24 * i, bottom: top - 24 * i - 20 }));

test("EDITOR_CAPABILITIES advertises reflow and a bounded pagination descriptor", () => {
  assert.equal(EDITOR_CAPABILITIES.reflow, true);
  const p = EDITOR_CAPABILITIES.pagination;
  assert.equal(p.supported, true);
  assert.match(p.continuationPages, /source-style copies of the source page's header\/footer text/);
  assert.match(p.continuationPages, /standalone Arabic page number becomes source number plus decimal suffix/);
  assert.match(p.continuationPages, /no synthesized label/);
  assert.match(p.sourcePageNumbers, /unchanged/);
  assert.deepEqual({ ...p.continuationStyle }, { version: 1, policy: "source-number-suffix" });
  for (const u of ["multi_column_flow", "foreign_object_in_flow", "edge_graphics", "edge_clip", "edge_style", "ambiguous_page_number", "page_number_glyph_missing"]) assert.ok(p.unsupported.includes(u), u);
  assert.equal(p.maxNewPagesLimit, PAGINATION_LIMITS.maxNewPages);
  assert.ok(Object.isFrozen(EDITOR_CAPABILITIES) && Object.isFrozen(p) && Object.isFrozen(p.continuationStyle));
});

test("planFlow keeps lines that fit (wrap without new page)", () => {
  const r = planFlow(lines(5), { bodyTop: 700, floor: 500, maxNewPages: 8 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.pages.map((p) => p.lines), [[0, 1, 2, 3, 4]]);
});

test("planFlow splits a long flow into continuation pages in order", () => {
  const r = planFlow(lines(30, 300), { bodyTop: 700, floor: 100, maxNewPages: 8 });
  assert.equal(r.ok, true);
  const flat = r.pages.flatMap((p) => p.lines);
  assert.deepEqual(flat, [...Array(30).keys()]);
  assert.ok(r.pages.length >= 2);
  for (const [k, p] of r.pages.entries()) {
    for (const i of p.lines) {
      const l = lines(30, 300)[i];
      assert.ok(l.bottom + p.offset >= 100 - 0.01 && l.top + p.offset <= 700 + 0.01, `page ${k} line ${i} in body band`);
    }
    if (k) assert.ok(Math.abs(lines(30, 300)[p.lines[0]].top + p.offset - 700) < 1e-9);
  }
});

test("planFlow budget, oversize line and non-monotonic flows stop", () => {
  assert.equal(planFlow(lines(30, 300), { bodyTop: 700, floor: 100, maxNewPages: 0 }).code, "pagination_budget_exceeded");
  assert.equal(planFlow([{ top: 90, bottom: -700 }], { bodyTop: 700, floor: 100, maxNewPages: 8 }).code, "pagination_line_exceeds_body");
  assert.equal(planFlow([{ top: 300, bottom: 280 }, { top: 400, bottom: 380 }], { bodyTop: 700, floor: 100, maxNewPages: 8 }).code, "pagination_flow_not_monotonic");
  assert.equal(planFlow(lines(2), { bodyTop: 100, floor: 100, maxNewPages: 8 }).code, "pagination_body_band_invalid");
});

test("groupLines clusters objects by line and separates zero-height objects", () => {
  const items = [
    { top: 700, bottom: 688, order: 0 },
    { top: 702, bottom: 690, order: 1 },
    { top: 676, bottom: 664, order: 2 },
    { top: 690, bottom: 690, order: 3 },
  ];
  const { lines: ls, loose } = groupLines(items);
  assert.deepEqual(ls.map((l) => l.items.map((i) => i.order).sort()), [[0, 1], [2]]);
  assert.deepEqual(loose.map((i) => i.order), [3]);
});

test("normalizePageMap requires consecutive output indices and continuation geometry", () => {
  assert.deepEqual(normalizePageMap(undefined, 2).map((m) => m.outputPageIndex), [0, 1]);
  const good = [
    { sourcePageIndex: 0, outputPageIndex: 0, continuationPageIndices: [1, 2], bodyTop: 700, floor: 50, lineCounts: [3, 1] },
    { sourcePageIndex: 1, outputPageIndex: 3, continuationPageIndices: [] },
  ];
  assert.equal(normalizePageMap(good, 2).length, 2);
  assert.equal(normalizePageMap([good[0]], 2), null);
  assert.equal(normalizePageMap([good[0], { ...good[1], outputPageIndex: 1 }], 2), null);
  assert.equal(normalizePageMap([{ ...good[0], lineCounts: [3] }, good[1]], 2), null);
  assert.equal(normalizePageMap([{ ...good[0], continuationPageIndices: [2] }, good[1]], 2), null);
});

test("joinFlowParts joins a page-end soft hyphen only where the source has one", () => {
  assert.equal(joinFlowParts(["a fit-", "ting b"], "a fit\u0002ting b").text, "a fit\u0002ting b");
  assert.equal(joinFlowParts(["well-", "known"], "well- known").text, "well- known");
  assert.equal(joinFlowParts(["one two", "three"], "one two three").softJoins, 0);
});

test("countGlyphLines measures lines from glyph boxes", () => {
  const g = (l, b) => ({ l, r: l + 5, b, t: b + 10 });
  assert.equal(countGlyphLines([g(0, 700), g(6, 701), g(0, 676), g(6, 652)]), 3);
  assert.equal(countGlyphLines([]), 0);
});

// ---------- saved-PDF inspection through a page map (mock text engine) ----------

function pdfEngineFor(docs) {
  return async () => {
    const heap = new Float64Array(8);
    let doc = null;
    return {
      pageCount: 0, page: 0, pageIndex: -1,
      open(b) { doc = docs.get(b); this.pageCount = doc.length; },
      close() {},
      loadPage(i) { this.pageIndex = i; this.page = i + 1; },
      M: {
        HEAPF64: heap, _malloc: () => 0, _free() {},
        _FPDF_GetPageWidthF: () => 600, _FPDF_GetPageHeightF: () => 800,
        _FPDFText_LoadPage: (p) => p, _FPDFText_ClosePage() {},
        _FPDFText_CountChars: (p) => doc[p - 1].length,
        _FPDFText_GetUnicode: (p, i) => doc[p - 1][i][0].charCodeAt(0),
        _FPDFText_IsGenerated: (p, i) => doc[p - 1][i][3] ? 1 : 0,
        _FPDFText_GetCharBox: (p, i) => {
          const [, x, y] = doc[p - 1][i];
          heap[0] = x; heap[1] = x + 6; heap[2] = y; heap[3] = y + 10;
          return 1;
        },
      },
    };
  };
}
const line = (s, x, y) => [...s].map((c, i) => [c, x + i * 7, y]);
const br = [" ", 0, 0];
const footer = line("7", 297, 30);
const body = (rows) => rows.flatMap((r, i) => [...line(r, 50, 700 - 24 * i), br]);

function mapFor(lineCounts = [2]) {
  return [
    { sourcePageIndex: 0, outputPageIndex: 0, continuationPageIndices: [1], bodyTop: 712, floor: 600, lineCounts },
    { sourcePageIndex: 1, outputPageIndex: 2, continuationPageIndices: [] },
  ];
}

function setup(outPages) {
  const src = new Uint8Array([1]), out = new Uint8Array([2]);
  const docs = new Map([
    [src, [[...body(["alpha beta", "gamma", "delta"]), ...footer], line("other page", 50, 700)]],
    [out, outPages],
  ]);
  return { factory: pdfEngineFor(docs), src, out };
}
const edit = [{ id: "e1", pageIndex: 0, before: "beta", after: "beta long words" }];

test("inspect accepts ordered flow across a continuation page with fixed footer", async () => {
  const { factory, src, out } = setup([
    [...body(["alpha beta", "long words", "gamma"]), ...footer],
    [...body(["delta"])],
    line("other page", 50, 700),
  ]);
  const r = await inspectSavedPdf(factory, src, out, edit, { sourcePageMap: mapFor([1]) });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.deepEqual(r.page_count, { source: 2, output: 3, expected: 3, added: 1 });
  assert.deepEqual(r.pages[0].continuation[0].lines, { planned: 1, measured: 1 });
  assert.equal(r.pages[1].outputPageIndex, 2);
  assert.equal(r.pages[0].expected_text.text, undefined);
});

test("inspect rejects reordered flow, moved footer, wrong count and changed downstream page", async () => {
  const reordered = setup([[...body(["alpha beta", "gamma", "long words"]), ...footer], [...body(["delta"])], line("other page", 50, 700)]);
  let r = await inspectSavedPdf(reordered.factory, reordered.src, reordered.out, edit, { sourcePageMap: mapFor([1]) });
  assert.ok(r.failures.some((f) => f.code === "edited_flow_text_or_order_mismatch"));
  const moved = setup([[...body(["alpha beta", "long words", "gamma"]), ...line("7", 297, 40)], [...body(["delta"])], line("other page", 50, 700)]);
  r = await inspectSavedPdf(moved.factory, moved.src, moved.out, edit, { sourcePageMap: mapFor([1]) });
  assert.ok(r.failures.some((f) => f.code === "header_footer_moved"));
  const counted = setup([[...body(["alpha beta", "long words", "gamma"]), ...footer], [...body(["delta"])], line("other page", 50, 700)]);
  r = await inspectSavedPdf(counted.factory, counted.src, counted.out, edit, { sourcePageMap: mapFor([2]) });
  assert.ok(r.failures.some((f) => f.code === "continuation_line_count_mismatch"));
  const down = setup([[...body(["alpha beta", "long words", "gamma"]), ...footer], [...body(["delta"])], line("other pag", 50, 700)]);
  r = await inspectSavedPdf(down.factory, down.src, down.out, edit, { sourcePageMap: mapFor([1]) });
  assert.ok(r.failures.some((f) => f.code === "unedited_page_text_changed"));
  const short = setup([[...body(["alpha beta", "long words", "gamma"]), ...footer], line("other page", 50, 700)]);
  r = await inspectSavedPdf(short.factory, short.src, short.out, edit, { sourcePageMap: mapFor([1]) });
  assert.ok(r.failures.some((f) => f.code === "page_count_mismatch"));
});

// ---------- editor orchestration with a paginating mock quality ----------

function mockEngine(pages) {
  const calls = [];
  let current = 0, nextId = 1;
  const eng = {
    pageCount: pages.length,
    loadPage: (i) => { current = i; calls.push(["loadPage", i]); },
    normalizeFontsForEdit() {},
    pageRegenHostile: () => false,
    buildModel: () => (pages[current] ?? []).map((t, i) => ({ id: nextId++, editable: true, box: { x: 0, top: 700 - i * 20, w: 50, h: 9 }, lines: [{}], format: {}, runs: [{ text: t, rgba: 0 }] })),
    commitParagraph: (id) => ({ id, surgical: false, lines: [{}] }),
    save: () => bytes("%PDF-edited"),
    close() {},
  };
  return { eng, calls, factory: async () => eng };
}

test("editPdf maps source pages through inserted continuation pages and keeps later indices", async () => {
  // Source pages 0..2; page 0 gains two continuation pages, page 2 is
  // edited too and must be addressed at output index 4 during commit.
  const pages = [["alpha"], ["beta"], ["gamma"]];
  const m = mockEngine(pages);
  let inspected;
  const quality = {
    capturePageLayout: (e, at) => ({ at }),
    repairPageLayout: (e, at, ctx, touched, opts) => {
      assert.equal(typeof opts.paginate, "function");
      if (at === 0) {
        pages.splice(1, 0, ["c1"], ["c2"]);
        return { repairs: [], warnings: [], pagination: { added: 2, lineCounts: [30, 4], keptLines: 10, bodyTop: 700, floor: 50 } };
      }
      return { repairs: [], warnings: [] };
    },
    inspectSavedPdf: async (f, s, o, edits, opts) => { inspected = opts; return { ok: true, failures: [], warnings: [], pages: [] }; },
  };
  const edits = [{ id: "a", pageIndex: 0, before: "alpha", after: "ALPHA" }, { id: "g", pageIndex: 2, before: "gamma", after: "GAMMA" }];
  const { report } = await editPdf({ sourceBytes: bytes(), edits, reflow: true }, { engineFactory: m.factory, quality });
  assert.deepEqual(m.calls.filter((c) => c[0] === "loadPage").slice(-2).map((c) => c[1]), [0, 4]);
  assert.deepEqual(report.pagination.pages, { source: 3, output: 5 });
  assert.equal(report.pagination.addedPages, 2);
  assert.deepEqual(report.pagination.sourcePageMap.map((e) => [e.outputPageIndex, e.continuationPageIndices]), [[0, [1, 2]], [3, []], [4, []]]);
  assert.deepEqual(inspected.sourcePageMap, report.pagination.sourcePageMap);
  assert.equal(inspected.includeText, false);
});

test("editPdf validates pagination options and maps budget errors", async () => {
  for (const o of [{ allowPagination: "yes" }, { maxNewPages: -1 }, { maxNewPages: 33 }, { maxNewPages: 1.5 }]) {
    await assert.rejects(editPdf({ sourceBytes: bytes(), edits: [], reflow: true }, { ...o, engineFactory: mockEngine([["a"]]).factory, quality: {} }), { code: "INVALID_REQUEST" });
  }
  const m = mockEngine([["alpha"]]);
  const quality = {
    capturePageLayout: () => ({}),
    repairPageLayout: (e, at, ctx, t, opts) => ({ repairs: [], warnings: opts.paginate ? [{ code: "pagination_budget_exceeded", severity: "error" }] : [{ code: "pagination_unsupported", severity: "error" }] }),
    inspectSavedPdf: async () => ({ ok: true, failures: [], warnings: [] }),
  };
  const req = { sourceBytes: bytes(), edits: [{ id: "a", pageIndex: 0, before: "alpha", after: "b" }], reflow: true };
  await assert.rejects(editPdf(req, { engineFactory: m.factory, quality }), { code: "PAGINATION_LIMIT" });
  await assert.rejects(editPdf(req, { engineFactory: mockEngine([["alpha"]]).factory, quality, allowPagination: false }), { code: "LAYOUT_UNSUPPORTED" });
});

// ---------- real engine (synthetic PDF, patched or pinned runtime) ----------

function syntheticPdf(lineTexts, footerText) {
  // One text object per short paragraph at a 32pt pitch.
  const body = lineTexts.map((l, i) => `BT /F1 12 Tf 72 ${740 - 32 * i} Td (${l}) Tj ET`).join(" ");
  const content = body + ` BT /F1 10 Tf 300 30 Td (${footerText}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
  ];
  const second = "BT /F1 12 Tf 72 740 Td (Second page stays as it is.) Tj ET BT /F1 10 Tf 300 30 Td (2) Tj ET";
  objs.push(`<< /Length ${second.length} >>\nstream\n${second}\nendstream`);
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

let runtimeOk = false;
try {
  await loadRuntime();
  runtimeOk = true;
} catch {}

test("real engine: long edit continues onto a new page with mapped, unchanged second page", { skip: !runtimeOk && "runtime not available" }, async () => {
  const rows = Array.from({ length: 22 }, (_, i) => `Paragraph ${i + 1} stays.`);
  rows[3] = "If every check passes, we continue.";
  const src = syntheticPdf(rows, "1");
  const copy = Buffer.from(src);
  const after = "We continue only after a much longer explanation that wraps across several lines of the same column. ".repeat(6).trim();
  const { pdf, report } = await editPdf({ sourceBytes: src, edits: [{ id: "long", pageIndex: 0, before: "If every check passes, we continue.", after }], reflow: true });
  assert.equal(report.ok, true, JSON.stringify(report.selfCheck.failures));
  assert.ok(report.pagination.addedPages >= 1);
  const m = report.pagination.sourcePageMap;
  assert.equal(m[1].outputPageIndex, 1 + report.pagination.addedPages);
  assert.deepEqual(report.selfCheck.page_count, { source: 2, output: 2 + report.pagination.addedPages, expected: 2 + report.pagination.addedPages, added: report.pagination.addedPages });
  const flow = report.pagination.flow[0];
  assert.equal(flow.textEqual, true);
  assert.ok(flow.measuredLines.every((l) => l.planned === l.measured && l.measured > 0));
  assert.equal(Buffer.compare(copy, Buffer.from(src)), 0);
  assert.ok(pdf.length > 0);
  const capped = editPdf({ sourceBytes: src, edits: [{ id: "long", pageIndex: 0, before: "If every check passes, we continue.", after }], reflow: true }, { maxNewPages: 0 });
  await assert.rejects(capped, { code: "PAGINATION_LIMIT" });
  assert.equal(Buffer.compare(copy, Buffer.from(src)), 0);
});


test("pagination binds a unique short inline underline but refuses table rules and filled shapes", () => {
  const q={id:1,role:"body",editable:true,topLevel:true,box:{x:50,top:700,w:100,h:20},size:10};
  const objects=[{h:1,type:1,b:{x:50,y:680,w:10,h:10}},{h:2,type:2,b:{x:50,y:678,w:10,h:0}}];
  const engine={page:1,pageHeight:800,M:{_FPDFPage_CountObjects:()=>objects.length,_FPDFPage_GetObject:(_,i)=>objects[i].h,_FPDFPageObj_GetType:(h)=>objects.find(o=>o.h===h).type},paragraphObjects:()=>[1],objectBounds:(h)=>objects.find(o=>o.h===h).b};
  const plan=()=>buildFlowPlan(engine,{paras:[q],pageH:800},[{id:1,box:q.box,delta:0}],{floor:50,maxNewPages:8});
  assert.equal(plan().ok,true);
  assert.deepEqual(plan().lines[0].items.map(i=>i.h),[1,2]);
  objects[1].b.w=100;
  assert.equal(plan().code,"pagination_unsupported_foreign_object_in_flow");
  objects[1].b.w=10;objects[1].b.h=3;
  assert.equal(plan().code,"pagination_unsupported_foreign_object_in_flow");
});


test("saved whole logical paragraph compares generated spaces across continuation without accepting a visible hyphen or typed space", async () => {
  const src=new Uint8Array([21]),out=new Uint8Array([22]);
  const edits=[{id:"whole",pageIndex:0,before:"trial,routinely beneficial delta",after:"trial,routinely beneficial qualified delta"}];
  const source=[[...body(["trial,routinely ben\u0002eficial", "delta"]),...footer],line("other page",50,700)];
  const inspect=async (text, generated) => {
    const rows=[...line(text,50,700).map((c,i)=>[c[0],50+i*5,c[2]]),br];
    const added=rows.find((c,i) => i>0 && rows[i-1][0]==="," && c[0]===" ");
    if (added) added[3]=generated;
    const docs=new Map([[src,source],[out,[[...rows,...footer],body(["delta"]),line("other page",50,700)]]]);
    return inspectSavedPdf(pdfEngineFor(docs),src,out,edits,{sourcePageMap:mapFor([1])});
  };
  const good=await inspect("trial, routinely beneficial qualified",true);
  assert.equal(good.ok,true,JSON.stringify(good.failures));
  assert.equal(good.pages[0].generated_whitespace_normalized,true);
  assert.ok(good.warnings.some(w=>w.code==="continued_flow_generated_whitespace_normalized"));
  for (const [text,generated] of [["trial, routinely beneficial qualified",false],["trial, routinely ben-eficial qualified",true],["trial, routinely qualified beneficial",true]]) {
    const bad=await inspect(text,generated);
    assert.ok(bad.failures.some(f=>f.code==="edited_flow_text_or_order_mismatch"),text);
  }
});


test("literal extra space in unchanged continued flow fails even while the requested word After exists", async () => {
  const src=new Uint8Array([31]),out=new Uint8Array([32]);
  const source=[[...body(["trial,routinely beta", "ben\u0002eficial delta"]),...footer],line("other page",50,700)];
  const inspect=async(generated)=>{
    const first=line("trial, routinely qualified",50,700);
    first.find((c,i)=>i>0&&first[i-1][0]===","&&c[0]===" ")[3]=generated;
    const docs=new Map([[src,source],[out,[[...first,br,...footer],body(["beneficial delta"]),line("other page",50,700)]]]);
    return inspectSavedPdf(pdfEngineFor(docs),src,out,[{id:"word",pageIndex:0,before:"beta",after:"qualified"}],{sourcePageMap:mapFor([1])});
  };
  const bad=await inspect(false);
  assert.ok(bad.failures.some(f=>f.code==="edited_flow_text_or_order_mismatch"));
  const good=await inspect(true);
  assert.equal(good.ok,true,JSON.stringify(good.failures));
});
