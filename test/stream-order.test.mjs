// Source-level tests for patches/pdfium-stream-order.patch. They do NOT build
// PDFium or WASM: the patch's own added C++ (extracted verbatim from the patch
// file) is compiled against minimal stand-in types and driven through the
// same dirty-stream flow as CPDF_PageContentGenerator::GenerateModifiedStreams.
// Real serialization, CTM and graphics-state behaviour need the rebuilt WASM.
// Skipped when no host g++ (native or `wsl.exe -e g++`) is available.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const PATCH = new URL("../patches/pdfium-stream-order.patch", import.meta.url);
const TARGET = "core/fpdfapi/edit/cpdf_pagecontentgenerator.cpp";
const text = readFileSync(PATCH, "utf8");

function hunks(diff) {
  const out = [];
  let cur = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) out.push((cur = { added: [], removed: [], next: [] }));
    else if (!cur) continue;
    else if (line.startsWith("+")) { cur.added.push(line.slice(1)); cur.next.push(line.slice(1)); }
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
    else if (line.startsWith(" ")) cur.next.push(line.slice(1));
  }
  return out;
}

// Lines from the first line containing `start` through the line containing
// `end`, or (without `end`) through the line where braces balance again.
function slice(lines, start, end) {
  const i = lines.findIndex((l) => l.includes(start));
  assert.ok(i >= 0, `patch hunk lacks ${start}`);
  let depth = 0;
  for (let j = i; j < lines.length; j++) {
    if (end && lines[j].includes(end)) return lines.slice(i, j + 1).join("\n");
    for (const c of lines[j]) depth += c === "{" ? 1 : c === "}" ? -1 : 0;
    if (!end && j > i && depth === 0) return lines.slice(i, j + 1).join("\n");
  }
  assert.fail(`unterminated block from ${start}`);
}

