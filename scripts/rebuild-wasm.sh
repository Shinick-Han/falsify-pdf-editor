#!/usr/bin/env bash
# Local, scoped rebuild of the editcore PDFium WebAssembly runtime.
#
# Translates the engine's containerised route (packages/pdfium/Dockerfile,
# scripts/build.sh, build/compile.esm.sh) to one build directory on a Linux
# host (tested on WSL Ubuntu, ext4) without Docker, sudo, global apt packages
# or global git configuration. Everything lives under $BUILD_ROOT.
#
# Usage:
#   BUILD_ROOT=$(mktemp -d "$HOME/editor-wasm-build.XXXXXX")
#   BUILD_ROOT=... scripts/rebuild-wasm.sh <stage>...
#
# BUILD_ROOT must be a dedicated real directory owned by the current user. On
# first use it must be empty; the script then writes the ownership marker
# .editor-wasm-build-root and refuses any directory without it. To adopt an
# existing non-empty directory, set ADOPT_BUILD_ROOT to its canonical path.
#
# Stages (run in this order; each is idempotent where practical):
#   fetch       fetch the engine and PDFium at their pinned commits
#   toolchain   emsdk EMSDK_VERSION install/activate; depot_tools at the
#               revision pinned in PDFium DEPS
#   sync        gclient sync --no-history --shallow --nohooks --deps=builder
#   prepare     copy the engine's GN overrides and apply its PDFium patches
#   patch       apply extra patches: PATCH_REPO=engine|pdfium PATCHES="a b"
#   configure   gn gen out/wasm with the engine's arguments
#   lib         ninja pdfium -> out/wasm/obj/libembedpdf.a
#   exports     clang AST dump of public headers -> exported-*.txt
#   link        em++ ESM link -> build/wasm/pdfium.{js,wasm}
#   snapshot    copy outputs to a new $BUILD_ROOT/out/$SNAPSHOT and, if set,
#               to CANDIDATE_DIR (new or empty apart from package.json)
#   inventory   record tool versions, gclient revinfo and license files
#
# The output is a new artifact. It is not expected to be byte-identical to the
# binary committed upstream and must be tested before use.
set -euo pipefail

die() { printf 'rebuild-wasm: %s\n' "$*" >&2; exit 1; }
log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

