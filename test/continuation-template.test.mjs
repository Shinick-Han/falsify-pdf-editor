// Continuation-page edge template tests. Pure helpers run everywhere; the
// real-engine cases run only when a runtime (pinned .runtime or
// FALSIFY_EDITOR_CANDIDATE_MANIFEST) loads, and are skipped otherwise.
import assert from "node:assert/strict";
import { test } from "node:test";
import { editPdf } from "../src/editor.mjs";
import {
  anchorOf,
  applyPageEdges,
  classifyEdgeText,
  continuationNumberText,
  expectedPageEdges,
  preflightPageEdges,
  snapshotPageEdges,
  suffixedText,
  verifyPageEdges,
} from "../src/continuation-template.mjs";
import * as branchQuality from "../src/quality.mjs";
import { loadRuntime } from "../src/runtime.mjs";

// The continuation-aware saved-PDF check lives in the quality module. When
// FALSIFY_EDITOR_QUALITY_MODULE names one (e.g. the integrated main
// checkout), the end-to-end case also requires its self-check to pass.
const externalQuality = process.env.FALSIFY_EDITOR_QUALITY_MODULE
  ? await import(new URL(`file:///${process.env.FALSIFY_EDITOR_QUALITY_MODULE.replace(/\\/g, "/").replace(/^\/+/, "")}`).href)
  : null;
const quality = externalQuality ?? branchQuality;

// ---------- pure ----------

test("classifyEdgeText: only bare Arabic numbers are page numbers; other number shapes are refused", () => {
  assert.equal(classifyEdgeText("10"), "page_number");
  assert.equal(classifyEdgeText("10 "), "page_number");
  assert.equal(classifyEdgeText(" 7\u00a0"), "page_number");
  for (const t of ["xii", "- 4 -", "3 of 9", "4/9", "(5)"]) assert.equal(classifyEdgeText(t), "number_unsupported", t);
  for (const t of ["Annual Report 2024", "Chapter 3: Results", "Confidential"]) assert.equal(classifyEdgeText(t), "running", t);
});

test("continuationNumberText/suffixedText keep the source number and surrounding whitespace", () => {
  assert.equal(continuationNumberText("10", 1), "10.1");
  assert.equal(continuationNumberText(" 10 ", 12), "10.12");
  assert.equal(continuationNumberText("x", 1), null);
  assert.equal(continuationNumberText("10", 0), null);
  assert.equal(continuationNumberText("10", 1.5), null);
  assert.equal(suffixedText("10 ", 2), "10.2 ");
  assert.equal(suffixedText(" 3", 1), " 3.1");
  assert.equal(suffixedText("Page 3", 1), null);
});

test("anchorOf: centred within 2pt, else right or left half", () => {
  assert.deepEqual(anchorOf({ l: 291.6, r: 306.6 }, 595.3), { anchor: "center", x: 299.1 });
  assert.deepEqual(anchorOf({ l: 500, r: 520 }, 612), { anchor: "right", x: 520 });
  assert.deepEqual(anchorOf({ l: 72, r: 90 }, 612), { anchor: "left", x: 72 });
});

test("expectedPageEdges is deterministic from snapshot and ordinal only", () => {
  const style = { font: { baseName: "Helvetica" }, size: 10, matrix: [1, 0, 0, 1, 300, 30], fill: [0, 0, 0, 255], stroke: null, strokeWidth: 1, renderMode: 0 };
  const ch = (u, x) => ({ u, ox: x, oy: 30, l: x, b: 30, r: x + 5, t: 37 });
  const snap = {
    ok: true,
    items: [
      { index: 0, role: "running", band: "top", text: "Hi", bounds: { l: 72, b: 760, r: 80, t: 767 }, chars: [ch(72, 72), ch(105, 78)], style, anchor: null },
      { index: 9, role: "page_number", band: "bottom", text: "10 ", bounds: { l: 300, b: 30, r: 313, t: 37 }, chars: [ch(49, 300), ch(48, 305), ch(32, 310)], style, anchor: { anchor: "center", x: 306.5 } },
    ],
  };
  const a = expectedPageEdges(snap, 2);
  assert.equal(a.ok, true);
  assert.deepEqual(a.items.map((i) => [i.role, i.text, i.sourceText]), [["running", "Hi", "Hi"], ["page_number", "10.2 ", "10 "]]);
  assert.equal(a.items[0].bounds, snap.items[0].bounds);
  assert.equal(a.items[1].bounds, null);
  assert.deepEqual(a.items[1].prefixChars.map((c) => c.u), [49, 48]);
  assert.equal(a.items[1].suffix, ".2");
  assert.deepEqual(expectedPageEdges(snap, 2), a);
  assert.equal(expectedPageEdges(snap, 0).code, "continuation_ordinal_invalid");
  assert.equal(expectedPageEdges({ ok: false }, 1).code, "continuation_edge_snapshot_invalid");
});

// ---------- real engine ----------

