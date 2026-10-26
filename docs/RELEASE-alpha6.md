# falsify-pdf-editor 0.1.0-alpha.6

Source-only prerelease. Works with Workbench 0.2.0-alpha.5 through the existing web bridge.

- Prefix-preserving reflow keeps independently owned earlier line objects in place.
- Effective type size compares Tf and the finite upright text matrix at 0.02pt tolerance; missing/nonfinite matrices decline explicitly.
- Declined commits restore object/glyph state, rebind font-source indices and publish refreshed paragraph IDs, including the layout-repair ID.
- Previously edited paragraphs are checked against their pre-attempt object/glyph snapshot; untouched paragraphs still match source text. Both edit orders and reflow settings have regressions.
- Local final suite: 206 tests, 205 passed and one optional QA fixture not supplied. One 15-page calibration retained preceding glyphs and all 14 unedited pages under independent MuPDF measurement. This is not a universal PDF, invisible-edit or scientific-performance guarantee.

No native rebuild or bundled patched WASM. The configured same-host runtime remains sourceBuildVerified=false. Existing warnings and AMAS/complex-layout limitations remain. See [prefix details](prefix-reflow.md), [runtime setup](CANDIDATE_RUNTIME.md), [build instructions](BUILD.md) and [quality contract](QUALITY.md).
