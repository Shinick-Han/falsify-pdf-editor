# Falsify PDF Editor

Experimental, standalone **AGPL-3.0-only** PDF editing module for controlled document-verification research. This is not the Falsify Workbench website and does not include private research material, agent harnesses, or experiment ground truth.

It reuses pinned BentoPDF source and its committed editcore WASM. Input stays on the local machine. No model API, telemetry, remote paper upload, or hosted editor is used.

## Status

Alpha: not a general-purpose PDF editor or a production-quality guarantee. Layout, reading-order, and font coverage limitations must be tested for each document. An engine's successful save is not independent acceptance. The existing Workbench is not automatically connected to this module.

The supplied WASM is hash-checked against a pinned upstream git blob; we have **not independently rebuilt it from C++**. See [build provenance and instructions](docs/BUILD.md).

## Local setup

Requires Git and Node.js 24 or later.

```sh
git clone https://github.com/Shinick-Han/falsify-pdf-editor.git
cd falsify-pdf-editor
git submodule update --init --depth 1
npm run prepare:runtime
npm test
```

Dependencies are git submodules, not fetched from floating package versions. The preparation command creates ignored `.runtime/` files from verified source blobs; they are not checked into this repository.

## Explicit edits only

Create a local request file outside source control:

```json
{
  "input": "paper.pdf",
  "reflow": true,
  "edits": [
    {
      "id": "example",
      "pageIndex": 0,
      "before": "If every check passes, continue.",
      "after": "Continue."
    }
  ]
}
```

Page indices are zero-based. Relative input paths are resolved against the request file. The original input must never be used as the output path. Only requested edits are applied; no attack selection or autonomous paper modification occurs.

```sh
node src/cli.mjs request.json --out output/edited.pdf --report output/report.json
```

Use only documents you are entitled to edit. Preserve the clean original, keep experimental variants identifiable in your research records, and separate verification answers from blind evaluation inputs. This module does not certify scientific validity or absence of edit artifacts.

## Quality boundary

- Unique, whitespace-normalized Before matching, without fuzzy relocation or silently shortening After.
- Preserves the existing surgical path for short edits where possible.
- Experimental column-bounded reflow, source-order restoration, and protection of identifiable page-edge content.
- Saved-document text/geometry checks are same-PDFium checks, not independent rendering or external BLUE validation.
- Unsupported or uncertain layouts require explicit diagnostics, not false success. Multi-column text, scanned pages, tables, equations, mixed fonts, missing glyphs, rotated/cropped pages and pagination are not universally supported.

## Source and notices

The complete module source is in this repository. Pinned upstream sources are referenced by `.gitmodules` and gitlinks and are obtainable with `git submodule update --init`. See [upstream pins](UPSTREAM.json), [third-party notices](THIRD_PARTY_NOTICES.md), [NOTICE](NOTICE), and [architecture](docs/ARCHITECTURE.md).

Retain applicable notices and offer corresponding source where required for the intended distribution or network deployment. Separating this module from another application is **not a promise of automatic AGPL exemption** for that application. Do not assume an MIT grant for BentoPDF's editcore or silently relicense existing Workbench/private code. Review the actual terms for your deployment.

No private documents, user requests, API keys, or research receipts belong in this repository. Generated PDFs and runtime binaries are ignored.
