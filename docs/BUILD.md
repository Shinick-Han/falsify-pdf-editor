# Build and provenance

The default Node.js setup does not compile C++ or WebAssembly: it runs the
**upstream committed binary** from the pinned engine repository. The optional
source-build script below produces separate local baseline/patched artifacts;
it does not overwrite the default runtime or change the existing Workbench.

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
- **Rebuilt once from source:** one local build with
  [`scripts/rebuild-wasm.sh`](../scripts/rebuild-wasm.sh) (see below) of the
  unmodified pinned sources produced `pdfium.wasm` and `pdfium.js` that are
  byte-identical to the committed blobs (SHA-256 `1860f0b3…a893ce` and
  `6e6989a9…7bb3eb`). This is one build on one host, not a demonstration that
  every build or every host reproduces these bytes.
- **Still not shipped:** the module runs the committed upstream binary. A
  locally rebuilt or patched binary is a separate artifact and is not used
  unless it is explicitly selected and tested.

The corresponding source for the binaries is the engine at the pinned commit:
editcore C++ in `packages/pdfium/build/code/editcore/`, glue code in
`packages/pdfium/build/code/cpp/`, HarfBuzz in
`packages/pdfium/build/code/harfbuzz/`, PDFium patches in
`packages/pdfium/build/patch/`, and PDFium itself in the nested submodule.

## Local source rebuild (`scripts/rebuild-wasm.sh`)

`scripts/rebuild-wasm.sh` translates the engine's containerised build to one
dedicated directory on a Linux host, without Docker, `sudo`, global apt
packages or global Git configuration. It was run on WSL Ubuntu with the build
directory on the Linux ext4 file system (not `/tmp`, not `/mnt/c`).

```sh
export BUILD_ROOT=$(mktemp -d "$HOME/editor-wasm-build.XXXXXX")
scripts/rebuild-wasm.sh fetch toolchain sync prepare configure lib
SNAPSHOT=baseline scripts/rebuild-wasm.sh exports link snapshot
# optional extra PDFium patch, then an incremental rebuild:
PATCH_REPO=pdfium PATCHES="$PWD/patches/pdfium-stream-order.patch" scripts/rebuild-wasm.sh patch lib exports link
SNAPSHOT=patched CANDIDATE_DIR=/new/empty/dir scripts/rebuild-wasm.sh snapshot
scripts/rebuild-wasm.sh inventory
```

`OUT_NAME` (default `wasm`) selects the GN output directory
`pdfium-src/out/$OUT_NAME`, so a full compile can be repeated beside an
existing one without cleaning it (`OUT_NAME=wasm-2 scripts/rebuild-wasm.sh
configure lib exports link`). The `provenance` stage describes an existing
snapshot that still matches the live tree:

```sh
SNAPSHOT=patched RECORD_PATCHES="pdfium=$PWD/patches/pdfium-stream-order.patch" \
  scripts/rebuild-wasm.sh provenance
```

`snapshot` (format `editor-wasm-build-snapshot/3`) records, for both the
engine and PDFium checkouts, the `HEAD` commit (file `heads`), the tracked
diff, `git status --porcelain --untracked-files=all` and an inventory of
untracked source files (`git ls-files --others --exclude-standard`, so ignored
build outputs and the gclient dependency checkouts are excluded) with the
SHA-256 of each file's content, plus `OUT_NAME`. All of them are listed in
`SHA256SUMS`. The tracked diff compares the worktree with the index, so the
index must equal `HEAD`: a checkout with staged changes, or with
assume-unchanged, skip-worktree or unmerged index entries (any `git ls-files
-v` tag other than `H`), is refused rather than recorded; unstage or clear
them first. An untracked symlink, nested repository or other non-regular
entry is refused (never followed), and nothing is created until the source
state has been read. Both `HEAD`s and indexes are checked again before
`SHA256SUMS` is written.
Untracked files created by the engine's build patches (for example
`core/fxcodec/brotli/`) or by extra patches are ordinary inventory entries.