: "${BUILD_ROOT:?set BUILD_ROOT to the build directory}"
ENGINE_URL=${ENGINE_URL:-https://github.com/alam00000/bentopdf-pdfium-viewer.git}
ENGINE_REV=${ENGINE_REV:-813903c93c758dfb8df46dbd34ace3b7f7a8538b}
PDFIUM_URL=${PDFIUM_URL:-https://github.com/embedpdf/pdfium.git}
PDFIUM_REV=${PDFIUM_REV:-fce2b000cc7a9e2cabc92db41cd57ca03233f07d}
EMSDK_URL=${EMSDK_URL:-https://github.com/emscripten-core/emsdk.git}
EMSDK_VERSION=${EMSDK_VERSION:-3.1.70}
DEPOT_TOOLS_URL=${DEPOT_TOOLS_URL:-https://chromium.googlesource.com/chromium/tools/depot_tools.git}
JOBS=${JOBS:-8}
SNAPSHOT=${SNAPSHOT:-build}
CANDIDATE_DIR=${CANDIDATE_DIR:-}
MARKER_NAME=.editor-wasm-build-root

# guard_build_root: canonical, real, user-owned, not a system or home
# directory, and carrying (or explicitly adopting) the ownership marker.
guard_build_root() {
  [[ -d $BUILD_ROOT && ! -L $BUILD_ROOT ]] ||
    die "BUILD_ROOT must be an existing real directory (create it with mktemp -d)"
  BUILD_ROOT=$(realpath -e -- "$BUILD_ROOT")
  local home
  home=$(realpath -m -- "${HOME:-/}")
  case $BUILD_ROOT in
    /|/home|/root|/tmp|/var|/var/tmp|/usr|/usr/*|/etc|/etc/*|/bin|/sbin|/lib*|/opt|/mnt|/mnt/*|/proc*|/sys*|/dev*)
      die "refusing BUILD_ROOT=$BUILD_ROOT (system, shared or Windows-mounted directory)" ;;
  esac
  [[ $BUILD_ROOT != "$home" ]] || die "refusing BUILD_ROOT equal to HOME"
  [[ $home != "$BUILD_ROOT"/* ]] || die "refusing BUILD_ROOT that contains HOME"
  [[ $(stat -c %u -- "$BUILD_ROOT") == "$(id -u)" ]] || die "BUILD_ROOT is not owned by $(id -un)"
  local marker=$BUILD_ROOT/$MARKER_NAME
  [[ ! -L $marker ]] || die "$marker is a symlink"
  if [[ ! -e $marker ]]; then
    if [[ -n $(ls -A -- "$BUILD_ROOT") && ${ADOPT_BUILD_ROOT:-} != "$BUILD_ROOT" ]]; then
      die "BUILD_ROOT is not empty and has no $MARKER_NAME; set ADOPT_BUILD_ROOT=$BUILD_ROOT to adopt it"
    fi
    printf 'editor-wasm-build-root\npath=%s\nuid=%s\ncreated=%s\n' \
      "$BUILD_ROOT" "$(id -u)" "$(date -u +%FT%TZ)" > "$marker"
    log "ownership marker written: $marker"
  fi
  [[ -f $marker ]] && grep -qxF "path=$BUILD_ROOT" "$marker" ||
    die "$marker does not name $BUILD_ROOT"
}

# real_dir DIR: create DIR (and parents) unless it exists; refuse symlinks
# and non-directories.
real_dir() {
  [[ ! -L $1 ]] || die "refusing symlink: $1"
  [[ ! -e $1 || -d $1 ]] || die "not a directory: $1"
  mkdir -p -- "$1"
}

guard_build_root
TOOLS=$BUILD_ROOT/tools
EMSDK_DIR=$TOOLS/emsdk
DEPOT_TOOLS=$TOOLS/depot_tools
ENGINE=$BUILD_ROOT/src/engine
PDFIUM=$ENGINE/packages/pdfium
SRC=$PDFIUM/pdfium-src
OUT=$SRC/out/wasm
WS=$PDFIUM/build/wasm
# Files the exports and link stages may (over)write in $WS, and nothing else.
WS_FILES=(all.h ast.json exported-functions.txt exported-runtime-methods.txt
          functions.ts runtime-methods.ts pdfium.js pdfium.wasm)

for d in "$TOOLS" "$BUILD_ROOT/src" "$BUILD_ROOT/cache" "$BUILD_ROOT/logs" "$BUILD_ROOT/out"; do
  real_dir "$d"
done

# Isolation: fixed PATH (no Windows interop entries), no user or system git
# config, caches inside BUILD_ROOT, no depot_tools self-update, C locale.
export LC_ALL=C TZ=UTC
export PATH=/usr/local/bin:/usr/bin:/bin
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=false
export GIT_CONFIG_KEY_1=advice.detachedHead GIT_CONFIG_VALUE_1=false
export XDG_CACHE_HOME=$BUILD_ROOT/cache
export XDG_CONFIG_HOME=$BUILD_ROOT/cache/config
export VPYTHON_VIRTUALENV_ROOT=$BUILD_ROOT/cache/vpython
export CIPD_CACHE_DIR=$BUILD_ROOT/cache/cipd
export DEPOT_TOOLS_UPDATE=0 DEPOT_TOOLS_METRICS=0
export EM_CACHE=$BUILD_ROOT/cache/emscripten

# fetch_pinned DIR URL REV: shallow fetch of one commit, verified by hash.
# An existing checkout already at REV is kept as is (it may carry applied
# patches). Any other existing checkout is moved only if it is clean and its
# origin is URL; a non-empty non-git directory is refused.
fetch_pinned() {
  local dir=$1 url=$2 rev=$3
  [[ ! -L $dir ]] || die "refusing symlink: $dir"
  if [[ -d $dir/.git ]]; then
    if [[ $(git -C "$dir" rev-parse HEAD 2>/dev/null) == "$rev" ]]; then
      log "$dir already at $rev"
      return
    fi
    [[ $(git -C "$dir" remote get-url origin 2>/dev/null) == "$url" ]] ||
      die "$dir is not an owned checkout of $url; refusing to move it"
    [[ -z $(git -C "$dir" status --porcelain --untracked-files=all) ]] ||
      die "$dir has local changes; refusing to check out $rev over them"
  elif [[ -e $dir && ( ! -d $dir || -n $(ls -A -- "$dir") ) ]]; then
    die "$dir exists and is not a git checkout; refusing"
  else
    git init -q "$dir"
    git -C "$dir" remote add origin "$url"
  fi
  git -C "$dir" fetch --depth 1 origin "$rev"
  git -C "$dir" checkout -q --detach FETCH_HEAD
  [[ $(git -C "$dir" rev-parse HEAD) == "$rev" ]] || die "pin mismatch in $dir"
}

# prepare_ws: $WS is a real directory holding only known generated files.
prepare_ws() {
  real_dir "$WS"
  local e name ok f
  shopt -s nullglob dotglob
  for e in "$WS"/*; do
    name=${e##*/}
    ok=
    for f in "${WS_FILES[@]}"; do [[ $name == "$f" ]] && ok=1; done
    [[ -n $ok ]] || die "unexpected entry in $WS: $name"
    [[ -f $e && ! -L $e ]] || die "not a regular file: $e"
  done
  shopt -u nullglob dotglob
}

activate_tools() {
  if [[ -f $EMSDK_DIR/emsdk_env.sh ]]; then
    # shellcheck disable=SC1091
    EMSDK_QUIET=1 source "$EMSDK_DIR/emsdk_env.sh" >/dev/null
    export PATH="$EMSDK_DIR/upstream/bin:$PATH"
  fi
  if [[ -d $DEPOT_TOOLS ]]; then export PATH="$PATH:$DEPOT_TOOLS"; fi
}

stage_fetch() {
  fetch_pinned "$ENGINE" "$ENGINE_URL" "$ENGINE_REV"
  local gitlink
  gitlink=$(git -C "$ENGINE" ls-tree HEAD packages/pdfium/pdfium-src | awk '{print $3}')
  [[ $gitlink == "$PDFIUM_REV" ]] || die "engine gitlink $gitlink != $PDFIUM_REV"
  fetch_pinned "$SRC" "$PDFIUM_URL" "$PDFIUM_REV"
}

stage_toolchain() {
  if [[ -d $EMSDK_DIR/.git ]]; then
    [[ -z $(git -C "$EMSDK_DIR" status --porcelain --untracked-files=no) ]] ||
      die "$EMSDK_DIR has local changes"
  else
    [[ ! -e $EMSDK_DIR ]] || die "$EMSDK_DIR exists and is not a git checkout"
    git clone -q "$EMSDK_URL" "$EMSDK_DIR"
  fi
  git -C "$EMSDK_DIR" checkout -q --detach "$EMSDK_VERSION"
  ( cd "$EMSDK_DIR" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION" )
  local rev
  rev=$(sed -n "s/^ *'depot_tools_revision': '\([0-9a-f]\{40\}\)',.*/\1/p" "$SRC/DEPS")
  [[ -n $rev ]] || die "depot_tools_revision not found; run fetch first"
  if [[ -d $DEPOT_TOOLS/.git ]]; then
    [[ -z $(git -C "$DEPOT_TOOLS" status --porcelain --untracked-files=no) ]] ||
      die "$DEPOT_TOOLS has local changes"
  else
    [[ ! -e $DEPOT_TOOLS ]] || die "$DEPOT_TOOLS exists and is not a git checkout"
    git clone -q --no-checkout "$DEPOT_TOOLS_URL" "$DEPOT_TOOLS"
  fi
  git -C "$DEPOT_TOOLS" checkout -q --detach "$rev"
  [[ $(git -C "$DEPOT_TOOLS" rev-parse HEAD) == "$rev" ]] || die "depot_tools pin mismatch"
  log "emsdk $(git -C "$EMSDK_DIR" rev-parse HEAD), depot_tools $rev"
}

stage_sync() {
  activate_tools
  # Same solution as the engine's scripts/build.sh. It is unmanaged, so
  # gclient leaves the pinned PDFium checkout alone and fetches its DEPS.
  if [[ ! -f $ENGINE/.gclient ]]; then
    ( cd "$ENGINE" && gclient config --unmanaged --name packages/pdfium/pdfium-src \
        https://pdfium.googlesource.com/pdfium.git )
  fi
  ( cd "$SRC" && gclient sync --no-history --shallow --nohooks --deps=builder )
  [[ $(git -C "$SRC" rev-parse HEAD) == "$PDFIUM_REV" ]] || die "PDFium moved during sync"
}

stage_prepare() {
  cp -f "$PDFIUM/build/patch/build/config/BUILDCONFIG.gn" "$SRC/build/config/BUILDCONFIG.gn"
  real_dir "$SRC/build/toolchain/wasm"
  cp -f "$PDFIUM/build/patch/build/toolchain/wasm/BUILD.gn" "$SRC/build/toolchain/wasm/BUILD.gn"
  local p
  for p in security-fixes editcore-pdfium brotli-decode; do
    if git -C "$SRC" apply --reverse --check "$PDFIUM/build/patch/$p.patch" >/dev/null 2>&1; then
      log "$p already applied"
    else
      git -C "$SRC" apply "$PDFIUM/build/patch/$p.patch"
      log "$p applied"
    fi
  done
}

stage_patch() {
  local repo p
  case ${PATCH_REPO:-} in
    engine) repo=$ENGINE ;;
    pdfium) repo=$SRC ;;
    *) die "PATCH_REPO must be engine or pdfium" ;;
  esac
  for p in ${PATCHES:?set PATCHES to patch file paths}; do
    [[ -f $p && ! -L $p ]] || die "not a regular patch file: $p"
    sha256sum -- "$p"
    if git -C "$repo" apply --reverse --check "$p" >/dev/null 2>&1; then
      log "already applied: $p"
    else
      git -C "$repo" apply --check "$p"
      git -C "$repo" apply "$p"
      log "applied: $p"
    fi
  done
}

stage_configure() {
  activate_tools
  "$SRC/buildtools/linux64/gn" gen "$OUT" --root="$SRC" --args='is_debug=false treat_warnings_as_errors=false pdf_use_skia=false pdf_enable_xfa=false pdf_enable_v8=false is_component_build=false clang_use_chrome_plugins=false pdf_is_standalone=true use_debug_fission=false use_custom_libcxx=false use_sysroot=false pdf_is_complete_lib=true pdf_use_partition_alloc=false is_clang=false symbol_level=0 target_os="wasm" target_cpu="wasm"'
}

stage_lib() {
  activate_tools
  "$SRC/third_party/ninja/ninja" -C "$OUT" pdfium -j "$JOBS"
  sha256sum "$OUT/obj/libembedpdf.a"
}

stage_exports() {
  activate_tools
  prepare_ws
  ( cd "$SRC" &&
    find public -path public/cpp -prune -o -name '*.h' -print |
    sort | sed 's|^|#include "|;s|$|"|' ) > "$WS/all.h"
  echo '#include "../build/code/cpp/ext_api.h"' >> "$WS/all.h"
  echo '#include "editcore.h"' >> "$WS/all.h"
  # Include paths as in the engine's scripts/build.sh (ext_api.h resolves
  # through -I"$SRC").
  clang -std=c11 -I"$SRC" -I"$ENGINE/build/code/cpp" -I"$SRC/public" -I"$PDFIUM/build/code/editcore" \
        -fsyntax-only -Xclang -ast-dump=json "$WS/all.h" > "$WS/ast.json"
  node "$PDFIUM/build/generate-functions.mjs" "$WS/ast.json" "$WS"
  node "$PDFIUM/build/generate-runtime-methods.mjs" "$WS"
  prepare_ws
  sha256sum "$WS/exported-functions.txt" "$WS/exported-runtime-methods.txt"
}

stage_link() {
  activate_tools
  prepare_ws
  cd "$PDFIUM/build"
  # Flags mirror build/compile.esm.sh with /workspace made relative to this
  # checkout.
  # shellcheck disable=SC2046
  em++ $(ls ./code/cpp/*.cpp) $(ls ./code/editcore/*.cpp) \
    "$OUT/obj/libembedpdf.a" \
    -v \
    -sEXPORT_ES6=1 \
    -sENVIRONMENT=node,worker,web,shell \
    -sMODULARIZE=1 \
    -sWASM=1 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sALLOW_TABLE_GROWTH=1 \
    -sEXPORT_NAME=createPdfium \
    -sUSE_ZLIB=1 \
    -sASSERTIONS=0 \
    -O3 \
    -sEXPORTED_RUNTIME_METHODS="$(cat ./wasm/exported-runtime-methods.txt)" \
    -sEXPORTED_FUNCTIONS="$(cat ./wasm/exported-functions.txt)" \
    -lembedpdf \
    -L"$OUT/obj" \
    -I"$SRC/public" \
    -I./code/editcore \
    -I./code/harfbuzz/src \
    -std=c++17 \
    -Wall \
    --no-entry \
    -o ./wasm/pdfium.js
  prepare_ws
  sha256sum ./wasm/pdfium.js ./wasm/pdfium.wasm
}

# guard_candidate_dir: CANDIDATE_DIR is new, or a real directory that holds
# at most a package.json; never an existing pdfium.js/pdfium.wasm.
guard_candidate_dir() {
  local c e
  c=$(realpath -m -- "$CANDIDATE_DIR")
  case $c in /|/home|/mnt|/mnt/?|/tmp) die "refusing CANDIDATE_DIR=$c" ;; esac
  [[ $c != "$BUILD_ROOT" && $c != "$(realpath -m -- "${HOME:-/}")" ]] ||
    die "CANDIDATE_DIR must be a dedicated directory"
  [[ ! -L $CANDIDATE_DIR ]] || die "refusing symlink CANDIDATE_DIR"
  if [[ -e $c ]]; then
    [[ -d $c ]] || die "CANDIDATE_DIR is not a directory"
    shopt -s nullglob dotglob
    for e in "$c"/*; do
      [[ ${e##*/} == package.json && -f $e && ! -L $e ]] ||
        die "CANDIDATE_DIR is not empty (found ${e##*/}); refusing to overwrite"
    done
    shopt -u nullglob dotglob
  fi
  CANDIDATE_DIR=$c
}

