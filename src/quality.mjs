// Layout and reading-order quality layer for the editor module.
//
// Shared contract with the core editor:
//   capturePageLayout(engine, pageIndex, paragraphs) => context
//   repairPageLayout(engine, pageIndex, context, touched) => { repairs, warnings }
//   inspectSavedPdf(engineFactory, sourceBytes, outputBytes, edits) => report
//
// Object handles are compared as integers only. A handle captured before a
// commit is never passed back to PDFium; only handles enumerated from the
// current page (or returned by paragraphObjects on the current page) are.
// inspectSavedPdf uses the same PDFium build as the editor, so it is a
// self-check, not an independent or rendering-based release check.

const TOL = 1;
const EDGE_BAND = 0.1;
const OBJ_TEXT = 1;

const normStr = (s) => String(s).replace(/\s+/g, " ").trim();
const paraText = (p) => (p.runs || []).map((r) => r.text || "").join("");
const bottomOf = (b) => b.top - b.h;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

function ensurePage(engine, pageIndex) {
  if (!engine.page || engine.pageIndex !== pageIndex) engine.loadPage(pageIndex);
}

function listObjects(engine) {
  const M = engine.M;
  const n = M._FPDFPage_CountObjects(engine.page);
  const out = [];
  for (let i = 0; i < n; i++) out.push(M._FPDFPage_GetObject(engine.page, i) >>> 0);
  return out;
}

function unionBounds(engine, handles) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const h of handles) {
    const b = engine.objectBounds(h);
    if (!b) continue;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  if (!(x1 > x0)) return null;
  return { x: x0, top: y1, w: x1 - x0, h: y1 - y0 };
}

function hOverlap(a, b) {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
}

// Header/footer classification from the page itself. Only short paragraphs
// fully inside the top/bottom band are edge content; numeric ones are
// treated as page numbers, the rest as uncertain running headers/footers.
// Both are fixed: repair never moves them.
function classify(p, pageH, edgeBottomY) {
  if (!p.box) return "unknown";
  const text = normStr(paraText(p));
  const short = text.length <= 60 && text.split(" ").length <= 8 && (p.lines?.length || 1) <= 2;
  const inTop = bottomOf(p.box) >= edgeBottomY + pageH * (1 - EDGE_BAND);
  const inBottom = p.box.top <= edgeBottomY + pageH * EDGE_BAND;
  if (!short || !(inTop || inBottom)) return "body";
  if (/^[\s\-–—|/.()]*(\d+|[ivxlcdm]+)([\s\-–—|/.()]*(\d+|of))*[\s\-–—|/.()]*$/i.test(text)) return "page_number";
  return inTop ? "header_uncertain" : "footer_uncertain";
}

export function capturePageLayout(engine, pageIndex, paragraphs) {
  ensurePage(engine, pageIndex);
  const pageW = engine.pageWidth, pageH = engine.pageHeight;
  const objects = listObjects(engine);
  const M = engine.M;
  const types = objects.map((h) => M._FPDFPageObj_GetType(h));
  const indexOf = new Map(objects.map((h, i) => [h, i]));
  const boxes = (paragraphs || []).filter((p) => p.box).map((p) => p.box);
  const edgeBottomY = boxes.length ? Math.min(0, ...boxes.map(bottomOf)) : 0;
  const paras = (paragraphs || []).map((p) => {
    const handles = (engine.paragraphObjects(p.id) || []).map((h) => h >>> 0);
    const slots = handles.map((h) => indexOf.get(h)).filter((i) => i !== undefined).sort((a, b) => a - b);
    const baselines = (p.lines || []).map((l) => l.y).filter(Number.isFinite);
    const size = median((p.runs || []).map((r) => r.size).filter((s) => s > 0));
    return {
      id: p.id,
      role: classify(p, pageH, edgeBottomY),
      editable: !!p.editable,
      sharesObjects: !!p.sharesObjects,
      box: p.box ? { ...p.box } : null,
      baselines,
      size,
      handles,
      slots,
      topLevel: slots.length === handles.length,
    };
  });
  return { pageIndex, pageW, pageH, objects, types, paras };
}

function columnOf(ctx, box) {
  let right = box.x + box.w;
  for (const q of ctx.paras) {
    if (q.role !== "body" || !q.box) continue;
    if (hOverlap(q.box, box) < 0.35 * Math.min(box.w, q.box.w)) continue;
    right = Math.max(right, q.box.x + q.box.w);
  }
  return { left: box.x, right };
}

