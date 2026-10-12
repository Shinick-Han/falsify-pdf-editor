// Continuation pages for long edits on the BentoPDF editcore.
//
// When a reflowed edit no longer fits above the page's footer floor, the
// edited paragraph and the body text that follows it on the same page form
// one flow. The flow is split by its actual line objects into the source
// page (shifted down, as cascade does) and new continuation pages inserted
// directly after the source page in the same document. Line objects are
// moved with FPDFPage_RemoveObject/FPDFPage_InsertObject, so fonts, runs,
// colours and source line pitch are the original objects' own; fonts are
// re-bound by object number into the new page's resources by PDFium's
// content generator.
//
// Scope is deliberately narrow: one top-level single-column body flow on an
// unrotated page with no crop/media offset and no Type3 segments. Anything
// else (multi-column, foreign images/paths or unassignable text inside the
// flow, edge paragraphs inside the flow, shared objects, form-XObject text)
// is reported as an explicit *_unsupported error before anything moves.
// Continuation pages carry only moved body lines: no header, footer, page
// number or label is copied or synthesized, and original page numbers stay
// on their source pages (see docs/PAGINATION.md for the page map contract).

const OBJ_TEXT = 1;
const EPS = 0.01;

export const PAGINATION_LIMITS = Object.freeze({ defaultMaxNewPages: 8, maxNewPages: 32 });

export const PAGINATION_CAPABILITY = Object.freeze({
  supported: true,
  scope: "single-column top-level body text flow below the edited paragraph on unrotated, uncropped pages",
  continuationPages: "same size as the source page, inserted directly after it, body lines only; no copied or synthesized header, footer, page number or label",
  sourcePageNumbers: "unchanged; existing page-number objects stay on their source page",
  downstreamPages: "never modified; only their output index shifts, see report.pagination.sourcePageMap",
  maxNewPagesDefault: PAGINATION_LIMITS.defaultMaxNewPages,
  maxNewPagesLimit: PAGINATION_LIMITS.maxNewPages,
  unsupported: Object.freeze([
    "multi_column_flow",
    "foreign_object_in_flow",
    "edge_paragraph_in_flow",
    "rotated_page",
    "cropped_or_offset_page",
    "type3_segments",
    "non_top_level_text",
    "shared_objects",
  ]),
});

const bottomOf = (b) => b.top - b.h;
const hOverlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
const sameColumn = (a, b) => hOverlap(a, b) >= 0.35 * Math.min(a.w, b.w);

// Groups object boxes ({ top, bottom, order }) into lines by vertical centre
// membership. Zero-height boxes are returned as `loose` for attachment.
export function groupLines(items) {
  const seeds = items.filter((it) => it.top - it.bottom > EPS).sort((a, b) => b.top - a.top || a.order - b.order);
  const lines = [];
  for (const it of seeds) {
    const cy = (it.top + it.bottom) / 2;
    const l = lines[lines.length - 1];
    const lc = l ? (l.top + l.bottom) / 2 : 0;
    if (l && ((cy <= l.top + EPS && cy >= l.bottom - EPS) || (lc <= it.top + EPS && lc >= it.bottom - EPS))) {
      l.items.push(it);
      l.top = Math.max(l.top, it.top);
      l.bottom = Math.min(l.bottom, it.bottom);
    } else {
      lines.push({ top: it.top, bottom: it.bottom, items: [it] });
    }
  }
  return { lines, loose: items.filter((it) => !(it.top - it.bottom > EPS)) };
}

// Splits ordered flow lines (virtual positions after the in-page shift)
// into the source page (index 0) and continuation pages. Each continuation
// page starts with its first line's top at bodyTop. Pure and bounded: every
// page takes at least one line and at most maxNewPages pages are added.
export function planFlow(lines, { bodyTop, floor, maxNewPages }) {
  if (!(bodyTop > floor)) return { ok: false, code: "pagination_body_band_invalid" };
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i];
    if (!((b.top + b.bottom) / 2 < (a.top + a.bottom) / 2 && b.top <= a.top + EPS)) return { ok: false, code: "pagination_flow_not_monotonic", line: i };
  }
  const pages = [{ offset: 0, lines: [] }];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const page = pages[pages.length - 1];
    if (l.bottom + page.offset >= floor - EPS) {
      page.lines.push(i);
      continue;
    }
    const offset = bodyTop - l.top;
    if (l.bottom + offset < floor - EPS) return { ok: false, code: "pagination_line_exceeds_body", line: i };
    if (pages.length - 1 >= maxNewPages) return { ok: false, code: "pagination_budget_exceeded", maxNewPages };
    pages.push({ offset, lines: [i] });
  }
  return { ok: true, pages };
}

