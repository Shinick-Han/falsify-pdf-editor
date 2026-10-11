# Tested scope of the first alpha

This is an implementation baseline and reproducible research module, not a
general PDF editor or a promise that all short edits work.

## Coordinator checks

- Automated suite: **42 passed, 0 failed, 0 skipped** after preparing the
  pinned runtime. Includes real-WASM smoke tests and synthetic mocks; the
  count is not 42 independent document-quality tests.
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

## Next implementation boundary

1. Fix or expose source content-stream assignment in the PDFium/editcore layer,
   then rebuild and check against the pinned dependency/toolchain manifest.
2. Test the actual saved stream order with all three independent extractors.
3. Preserve original line pitch, column width, headers/footers, and graphical
   stacking. Implement pagination before claiming long expansions are safe.
4. Add missing-glyph, mixed-font, column, table, equation, rotation/crop, and
   scanned-document cases. They are currently unverified or unsupported.

The supplied WASM has not been independently rebuilt. A website integration
or production rollout has not been performed.