// Source line pitch: from the paragraph's own lines when it had several,
// otherwise from consistent baseline gaps of neighbouring body lines in the
// same column. Returns null when no consistent pitch exists.
function inferPitch(ctx, t, info) {
  const own = (t.sourceLines || info?.baselines || []).map((l) => (typeof l === "number" ? l : l?.y)).filter(Number.isFinite);
  const gaps = [];
  for (let i = 1; i < own.length; i++) gaps.push(own[i - 1] - own[i]);
  if (gaps.length) {
    const m = median(gaps);
    if (m > 0 && gaps.every((g) => Math.abs(g - m) <= 0.05 * m)) return { pitch: m, from: "source_lines" };
    return null;
  }
  const col = ctx.paras
    .filter((q) => q.role === "body" && q.box && q.baselines.length && hOverlap(q.box, t.sourceBox) >= 0.35 * Math.min(q.box.w, t.sourceBox.w))
    .flatMap((q) => q.baselines)
    .sort((a, b) => b - a);
  const size = info?.size || 0;
  const near = [];
  for (let i = 1; i < col.length; i++) {
    const g = col[i - 1] - col[i];
    if (g > 0.5 && (!size || g < 2.6 * size)) near.push(g);
  }
  if (near.length < 2) return null;
  const m = median(near);
  const agree = near.filter((g) => Math.abs(g - m) <= 0.05 * m).length;
  return agree >= Math.max(2, 0.6 * near.length) ? { pitch: m, from: "neighbour_lines" } : null;
}

// Move each re-laid-out line so the baseline pitch matches the source.
function restorePitch(engine, id, rz, pitch) {
  const lines = (rz.lines || []).map((l) => l.y);
  if (lines.length < 2) return { ok: true, dyLast: 0, moved: 0 };
  const cur = median(lines.slice(1).map((y, i) => lines[i] - y));
  if (Math.abs(cur - pitch) <= 0.25) return { ok: true, dyLast: 0, moved: 0 };
  const handles = (engine.paragraphObjects(id) || []).map((h) => h >>> 0);
  const groups = lines.map(() => []);
  for (const h of handles) {
    const b = engine.objectBounds(h);
    if (!b) return { ok: false, reason: "object_without_bounds" };
    const hits = lines.map((y, k) => (y >= b.y - 0.5 && y <= b.y + b.h + 0.5 ? k : -1)).filter((k) => k >= 0);
    if (hits.length !== 1) return { ok: false, reason: "object_line_ambiguous" };
    groups[hits[0]].push(h);
  }
  let moved = 0;
  for (let k = 1; k < lines.length; k++) {
    const dy = lines[0] - k * pitch - lines[k];
    if (Math.abs(dy) < 0.01) continue;
    for (const h of groups[k]) {
      engine.translateObject(h, 0, dy);
      moved++;
    }
  }
  const last = lines.length - 1;
  return { ok: true, dyLast: lines[0] - last * pitch - lines[last], moved };
}

