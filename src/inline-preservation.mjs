// Source-preserving inline edits.
//
// Two decisions the plain run rebuild left to chance:
// - which characters an edit really changes, and which source run style the
//   replacement inherits (unchanged tokens keep their own run and style);
// - where untouched source lines end up when the engine cannot splice a
//   paragraph and re-lays it out instead (non-surgical commit).
// Neither relaxes matching: the caller has already matched Before exactly
// once; this module only narrows the mutation inside that match.

const WS = /^\s+$/;
const tokens = (s) => s.match(/\s+|\S+/g) || [];
const isWs = (c) => /\s/.test(c.ch);
const nfc = (t) => t.normalize("NFC");
const STYLE_KEYS = ["family", "bold", "italic", "size", "rgba", "underline", "strike", "script", "renderMode", "strokeRgba", "strokeWidth", "hScale", "rise"];

export const runStyleKey = (r) => STYLE_KEYS.map((k) => String(k === "rgba" || k === "strokeRgba" ? (r?.[k] ?? 0) >>> 0 : r?.[k] ?? "")).join("|");

/**
 * Narrows one matched edit to its changed tokens.
 * chars/map: page character index and normalized map; hit: normalized
 * offset of the single match; needle: normalized Before.
 * Returns { del: chars[], inserts: [{ pi, ri, o, text }], warning? } or
 * { failure: "AMBIGUOUS_STYLE" } when no run style can be justified for the
 * replacement. A whitespace token of After equals the source whitespace it
 * faces only when it is a single plain space or the same characters.
 */
export function planInlineChange(paras, chars, map, hit, needle, after) {
  const bt = [];
  let k = 0;
  for (const t of tokens(needle)) {
    bt.push({ t, k0: k, k1: k + t.length });
    k += t.length;
  }
  const at = tokens(after);
  const rawOf = (tok) => chars.slice(map[hit + tok.k0][0], map[hit + tok.k1 - 1][1] + 1);
  const same = (b, a) => (WS.test(b.t) ? WS.test(a) && (a === " " || a === rawOf(b).map((c) => c.ch).join("")) : a === b.t);
  let p = 0;
  while (p < bt.length && p < at.length && same(bt[p], at[p])) p++;
  let s = 0;
  while (s < bt.length - p && s < at.length - p && same(bt[bt.length - 1 - s], at[at.length - 1 - s])) s++;
  const D = bt.slice(p, bt.length - s);
  const X = at.slice(p, at.length - s);
  const text = X.join("");
  const del = D.flatMap(rawOf).filter((c) => c.pi >= 0);
  if (!text) return { del, inserts: [] };
  const style = (c) => runStyleKey(paras[c.pi].runs[c.ri]);
  const place = (c, text, after = false) => ({ pi: c.pi, ri: c.ri, o: c.o + (after ? 1 : 0), text });
  const words = del.filter((c) => !isWs(c));

  if (words.length) {
    const styles = new Set(words.map(style));
    const paraSet = new Set(del.map((c) => c.pi));
    if (paraSet.size > 1) {
      // Paragraph merge: After goes into the last touched paragraph, as before.
      const lastPi = Math.max(...paraSet);
      const anchor = del.find((c) => c.pi === lastPi);
      return { del, inserts: [place(anchor, text)], warning: styles.size > 1 ? "style_inherited_across_paragraphs" : undefined };
    }
    if (styles.size === 1) return { del, inserts: [place(words[0], text)] };
    // Several styles replaced: map word to word when the token shape agrees.
    if (D.length !== X.length) return { failure: "AMBIGUOUS_STYLE" };
    // A changed After word that spells a source word of the match in another
    // style may be that word moved (then bold -> bold then): its position
    // alone justifies neither style.
    const sourceStyles = new Map();
    for (const b of bt) {
      if (WS.test(b.t)) continue;
      const set = sourceStyles.get(nfc(b.t)) ?? new Set();
      for (const c of rawOf(b)) if (c.pi >= 0) set.add(style(c));
      sourceStyles.set(nfc(b.t), set);
    }
    const keep = new Set();
    const inserts = [];
    for (let i = 0; i < D.length; i++) {
      const d = D[i], x = X[i];
      if (WS.test(d.t) !== WS.test(x)) return { failure: "AMBIGUOUS_STYLE" };
      if (WS.test(d.t)) {
        if (!same(d, x)) return { failure: "AMBIGUOUS_STYLE" };
        for (const c of rawOf(d)) keep.add(c);
        continue;
      }
      const w = rawOf(d).filter((c) => c.pi >= 0);
      if (new Set(w.map(style)).size !== 1) return { failure: "AMBIGUOUS_STYLE" };
      if (x === d.t) {
        for (const c of w) keep.add(c);
        continue;
      }
      if ([...(sourceStyles.get(nfc(x)) ?? [])].some((k) => k !== style(w[0]))) return { failure: "AMBIGUOUS_STYLE" };
      inserts.push(place(w[0], x));
    }
    return { del: del.filter((c) => !keep.has(c)), inserts };
  }

  // Pure insertion, or only whitespace replaced: inherit from the
  // neighbouring words inside the match; differing styles are ambiguous.
  const left = bt.slice(0, p).flatMap(rawOf);
  const right = bt.slice(bt.length - s).flatMap(rawOf);
  const leftWord = left.filter((c) => c.pi >= 0 && !isWs(c)).at(-1);
  const rightWord = right.find((c) => c.pi >= 0 && !isWs(c));
  const lk = leftWord && style(leftWord), rk = rightWord && style(rightWord);
  if (lk && rk && lk !== rk) return { failure: "AMBIGUOUS_STYLE" };
  const viaLeft = left.length && left.at(-1).pi >= 0 ? place(left.at(-1), text, true) : null;
  const viaRight = right.length && right[0].pi >= 0 ? place(right[0], text) : null;
  const want = lk || rk;
  if (!want) {
    // No word evidence: inherit from the replaced whitespace run if unique.
    if (del.length && new Set(del.map(style)).size === 1) return { del, inserts: [place(del[0], text)] };
    return { failure: "AMBIGUOUS_STYLE" };
  }
  const ins = [rk ? viaRight : null, lk ? viaLeft : null, viaRight, viaLeft].find((c) => c && style(c) === want);
  return ins ? { del, inserts: [ins] } : { failure: "AMBIGUOUS_STYLE" };
}

