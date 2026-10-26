// Prefix suffix reflow. Synthetic pages only; PDF bytes stay in memory.
// Covered by `npm test` (test/*.test.mjs) via relative imports.
// Real-engine cases run when a runtime loads (module .runtime,
// FALSIFY_EDITOR_CANDIDATE_MANIFEST, or FALSIFY_EDITOR_RUNTIME_DIR).
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

const EDGES = "BT /F1 8 Tf 72 760 Td (SYNTHETIC TEST PAGE - not a paper) Tj ET BT /F1 8 Tf 72 36 Td (Synthetic page 1) Tj ET ";
const P1 = ["Alpha beta gamma delta held steady on the long bench", "The red gear and the green bolt rested on a shelf", "Each toy part was checked once and then set down", "The end."];
const WIDTH = 280;
const num = (v) => +v.toFixed(4);
const ONE = [{ y: 500, lines: P1 }];
const OVERFLOW = [{ id: "w", pageIndex: 0, before: "the green", after: "the very green" }];

const justifiedContent = (paras, kerns, s = 1) => (s === 1 ? "" : `q ${s} 0 0 ${s} 0 0 cm `) + paras.map(({ y, lines }, n) => `BT /F1 ${num(11 / s)} Tf ${num(15 / s)} TL ${num(72 / s)} ${num(y / s)} Td `
  + lines.map((l, k) => `${k === 1 ? 98 : 100} Tz [` + l.split(" ").map((w) => `(${w})`).join(` ${kerns[n][k].toFixed(3)} `) + "] TJ T*").join(" ") + " ET ").join("") + (s === 1 ? "" : "Q ");

// Tf 1 with an upright text matrix of 9.5. The drawn size is 9.5 either way
// the engine splits Tf and the matrix on the committed glyphs.
function matrixContent(paras, kerns) {
  const s = 9.5;
  return paras.map(({ y, lines }, n) => `BT /F1 1 Tf ${num(15 / s)} TL ${s} 0 0 ${s} 72 ${num(y)} Tm `
    + lines.map((l, k) => `${k === 1 ? 98 : 100} Tz [` + l.split(" ").map((w) => `(${w})`).join(` ${kerns[n][k].toFixed(3)} `) + "] TJ T*").join(" ") + " ET ").join("");
}

async function fitPdf(contentFor) {
  let kerns = ONE.map(({ lines }) => lines.map(() => -278));
  const make = () => pdf(EDGES + contentFor(ONE, kerns));
  for (let it = 0; it < 4; it++) {
    const e = await rt.engineFactory(make());
    try {
      e.loadPage(0);
      const model = e.buildModel().filter((p) => p.lines.length === 4);
      assert.equal(model.length, 1, "synthetic paragraph was not modelled as four lines");
      kerns = kerns.map((ks, n) => ks.map((v, k) => {
        if (k === 3) return v;
        const gaps = ONE[n].lines[k].split(" ").length - 1;
        const drawn = contentFor === matrixContent ? 9.5 : 11;
        return v - ((WIDTH - model[n].lines[k].w) / gaps / (drawn * (k === 1 ? 0.98 : 1))) * 1000;
      }));
    } finally {
      e.close();
    }
  }
  return make();
}

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
      const size = M._FPDFText_GetFontSize(tp, i);
      M._FPDFText_GetMatrix(tp, i, b + 160);
      const matrix = Array.from({ length: 6 }, (_, j) => M.HEAPF32[((b + 160) >> 2) + j]);
      out.push({ ch: String.fromCharCode(u), x: M.HEAPF64[b >> 3], y: M.HEAPF64[(b + 8) >> 3], font, size, matrix });
    }
    M._free(b);
    M._FPDFText_ClosePage(tp);
    return out;
  } finally {
    e.close();
  }
}

const bodyOf = (gs) => gs.filter((g) => g.y < 700 && g.y > 50);
const onLine = (gs, y) => gs.filter((g) => Math.abs(g.y - y) < 1).sort((a, b) => a.x - b.x);
const drawnOf = (g) => g.size * g.matrix[3];
const sig = (gs) => [...gs].sort((a, b) => a.y - b.y || a.x - b.x || a.ch.charCodeAt(0) - b.ch.charCodeAt(0))
  .map((g) => [g.ch, g.x.toFixed(3), g.y.toFixed(3), g.font, g.size.toFixed(3), g.matrix.map((v) => v.toFixed(4)).join(":")].join(","));