export function repairPageLayout(engine, pageIndex, context, touched) {
  const repairs = [];
  const warnings = [];
  if (!context || context.pageIndex !== pageIndex) {
    warnings.push({ code: "context_mismatch", pageIndex, severity: "error" });
    return { repairs, warnings };
  }
  ensurePage(engine, pageIndex);
  const byId = new Map(context.paras.map((q) => [q.id, q]));
  const grown = [];

  const order = [...(touched || [])].filter((t) => t?.sourceBox).sort((a, b) => b.sourceBox.top - a.sourceBox.top);
  for (const t of order) {
    const info = byId.get(t.id);
    const rec = { kind: "paragraph", id: t.id, action: "kept" };
    repairs.push(rec);
    if (info && info.role !== "body") {
      warnings.push({ code: "edited_edge_paragraph", id: t.id, role: info.role, severity: "warning" });
      continue;
    }
    const cur = unionBounds(engine, (engine.paragraphObjects(t.id) || []).map((h) => h >>> 0));
    if (!cur) {
      warnings.push({ code: "paragraph_objects_unavailable", id: t.id, severity: "error" });
      continue;
    }
    const col = columnOf(context, t.sourceBox);
    const widened = cur.x + cur.w > col.right + TOL || cur.x < t.sourceBox.x - TOL || cur.x + cur.w > context.pageW;
    if (!widened) {
      // Surgical result stays inside its source column: keep it untouched.
      rec.action = "kept_surgical";
      continue;
    }
    const colW = col.right - t.sourceBox.x;
    const width = t.sourceBox.w >= 0.85 * colW ? t.sourceBox.w : colW;
    const rz = engine.resizeParagraph(t.id, width);
    if (!rz || !rz.box) {
      warnings.push({ code: "resize_failed", id: t.id, severity: "error" });
      continue;
    }
    rec.action = "resized";
    rec.width = +width.toFixed(2);
    rec.lines = rz.lines?.length || 0;
    let bottom = bottomOf(rz.box);
    const pitch = inferPitch(context, t, info);
    if (pitch && rec.lines > 1) {
      const r = restorePitch(engine, t.id, rz, pitch.pitch);
      if (r.ok) {
        rec.pitch = { value: +pitch.pitch.toFixed(2), from: pitch.from, objects_moved: r.moved };
        bottom += r.dyLast;
        if (r.moved) warnings.push({ code: "engine_model_lines_stale", id: t.id, severity: "info" });
      } else {
        warnings.push({ code: "line_pitch_not_restored", id: t.id, reason: r.reason, severity: "warning" });
      }
    } else if (rec.lines > 1) {
      warnings.push({ code: "line_pitch_unknown", id: t.id, severity: "warning" });
    }
    const delta = bottomOf(t.sourceBox) - bottom;
    if (delta > 0.5) grown.push({ id: t.id, box: t.sourceBox, delta });
  }

  if (grown.length) cascade(engine, context, grown, new Set(order.map((t) => t.id)), repairs, warnings);
  restoreSourceOrder(engine, context, repairs, warnings);
  return { repairs, warnings };
}

// Shift following body paragraphs of the same column by the growth above
// them. Edge paragraphs (headers, footers, page numbers) never move. If the
// shift would push body text into the footer zone, nothing is moved and the
// overflow is reported: pagination is not supported.
function cascade(engine, ctx, grown, touchedIds, repairs, warnings) {
  const edgeTops = ctx.paras.filter((q) => q.box && q.role !== "body" && q.box.top < ctx.pageH / 2).map((q) => q.box.top);
  const bodyBottoms = ctx.paras.filter((q) => q.box && q.role === "body").map((q) => bottomOf(q.box));
  const floor = edgeTops.length ? Math.max(...edgeTops) + 2 : Math.min(...bodyBottoms, Infinity);
  const plan = new Map();
  for (const g of grown) {
    for (const q of ctx.paras) {
      if (!q.box || q.id === g.id || q.role !== "body" || !q.editable) continue;
      if (q.box.top > bottomOf(g.box) + 0.5) continue;
      if (hOverlap(q.box, g.box) < 0.35 * Math.min(g.box.w, q.box.w)) continue;
      plan.set(q.id, (plan.get(q.id) || 0) + g.delta);
    }
  }
  const violations = [];
  for (const [id, dy] of plan) {
    const q = ctx.paras.find((p) => p.id === id);
    if (bottomOf(q.box) - dy < floor - 0.01) violations.push(id);
  }
  // Growth of the last paragraph itself must also fit.
  for (const g of grown) if (bottomOf(g.box) - g.delta < floor - 0.01) violations.push(g.id);
  if (violations.length) {
    warnings.push({ code: "pagination_unsupported", severity: "error", paragraphs: violations, floor: +floor.toFixed(2) });
    repairs.push({ kind: "cascade", action: "skipped_no_room", moved: 0 });
    return;
  }
  let moved = 0;
  for (const [id, dy] of plan) {
    if (!engine.moveParagraph(id, 0, -dy)) {
      warnings.push({ code: "move_failed", id, severity: "error" });
      continue;
    }
    if (touchedIds.has(id)) warnings.push({ code: "moved_edited_paragraph", id, severity: "info" });
    moved++;
  }
  repairs.push({ kind: "cascade", action: "shifted", moved, floor: +floor.toFixed(2) });
}

