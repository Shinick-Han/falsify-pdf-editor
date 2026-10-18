#!/usr/bin/env bash
# Focused tests for the snapshot and provenance stages of
# scripts/rebuild-wasm.sh on a mock build root (no toolchain, no compile).
#
# Run on a Linux host (WSL) with git and python3:
#   bash test/rebuild-wasm-provenance.test.sh
#
# The mock root is a new mktemp -d directory under $HOME (user-owned ext4).
# It is left in place for inspection; nothing is deleted.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT=$REPO/scripts/rebuild-wasm.sh
R=$(realpath -e -- "$(mktemp -d "$HOME/rebuild-wasm-test.XXXXXX")")
E=$R/src/engine
P=$E/packages/pdfium/pdfium-src
ATTIC=$R/attic
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
g() { git -c user.name=test -c user.email=test@example.invalid -c init.defaultBranch=main "$@"; }

failures=0
ok() { printf 'PASS %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }

# mock_tool PATH VAR LINE: prints LINE and a second line; VAR=fail prints LINE
# and exits 3, VAR=empty prints nothing and exits 0.
mock_tool() {
  mkdir -p -- "${1%/*}"
  cat > "$1" <<EOF
#!/bin/sh
case \${$2:-ok} in
  fail) echo "$3"; exit 3 ;;
  empty) exit 0 ;;
esac
echo "$3"
echo "second line"
EOF
  chmod +x -- "$1"
}

# --- fixture -------------------------------------------------------------
mkdir -p "$ATTIC" "$R/patches" "$P/core" "$E/editcore" "$E/packages/pdfium/build/patch"
printf 'a\n' > "$P/core/a.c"
printf 'b\n' > "$P/core/b.c"
printf '/out/\n/buildtools/\n/third_party/ninja/\n' > "$P/.gitignore"
g -C "$P" init -q
g -C "$P" remote add origin https://example.invalid/pdfium.git
g -C "$P" add -A
g -C "$P" commit -qm pdfium

cat > "$E/packages/pdfium/build/patch/security-fixes.patch" <<'EOF'
diff --git a/core/a.c b/core/a.c
--- a/core/a.c
+++ b/core/a.c
@@ -1 +1 @@
-a
+a fixed
EOF
cat > "$E/packages/pdfium/build/patch/editcore-pdfium.patch" <<'EOF'
diff --git a/core/b.c b/core/b.c
--- a/core/b.c
+++ b/core/b.c
@@ -1 +1 @@
-b
+b editcore
EOF
# Like the real brotli-decode patch, this one creates untracked files.
cat > "$E/packages/pdfium/build/patch/brotli-decode.patch" <<'EOF'
diff --git a/core/brotli/dec.c b/core/brotli/dec.c
new file mode 100644
--- /dev/null
+++ b/core/brotli/dec.c
@@ -0,0 +1 @@
+brotli
EOF
cat > "$R/patches/engine-extra.patch" <<'EOF'
diff --git a/editcore/x.cpp b/editcore/x.cpp
--- a/editcore/x.cpp
+++ b/editcore/x.cpp
@@ -1 +1 @@
-x
+x natural
diff --git a/editcore/natural.cpp b/editcore/natural.cpp
new file mode 100644
--- /dev/null
+++ b/editcore/natural.cpp
@@ -0,0 +1 @@
+natural
EOF
printf 'x\n' > "$E/editcore/x.cpp"
printf 'engine\n' > "$E/README"
printf 'packages/pdfium/build/wasm/\n' > "$E/.gitignore"
g -C "$E" init -q
g -C "$E" remote add origin https://example.invalid/engine.git
g -C "$E" -c advice.addEmbeddedRepo=false add -A 2>/dev/null
g -C "$E" commit -qm engine

for p in security-fixes editcore-pdfium brotli-decode; do
  g -C "$P" apply "$E/packages/pdfium/build/patch/$p.patch"
done
g -C "$E" apply "$R/patches/engine-extra.patch"
printf 'n1' > "$P/notes.txt"
printf 'e1' > "$E/notes.txt"

