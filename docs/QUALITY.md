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

## Remaining implementation boundaries

1. Implement pagination before claiming arbitrary long expansions are safe.
2. Existing cross-stream z-order is not solved by new-object binding. Tagged
   MCID spans and ambient operations not owned by page objects are not
   universally preserved; pure tail appends retain the non-regeneration path.
3. Add missing-glyph, mixed-font, column, table, equation, rotation/crop, and
   scanned-document cases. They are currently unverified or unsupported.

Neither a website integration, broker restart, binary publication nor a
production rollout has been performed. Source patches, build recipes and
candidate-runtime verification remain distinct from deploying an editor.
