# Falsify PDF Editor

Experimental, standalone **AGPL-3.0-only** PDF editing module for controlled document-verification research. This is not the Falsify Workbench website and does not include private research material, agent harnesses, or experiment ground truth.

It reuses pinned BentoPDF source. By default it runs the committed editcore WASM; an explicitly selected, hash-verified local rebuild can apply the included PDFium source patch. Input stays on the local machine. No model API, telemetry, remote paper upload, or hosted editor is used.

## Status

Current source prerelease: [0.1.0-alpha.6](docs/RELEASE-alpha6.md), including prefix preservation and rollback for ordered edits.

Alpha: not a general-purpose PDF editor or a production-quality guarantee. Layout, reading-order, and font coverage limitations must be tested for each document. An engine's successful save is not independent acceptance. The existing Workbench is not automatically connected to this module.

An independent local C++ rebuild reproduced the supplied JS/WASM byte-for-byte. A second, patched build fixed the tested inserted-text stream-order failures. This is one host/build comparison, not a universal PDF quality guarantee. See [build provenance and instructions](docs/BUILD.md).

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
- Experimental column-bounded reflow, source-object-slot diagnostics, and protection of identifiable page-edge content.
- Saved-document text/geometry checks are same-PDFium checks, not independent rendering or external BLUE validation.
- Unsupported or uncertain layouts require explicit diagnostics, not false success. Multi-column text, scanned pages, tables, equations, mixed fonts, missing glyphs, rotated/cropped pages and pagination are not universally supported.

**Runtime choice matters:** the default upstream WASM still has inserted-text stream-order failures. The included [C++ patch](docs/STREAM_ORDER.md) and [source rebuild](docs/BUILD.md) fixed the eight tested short/long failure variants when the rebuilt WASM was [explicitly selected](docs/CANDIDATE_RUNTIME.md). Saved-text checks are not weakened. Bounded [single-column continuation pages](docs/PAGINATION.md) now support long After text, with default eight added pages. New pages repeat source-font text headers/footers and use source-number decimal continuation suffixes (for example `10.1`); original page numbers stay unchanged. This is not full-template replication: graphics, clipping and ambiguous numbering remain unsupported. Arbitrary cross-stream z-order and unsupported layouts remain outside the supported scope. The [public Workbench](https://github.com/Shinick-Han/falsify-workbench) can opt in through `src/web-bridge.mjs`; existing running companions are not silently upgraded or replaced.

## Source and notices

The complete module source is in this repository. Pinned upstream sources are referenced by `.gitmodules` and gitlinks and are obtainable with `git submodule update --init`. See [upstream pins](UPSTREAM.json), [third-party notices](THIRD_PARTY_NOTICES.md), [NOTICE](NOTICE), and [architecture](docs/ARCHITECTURE.md).

Retain applicable notices and offer corresponding source where required for the intended distribution or network deployment. Separating this module from another application is **not a promise of automatic AGPL exemption** for that application. Do not assume an MIT grant for BentoPDF's editcore or silently relicense existing Workbench/private code. Review the actual terms for your deployment.

No private documents, user requests, API keys, or research receipts belong in this repository. Generated PDFs and runtime binaries are ignored.