test("patch is additive, single-file and LF", () => {
  const files = [...text.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(files, [TARGET]);
  assert.ok(!text.includes("\r"), "patch must be LF");
  const hs = hunks(text);
  assert.equal(hs.length, 2);
  // No existing generator line (stream prolog/epilogue, CTM handoff, marks,
  // resource pruning) is removed or rewritten; only lines are added.
  for (const h of hs) assert.deepEqual(h.removed, []);
});

const HARNESS = (appendOnly, rebind) => `
#include <cstdint>
#include <iostream>
#include <set>
#include <sstream>
#include <string>
#include <vector>
struct CPDF_PageObject {
  static constexpr int32_t kNoContentStream = -1;
  int32_t stream; bool active;
  int32_t GetContentStream() const { return stream; }
  void SetContentStream(int32_t s) { stream = s; }
  bool IsActive() const { return active; }
};
template <class T> struct UnownedPtr {
  T* p; T* operator->() const { return p; } T* get() const { return p; }
};
using Objs = std::vector<UnownedPtr<CPDF_PageObject>>;
static bool AppendOnly(const Objs& page_objects_, std::set<int32_t> marked_dirty_streams,
                       std::set<int32_t> all_dirty_streams) {
${appendOnly}
  return append_only;
}
static void Rebind(const Objs& page_objects_, int32_t last_index,
                   std::set<int32_t>& all_dirty_streams) {
${rebind}
}
// Input line: "<last_index> <marked csv or -> <objs...>", obj = stream index
// with optional trailing 'i' for inactive. Every streamless object counts as
// dirty (freshly inserted), as do the marked streams (removed objects).
int main() {
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    std::istringstream in(line);
    int32_t last_index; std::string marked_csv, tok;
    in >> last_index >> marked_csv;
    std::set<int32_t> marked;
    if (marked_csv != "-") {
      std::istringstream m(marked_csv);
      for (std::string v; std::getline(m, v, ',');) marked.insert(std::stoi(v));
    }
    std::vector<CPDF_PageObject> store;
    while (in >> tok) {
      bool active = tok.back() != 'i';
      if (!active) tok.pop_back();
      store.push_back({std::stoi(tok), active});
    }
    Objs objs;
    for (auto& o : store) objs.push_back({&o});
    std::set<int32_t> dirty = marked;
    for (auto& o : store) if (o.stream < 0) dirty.insert(o.stream);
    const bool append_only = AppendOnly(objs, marked, dirty);
    if (!append_only && !dirty.empty()) {
      for (int32_t i = 0; i <= last_index; ++i) dirty.insert(i);
      Rebind(objs, last_index, dirty);
    }
    std::cout << (append_only ? "append" : "regen") << " |";
    for (auto& o : store) std::cout << ' ' << o.stream << (o.active ? "" : "i");
    std::cout << " |" << (dirty.count(-1) ? " appended" : "") << "\\n";
  }
}
`;

function compiler() {
  const native = spawnSync("g++", ["--version"], { encoding: "utf8" });
  if (native.status === 0) return { pre: ["g++"], cmd: "g++", path: (p) => p, wsl: false };
  if (process.platform !== "win32") return null;
  const wsl = spawnSync("wsl.exe", ["-e", "g++", "--version"], { encoding: "utf8" });
  if (wsl.status !== 0) return null;
  const path = (p) =>
    spawnSync("wsl.exe", ["-e", "wslpath", "-a", p.replaceAll("\\", "/")], { encoding: "utf8" }).stdout.trim();
  return { path, wsl: true };
}

function run(cases) {
  const cc = compiler();
  if (!cc) return null;
  const [h1, h2] = hunks(text);
  const appendOnly = slice(h1.next, "bool streamless_precedes_streamed", "kNoContentStream) == 1;");
  const rebind = slice(h2.next, "if (last_index >= 0) {");
  const dir = mkdtempSync(join(tmpdir(), "fpe-stream-order-"));
  const src = join(dir, "h.cpp");
  const exe = join(dir, "h.out");
  writeFileSync(src, HARNESS(appendOnly, rebind));
  const args = ["-std=c++20", "-Wall", "-Werror", "-o", cc.path(exe), cc.path(src)];
  const build = cc.wsl
    ? spawnSync("wsl.exe", ["-e", "g++", ...args], { encoding: "utf8" })
    : spawnSync("g++", args, { encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const input = cases.join("\n") + "\n";
  const res = cc.wsl
    ? spawnSync("wsl.exe", ["-e", cc.path(exe)], { input, encoding: "utf8" })
    : spawnSync(exe, [], { input, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim().split("\n").map((l) => l.trim());
}

// [input, expected]; see the harness for the line format. Stream indices
// after the first "|" are the post-pass bindings in object-list order.
const CASES = [
  // Middle insertion after the original paragraph was removed from stream 0.
  ["1 0 0 0 -1 0 1 1", "regen | 0 0 0 0 1 1 |"],
  // Front insertion: a leading new object joins the first following stream.
  ["1 0 -1 0 0 1", "regen | 0 0 0 1 |"],
  // Tail, nothing removed: genuine append, untouched streams are not rewritten.
  ["1 - 0 1 -1", "append | 0 1 -1 | appended"],
  // Tail after a removal: bound to the last stream, still painted last.
  ["1 1 0 1 -1", "regen | 0 1 1 |"],
  // Pure insertion without any removal is no longer treated as an append.
  ["0 - 0 -1 0", "regen | 0 0 0 |"],
  // Inactive objects neither donate a stream nor get rebound.
  ["1 0 0 -1i -1 1i 1", "regen | 0 -1i 0 1i 1 |"],
  ["1 0 0 1i -1 1", "regen | 0 1i 0 1 |"],
  // Existing streams but no remaining streamed object: keep the appended stream.
  ["0 0 -1 -1", "regen | -1 -1 | appended"],
  // Page without /Contents: unchanged behaviour (one new stream).
  ["-1 - -1", "append | -1 | appended"],
  ["-1 - -1 -1", "append | -1 -1 | appended"],
  // Multi-stream page: each new object lands in its predecessor's stream.
  ["2 1 0 0 -1 1 1 -1 2", "regen | 0 0 0 1 1 1 2 |"],
  // Stale out-of-range index is neither a donor nor rebound.
  ["0 0 0 5 -1", "regen | 0 5 0 |"],
  // KNOWN LIMITATION, not a fix: existing objects reordered across streams
  // (non-monotonic indices) keep their stream and the generator still writes
  // stream 0 before stream 1, so their list order is NOT restored. This only
  // asserts that the pass never rebinds an existing object.
  ["1 0 1 0 -1 0", "regen | 1 0 0 0 |"],
];

test("added C++ binds only streamless objects, in list order", (t) => {
  const out = run(CASES.map(([i]) => i));
  if (!out) return t.skip("no host g++ (native or WSL)");
  assert.deepEqual(out, CASES.map(([, e]) => e));
});
