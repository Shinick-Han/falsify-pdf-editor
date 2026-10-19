# falsify-pdf-editor 0.1.0-alpha.5 (source-only prerelease)

Source tree: `3522f0f3c03624acf7e797caf7adcfa9b6336437` plus this version/notes commit. Alpha: not a
general-purpose PDF editor and not a production-quality guarantee (see [README](../README.md)).

## Changes since alpha.4

- Line-local re-layout for short inline edits keeps source lines and run styles; body text is pushed below
  surgically wrapped edits, edge-band body movement stays a failure, and line-local is declined when the source
  line aspect cannot be read. A line-count-changing plain re-layout is routed to the line-local recovery.
- Moved cross-style words are refused and edited-line overflow is warned.
- Native editcore source patches for word spacing: natural-space fallback (guarded to fonts without a usable
  space width), justified-space handling that keeps the natural gap under word spacing, and source word-spacing
  normalization for re-edits (unknown-whitespace zero spacing and post-atomic gaps). See `patches/editcore-*.patch`.
- Build helper: `scripts/rebuild-wasm.sh` gains `OUT_NAME` and a provenance stage; provenance reads fail closed,
  snapshots bind both source trees and their HEADs, and index states that `git diff` cannot see are refused.

## Evidence and its limits

- Repeated same-line edits succeeded on the calibration documents in two and three successive edit generations.
  Source-structure and preservation warnings still occur and are reported; they are not hidden.
- Three AMAS documents remain refusals at this boundary. No claim is made for arbitrary PDFs, AMAS documents,
  invisible/undetectable editing or scientific/model performance.
- The locally built runtime (WASM digest prefix `9b14`, candidate manifest prefix `5910`) was verified on the
  maintainer host only: `sourceBuildVerified=false`, same-host incremental build. It is not a reproducible or
  independently attested build.

## Distribution

The patched runtime WASM is **not** bundled; build it from the pinned sources and patches as described in
[BUILD.md](BUILD.md) and [CANDIDATE_RUNTIME.md](CANDIDATE_RUNTIME.md). The existing portable C++ patches and the
license notices under `licenses/` remain included. This release contains no privately recorded experiment
artifacts, harnesses, PDFs or credentials.