// Put every paragraph whose objects were replaced back into the source
// object slot of that paragraph. Unrelated objects keep their relative
// order. Anything that cannot be mapped unambiguously is reported and the
// page order is left as the engine produced it.
//
// Limitation: PDFium's content generator writes objects that have no source
// content stream (every object created by a re-layout) into a new stream
// appended after the existing ones, whatever their object index. The index
// order fixes draw order inside a stream only, so a replaced paragraph that
// is followed by surviving source objects is still serialized last. That
// case is reported as an error instead of being labelled restored.
export function restoreSourceOrder(engine, ctx, repairs, warnings) {
  const M = engine.M;
  const current = listObjects(engine);
  const present = new Set(current);
  const ownerOfSource = new Map();
  for (const q of ctx.paras) for (const h of q.handles) ownerOfSource.set(h, q.id);

  const changed = [];
  const claimed = new Map();
  const fail = (code, extra) => {
    warnings.push({ code, severity: "warning", ...extra });
    repairs.push({ kind: "reading_order", action: "skipped", reason: code });
  };
  for (const q of ctx.paras) {
    const now = (engine.paragraphObjects(q.id) || []).map((h) => h >>> 0);
    for (const h of now) {
      if (claimed.has(h) && claimed.get(h) !== q.id) return fail("object_shared_between_paragraphs", { id: q.id });
      claimed.set(h, q.id);
    }
    const same = now.length === q.handles.length && now.every((h, i) => h === q.handles[i]);
    if (same) continue;
    if (!q.topLevel || now.some((h) => !present.has(h))) return fail("paragraph_not_top_level", { id: q.id });
    if (q.sharesObjects) return fail("paragraph_shares_objects", { id: q.id });
    if (!q.slots.length) return fail("paragraph_without_source_slot", { id: q.id });
    const lo = q.slots[0], hi = q.slots[q.slots.length - 1];
    for (let i = lo; i <= hi; i++) {
      if (ownerOfSource.get(ctx.objects[i]) !== q.id) return fail("interleaved_source_slot", { id: q.id });
    }
    for (const h of now) {
      const o = ownerOfSource.get(h);
      if (o !== undefined && o !== q.id) return fail("handle_identity_reused", { id: q.id });
      if (o === undefined && ctx.objects.includes(h)) return fail("handle_identity_reused", { id: q.id });
    }
    changed.push({ id: q.id, first: ctx.objects[lo], now });
  }
  if (!changed.length) {
    repairs.push({ kind: "reading_order", action: "unchanged", moved: 0 });
    return;
  }
  const changedIds = new Set(changed.map((c) => c.id));
  const firstSlot = new Map(changed.map((c) => [c.first, c]));
  const desired = [];
  for (const h of ctx.objects) {
    const c = firstSlot.get(h);
    if (c) {
      const pos = new Map(current.map((x, i) => [x, i]));
      desired.push(...[...c.now].sort((a, b) => pos.get(a) - pos.get(b)));
      continue;
    }
    if (changedIds.has(ownerOfSource.get(h))) continue;
    if (!present.has(h)) continue;
    if (claimed.has(h) && changedIds.has(claimed.get(h))) continue;
    desired.push(h);
  }
  const desiredSet = new Set(desired);
  const unmapped = current.filter((h) => !desiredSet.has(h));
  if (unmapped.length || desired.length !== current.length) {
    return fail("unmapped_new_objects", { count: unmapped.length });
  }
  const lost = ctx.objects.filter((h) => !present.has(h) && !changedIds.has(ownerOfSource.get(h)));
  if (lost.length) return fail("unrelated_object_missing", { count: lost.length });

  const typesBefore = current.filter((h) => !claimedText(M, h)).map((h) => h);
  const work = [...current];
  let moves = 0;
  for (let i = 0; i < desired.length; i++) {
    if (work[i] === desired[i]) continue;
    const j = work.indexOf(desired[i], i + 1);
    const h = desired[i];
    if (j < 0 || !M._FPDFPage_RemoveObject(engine.page, h)) {
      warnings.push({ code: "reorder_remove_failed", severity: "error" });
      break;
    }
    work.splice(j, 1);
    if (!M._FPDFPage_InsertObjectAtIndex(engine.page, h, i)) {
      // Keep ownership with the page even if the indexed insert fails.
      M._FPDFPage_InsertObject(engine.page, h);
      work.push(h);
      warnings.push({ code: "reorder_insert_failed", severity: "error" });
      break;
    }
    work.splice(i, 0, h);
    moves++;
  }
  if (moves) engine._pageDirty = true;
  const after = listObjects(engine);
  const nonText = (list) => list.filter((h) => !claimedText(M, h));
  const stackKept = nonText(after).join(",") === typesBefore.join(",");
  const exact = after.length === desired.length && after.every((h, i) => h === desired[i]);
  if (!exact) warnings.push({ code: "reading_order_not_exact", severity: "error" });
  if (!stackKept) warnings.push({ code: "nontext_order_changed", severity: "error" });
  const appended = changed.filter((c) => {
    const last = Math.max(...ctx.paras.find((q) => q.id === c.id).slots);
    return ctx.objects.slice(last + 1).some((h) => present.has(h) && !changedIds.has(ownerOfSource.get(h)));
  });
  if (appended.length) {
    warnings.push({ code: "content_stream_append_order", severity: "error", paragraphs: appended.map((c) => c.id) });
  }
  repairs.push({
    kind: "reading_order",
    action: appended.length ? "index_only_stream_order_unresolved" : moves ? "restored" : "unchanged",
    moved: moves,
    paragraphs: changed.map((c) => c.id),
  });
}