function listObjects(M, page) {
  const n = M._FPDFPage_CountObjects(page);
  const out = [];
  for (let i = 0; i < n; i++) out.push(M._FPDFPage_GetObject(page, i) >>> 0);
  return out;
}

function readBox(M, page, fn) {
  const p = M._malloc(16);
  try {
    if (!M[fn](page, p, p + 4, p + 8, p + 12)) return null;
    return [0, 1, 2, 3].map((k) => M.HEAPF32[(p >> 2) + k]);
  } finally {
    M._free(p);
  }
}

// Rejects page geometry this module does not model. Returns a code or null.
export function unsupportedPage(engine) {
  const M = engine.M;
  if (engine._t3seg && Object.keys(engine._t3seg).length) return "pagination_unsupported_type3_segments";
  if (typeof M._FPDFPage_GetRotation === "function" && M._FPDFPage_GetRotation(engine.page) !== 0) return "pagination_unsupported_rotated_page";
  const t = engine.pageT || [1, 0, 0, 1, 0, 0];
  if ([1, 0, 0, 1, 0, 0].some((v, i) => Math.abs(t[i] - v) > 1e-4)) return "pagination_unsupported_cropped_or_offset_page";
  const media = typeof M._FPDFPage_GetMediaBox === "function" ? readBox(M, engine.page, "_FPDFPage_GetMediaBox") : null;
  if (media && (Math.abs(media[0]) > 1e-3 || Math.abs(media[1]) > 1e-3)) return "pagination_unsupported_cropped_or_offset_page";
  const crop = typeof M._FPDFPage_GetCropBox === "function" ? readBox(M, engine.page, "_FPDFPage_GetCropBox") : null;
  if (crop && media && crop.some((v, i) => Math.abs(v - media[i]) > 1e-3)) return "pagination_unsupported_cropped_or_offset_page";
  return null;
}