stage_snapshot() {
  [[ $SNAPSHOT =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "SNAPSHOT must be a simple name"
  [[ -z $CANDIDATE_DIR ]] || guard_candidate_dir
  prepare_ws
  local dest=$BUILD_ROOT/out/$SNAPSHOT
  [[ ! -e $dest && ! -L $dest ]] || die "$dest already exists; choose a new SNAPSHOT"
  mkdir -- "$dest"
  cp -- "$WS/pdfium.js" "$WS/pdfium.wasm" "$WS/exported-functions.txt" \
        "$WS/exported-runtime-methods.txt" "$OUT/obj/libembedpdf.a" "$dest/"
  git -C "$ENGINE" diff --binary > "$dest/engine.diff"
  git -C "$SRC" diff --binary > "$dest/pdfium.diff"
  git -C "$SRC" status --porcelain > "$dest/pdfium.status"
  ( cd "$dest" && sha256sum pdfium.js pdfium.wasm exported-functions.txt \
      exported-runtime-methods.txt libembedpdf.a engine.diff pdfium.diff | tee SHA256SUMS )
  if [[ -n $CANDIDATE_DIR ]]; then
    mkdir -p -- "$CANDIDATE_DIR"
    # guard_candidate_dir has already refused existing pdfium.js/pdfium.wasm.
    cp -- "$dest/pdfium.js" "$dest/pdfium.wasm" "$CANDIDATE_DIR/"
    ( cd "$CANDIDATE_DIR" && sha256sum pdfium.js pdfium.wasm )
    cmp -s "$dest/pdfium.wasm" "$CANDIDATE_DIR/pdfium.wasm" &&
      cmp -s "$dest/pdfium.js" "$CANDIDATE_DIR/pdfium.js" || die "candidate copy mismatch"
  fi
}

stage_inventory() {
  activate_tools
  local inv=$BUILD_ROOT/out/inventory
  real_dir "$inv"
  {
    echo "emsdk $(git -C "$EMSDK_DIR" rev-parse HEAD) ($EMSDK_VERSION)"
    echo "depot_tools $(git -C "$DEPOT_TOOLS" rev-parse HEAD)"
    echo "engine $(git -C "$ENGINE" rev-parse HEAD)"
    echo "pdfium $(git -C "$SRC" rev-parse HEAD)"
    emcc --version | head -1
    clang --version | head -1
    echo "node $(node --version)"
    python3 --version
    echo "gn $("$SRC/buildtools/linux64/gn" --version)"
    echo "ninja $("$SRC/third_party/ninja/ninja" --version)"
  } > "$inv/tools.txt" 2>&1
  ( cd "$ENGINE" && gclient revinfo ) > "$inv/revinfo.txt" 2>&1 || true
  ( cd "$BUILD_ROOT" &&
    find src/engine/packages/pdfium/pdfium-src src/engine/packages/pdfium/build/code \
         src/engine/packages/pdfium/LICENSE src/engine/packages/pdfium/LICENSE.pdfium \
         src/engine/LICENSE src/engine/NOTICE tools/emsdk/LICENSE \
         tools/emsdk/upstream/emscripten/LICENSE \
         -path '*/out' -prune -o -type f \
         \( -iname 'LICENSE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' -o -name README.chromium -o -name README.pdfium \) \
         -print 2>/dev/null | sort | xargs -r sha256sum ) > "$inv/licenses.sha256" || true
  wc -l < "$inv/licenses.sha256"
  cat "$inv/tools.txt"
}

[[ $# -gt 0 ]] || { sed -n '2,35p' "$0"; exit 2; }
for stage in "$@"; do
  case $stage in
    fetch|toolchain|sync|prepare|patch|configure|lib|exports|link|snapshot|inventory) ;;
    *) die "unknown stage: $stage" ;;
  esac
  log "stage $stage start"
  ( "stage_$stage" )
  log "stage $stage done"
done
exit 0
