# Content-stream order repair (PDFium patch)

Status: source patch for a rebuilt WASM. It is **not** in the supplied
upstream binary and has not been accepted on a rebuilt engine yet.

## Root cause

Editcore commits that replace text objects (including reflow and some surgical
paths) create new objects and insert them with `FPDFPage_InsertObjectAtIndex`.
In-place surgical edits can retain the existing object's stream and do not
necessarily trigger this defect. Newly created objects carry
`CPDF_PageObject::kNoContentStream`. Removing the original objects marks their
stream dirty, so `CPDF_PageContentGenerator::GenerateModifiedStreams`
regenerates every existing stream, but it writes streamless objects into a
separate bucket that `UpdateContentStreams` appends after all existing
streams. The object list order is right; the saved order is not, so reopened
text (and paint order) puts the edited paragraph at the end of the page.

## Fix (`patches/pdfium-stream-order.patch`)

One file, additive only: `core/fpdfapi/edit/cpdf_pagecontentgenerator.cpp`.

1. **Append detection.** The existing "pure append" exemption (which keeps
   untouched streams byte-for-byte to protect ambient prolog state) now also
   requires the streamless objects to be at the tail of the active object
   list. A streamless object before a streamed one is an insertion and takes
   the full-regeneration path.
2. **In-place binding.** When all existing streams are regenerated, each
   active streamless object is bound to the stream of its nearest preceding
   active object that has a valid stream index (leading ones: nearest
   following). It is then serialized in object-list order inside that stream.
   If no streamed active object exists, the appended stream is kept as before.

Only streamless (new) objects are rebound. Objects parsed from, or previously
saved to, a stream keep their index. No spatial sorting, text-only flattening,
ActualText, or post-save reordering is involved, and editcore C++ is unchanged.

The expected graphics-state preservation follows from the existing generator:
each regenerated stream starts
with `q`, the inverse of the CTM at the start of that stream and default
graphics, and ends with `Q` plus the CTM handoff to the next stream. Each
object is written as `q <own graphics state> ... Q` (text adds its own
`BT`/`Tf`/`Tm`). The baseline already regenerated all streams in this case;
only the bucket of new objects changes. This argument is not a proof for every
PDF: ambient state, marked content and unsupported cross-stream z-order still
need the safeguards and limitations below.

## Precondition and limits

- List order is restored only if the stream indices of retained existing
  objects are monotonic in list order. **Existing objects that were reordered
  across streams** (z-order commands, undo of such moves) keep their stream,
  and stream *k* is still written before stream *k+1*. That case is not
  solved; arbitrary z-order is not supported.
- A new object inside a marked-content span closes and reopens the span
  around itself (existing mark-diff logic), which may split a tagged MCID run.
- Inactive objects neither donate a stream nor are rebound.
- A stale index beyond the page's `/Contents` is ignored as a donor.
- Insertions without any removal now regenerate all streams; ambient ops
  owned by no page object can be lost there, as for any other non-append edit.
- Form XObject holders have one stream (index 0) and follow the same rule.

## Tests

`test/stream-order.test.mjs` extracts the patch's added C++ verbatim and
compiles it against stand-in types (host `g++` or WSL `g++`; skipped
otherwise). It covers middle/front/tail insertion, inactive objects, pages
with no streamed or no existing objects, multi-stream pages, stale indices,
and asserts that non-monotonic existing objects are never rebound. It does
not exercise serialization, CTM or graphics state; those, the synthetic
2-page SHORT/LONG cases, the graphics single/multi-stream fixtures and the
private 18-page corpus require the rebuilt WASM.

Apply order: PDFium `fce2b000cc7a9e2cabc92db41cd57ca03233f07d`, then engine
`security-fixes.patch`, `editcore-pdfium.patch`, then this patch
(`git apply`, LF, `-p1`).