function pdfFromPages(pages, extraObjects = []) {
  // pages: content stream strings; F1 = Helvetica (WinAnsi), F2 = Times-Roman.
  const n = pages.length;
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + 2 * i} 0 R`).join(" ")}] /Count ${n} >>`];
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>");
  pages.forEach((c, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`);
    objs.push(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
  });
  objs.push(...extraObjects);
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

const HEADER = "BT 0.2 0.3 0.6 rg /F2 9 Tf 72 762 Td [(Annual) -250 (Re) 40 (port) 300 (2024)] TJ ET";
const body = (rows) => rows.map((l, i) => `BT /F1 12 Tf 72 ${740 - 32 * i} Td (${l}) Tj ET`).join(" ");
const footer = (t, x = 300) => `BT /F2 10 Tf ${x} 30 Td (${t}) Tj ET`;
const LONG = "We continue only after a much longer explanation that wraps across several lines of the same column. ".repeat(6).trim();

function rowsWithTarget() {
  const rows = Array.from({ length: 22 }, (_, i) => `Paragraph ${i + 1} stays.`);
  rows[3] = "If every check passes, we continue.";
  return rows;
}

let rt = null;
try {
  rt = await loadRuntime();
} catch {}
const skip = !rt && "runtime not available";

async function withPage(bytes, fn) {
  const engine = await rt.engineFactory(bytes);
  try {
    engine.loadPage(0);
    engine.buildModel();
    return await fn(engine);
  } finally {
    engine.close();
  }
}

test("real engine: snapshot reads header TJ text and footer number without mutation", { skip }, async () => {
  const src = pdfFromPages([HEADER + " " + body(rowsWithTarget()) + " " + footer("10 ")]);
  await withPage(src, (engine) => {
    const M = engine.M;
    const count = M._FPDFPage_CountObjects(engine.page);
    const snap = snapshotPageEdges(engine, 50, 750);
    assert.equal(snap.ok, true, snap.code);
    assert.equal(M._FPDFPage_CountObjects(engine.page), count);
    const [head, num] = snap.items;
    assert.equal(head.role, "running");
    // Generated (gap) spaces are not object characters.
    assert.equal(head.text, "AnnualReport2024");
    assert.equal(head.style.font.baseName.includes("Times"), true);
    assert.deepEqual(head.style.fill.slice(0, 3), [51, 77, 153]);
    assert.equal(num.role, "page_number");
    // The trailing space is a generated char; the anchor uses the digits' ink.
    assert.equal(num.text, "10");
    assert.equal(num.anchor.anchor, "center");
    assert.ok(Math.abs(num.anchor.x - (num.chars[0].l + num.chars[1].r) / 2) < 1e-6);
    assert.equal(JSON.parse(JSON.stringify(snap)).items[0].h, undefined);
  });
});

test("real engine: clones match source glyphs and page number gets a decimal suffix at its anchor", { skip }, async () => {
  const src = pdfFromPages([HEADER + " " + body(rowsWithTarget()) + " " + footer("10 ", 520)]);
  await withPage(src, (engine) => {
    const M = engine.M;
    const snap = snapshotPageEdges(engine, 50, 750);
    assert.equal(snap.ok, true, snap.code);
    assert.equal(preflightPageEdges(engine, snap, 12).ok, true);
    for (const ordinal of [1, 2, 11]) {
      const np = M._FPDFPage_New(engine.doc, 1, snap.pageW, snap.pageH);
      try {
        const applied = applyPageEdges(engine, np, snap, ordinal);
        assert.equal(applied.ok, true, applied.code);
        assert.equal(M._FPDFPage_CountObjects(np), applied.items.length);
        const proof = verifyPageEdges(engine, np, snap, ordinal, applied);
        assert.equal(proof.ok, true, `${proof.code} ${proof.reason}`);
        const num = proof.items.find((i) => i.role === "page_number");
        assert.equal(num.text, `10.${ordinal}`);
        assert.equal(snap.items[1].anchor.anchor, "right");
        assert.equal(M._FPDFPage_GenerateContent(np), 1);
      } finally {
        M._FPDF_ClosePage(np);
      }
    }
    // Originals untouched.
    const again = snapshotPageEdges(engine, 50, 750);
    assert.deepEqual(JSON.parse(JSON.stringify(again.items)), JSON.parse(JSON.stringify(snap.items)));
  });
});

test("real engine: tampered clone is caught by verifyPageEdges", { skip }, async () => {
  const src = pdfFromPages([HEADER + " " + body(rowsWithTarget()) + " " + footer("10 ")]);
  await withPage(src, (engine) => {
    const M = engine.M;
    const snap = snapshotPageEdges(engine, 50, 750);
    const np = M._FPDFPage_New(engine.doc, 1, snap.pageW, snap.pageH);
    try {
      const applied = applyPageEdges(engine, np, snap, 1);
      engine.translateObject(applied.items[0].h, 0, 3);
      const proof = verifyPageEdges(engine, np, snap, 1, applied);
      assert.equal(proof.code, "continuation_edge_clone_mismatch");
      assert.equal(proof.reason, "geometry");
      engine.translateObject(applied.items[0].h, 0, -3);
      assert.equal(verifyPageEdges(engine, np, snap, 1, applied).ok, true);
      // A clone made for ordinal 1 does not prove ordinal 2.
      assert.equal(verifyPageEdges(engine, np, snap, 2, applied).reason, "text");
      engine.translateObject(applied.items[1].h, 4, 0);
      assert.equal(verifyPageEdges(engine, np, snap, 1, applied).reason, "anchor");
    } finally {
      M._FPDF_ClosePage(np);
    }
  });
});

test("real engine: unsupported edges fail closed with specific codes", { skip }, async () => {
  const rows = body(rowsWithTarget());
  const cases = [
    [`0 0 0 RG 72 770 m 540 770 l S ${rows} ${footer("10")}`, "continuation_edge_graphics_unsupported"],
    [`${rows} ${footer("Page 3")}`, "continuation_page_number_unsupported"],
    [`${rows} ${footer("xii")}`, "continuation_page_number_unsupported"],
    [`BT /F2 10 Tf 300 770 Td (3) Tj ET ${rows} ${footer("4")}`, "continuation_page_number_ambiguous"],
    [`${rows} BT /F2 10 Tf 300 30 Td [(1) -400 (0)] TJ ET`, "continuation_page_number_spacing_unsupported"],
    [`${rows} BT /F2 10 Tf 300 30 Td (1) Tj 5 3 Td (0) Tj ET`, "continuation_page_number_ambiguous"],
  ];
  for (const [content, code] of cases) {
    await withPage(pdfFromPages([content]), (engine) => {
      assert.equal(snapshotPageEdges(engine, 50, 750).code, code, content.slice(0, 40));
    });
  }
});

test("real engine: editPdf copies source-style edges onto continuation pages", { skip }, async () => {
  const src = pdfFromPages([HEADER + " " + body(rowsWithTarget()) + " " + footer("10 "), "BT /F1 12 Tf 72 740 Td (Second page stays as it is.) Tj ET " + footer("11 ")]);
  let saved = null;
  // Real quality functions; the seam only records the output bytes so the
  // engine side is checked even when the branch quality rejects edges.
  const q = { ...quality, inspectSavedPdf: async (f, s, o, e, opt) => ((saved = o), quality.inspectSavedPdf(f, s, o, e, opt)) };
  let report = null;
  let error = null;
  try {
    ({ report } = await editPdf({ sourceBytes: src, edits: [{ id: "long", pageIndex: 0, before: "If every check passes, we continue.", after: LONG }], reflow: true }, { quality: q }));
  } catch (err) {
    error = err;
    report = err.report;
  }
  assert.ok(saved, `no output: ${report?.status} ${JSON.stringify(report?.warnings)}`);
  if (externalQuality) {
    assert.equal(error, null, `${error?.code} ${JSON.stringify(report?.selfCheck?.failures)}`);
    assert.deepEqual(report.pagination.continuationStyle, { policy: "source-number-suffix", applied: true, copiedPages: report.pagination.addedPages });
  }
  const m = report.pagination.sourcePageMap;
  assert.ok(m[0].continuationPageIndices.length >= 1);
  assert.deepEqual(m[0].continuationStyle, { version: 1, policy: "source-number-suffix", applied: true });
  assert.equal(m[1].continuationStyle, undefined);
  const out = await rt.engineFactory(saved);
  const srcEngine = await rt.engineFactory(src);
  try {
    srcEngine.loadPage(0);
    const snap = snapshotPageEdges(srcEngine, m[0].floor, m[0].bodyTop);
    assert.equal(snap.ok, true);
    // Non-generated characters outside the body band, in stream order
    // ("10.1" is number-like, so the snapshot classifier is not reused here).
    const edgeText = (k) => {
      out.loadPage(k);
      const M = out.M;
      const tp = M._FPDFText_LoadPage(out.page);
      const b = M._malloc(32);
      let t = "";
      for (let i = 0; i < M._FPDFText_CountChars(tp); i++) {
        if (M._FPDFText_IsGenerated(tp, i) === 1 || !M._FPDFText_GetCharBox(tp, i, b, b + 8, b + 16, b + 24)) continue;
        const cy = (M.HEAPF64[(b + 16) >> 3] + M.HEAPF64[(b + 24) >> 3]) / 2;
        if (cy < m[0].floor - 0.5 || cy > m[0].bodyTop + 0.5) t += String.fromCodePoint(M._FPDFText_GetUnicode(tp, i));
      }
      M._free(b);
      M._FPDFText_ClosePage(tp);
      return t;
    };
    assert.equal(edgeText(0), snap.items.map((i) => i.text).join(""));
    m[0].continuationPageIndices.forEach((k, j) => {
      assert.equal(edgeText(k), expectedPageEdges(snap, j + 1).items.map((i) => i.text).join(""));
    });
    assert.ok(edgeText(m[1].outputPageIndex).endsWith("11"));
  } finally {
    out.close();
    srcEngine.close();
  }
});