// Builds the flow plan without mutating anything. ctx comes from
// capturePageLayout (pre-commit); grown carries { id, box, delta } for each
// edited paragraph that grew. floor is the cascade's body floor.
export function buildFlowPlan(engine, ctx, grown, { floor, maxNewPages }) {
  const M = engine.M;
  const err = (code, extra = {}) => ({ ok: false, code, ...extra });
  const bad = unsupportedPage(engine);
  if (bad) return err(bad);
  const grownIds = new Set(grown.map((g) => g.id));
  const flowTop = Math.max(...grown.map((g) => g.box.top));
  const anchor = grown.find((g) => g.box.top === flowTop).box;
  const objects = listObjects(M, engine.page);
  const indexOf = new Map(objects.map((h, i) => [h, i]));
  const bounds = (h) => {
    const b = engine.objectBounds(h);
    return b ? { top: b.y + b.h, bottom: b.y, x: b.x, w: b.w } : null;
  };

  const owner = new Map();
  const current = new Map();
  for (const q of ctx.paras) {
    const hs = (engine.paragraphObjects(q.id) || []).map((h) => h >>> 0);
    current.set(q.id, hs);
    for (const h of hs) {
      if (owner.has(h) && owner.get(h) !== q.id) return err("pagination_unsupported_shared_objects");
      owner.set(h, q.id);
    }
  }

  const flow = [];
  for (const q of ctx.paras) {
    if (!q.box) continue;
    const cy = q.box.top - q.box.h / 2;
    const below = q.box.top <= flowTop + 0.5;
    if (q.role !== "body") {
      if (cy > floor + EPS && cy < flowTop && below) return err("pagination_unsupported_edge_paragraph_in_flow");
      continue;
    }
    if (!below) continue;
    if (!sameColumn(q.box, anchor)) return err("pagination_unsupported_multi_column_flow");
    if (!q.editable || q.sharesObjects) return err("pagination_unsupported_shared_objects");
    if (!q.topLevel && !grownIds.has(q.id)) return err("pagination_unsupported_non_top_level_text");
    flow.push(q);
  }
  flow.sort((a, b) => b.box.top - a.box.top || a.box.x - b.box.x);

  // In-page shift: the growth of every grown paragraph above (as cascade).
  const shiftOf = (q) => {
    let s = 0;
    for (const g of grown) {
      if (g.id === q.id || q.box.top > bottomOf(g.box) + 0.5 || !sameColumn(q.box, g.box)) continue;
      s += g.delta;
    }
    return s;
  };

  const lines = [];
  const untouchedLines = [];
  for (const q of flow) {
    const shift = shiftOf(q);
    const items = [];
    for (const h of current.get(q.id)) {
      if (!indexOf.has(h)) return err("pagination_unsupported_non_top_level_text");
      const b = bounds(h);
      if (!b) return err("pagination_unsupported_non_top_level_text");
      items.push({ h, order: indexOf.get(h), ...b });
    }
    const { lines: ls, loose } = groupLines(items);
    if (!ls.length && loose.length) ls.push({ top: Math.max(...loose.map((i) => i.top)), bottom: Math.min(...loose.map((i) => i.bottom)), items: [] });
    for (const it of loose) {
      const l = ls.find((x) => it.bottom <= x.top + 0.5 && it.bottom >= x.bottom - 0.5) || ls[ls.length - 1];
      l.items.push(it);
    }
    for (const l of ls) {
      const line = { para: q.id, shift, top: l.top, bottom: l.bottom, items: l.items };
      lines.push(line);
      if (!grownIds.has(q.id) && shift >= 0) untouchedLines.push(line);
    }
  }

  // Objects inside the flow band that no paragraph owns: soft hyphens and
  // empty spacing objects ride with the untouched line they sit on; any
  // other object there makes the flow ambiguous.
  let orphans = 0;
  for (const h of objects) {
    if (owner.has(h)) continue;
    const b = bounds(h);
    if (!b) return err("pagination_unsupported_foreign_object_in_flow");
    const cy = (b.top + b.bottom) / 2;
    if (cy < floor - EPS || cy > flowTop + 0.5) continue;
    if (b.x + b.w < anchor.x - 0.5 || b.x > anchor.x + anchor.w + 0.5) {
      return err("pagination_unsupported_multi_column_flow");
    }
    if (M._FPDFPageObj_GetType(h) !== OBJ_TEXT) return err("pagination_unsupported_foreign_object_in_flow");
    const l = untouchedLines.find((x) => cy <= x.top + 0.5 && cy >= x.bottom - 0.5);
    if (l) {
      l.items.push({ h, order: indexOf.get(h), ...b });
      continue;
    }
    if (b.top - b.bottom <= EPS && b.w <= EPS) {
      orphans++;
      continue;
    }
    return err("pagination_unsupported_foreign_object_in_flow");
  }

  let bodyTop = -Infinity;
  for (const q of ctx.paras) {
    if (q.role !== "body") continue;
    for (const h of current.get(q.id)) {
      const b = indexOf.has(h) ? bounds(h) : null;
      if (b && b.top - b.bottom > EPS) bodyTop = Math.max(bodyTop, b.top);
    }
  }
  const virtual = lines.map((l) => ({ top: l.top - l.shift, bottom: l.bottom - l.shift }));
  const split = planFlow(virtual, { bodyTop, floor, maxNewPages });
  if (!split.ok) return err(split.code, { line: split.line, maxNewPages: split.maxNewPages });
  return { ok: true, lines, pages: split.pages, bodyTop, floor, orphans, objects };
}

// Closes cached page handles above pageIndex; their content was generated
// when the engine switched away from them, and their cache keys are about
// to name different pages.
function evictPagesAfter(engine, pageIndex) {
  const M = engine.M;
  const cache = engine._pageCache;
  if (!cache) return;
  for (const [k, h] of [...cache.entries()]) {
    if (k <= pageIndex || !h || h === engine.page) continue;
    M._ec_history_drop_page?.(engine.session, h);
    M._FPDF_ClosePage(h);
    cache.delete(k);
  }
}