for t in emsdk depot_tools; do
  mkdir -p "$R/tools/$t"
  : > "$R/tools/$t/emsdk_env.sh"
  g -C "$R/tools/$t" init -q
  g -C "$R/tools/$t" add -A
  g -C "$R/tools/$t" commit -qm "$t"
done
mock_tool "$R/tools/emsdk/upstream/bin/emcc" MOCK_EMCC 'emcc (mock) 3.1.70'
mock_tool "$R/tools/emsdk/upstream/bin/clang" MOCK_CLANG 'clang version 20 (mock)'
mock_tool "$R/tools/emsdk/upstream/bin/node" MOCK_NODE 'v20.18.0'
mock_tool "$P/buildtools/linux64/gn" MOCK_GN '2190 (mock)'
mock_tool "$P/third_party/ninja/ninja" MOCK_NINJA '1.12.1'

WS=$E/packages/pdfium/build/wasm
mkdir -p "$WS" "$P/out/wasm/obj"
for f in pdfium.js pdfium.wasm exported-functions.txt exported-runtime-methods.txt; do
  printf '%s\n' "$f" > "$WS/$f"
done
printf 'lib\n' > "$P/out/wasm/obj/libembedpdf.a"

# --- helpers -------------------------------------------------------------
stage() { # stage NAME VAR=VALUE...: run one stage with extra environment
  local s=$1
  shift
  env BUILD_ROOT="$R" ADOPT_BUILD_ROOT="$R" RECORD_PATCHES="engine=$R/patches/engine-extra.patch" \
    "$@" bash "$SCRIPT" "$s" > "$R/last.out" 2> "$R/last.err"
}
snap() { stage snapshot SNAPSHOT="$1" || { cat "$R/last.err"; bad "snapshot $1"; return 1; }; }

check_json() {
  python3 - "$1" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
def walk(x, p=""):
    if isinstance(x, dict):
        for k, v in x.items(): walk(v, p + "/" + k)
    elif isinstance(x, list):
        for i, v in enumerate(x): walk(v, p + "/" + str(i))
    else:
        assert isinstance(x, str) and x, "empty value at " + p
walk(d)
assert d["schema"] == "editor-wasm-build-provenance/2", d["schema"]
assert d["snapshot_format"] == "editor-wasm-build-snapshot/2"
assert d["out_name"] == "wasm"
tc = d["toolchain"]
assert tc["emcc"] == "emcc (mock) 3.1.70", tc["emcc"]
assert tc["clang"] == "clang version 20 (mock)", tc["clang"]
assert tc["ninja"] == "1.12.1" and tc["gn"] == "2190 (mock)" and tc["node"] == "v20.18.0"
for r in ("engine", "pdfium"):
    assert len(d[r]["commit"]) == 40
    for k in ("diff_sha256", "status_sha256", "untracked_sha256"):
        assert len(d[r][k]) == 64, (r, k)
assert d["extra_patches"][0]["repo"] == "engine"
EOF
}

# expect_pass LABEL SNAPSHOT [VAR=VALUE...]
expect_pass() {
  local label=$1 s=$2
  shift 2
  if stage provenance SNAPSHOT="$s" "$@" && check_json "$R/out/$s/provenance.json"; then
    ok "$label"
  else
    cat "$R/last.err"
    bad "$label"
  fi
}

# expect_fail LABEL SNAPSHOT PATTERN [VAR=VALUE...]: nonzero exit, PATTERN on
# stderr and no provenance.json.
expect_fail() {
  local label=$1 s=$2 pat=$3 rc=0
  shift 3
  stage provenance SNAPSHOT="$s" "$@" || rc=$?
  if [[ $rc != 0 && ! -e $R/out/$s/provenance.json && ! -L $R/out/$s/provenance.json ]] &&
     grep -qF -- "$pat" "$R/last.err"; then
    ok "$label"
  else
    printf 'rc=%s\n' "$rc"
    cat "$R/last.err"
    bad "$label"
  fi
}