// ---------- source line retention ----------

/**
 * Source line plan for one paragraph mutation: the soft line breaks to turn
 * into hard breaks so a re-laid-out paragraph keeps its source lines, and
 * the lines the edit touches. null when the engine model has no line
 * geometry; { reason } when the source lines cannot be kept without
 * changing text (break inside a word, edited break).
 */
export function sourceLinePlan(para, del, inserts) {
  const lines = para.lines || [];
  if (!lines.length || lines.some((l) => !Number.isFinite(l?.y) || !Number.isFinite(l?.x) || !Number.isInteger(l?.off))) return null;
  const runStart = [];
  const flat = [];
  para.runs.forEach((r, ri) => {
    runStart.push(flat.length);
    for (let o = 0; o < r.text.length; o++) flat.push({ ri, o, ch: r.text[o] });
  });
  const starts = lines.map((l) => l.off);
  for (let k = 1; k < starts.length; k++) if (!(starts[k] > starts[k - 1]) || starts[k] > flat.length) return { reason: "line_offsets_invalid" };
  const lineOf = (f) => {
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1] <= f) k++;
    return k;
  };
  const breaks = new Set();
  for (let k = 1; k < starts.length; k++) {
    const c = flat[starts[k] - 1];
    if (c.ch === "\n") continue;
    if (!/\s/.test(c.ch)) return { reason: "break_inside_word" };
    if (del.has(c.ri + ":" + c.o)) return { reason: "edit_crosses_line" };
    breaks.add(c.ri + ":" + c.o);
  }
  const edited = new Set();
  for (const key of del) {
    const [ri, o] = key.split(":").map(Number);
    edited.add(lineOf(runStart[ri] + o));
  }
  for (const ins of inserts) {
    const f = runStart[ins.ri] + ins.o;
    edited.add(lineOf(f));
    if (f > 0) edited.add(lineOf(f - 1));
  }
  return { breaks, edited };
}

