# Local Workbench bridge (alpha.4)

`src/web-bridge.mjs` is a fixed JSON bridge, not a shell or agent executor.
It requires an explicitly configured, digest-verified patched candidate manifest
via `FALSIFY_EDITOR_CANDIDATE_MANIFEST`. It opens no document for `--capabilities`;
that probe verifies pinned sources and instantiates the WASM.

```
node src/web-bridge.mjs --capabilities
node src/web-bridge.mjs --request ABS --out ABS --report ABS
```

Edit requests use `schema: "falsify-web-bridge-request/1"`, a plain input
filename in the request directory, `inputSha256`, `reflow` and explicit `edits`
with `id`, `pageIndex`, `before`, `after`. The input and request must be regular
files; source/request/output/report must differ; output and report cannot exist.
No harness, model, rationale, answer key, remote endpoint or executable is accepted.

The companion owns the temporary directory. Strict requests (no `draft` field,
or `draft: false`) write the PDF only after the mandatory saved-document
self-check passed. A sanitized report retains indices,
counts, diagnostic codes, runtime digests and source-page mapping, not text or
private paths. Public capability flags normalize `EDITOR_CAPABILITIES.pagination`
through `.supported === true`; they describe supported scope, not guaranteed
success for arbitrary PDFs. See [pagination boundaries](PAGINATION.md).

The optional Workbench adapter authenticates `/api/export`, validates the source
hash and selected spans, and invokes this entry point with a fixed argument list,
timeouts and budgets. Configured failures never fall back to the old editor. The
UI requires `layoutVerified === true` and matching output bytes/hash. Same-engine
self-check is not independent rendering QA, scientific validity or RED/BLUE
performance evidence.

Alpha.4 adds the optional `continuationStyle` capability, only for the known
`source-number-suffix` policy. This covers source-font text headers/footers and
standalone Arabic page numbers; original numbers remain unchanged and new pages
use a decimal continuation suffix (for example `10.1`). Graphics, ambiguous
numbering and unsupported text layout remain explicit failures. The output
report exposes only `{policy, applied: true, copiedPages}` after a passed
self-check, with a positive count equal to the reported added-page count and
at most 32. Source edge text, font handles and private paths are never published
in this metadata. A missing capability keeps old companions compatible.

## Explicit draft preservation

`draft` is an optional boolean on `falsify-web-bridge-request/1`. Only `true`
opts in. The CLI does not accept the field and remains strict: a failed
self-check still writes no PDF.

When `draft` is true and `editPdf` has already saved readable `%PDF-` bytes,
a failed or errored self-check still writes those bytes and the report, then
exits 1. Stdout is one object, `{ok:false, code, draft:true}`. The report keeps
`ok: false`, `status: "draft"`, `quality` of `failed` or `error`, the machine
`selfCheck.status`, `error.code`, per-edit statuses, `outputSha256`,
`inputSha256` and the runtime digests. It is not rewritten to
`self-check-passed` or `ok: true`. An edit whose After is absent
(`after_missing`) is not left as `applied` or `noop`; its status is
`after-missing`. A read-order failure such as
`edited_page_text_or_order_mismatch` keeps the machine applied status when the
After is present, while the export stays unsuccessful.

Bytes are not invented. A failure before save, a missing file, or a payload
that does not start with `%PDF-` still writes no output. Hash, runtime and
source-hash checks stay with the companion. There is no fallback to another
editor, white overlay or raster rewrite. `capabilities` advertises `draft: true`
for this protocol; an older bridge rejects the unknown field instead of
pretending the check passed.

Alpha.3 integration checks: 80 module tests executed, zero failures/skips in the
prepared coordinator environment; actual browser upload/edit/export produced
two continuation pages without model calls. Independent MuPDF, PDFium and pypdf
extraction verified full ordered text, not a word bag. MuPDF/PDFium preserved
mapped unselected-page pixels; Poppler verified the research fixture but exposed
the inherited synthetic page-box precision limit documented in `PAGINATION.md`.
These private QA documents and receipts are not distributed as benchmark data.

The source release does not bundle a patched WASM. [Build](BUILD.md) and
[candidate selection](CANDIDATE_RUNTIME.md) remain explicit. No claim is made that
publication itself completes every recipient's setup or license obligations.