# resum DIR: rewrite SHA256SUMS consistently after a deliberate tamper.
resum() {
  ( cd "$1" && sha256sum -- pdfium.js pdfium.wasm exported-functions.txt exported-runtime-methods.txt \
      libembedpdf.a engine.diff pdfium.diff engine.status pdfium.status \
      engine.untracked pdfium.untracked snapshot.format > SHA256SUMS )
}

# --- tests ---------------------------------------------------------------
bash -n "$SCRIPT" && ok "bash -n" || bad "bash -n"

# Valid mock root; untracked files created by the engine build patch and the
# engine extra patch are inventoried and accepted.
snap s1
grep -q '  editcore/natural.cpp$' "$R/out/s1/engine.untracked" &&
  grep -q '  core/brotli/dec.c$' "$R/out/s1/pdfium.untracked" &&
  grep -qx '?? core/brotli/dec.c' "$R/out/s1/pdfium.status" &&
  ok "snapshot inventories legitimate untracked patch files" ||
  bad "snapshot inventories legitimate untracked patch files"
expect_pass "unchanged sources pass" s1

# Create-once guards.
before=$(sha256sum < "$R/out/s1/provenance.json")
if stage provenance SNAPSHOT=s1; then bad "provenance is create-once"; else
  grep -qF "provenance.json already exists" "$R/last.err" &&
    [[ $(sha256sum < "$R/out/s1/provenance.json") == "$before" ]] &&
    ok "provenance is create-once; existing record unchanged" ||
    bad "provenance is create-once; existing record unchanged"; fi
if stage snapshot SNAPSHOT=s1; then bad "snapshot name reuse refused"; else
  grep -qF "already exists" "$R/last.err" && ok "snapshot name reuse refused" ||
    bad "snapshot name reuse refused"; fi

# Toolchain reads: nonzero exit (even with stdout), empty output, missing tool,
# broken git reads. Each leaves no provenance.json, so one snapshot serves all.
snap s2
for t in EMCC CLANG NODE GN NINJA; do
  expect_fail "$t nonzero exit with stdout fails" s2 "command failed" "MOCK_$t=fail"
  expect_fail "$t empty output fails" s2 "empty output" "MOCK_$t=empty"
done
mv -- "$P/third_party/ninja/ninja" "$ATTIC/ninja"
expect_fail "missing ninja fails" s2 "command failed"
mv -- "$ATTIC/ninja" "$P/third_party/ninja/ninja"
mv -- "$R/tools/depot_tools/.git" "$ATTIC/depot_tools.git"
expect_fail "depot_tools without git repository fails" s2 "depot_tools"
mv -- "$ATTIC/depot_tools.git" "$R/tools/depot_tools/.git"
g -C "$E" remote rename origin upstream
expect_fail "missing engine origin fails" s2 "command failed: git -C $E remote get-url origin"
g -C "$E" remote rename upstream origin
expect_pass "same snapshot passes after the failures" s2