const ENGINE_FNS = ["previewParagraph", "historyBeginStep", "historyEndStep", "historyUndo", "paragraphObjects", "objectBounds", "translateObject"];
const TEXT_FNS = ["_FPDFPage_CountObjects", "_FPDFPage_GetObject", "_FPDFText_LoadPage", "_FPDFText_CountChars", "_FPDFText_GetUnicode", "_FPDFText_GetCharOrigin", "_FPDFText_GetTextObject", "_FPDFText_GetFontSize", "_FPDFText_GetFontInfo", "_FPDFText_ClosePage"];

// Whether the engine exposes what line retention needs: undoable commits,
// object geometry and per-glyph text-page reads for the kept-line proof.
export function canRetainLines(engine) {
  return ENGINE_FNS.every((f) => typeof engine?.[f] === "function") && TEXT_FNS.every((f) => typeof engine?.M?.[f] === "function");
}

// Glyph origins, font and size of the given text objects, grouped by the
// nearest of the given baselines and sorted by x.
function lineGlyphs(engine, handles, lines) {
  const M = engine.M;
  const own = new Set(handles.map((h) => h >>> 0));
  const tp = M._FPDFText_LoadPage(engine.page);
  const n = tp ? M._FPDFText_CountChars(tp) : 0;
  const buf = M._malloc(160);
  const out = lines.map(() => []);
  for (let i = 0; i < n; i++) {
    const u = M._FPDFText_GetUnicode(tp, i);
    if (u <= 32 || !own.has(M._FPDFText_GetTextObject(tp, i) >>> 0)) continue;
    if (!M._FPDFText_GetCharOrigin(tp, i, buf, buf + 8)) continue;
    const x = M.HEAPF64[buf >> 3], y = M.HEAPF64[(buf + 8) >> 3];
    const len = M._FPDFText_GetFontInfo(tp, i, buf + 16, 128, buf + 144);
    const font = len > 0 && len <= 128 ? M.UTF8ToString(buf + 16, 128) : null;
    const size = M._FPDFText_GetFontSize(tp, i);
    let k = -1, best = Infinity;
    lines.forEach((l, j) => {
      const d = Math.abs(l.y - y);
      if (d < best) [k, best] = [j, d];
    });
    if (k >= 0 && best <= Math.max(0.5, 0.3 * size)) out[k].push({ u, x, y, font, size });
  }
  M._free(buf);
  if (tp) M._FPDFText_ClosePage(tp);
  for (const g of out) g.sort((a, b) => a.x - b.x);
  return out;
}

// Moves each committed line onto its source baseline; kept lines also onto
// their source x. Returns false when an object cannot be tied to one line.
function alignLines(engine, id, committed, source, edited) {
  const groups = committed.map(() => []);
  for (const h of (engine.paragraphObjects(id) || []).map((x) => x >>> 0)) {
    const b = engine.objectBounds(h);
    if (!b) return false;
    const hits = committed.map((l, k) => (l.y >= b.y - 0.5 && l.y <= b.y + b.h + 0.5 ? k : -1)).filter((k) => k >= 0);
    if (hits.length !== 1) return false;
    groups[hits[0]].push(h);
  }
  committed.forEach((l, k) => {
    const dx = edited.has(k) ? 0 : source[k].x - l.x;
    const dy = source[k].y - l.y;
    if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) return;
    for (const h of groups[k]) engine.translateObject(h, dx, dy);
  });
  return true;
}

export const KEPT_LINE_TOL = 0.02;

// Kept lines must show the same glyphs, fonts and sizes at the source
// origins; edited lines must sit on their source baseline.
function keptLinesMatch(before, after, edited, source) {
  let max = 0;
  for (let k = 0; k < before.length; k++) {
    const a = after[k];
    if (edited.has(k)) {
      if (a.some((g) => Math.abs(g.y - source[k].y) > KEPT_LINE_TOL)) return { ok: false };
      continue;
    }
    const b = before[k];
    if (!b.length || a.length !== b.length) return { ok: false };
    for (let i = 0; i < b.length; i++) {
      const d = Math.max(Math.abs(a[i].x - b[i].x), Math.abs(a[i].y - b[i].y));
      if (a[i].u !== b[i].u || a[i].font !== b[i].font || Math.abs(a[i].size - b[i].size) > 0.01 || d > KEPT_LINE_TOL) return { ok: false };
      max = Math.max(max, d);
    }
  }
  return { ok: true, max };
}

