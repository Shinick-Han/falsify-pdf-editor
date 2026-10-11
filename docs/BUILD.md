# Build and provenance

This module is plain Node.js. It does not compile C++ or WebAssembly. The
PDF engine it runs is the **upstream committed binary** from the pinned
engine repository, not a binary this project rebuilt.

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Git | any recent | Needed for submodules and for reading pinned blobs |
| Node.js | 24 or later | Runtime and tests; no npm registry dependencies are fetched by the module |

No global toolchain, daemon, or administrator rights are required for the
module itself.

## Pinned dependencies

| Component | Pin | Where |
|---|---|---|
| BentoPDF | `3a5f146d1b89d54dc7ca576aa6797c8bd3e42b97` (`v2.8.8-40-g3a5f146`, `bento-pdf` 2.8.8) | `upstream/bentopdf` submodule |
| bentopdf-pdfium-viewer | `813903c93c758dfb8df46dbd34ace3b7f7a8538b` | `upstream/engine` submodule |
| PDFium (EmbedPDF fork) | `fce2b000cc7a9e2cabc92db41cd57ca03233f07d` | engine's nested submodule `packages/pdfium/pdfium-src` |
| Emscripten (upstream build image) | `emscripten/emsdk:3.1.70` | engine `packages/pdfium/Dockerfile` |
| pnpm (engine workspace) | `pnpm@10.4.0` | engine root `package.json` `packageManager` |

The authoritative pins are the gitlinks in this repository; `.gitmodules` and
[`UPSTREAM.json`](../UPSTREAM.json) mirror them.

## Local setup (module only)

```sh
git clone --recurse-submodules https://github.com/Shinick-Han/falsify-pdf-editor.git
cd falsify-pdf-editor
git submodule status          # expect the two commits above, no leading '+'
npm run prepare:runtime
npm test
```

The engine's nested PDFium submodule is not needed to run the module and is
not fetched by these commands.

`npm run prepare:runtime` reads two blobs straight from the engine's Git
object store (not from the working tree, so Windows CRLF conversion cannot
alter them), verifies them, and writes ignored files:

| Upstream blob | Generated file | SHA-256 |
|---|---|---|
| `packages/pdfium/src/vendor/pdfium.wasm` (blob `0fe9a407282757a252a3d1abc9933c328f77d563`, 7,330,128 bytes) | `.runtime/editcore.wasm` | `1860f0b33a1c7d231b78fa9bfedace19739f06e80b1d5f654dd2ea77a7a893ce` |
| `packages/pdfium/src/vendor/pdfium.js` (blob `9cc85e4284d88e93c18f2cd12a97705b09cb6139`, 218,591 bytes) | `.runtime/editcore.js` | `6e6989a9994715951720e05355111aca7eab898e92b519ebea160167875bb3eb` |

A hash mismatch is a hard failure. To check by hand:

```sh
git -C upstream/engine cat-file blob 813903c93c758dfb8df46dbd34ace3b7f7a8538b:packages/pdfium/src/vendor/pdfium.wasm | sha256sum
git -C upstream/engine cat-file blob 813903c93c758dfb8df46dbd34ace3b7f7a8538b:packages/pdfium/src/vendor/pdfium.js | sha256sum
```

## What the hash proves, and what it does not

- **Verified:** the runtime files are byte-identical to the files committed in
  the public engine repository at the pinned commit. BentoPDF's vendored
  tarball for the same engine revision carries the same WASM and JS.
- **Not verified:** that those committed binaries are reproducible from the
  pinned C++ sources. This project has **not** run a full WebAssembly rebuild,
  produced its own WASM hash, or compared bit-for-bit output. Source/header
  syntax probes on a host compiler and successful application of the
  engine's `security-fixes` and `editcore-pdfium` patches to the pinned PDFium
  are partial checks only, not a build.

The corresponding source for the binaries is the engine at the pinned commit:
editcore C++ in `packages/pdfium/build/code/editcore/`, glue code in
`packages/pdfium/build/code/cpp/`, HarfBuzz in
`packages/pdfium/build/code/harfbuzz/`, PDFium patches in
`packages/pdfium/build/patch/`, and PDFium itself in the nested submodule.

## Upstream rebuild route (Linux / Docker, not executed here)

The engine documents a containerised build. The outline below is for anyone
attempting an **independent** rebuild in an isolated Linux machine or VM with
Docker already available. It was not run for this repository and its output
is not covered by the hashes above.

```sh
# from the repository root
git -C upstream/engine submodule update --init packages/pdfium/pdfium-src
cd upstream/engine/packages/pdfium
docker compose run --rm pdfium-build   # upstream script: "wasm:build"
```

What the upstream route does (see `Dockerfile`, `docker-compose.yml`,
`scripts/build.sh`, `build/compile.sh` in the engine):

1. Builds an image `FROM emscripten/emsdk:3.1.70` with apt packages, Node.js
   22 (NodeSource), `depot_tools` cloned from its `main` branch, a Rust
   toolchain from rustup, and PDFium's `install-build-deps.sh`.
2. Runs `gclient sync --no-history --shallow` against PDFium `DEPS` to fetch
   the Chromium build toolchain and third-party libraries.
3. Copies the GN toolchain overrides and applies `security-fixes.patch`,
   `editcore-pdfium.patch` and `brotli-decode.patch`.
4. Runs `gn gen` with a WebAssembly target and builds `libembedpdf.a` with
   ninja.
5. Links `code/cpp/*.cpp`, `code/editcore/*.cpp` and the static library with
   `em++ -O3 ... -sEXPORT_NAME=createPdfium` to produce `pdfium.js` and
   `pdfium.wasm`.

Expect several GB of downloads and over 10 GB of disk; these are estimates,
not measurements. Several inputs are **not pinned** by the upstream route
(`depot_tools` `main`, rustup, NodeSource 22.x, apt package versions), so a
rebuilt WASM may legitimately differ from the committed binary. Treat any
rebuilt output as a new artifact: record its own hash and test it before
using it in place of the upstream binary. Do not run the container as root on
a shared host or mount directories other than the engine checkout.

## Generated and ignored files

`.runtime/`, `node_modules/`, `output/`, PDFs and similar generated files are
ignored by Git and must not be committed. Regenerate `.runtime/` from the
pinned submodule with `npm run prepare:runtime`.
