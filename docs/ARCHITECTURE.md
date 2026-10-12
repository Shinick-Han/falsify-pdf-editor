# Architecture

Falsify PDF Editor is a standalone, local Node.js module that applies
explicitly requested text replacements to a PDF. It is published separately
from the Falsify Workbench website and from any private research material.

## Components

```text
request.json ──► src/cli.mjs ──► src/editor.mjs ──► src/runtime.mjs ──► BentoPDF editcore JS (upstream/bentopdf, unmodified)
                                      │                                     │
                                      │                                     └─► .runtime/editcore.{js,wasm}
                                      │                                         (byte copies of pinned engine blobs)
                                      └─► src/quality.mjs (layout capture/repair, saved-PDF self-check)
```

- **CLI** (`src/cli.mjs`): validates the request, resolves the input relative to
  the request file, refuses to overwrite the input, and writes the output and
  report only after the self-check.
- **Editor** (`src/editor.mjs`): exposes `editPdf({ sourceBytes, edits, reflow })`.
  It matches each `before` exactly once (whitespace-normalised), validates all
  targets before any mutation, and applies all edits or none.
- **Quality** (`src/quality.mjs`): records page layout before commits,
  optionally repairs column width, line spacing and source object order after
  commits, then reopens the saved PDF and checks text, order and geometry.
  This is a same-engine self-check, not independent validation.
- **Runtime** (`src/runtime.mjs`, `scripts/prepare-runtime.mjs`): loads the
  upstream editcore JavaScript from the submodule and the verified WASM from
  `.runtime/`. Nothing is downloaded at run time.

Exact module file names are owned by the source tree; this page describes the
data flow.

## Data boundaries

- Input PDFs, requests and outputs stay on the local machine. The module makes
  no network requests and calls no model API.
- Only the edits listed in the request are applied. The module does not choose
  targets or generate replacement text.
- Requests, PDFs and reports are user data and do not belong in this
  repository.

## Licensing model

The module is AGPL-3.0-only because it is built on, and loads, AGPL-3.0-only
BentoPDF and engine code, and includes logic adapted from earlier work on
that code. The upstream MIT, HarfBuzz and PDFium notices continue to apply to
their parts. See [`NOTICE`](../NOTICE) and
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

This is an engineering description, not legal advice or a compliance
certification. The [GNU AGPL v3 text](https://www.gnu.org/licenses/agpl-3.0.html)
in [`LICENSE`](../LICENSE) is controlling; the
[GNU licenses FAQ](https://www.gnu.org/licenses/gpl-faq.html) is the official
explanatory source.

### Using the module

- Running the module privately on your own machine, and modifying it for that
  use, is permitted by the AGPL. The license's conditions mainly attach to
  conveying copies and, for modified versions, to offering the program to
  users over a network.
- If you **convey** the module or the engine binaries (for example by
  publishing a package, container image or installer), provide the
  corresponding source as the license requires and keep `LICENSE`, `NOTICE`,
  `THIRD_PARTY_NOTICES.md` and `licenses/` with the copy.
- If you **modify** the module or upstream code and let users **interact with
  it remotely over a network**, section 13 of the AGPL requires offering those
  users the corresponding source of your version. Linking to an unmodified
  public repository is not sufficient for a modified deployment; point to the
  exact source you run.
- The intended public source location for this module is
  <https://github.com/Shinick-Han/falsify-pdf-editor>, with upstream sources
  pinned as submodules. The WASM's corresponding source is the pinned engine
  repository and its nested PDFium submodule (see [`BUILD.md`](BUILD.md)).

### Combining with other software

Running this module as a separate process, or calling it through a command
line or local API, does **not** by itself establish that another application
is outside the scope of the AGPL. Whether a combination forms a single work
depends on how the parts communicate and are distributed. Assess the actual
integration before distributing or deploying a combined system. The module's
separation exists to keep its source and notices self-contained, not to
promise an exemption.

Do not assume that BentoPDF's commercial offering, the MIT metadata in the
engine's `packages/pdfium`, or a package-registry license field covers
editcore or the engine; this project has no evidence that it does. Do not
relicense other projects' code by copying it into this module.

## Binary provenance

The default engine binaries are upstream committed artifacts verified by
SHA-256 against pinned Git blobs. A single independent local source rebuild
reproduced both artifacts exactly; a patched rebuild has a different WASM
digest and is available through explicit candidate selection. [`BUILD.md`](BUILD.md)
and [`CANDIDATE_RUNTIME.md`](CANDIDATE_RUNTIME.md) separate byte verification,
observed build provenance, and caller-supplied manifest expectations.

## Limitations

This is alpha software for controlled research use. Multi-column layouts,
scanned pages, tables, equations, mixed fonts, missing glyphs, rotated or
cropped pages and pagination are not universally supported. An engine's
successful save is not acceptance; unsupported or uncertain cases should be
reported as diagnostics.