function claimedText(M, h) {
  return M._FPDFPageObj_GetType(h) === OBJ_TEXT;
}

// ---------- saved-PDF self-check ----------

function readGlyphs(engine, pageIndex) {
  ensurePage(engine, pageIndex);
  const M = engine.M;
  const tp = M._FPDFText_LoadPage(engine.page);
  const n = tp ? M._FPDFText_CountChars(tp) : 0;
  const b = M._malloc(32);
  let text = "";
  const glyphs = [];
  for (let i = 0; i < n; i++) {
    const u = M._FPDFText_GetUnicode(tp, i);
    text += String.fromCharCode(u);
    if (u <= 32) continue;
    if (!M._FPDFText_GetCharBox(tp, i, b, b + 8, b + 16, b + 24)) continue;
    const l = M.HEAPF64[b >> 3], r = M.HEAPF64[(b + 8) >> 3];
    const bo = M.HEAPF64[(b + 16) >> 3], t = M.HEAPF64[(b + 24) >> 3];
    glyphs.push({ u, l, r, b: bo, t });
  }
  M._free(b);
  if (tp) M._FPDFText_ClosePage(tp);
  return { text, glyphs, W: M._FPDF_GetPageWidthF(engine.page), H: M._FPDF_GetPageHeightF(engine.page) };
}

function offPage(g) {
  return g.glyphs.filter((c) => c.r > g.W + 0.5 || c.l < -0.5 || c.b < -0.5 || c.t > g.H + 0.5).length;
}

function overlaps(g) {
  const cell = 12;
  const grid = new Map();
  let count = 0;
  g.glyphs.forEach((c, i) => {
    const area = Math.max(0.01, (c.r - c.l) * (c.t - c.b));
    const seen = new Set();
    for (let x = Math.floor(c.l / cell); x <= Math.floor(c.r / cell); x++) {
      for (let y = Math.floor(c.b / cell); y <= Math.floor(c.t / cell); y++) {
        const key = x + ":" + y;
        for (const j of grid.get(key) || []) {
          if (seen.has(j)) continue;
          seen.add(j);
          const d = g.glyphs[j];
          const iw = Math.min(c.r, d.r) - Math.max(c.l, d.l);
          const ih = Math.min(c.t, d.t) - Math.max(c.b, d.b);
          if (iw <= 0 || ih <= 0) continue;
          const other = Math.max(0.01, (d.r - d.l) * (d.t - d.b));
          if (iw * ih > 0.3 * Math.min(area, other)) count++;
        }
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(i);
      }
    }
  });
  return count;
}

function edgeGlyphs(g) {
  if (!g.glyphs.length) return [];
  const lo = Math.min(...g.glyphs.map((c) => c.b));
  const hi = Math.max(...g.glyphs.map((c) => c.t));
  const band = EDGE_BAND * g.H;
  return g.glyphs.filter((c) => {
    const cy = (c.b + c.t) / 2;
    return cy <= lo + band || cy >= hi - band;
  });
}

function extents(g) {
  if (!g.glyphs.length) return null;
  return { left: Math.min(...g.glyphs.map((c) => c.l)), right: Math.max(...g.glyphs.map((c) => c.r)) };
}

// Apply each edit once to the whitespace-normalized source page text.
export function expectedPageText(sourceText, pageEdits) {
  const norm = normStr(sourceText);
  const spans = [];
  for (const e of pageEdits) {
    const needle = normStr(e.before);
    const k = needle ? norm.indexOf(needle) : -1;
    if (k < 0 || norm.indexOf(needle, k + 1) >= 0) return { ok: false, id: e.id, reason: k < 0 ? "before_not_found" : "before_ambiguous" };
    spans.push({ a: k, b: k + needle.length, after: normStr(e.after), id: e.id });
  }
  spans.sort((x, y) => x.a - y.a);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].a < spans[i - 1].b) return { ok: false, id: spans[i].id, reason: "edits_overlap" };
  }
  let out = "", at = 0;
  for (const s of spans) {
    out += norm.slice(at, s.a) + s.after;
    at = s.b;
  }
  return { ok: true, text: normStr(out + norm.slice(at)) };
}