function sameLine(src, out, y) {
  const [a, b] = [onLine(src, y), onLine(out, y)];
  assert.ok(a.length > 0, `source line ${y} present`);
  assert.equal(b.length, a.length, `glyph count on ${y}`);
  a.forEach((g, i) => {
    const h = b[i];
    assert.equal(h.ch, g.ch);
    assert.equal(h.font, g.font);
    assert.ok(Math.abs(h.x - g.x) <= 0.02 && Math.abs(h.y - g.y) <= 0.02, `origin ${i} on ${y}`);
    assert.ok(Math.abs(drawnOf(h) - drawnOf(g)) <= 0.02, `drawn size ${i} on ${y}`);
  });
}

// The Emscripten export replaces itself on its first call. Warm that call on
// a real text page, then wrap the initialized function. Prefix handles are
// read at the isolate step, after line-local has restored the page.
function matrixFactory(mode) {
  const seen = { isolates: 0, prefixHandles: 0 };
  const factory = async (bytes) => {
    const e = await rt.engineFactory(bytes);
    const begin = e.historyBeginStep.bind(e);
    const end = e.historyEndStep.bind(e);
    const undo = e.historyUndo.bind(e);
    const state = { lineOpen: 0, failMode: null, armShrink: false, prefix: null, real: null };
    const open = [];
    const load = e.loadPage.bind(e);
    const handlesAt = (y) => {
      const M = e.M;
      const tp = M._FPDFText_LoadPage(e.page);
      const n = tp ? M._FPDFText_CountChars(tp) : 0;
      const buf = M._malloc(16);
      const prefix = new Set();
      for (let i = 0; i < n; i++) {
        if (!M._FPDFText_GetCharOrigin(tp, i, buf, buf + 8)) continue;
        if (Math.abs(M.HEAPF64[(buf + 8) >> 3] - y) >= 1) continue;
        prefix.add(M._FPDFText_GetTextObject(tp, i) >>> 0);
      }
      M._free(buf);
      if (tp) M._FPDFText_ClosePage(tp);
      return prefix;
    };
    e.loadPage = (...args) => {
      const r = load(...args);
      if (!state.real) {
        const M = e.M;
        const tp = M._FPDFText_LoadPage(e.page);
        const n = tp ? M._FPDFText_CountChars(tp) : 0;
        const buf = M._malloc(32);
        let at = -1;
        for (let i = 0; i < n; i++) if (M._FPDFText_GetCharOrigin(tp, i, buf, buf + 8)) { at = i; break; }
        if (at >= 0) M._FPDFText_GetMatrix(tp, at, buf);
        M._free(buf);
        if (tp) M._FPDFText_ClosePage(tp);
        if (at >= 0) {
          state.real = M._FPDFText_GetMatrix.bind(M);
          M._FPDFText_GetMatrix = (tp2, i, b) => {
            const h = M._FPDFText_GetTextObject(tp2, i) >>> 0;
            const lie = state.failMode && (!state.prefix || !state.prefix.has(h));
            if (lie && state.failMode === "zero") return 0;
            const ok = state.real(tp2, i, b);
            if (!ok) return 0;
            if (lie && state.failMode === "nonfinite") M.HEAPF32[(b >> 2) + 3] = Number.NaN;
            else if (lie && state.armShrink) M.HEAPF32[(b >> 2) + 3] *= 0.5;
            return 1;
          };
        }
      }
      return r;
    };
    e.historyBeginStep = (label) => {
      open.push({ label, depth: e.historyDepth().undo });
      if (label === "falsify-prefix-isolate") {
        seen.isolates++;
        state.prefix = handlesAt(500);
        seen.prefixHandles = state.prefix.size;
      }
      if (label === "falsify-inline-edit") {
        state.failMode = null;
        state.armShrink = false;
      }
      return begin(label);
    };
    e.historyEndStep = () => {
      const r = end();
      const p = open.pop();
      if (p?.label.startsWith("falsify-line-") && e.historyDepth().undo > p.depth) state.lineOpen++;
      if (p?.label === "falsify-prefix-suffix" && mode.afterSuffix) {
        state.failMode = mode.afterSuffix;
        state.armShrink = mode.afterSuffix === "shrink";
      }
      return r;
    };
    e.historyUndo = () => {
      state.failMode = null;
      state.armShrink = false;
      const ok = undo();
      if (state.lineOpen > 0) {
        state.lineOpen--;
        if (state.lineOpen === 0 && mode.afterLineLocal) state.failMode = mode.afterLineLocal;
      }
      return ok;
    };
    return e;
  };
  factory.seen = seen;
  return factory;
}

