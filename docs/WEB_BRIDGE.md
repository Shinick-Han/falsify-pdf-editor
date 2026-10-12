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

The companion owns the temporary directory. Node writes output only after the
mandatory saved-document self-check passed. A sanitized report retains indices,
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