`provenance` refuses a stale snapshot: outputs or static library differ, a
snapshot file is missing, tampered or not listed in `SHA256SUMS`, either
`HEAD` differs from the snapshot's `heads` (even a commit that changes no
content), either index no longer equals `HEAD` or carries assume-unchanged,
skip-worktree or unmerged entries, or either tree's tracked diff, status or
untracked inventory (added, deleted or changed file) differs from the
snapshot. `HEAD`s and indexes are checked again just before the record is
written. It refuses a listed patch that does not
reverse-apply in its repository and fails closed on every read: a git,
toolchain, hash or size command that exits nonzero (even with output) or
prints nothing stops the stage before any file is written. It then writes
`out/$SNAPSHOT/provenance.json` once (`editor-wasm-build-provenance/3`):
engine/PDFium URLs, the snapshot's commits, the `heads` digest, the index
condition, diff, status and untracked-inventory digests,
`OUT_NAME`, the engine's three build patches, extra patches, the script's own
SHA-256, toolchain versions (first line of each) and the SHA-256 and size of
each artifact. It describes one build root at one moment; it is not an
independent or clean-room build and not a signed attestation, and it does not
bind the nested gclient dependency revisions (`inventory` lists them).

Snapshots taken by earlier versions of the script (no `snapshot.format`, no
engine status or untracked inventory, or `editor-wasm-build-snapshot/2`
without `heads`) are refused by `provenance` with a migration message: take a
new snapshot under a new name and describe that. Their existing
`editor-wasm-build-provenance/1` and `/2` records stay as they are and do not
gain the stronger claims. None of these records verifies a build from source
(`sourceBuildVerified` stays `false` for candidates).

`test/rebuild-wasm-provenance.test.sh` exercises the snapshot and provenance
stages on a mock build root under `$HOME` (no toolchain or compile needed).

What it pins and isolates:

| Input | Pin |
|---|---|
| Engine | `813903c93c758dfb8df46dbd34ace3b7f7a8538b`, fetched by commit and checked against the PDFium gitlink |
| PDFium | `fce2b000cc7a9e2cabc92db41cd57ca03233f07d` |
| emsdk | `3.1.70` (emsdk `2514ec73…`, emscripten `b53978ee…`, clang 20 `f52b8956…`, bundled Node 20.18.0) |
| depot_tools | `6235028c6b18b73e68f5414f935ec537a25ea51a` (from PDFium `DEPS`, self-update disabled) |
| GN / Ninja | from PDFium `DEPS`: gn `bd3356ac13f4`, ninja 1.12.1 |
| PDFium third-party deps | `gclient sync --no-history --shallow --nohooks --deps=builder`; `inventory` records `gclient revinfo` |

The script uses a fixed `PATH`, `GIT_CONFIG_GLOBAL=/dev/null` with
`core.autocrlf=false`, and keeps every cache inside `BUILD_ROOT`. It refuses a
`BUILD_ROOT` that is `/`, a system directory, `$HOME`, a Windows mount, not
owned by the user, or not marked with `.editor-wasm-build-root` (written on
first use of an empty directory). It never deletes recursively, refuses to
move a dirty or foreign checkout, writes only known generated files in
`build/wasm`, never reuses a snapshot name and never overwrites an existing
candidate binary.

Measured on a 32-core / 30 GB WSL host at `-j8`: dependency sync about
3 minutes, the full `libembedpdf.a` about 2 minutes, the ESM link about
1 minute; about 8 GB of disk in total. The ESM output only is built; the
engine's CommonJS variant (`compile.sh`) is not.

Differences from the upstream container route: no `install-build-deps.sh`
(not needed for the WebAssembly target), no NodeSource Node.js (emsdk's Node
runs the export generators), no Rust/watchexec, and Python is the host's
`python3` for emscripten and depot_tools' own bundled Python for gclient.

### Tested patched artifact (local only)

The stream-order patch SHA-256 is
`87190eea70e6d99e7a3f408c43c9fdfe3068996bde818beaa94ec7fe46b4c00d`.
The observed ESM build produced:

| Artifact | SHA-256 |
|---|---|
| `pdfium.js` (same wrapper as baseline) | `6e6989a9994715951720e05355111aca7eab898e92b519ebea160167875bb3eb` |
| `pdfium.wasm` (patched C++ compiled and linked) | `12e43c4c2e7deedab629c3b08b14fc0b24c1336f92b7de30ac58d7ec6dcbb833` |

The baseline compiled all 1,132 ninja steps; after applying the patch, ninja
rebuilt the content generator and static archive, and em++ relinked the WASM.
Both variants used the same pinned dependencies and flags. The patched
artifact passed the coordinator's saved-document corpus checks; see
[`QUALITY.md`](QUALITY.md). No runtime binary or private corpus is distributed
in this repository. Select a locally built artifact with
[`prepare-candidate-runtime.mjs`](CANDIDATE_RUNTIME.md); the manifest itself is
not a signed build attestation. The collected build inventory contains 244
third-party notice/license records, not a legal compliance certification.

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