const plainFactory = async (bytes) => {
  const e = await rt.engineFactory(bytes);
  e.historyNoteMatrix = undefined;
  return e;
};

async function expectFallback(src, mode, reason, { reflow, isolates }) {
  const factory = matrixFactory(mode);
  const edits = OVERFLOW;
  const { pdf: out, report } = await editPdf({ sourceBytes: src, edits, reflow }, { engineFactory: factory, runtimeInfo: rt.info });
  assert.equal(report.ok, true, JSON.stringify(report.selfCheck));
  assert.ok(out instanceof Uint8Array);
  const row = report.pages[0].paragraphs[0];
  assert.equal(row.lineLocal?.status, "declined", JSON.stringify(row.lineLocal ?? row.lineRetention));
  assert.equal(row.lineLocal?.reason, reason);
  assert.equal(factory.seen.isolates, isolates);
  if (isolates > 0) assert.ok(factory.seen.prefixHandles > 0, "prefix handles were not snapshotted");
  const plain = await editPdf({ sourceBytes: src, edits, reflow }, { engineFactory: plainFactory, runtimeInfo: rt.info });
  assert.equal(plain.report.ok, true, JSON.stringify(plain.report.selfCheck));
  assert.equal(row.surgical, plain.report.pages[0].paragraphs[0].surgical);
  const [a, b] = [await glyphsOf(plain.pdf), await glyphsOf(out)];
  assert.deepEqual(sig(b), sig(a));
}

test("Tf 1 with Tm 9.5 keeps the prefix and the 9.5pt drawn size", { skip }, async () => {
  const src = await fitPdf(matrixContent);
  const source = await glyphsOf(src);
  const body = bodyOf(source);
  assert.ok(body.length > 0);
  assert.ok(body.every((g) => Math.abs(g.size - 1) <= 0.01), `source Tf ${body[0].size}`);
  assert.ok(body.every((g) => Math.abs(g.matrix[3] - 9.5) <= 0.02), `source matrix d ${body[0].matrix[3]}`);
  const { pdf: out, report } = await editPdf({ sourceBytes: src, edits: OVERFLOW, reflow: true }, { engineFactory: rt.engineFactory, runtimeInfo: rt.info });
  assert.equal(report.ok, true, JSON.stringify(report.selfCheck?.failures));
  const row = report.pages[0].paragraphs[0];
  assert.equal(row.lineRetention?.prefixKept, 1);
  assert.equal(row.lineRetention?.suffixReflow, true);
  assert.equal(row.lineLocal, undefined);
  const got = await glyphsOf(out);
  sameLine(source, got, 500);
  const drawn = bodyOf(got).map(drawnOf);
  assert.ok(drawn.length > 0);
  assert.ok(drawn.every((v) => Math.abs(v - 9.5) <= 0.02), JSON.stringify(drawn.slice(0, 8)));
});

test("a real physical shrink declines and matches the plain re-layout", { skip }, async () => {
  const src = await fitPdf(justifiedContent);
  await expectFallback(src, { afterSuffix: "shrink" }, "suffix_font_changed", { reflow: true, isolates: 1 });
});

test("a missing glyph matrix declines before the prefix moves and matches the plain re-layout", { skip }, async () => {
  const src = await fitPdf(justifiedContent);
  await expectFallback(src, { afterLineLocal: "zero" }, "suffix_matrix_unavailable", { reflow: true, isolates: 0 });
});

test("a nonfinite glyph matrix declines before the prefix moves and matches the plain re-layout", { skip }, async () => {
  const src = await fitPdf(justifiedContent);
  await expectFallback(src, { afterLineLocal: "nonfinite" }, "suffix_matrix_unavailable", { reflow: true, isolates: 0 });
});