// Applies a flow plan: shift kept lines, generate the source page so every
// object has a content stream, then move continuation lines (in source
// object order) onto new pages inserted after pageIndex. Throws on any
// engine refusal; the caller discards the whole document then.
export function applyFlowPlan(engine, pageIndex, plan) {
  const M = engine.M;
  if (engine.pageIndex !== pageIndex) throw new Error("page_not_current");
  for (const [p, page] of plan.pages.entries()) {
    for (const i of page.lines) {
      const l = plan.lines[i];
      const dy = -l.shift + (p ? page.offset : 0);
      if (Math.abs(dy) < 1e-6) continue;
      for (const it of l.items) engine.translateObject(it.h, 0, dy);
    }
  }
  engine._pageDirty = true;
  if (!engine.generateContent()) throw new Error("source_generate_failed");
  const added = plan.pages.length - 1;
  const lineCounts = [];
  if (added > 0) {
    evictPagesAfter(engine, pageIndex);
    const W = engine.pageWidth, H = engine.pageHeight;
    const before = M._FPDFPage_CountObjects(engine.page);
    let movedTotal = 0;
    for (let p = 1; p <= added; p++) {
      const np = M._FPDFPage_New(engine.doc, pageIndex + p, W, H);
      if (!np) throw new Error("page_new_failed");
      try {
        const now = new Map(listObjects(M, engine.page).map((h, i) => [h, i]));
        const handles = plan.pages[p].lines.flatMap((i) => plan.lines[i].items.map((it) => it.h));
        if (handles.some((h) => !now.has(h))) throw new Error("object_not_on_source_page");
        handles.sort((a, b) => now.get(a) - now.get(b));
        for (const h of handles) {
          if (!M._FPDFPage_RemoveObject(engine.page, h)) throw new Error("remove_failed");
          M._FPDFPage_InsertObject(np, h);
        }
        if (M._FPDFPage_CountObjects(np) !== handles.length) throw new Error("insert_count_mismatch");
        if (!M._FPDFPage_GenerateContent(np)) throw new Error("continuation_generate_failed");
        movedTotal += handles.length;
        lineCounts.push(plan.pages[p].lines.length);
      } finally {
        M._FPDF_ClosePage(np);
      }
    }
    if (M._FPDFPage_CountObjects(engine.page) !== before - movedTotal) throw new Error("source_count_mismatch");
    engine._pageDirty = true;
    if (!engine.generateContent()) throw new Error("source_generate_failed");
    // Drop the session's model of the old handle (it still names the moved
    // objects) and reload the page from the regenerated document.
    M._ec_history_drop_page?.(engine.session, engine.page);
    engine._pageStale = true;
    engine.buildModel();
    engine.pageCount = M._FPDF_GetPageCount(engine.doc);
  }
  return { added, lineCounts, keptLines: plan.pages[0].lines.length };
}

// quality.repairPageLayout hook: plan, then apply. Returns
// { ok, warnings, repairs, added, lineCounts, bodyTop, floor }.
export function paginateOverflow(engine, ctx, grown, { floor, maxNewPages }) {
  const warnings = [];
  const repairs = [];
  const plan = buildFlowPlan(engine, ctx, grown, { floor, maxNewPages });
  if (!plan.ok) {
    warnings.push({ code: plan.code, severity: "error", ...(plan.maxNewPages !== undefined ? { maxNewPages: plan.maxNewPages } : {}) });
    repairs.push({ kind: "pagination", action: "rejected", reason: plan.code });
    return { ok: false, warnings, repairs, added: 0 };
  }
  let r;
  try {
    r = applyFlowPlan(engine, ctx.pageIndex, plan);
  } catch (e) {
    warnings.push({ code: "pagination_apply_failed", severity: "error", reason: String(e?.message || e).slice(0, 80) });
    repairs.push({ kind: "pagination", action: "failed" });
    return { ok: false, warnings, repairs, added: 0 };
  }
  if (plan.orphans) warnings.push({ code: "pagination_empty_objects_kept", severity: "info", count: plan.orphans });
  repairs.push({ kind: "pagination", action: r.added ? "continued" : "shifted", added: r.added, keptLines: r.keptLines, lineCounts: r.lineCounts, floor: +plan.floor.toFixed(2), bodyTop: +plan.bodyTop.toFixed(2) });
  return { ok: true, warnings, repairs, added: r.added, lineCounts: r.lineCounts, keptLines: r.keptLines, bodyTop: plan.bodyTop, floor: plan.floor };
}