export async function inspectSavedPdf(engineFactory, sourceBytes, outputBytes, edits) {
  const failures = [];
  const warnings = [];
  const pages = [];
  const report = { ok: false, independent: false, method: "same-pdfium-text-geometry", failures, warnings, pages };
  let src = null, out = null;
  try {
    src = await engineFactory();
    out = await engineFactory();
    src.open(sourceBytes);
    out.open(outputBytes);
    report.page_count = { source: src.pageCount, output: out.pageCount };
    if (src.pageCount !== out.pageCount) failures.push({ code: "page_count_changed" });
    const byPage = new Map();
    for (const e of edits || []) byPage.set(e.pageIndex, [...(byPage.get(e.pageIndex) || []), e]);
    for (const p of byPage.keys()) {
      if (!(p >= 0 && p < src.pageCount)) failures.push({ code: "edit_page_out_of_range", pageIndex: p });
    }
    const n = Math.min(src.pageCount, out.pageCount);
    for (let i = 0; i < n; i++) {
      const s = readGlyphs(src, i);
      const o = readGlyphs(out, i);
      const pageEdits = byPage.get(i) || [];
      const row = { pageIndex: i, edited: pageEdits.length > 0 };
      pages.push(row);
      if (!pageEdits.length) {
        row.text_equal = normStr(s.text) === normStr(o.text);
        if (!row.text_equal) failures.push({ code: "unedited_page_text_changed", pageIndex: i });
        continue;
      }
      const exp = expectedPageText(s.text, pageEdits);
      if (!exp.ok) {
        failures.push({ code: "expected_text_uncomputable", pageIndex: i, id: exp.id, reason: exp.reason });
      } else {
        row.text_equal = exp.text === normStr(o.text);
        if (!row.text_equal) failures.push({ code: "edited_page_text_or_order_mismatch", pageIndex: i });
        for (const e of pageEdits) {
          const t = normStr(o.text);
          if (normStr(e.after) && !t.includes(normStr(e.after))) failures.push({ code: "after_missing", pageIndex: i, id: e.id });
        }
      }
      row.offpage = { source: offPage(s), output: offPage(o) };
      if (row.offpage.output > row.offpage.source) failures.push({ code: "glyphs_off_page", pageIndex: i, count: row.offpage.output - row.offpage.source });
      row.overlap = { source: overlaps(s), output: overlaps(o) };
      if (row.overlap.output > row.overlap.source) failures.push({ code: "glyph_overlap_increased", pageIndex: i, count: row.overlap.output - row.overlap.source });
      const se = extents(s), oe = extents(o);
      row.extents = { source: se, output: oe };
      if (se && oe && (oe.right > se.right + TOL || oe.left < se.left - TOL)) failures.push({ code: "text_outside_source_columns", pageIndex: i });
      const es = edgeGlyphs(s), eo = edgeGlyphs(o);
      const stable = es.length === eo.length && es.every((c, k) => {
        const d = eo[k];
        return c.u === d.u && Math.abs(c.l - d.l) <= 0.5 && Math.abs(c.b - d.b) <= 0.5;
      });
      row.edge_glyphs = es.length;
      row.edge_stable = stable;
      if (!stable) {
        const edgeText = normStr(String.fromCharCode(...es.map((c) => c.u)));
        const editsEdge = pageEdits.some((e) => edgeText.replace(/ /g, "").includes(normStr(e.before).replace(/ /g, "")));
        if (editsEdge) warnings.push({ code: "edge_edit_unverified", pageIndex: i });
        else failures.push({ code: "header_footer_moved", pageIndex: i });
      }
    }
    report.ok = failures.length === 0;
    warnings.push({ code: "self_check_not_independent", detail: "same PDFium build; independent extraction and rendering review still required" });
  } catch (err) {
    failures.push({ code: "inspection_error", message: String(err?.message || err).slice(0, 200) });
    report.ok = false;
  } finally {
    try { src?.close(); } catch {}
    try { out?.close(); } catch {}
  }
  return report;
}