// Page object handles in page order, and the handles of one paragraph: an
// undo must give back exactly these, so paragraph ids and the captured
// layout context stay valid without rebuilding the model.
function objectState(engine, id) {
  const M = engine.M;
  const page = [];
  const n = M._FPDFPage_CountObjects(engine.page);
  for (let i = 0; i < n; i++) page.push(M._FPDFPage_GetObject(engine.page, i) >>> 0);
  return page.join(",") + "|" + (engine.paragraphObjects(id) || []).map((h) => h >>> 0).join(",");
}

export class LineRetentionError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * Commits one paragraph. A surgical engine commit is kept as is. When the
 * engine re-lays the paragraph out instead and the edit fits its source
 * lines, the commit is redone with the source soft breaks as hard breaks
 * (linePlan.lineRuns), every line is moved back onto its source baseline and
 * kept lines are proven glyph for glyph against the source. If any step does
 * not hold, the plain engine re-layout is restored and reported.
 * Returns { upd, lines }: lines is null (nothing to report) or
 * { status: "surgical" | "retained" | "reflowed", reason?, ... }.
 * A reflow keeping the source line count is never reported as
 * line_count_changed: when the edited line alone overflows its source line,
 * the reason is edited_line_overflows.
 * Throws LineRetentionError when the undone state cannot be re-verified.
 */
export function commitRetainingLines(engine, para, runs, linePlan) {
  const source = para.lines || [];
  const sameCount = (u) => (u?.lines?.length ?? -1) === source.length;
  if (!linePlan?.breaks || !canRetainLines(engine)) {
    const upd = engine.commitParagraph(para.id, runs, para.format);
    if (!linePlan || !upd || upd.surgical || !sameCount(upd)) return { upd, lines: null };
    return { upd, lines: { status: "reflowed", reason: linePlan.reason ?? "engine_capability_missing" } };
  }
  const { breaks, edited, lineRuns } = linePlan;
  const step = (id, r) => {
    engine.historyBeginStep("falsify-inline-edit");
    try {
      return engine.commitParagraph(id, r, para.format);
    } finally {
      engine.historyEndStep();
    }
  };
  const state = objectState(engine, para.id);
  const undo = () => {
    if (!engine.historyUndo()) throw new LineRetentionError("undo_failed");
    if (objectState(engine, para.id) !== state) throw new LineRetentionError("state_drift");
    return para.id;
  };
  const fits = breaks.size ? engine.previewParagraph(para.id, lineRuns, para.format)?.lines?.length === source.length : true;
  const before = lineGlyphs(engine, engine.paragraphObjects(para.id) || [], source);
  const upd = step(para.id, runs);
  if (!upd || upd.surgical) return { upd, lines: upd ? { status: "surgical" } : null };
  if (!fits || (!breaks.size && !sameCount(upd))) return { upd, lines: { status: "reflowed", reason: sameCount(upd) ? "edited_line_overflows" : "line_count_changed" } };
  let cur = upd;
  if (breaks.size) {
    cur = step(undo(), lineRuns);
    if (!cur) throw new LineRetentionError("commit_failed");
  }
  let reason = null;
  if (sameCount(cur)) {
    reason = "lines_not_aligned";
    const id = cur.id ?? para.id;
    if (alignLines(engine, id, cur.lines, source, edited)) {
      const proof = keptLinesMatch(before, lineGlyphs(engine, engine.paragraphObjects(id) || [], source), edited, source);
      if (proof.ok) return { upd: cur, lines: { status: "retained", lines: source.length, kept: source.length - edited.size, hardBreaks: breaks.size, maxKeptShift: +proof.max.toFixed(4) } };
      reason = "kept_lines_moved";
    }
  }
  // Restore the plain engine re-layout of the edit.
  const again = step(undo(), runs);
  reason ??= sameCount(again) ? "edited_line_overflows" : "line_count_changed";
  return { upd: again, lines: again ? { status: "reflowed", reason } : null };
}