test("a matrix failure after the suffix commit rolls back to the plain re-layout", { skip }, async () => {
  const src = await fitPdf(justifiedContent);
  await expectFallback(src, { afterSuffix: "zero" }, "suffix_matrix_unavailable", { reflow: true, isolates: 1 });
  await expectFallback(src, { afterSuffix: "zero" }, "suffix_matrix_unavailable", { reflow: false, isolates: 1 });
});

const P2 = ["Zinc wire and copper tape were laid on the table", "Two small lamps glowed while the old clock ticked", "Nobody moved the box until the bell rang twice", "Then quiet."];
const LONG = "green bolt plus several extra words about the shelf";

async function fitParas(paras) {
  let kerns = paras.map(({ lines }) => lines.map(() => -278));
  const make = () => pdf(EDGES + justifiedContent(paras, kerns));
  for (let it = 0; it < 4; it++) {
    const e = await rt.engineFactory(make());
    try {
      e.loadPage(0);
      const model = e.buildModel().filter((p) => p.lines.length === 4);
      assert.equal(model.length, paras.length);
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

for (const reflow of [false, true]) {
  test(`a declined prefix commit then another paragraph reflow=${reflow}`, { skip }, async () => {
    const src = await fitParas([{ y: 560, lines: P1 }, { y: 440, lines: P2 }]);
    let force = false;
    let did = false;
    const factory = async (bytes) => {
      const e = await rt.engineFactory(bytes);
      const begin = e.historyBeginStep.bind(e);
      const commit = e.commitParagraph.bind(e);
      e.historyBeginStep = (label) => {
        if (label === "falsify-prefix-suffix" && !did) force = true;
        return begin(label);
      };
      e.commitParagraph = (id, runs, fmt) => {
        if (force) { force = false; did = true; return null; }
        return commit(id, runs, fmt);
      };
      return e;
    };
    const edits = [
      { id: "a", pageIndex: 0, before: "green bolt", after: LONG },
      { id: "b", pageIndex: 0, before: "small lamps", after: "tiny lamps" },
    ];
    const { pdf: out, report } = await editPdf({ sourceBytes: src, edits, reflow }, { engineFactory: factory, runtimeInfo: rt.info });
    assert.equal(did, true);
    assert.equal(report.ok, true, JSON.stringify(report.selfCheck?.failures ?? report));
    assert.equal(report.pages[0].paragraphs[0].lineLocal?.reason, "suffix_commit_failed");
    const text = (await glyphsOf(out)).map((g) => g.ch).join("");
    assert.ok(text.includes("tinylamps"), text);
    assert.ok(text.includes(LONG.replace(/ /g, "")), text);
  });
}

for (const reflow of [false, true]) {
  test(`root: prior paragraph edit then declined prefix reflow=${reflow}`, { skip }, async () => {
    const src = await fitParas([{ y: 560, lines: P1 }, { y: 440, lines: P2 }]);
    let force = false;
    let did = false;
    const factory = async (bytes) => {
      const e = await rt.engineFactory(bytes);
      const begin = e.historyBeginStep.bind(e);
      const commit = e.commitParagraph.bind(e);
      e.historyBeginStep = (label) => {
        if (label === "falsify-prefix-suffix" && !did) force = true;
        return begin(label);
      };
      e.commitParagraph = (id, runs, fmt) => {
        if (force) { force = false; did = true; return null; }
        return commit(id, runs, fmt);
      };
      return e;
    };
    const after = "lamps glowed and then dimmed for a long while";
    const edits = [
      { id: "a", pageIndex: 0, before: "green bolt", after: "grey bolt" },
      { id: "b", pageIndex: 0, before: "lamps glowed", after },
    ];
    const { pdf: out, report } = await editPdf({ sourceBytes: src, edits, reflow }, { engineFactory: factory, runtimeInfo: rt.info });
    assert.equal(did, true);
    assert.equal(report.ok, true, JSON.stringify(report.selfCheck?.failures ?? report));
    assert.equal(report.pages[0].paragraphs[1].lineLocal?.reason, "suffix_commit_failed");
    const text = (await glyphsOf(out)).map((g) => g.ch).join("");
    assert.ok(text.includes("greybolt"), text);
    assert.ok(text.includes(after.replace(/ /g, "")), text);
  });
}