# Source tampering after snapshot, in both repositories.
n=0
for name in engine pdfium; do
  if [[ $name == engine ]]; then dir=$E; else dir=$P; fi
  n=$((n + 1))

  snap "add-$name"
  printf 'new\n' > "$dir/added.txt"
  expect_fail "$name: untracked file added fails" "add-$name" "tree changed since snapshot"
  mv -- "$dir/added.txt" "$ATTIC/added-$name.txt"
  expect_pass "$name: passes after the added file is moved away" "add-$name"

  snap "del-$name"
  mv -- "$dir/notes.txt" "$ATTIC/notes-$name.txt"
  expect_fail "$name: untracked file deleted fails" "del-$name" "tree changed since snapshot"
  mv -- "$ATTIC/notes-$name.txt" "$dir/notes.txt"
  expect_pass "$name: passes after the deleted file is restored" "del-$name"

  snap "chg-$name"
  cp -p -- "$dir/notes.txt" "$ATTIC/notes-$name.orig"
  printf 'X%s' "$n" > "$dir/notes.txt"
  expect_fail "$name: untracked content change (same size, same status) fails" "chg-$name" \
    "$name tree changed since snapshot (untracked files)"
  cp -p -- "$ATTIC/notes-$name.orig" "$dir/notes.txt"
  expect_pass "$name: passes after the content is restored" "chg-$name"

  snap "st-$name"
  printf '\n?? forged' >> "$R/out/st-$name/$name.status"
  expect_fail "$name: status tamper fails SHA256SUMS" "st-$name" "SHA256SUMS check failed"
  resum "$R/out/st-$name"
  expect_fail "$name: status tamper with rewritten SHA256SUMS fails" "st-$name" \
    "$name tree changed since snapshot (git status)"

  snap "inv-$name"
  printf '\n%064d  forged' 0 >> "$R/out/inv-$name/$name.untracked"
  resum "$R/out/inv-$name"
  expect_fail "$name: inventory tamper with rewritten SHA256SUMS fails" "inv-$name" \
    "$name tree changed since snapshot (untracked files)"

  snap "sum-$name"
  grep -v " $name.status\$" "$R/out/sum-$name/SHA256SUMS" > "$ATTIC/SHA256SUMS-$name"
  cp -- "$ATTIC/SHA256SUMS-$name" "$R/out/sum-$name/SHA256SUMS"
  expect_fail "$name: status missing from SHA256SUMS fails" "sum-$name" "does not list exactly"

  snap "miss-$name"
  mv -- "$R/out/miss-$name/$name.status" "$ATTIC/$name.status-miss"
  expect_fail "$name: missing status file fails" "miss-$name" "SHA256SUMS check failed"
done

# Untracked symlinks are refused and never followed.
ln -s /etc/hostname "$P/link.txt"
if stage snapshot SNAPSHOT=lnk; then bad "snapshot refuses an untracked symlink"; else
  grep -qF "untracked symlink" "$R/last.err" && [[ ! -e $R/out/lnk ]] &&
    ok "snapshot refuses an untracked symlink and creates nothing" ||
    bad "snapshot refuses an untracked symlink and creates nothing"; fi
mv -- "$P/link.txt" "$ATTIC/link.txt"
# A symlink added after the snapshot changes git status, which is checked
# before the inventory; either way it fails before anything is written.
snap lnk2
ln -s /etc/hostname "$E/link.txt"
expect_fail "provenance refuses an untracked symlink added after snapshot" lnk2 \
  "engine tree changed since snapshot (git status)"
mv -- "$E/link.txt" "$ATTIC/link2.txt"
expect_pass "passes after the symlink is moved away" lnk2

# Legacy snapshot (old layout: no snapshot.format, status or inventories).
snap base
mkdir "$R/out/legacy"
( cd "$R/out/base" && cp -- pdfium.js pdfium.wasm exported-functions.txt exported-runtime-methods.txt \
    libembedpdf.a engine.diff pdfium.diff "$R/out/legacy/" )
g -C "$P" status --porcelain > "$R/out/legacy/pdfium.status"
( cd "$R/out/legacy" && sha256sum pdfium.js pdfium.wasm exported-functions.txt \
    exported-runtime-methods.txt libembedpdf.a engine.diff pdfium.diff > SHA256SUMS )
expect_fail "legacy snapshot is refused with a migration message" legacy "legacy snapshot"
grep -qF "Migrate by taking a new snapshot" "$R/last.err" &&
  ok "legacy refusal names the migration" || bad "legacy refusal names the migration"

# The snapshot binds its OUT_NAME.
expect_fail "OUT_NAME mismatch fails" base "out_name=other" OUT_NAME=other

# Tracked change (pre-existing check, now fail-closed hashing).
printf 'engine 2\n' > "$E/README"
expect_fail "engine tracked change fails" base "engine tree changed since snapshot (tracked diff)"
printf 'engine\n' > "$E/README"
expect_pass "base passes after the tracked change is reverted" base

printf '\nmock root: %s\n' "$R"
if (( failures )); then printf '%d failure(s)\n' "$failures"; exit 1; fi
printf 'all passed\n'
