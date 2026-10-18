# Tested scope (alpha.2)

This is an implementation baseline and reproducible research module, not a
general PDF editor or a promise that all short edits work.

## Default baseline checks

- Current automated suite: **53 passed, 0 failed, 0 skipped** after preparing
  the pinned runtime. Includes real-WASM smoke tests, synthetic mocks,
  candidate identity/concurrency checks, import-failure recovery and C++
  binding tests; the count is not 53 independent document-quality tests.
- Local 18-page corpus: three unique text-shortening replacements, including
  one crossing two source lines, passed individually and together. MuPDF,
  PDFium, and pypdf each produced the exact expected normalized whole-document
  text, including order. Two renderers showed identical unedited pages and
  legible edited pages. A no-op control also passed.
- A long replacement in that corpus requires pagination to retain the source
  line pitch and footer. It is reported as unsupported, not as a good output.
- A separate, original two-page synthetic document with standard font text
  exposed saved reading-order changes for **both a long replacement and a
  short replacement**. No successful PDF was returned by the integrated CLI
  for those failures. This is a genuine unresolved limitation, not a passed
  test merely because the diagnostics correctly detected it.
- Source/request protection, pre-existing report protection, exclusive
  staging, pinned runtime hashes, source-pin verification, and safe runtime
  preparation were tested. File symlink creation was unavailable in the local
  Windows test environment; a directory-junction variant was exercised.

The private corpus, requests, outputs, ground truth, and research receipts are
not included in this repository. No BLUE/RED model evaluation was run.

## Reading-order root cause

`FPDFPage_InsertObjectAtIndex` controls the page object list. The saved content
generator can still append newly emitted text as a new content stream. The
index operation alone is not proof that a later extractor sees text in the
source order.

The pre-save indicator is therefore a warning followed by mandatory saved-text
comparison. Definite move/insertion failures and pagination errors remain
errors. The final text comparison is not weakened to a word bag or an After
substring check.

## Actual source build and patched-runtime acceptance

One independent local build from pinned C++ reproduced the upstream JS/WASM
byte-for-byte. A second build applied `pdfium-stream-order.patch`, rebuilt the
content generator/static archive, and relinked the WASM. Its SHA-256 is
`12e43c4c2e7deedab629c3b08b14fc0b24c1336f92b7de30ac58d7ec6dcbb833`.
This establishes the recorded local build, not universal reproducibility.

| Corpus case | Default / rebuilt unpatched baseline | Patched build |
|---|---|---|
| 18-page corpus: no-op, three short replacements individually, combined | 5 passed | 5 passed |
| Original 2-page standard-font fixture: short and long replacement | 2 saved-order failures, no output | 2 passed |
| Original image/path fixture: single and multiple content streams, short/long | 4 saved-order failures, no output | 4 passed |
| Original cross-stream translated/scaled CTM + Form graphic, short/long | 2 saved-order failures, no output | 2 passed |
| 18-page corpus expansion requiring pagination | Unsupported, no output | Still unsupported, no output |

For all 13 produced patched outputs, MuPDF, independent PDFium and pypdf
returned the exact expected normalized whole-document text, including order.
MuPDF/PDFium rendered every page; all unedited pages were pixel-identical,
with no off-page glyphs. Poppler added 24 page comparisons. The coordinator
inspected edited-page PNGs. Synthetic edge regions were pixel-identical;
transformed-page coordinates differed only by approximately 0.000061 pt,
within the documented 0.01 pt measurement tolerance. Image/path fixtures
deliberately contain a graphical overlay already present in the source;
preserving it is not evidence of automatic graphic-background reflow.

The default runtime still has the eight stream-order failures; this fix is
used only when the rebuilt candidate is explicitly selected. These are
controlled document checks, not BLUE/RED model or scientific-validity scores.

## Continuation pages with copied edges (self-check)

`inspectSavedPdf` checks a continued source page against the SOURCE PDF and
the page map's body band `[floor - 0.5, bodyTop + 0.5]` only. The editor
report never supplies expected edge text.

- The ordered flow (output page, then every continuation page) is compared
  by body-band text only; planned line counts are compared with lines
  measured from body-band glyphs only.
- Original output page edges must keep every source edge glyph at its source
  position and, where the runtime exposes it, its style (font name and
  flags, size, fill/stroke colour, render mode, glyph matrix scale/rotation).
- A map entry may carry exactly
  `continuationStyle: { version: 1, policy: "source-number-suffix", applied: true }`,
  only on an entry with continuation pages; any other shape invalidates the
  map. Without it (old body-only maps), any glyph outside the band on a
  continuation page fails as `continuation_outside_body_band`.
- With it, continuation page `k` (1-based) must carry every non-number source
  edge glyph at its source position and style. Each source edge text object
  that is only Arabic digits must appear as one object reading
  `<number>.<k>` on the source baseline and style, digits at their source
  spacing, suffix at natural advance, aligned on the source left, centre or
  right by page position (centre within 2pt of mid-page). Missing, extra,
  moved or restyled edge glyphs, changed numbering, two different source
  numbers, body text moved outside the band, and runtimes without the
  text-page style API all fail. Body column, overlap and off-page checks
  stay as before (column extents measured on body glyphs).

This remains a same-PDFium self-check. A private probe on hand-built PDFs
with the patched candidate runtime accepted the correct copy and rejected
changed/unsuffixed number, wrong anchor, size, colour, render mode, moved,
missing and extra header text and body text hidden in the footer zone. It
has now also been run on engine-produced continuation pages: 34 real saved-PDF
control/tamper cases passed their expected gates. Independent corpus checks used
three text extractors and two renderers; these private fixtures are not published
as a scientific benchmark or a proof for arbitrary inputs.

The self-check is not a visual integrity verifier. Diagnostic probes showed that
invisible/white body text, non-text covers, visually swapped body lines and
position/style changes on unedited downstream pages can retain the text/geometry
properties currently checked. These are documented gaps, not passing negative
tests. Independent rendering and human review remain necessary; the fixed editor
path is not a validator for arbitrary third-party modified PDFs.

## Inline style mapping and source-line retention warnings

- An edit across runs of different styles keeps unchanged tokens in their own
  run and maps a changed word to the style of the word it replaces only when
  the token shapes agree. When a changed After word spells a source word of the
  match in another style (canonical Unicode comparison), it may be that word
  moved, for example `then bold` -> `bold then`; the edit is refused with
  `STYLE_AMBIGUOUS` (`AMBIGUOUS_STYLE` per edit) instead of inventing styles.
- A re-laid-out short edit is reported in `lineRetention`. `line_count_changed`
  means the plain re-layout really needs a different number of lines and is not
  warned. When the edited line alone overflows its source line but the plain
  re-layout keeps the source line count, the reason is `edited_line_overflows`
  and a `source_lines_reflowed` warning is raised: untouched source lines were
  moved, not retained.

## Remaining implementation boundaries

1. Pagination is bounded to the supported single-column text flow; do not claim
   arbitrary long expansions or full-template replication are safe.
2. Existing cross-stream z-order is not solved by new-object binding. Tagged
   MCID spans and ambient operations not owned by page objects are not
   universally preserved; pure tail appends retain the non-regeneration path.
3. Add missing-glyph, mixed-font, column, table, equation, rotation/crop, and
   scanned-document cases. They are currently unverified or unsupported.

The Workbench bridge now supports explicit local-editor configuration. Existing
running companions are not silently restarted or upgraded, and the source release
does not bundle patched WASM binaries. Source patches, build recipes and runtime
verification remain distinct from recipient setup or a production certification.
