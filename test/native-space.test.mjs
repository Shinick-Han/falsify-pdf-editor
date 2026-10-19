// Source-level tests for patches/editcore-natural-space.patch. They do NOT
// build PDFium or WASM: the patch's own C++ (sliceSrcAdvAt and appendEditedRun
// from session.cpp, the natural-space helpers, pre-pass and space-token width
// from layout.cpp; extracted verbatim from the patch's pre- and post-image) is
// compiled against minimal stand-ins and driven through a reduced token loop.
// The stand-in font has no space glyph, like the TeX subset fonts where the
// source realises interword spaces as positioning folded into the advance of
// the glyph before the space. glyphAdvance, advanceOf and srcAdvMatchesFont
// (identity branch only) are transcribed from layout.cpp, not extracted.
// emitOverride stands in for an edited piece resolved to another font.
// Real text-object emission, fonts and line breaking need the rebuilt WASM.
// patches/editcore-justified-space.patch applies on top of it and changes only
// the space-token width under word spacing; its post-image expression is
// compiled the same way (namespace just) and compared with the natural-space
// post-image (namespace post).
// Skipped when no host C++ compiler (g++, `wsl.exe -e g++` or MSVC) is found.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const PATCH = new URL("../patches/editcore-natural-space.patch", import.meta.url);
const JUSTIFIED_PATCH = new URL("../patches/editcore-justified-space.patch", import.meta.url);
const DIR = "packages/pdfium/build/code/editcore/";
const text = readFileSync(PATCH, "utf8");
const justText = readFileSync(JUSTIFIED_PATCH, "utf8");

function images(diff) {
  const files = {};
  let cur = null;
  for (const line of diff.split("\n")) {
    const m = /^diff --git a\/(\S+) b\/\S+$/.exec(line);
    if (m) {
      cur = files[m[1]] = { pre: [], post: [], removed: [] };
      continue;
    }
    if (!cur || line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("+")) cur.post.push(line.slice(1));
    else if (line.startsWith("-")) { cur.pre.push(line.slice(1)); cur.removed.push(line.slice(1)); }
    else if (line.startsWith(" ")) { cur.pre.push(line.slice(1)); cur.post.push(line.slice(1)); }
  }
  return files;
}

// Lines from the first line containing `start` through the line containing
// `end`, or (without `end`) through the line where braces balance again.
function slice(lines, start, end) {
  const i = lines.findIndex((l) => l.includes(start));
  assert.ok(i >= 0, `patch image lacks ${start}`);
  let depth = 0;
  for (let j = i; j < lines.length; j++) {
    if (end && lines[j].includes(end)) return lines.slice(i, j + 1).join("\n");
    for (const c of lines[j]) depth += c === "{" ? 1 : c === "}" ? -1 : 0;
    if (!end && j > i && depth === 0) return lines.slice(i, j + 1).join("\n");
  }
  assert.fail(`unterminated block from ${start}`);
}

const files = images(text);
const session = files[DIR + "session.cpp"];
const layout = files[DIR + "layout.cpp"];
const justFiles = images(justText);
const justLayout = justFiles[DIR + "layout.cpp"];

test("patch touches only editcore layout.cpp and session.cpp, LF", () => {
  assert.deepEqual(Object.keys(files).sort(), [DIR + "layout.cpp", DIR + "session.cpp"]);
  assert.ok(!text.includes("\r"), "patch must be LF");
  // appendEditedRun itself is unchanged; only the slicing it calls is.
  assert.equal(slice(session.pre, "void appendEditedRun("), slice(session.post, "void appendEditedRun("));
  // The only removed lines are the old cut rule and the old space fallback.
  assert.deepEqual(session.removed.map((l) => l.trim()), ["if (at + len < src.text.size()) out.back() = -1.0f;"]);
  assert.deepEqual(layout.removed.map((l) => l.trim()), [": advanceOf(static_cast<int>(ri), u' ');"]);
});

test("justified-space patch replaces only the natural-space space-token width, LF", () => {
  assert.deepEqual(Object.keys(justFiles), [DIR + "layout.cpp"]);
  assert.ok(!justText.includes("\r"), "patch must be LF");
  // It applies to the natural-space post-image: what it removes is exactly
  // that patch's space-token expression.
  const old = slice(layout.post, "const bool naturalOk", "u' ');").split("\n").map((l) => l.trim());
  assert.deepEqual(justLayout.removed.map((l) => l.trim()), old);
});

const LAYOUT = (name, prepass, expr) => `
static std::vector<float> layout_${name}(std::vector<ParaRun> layoutRuns, float ws) {
  Para p;
  p.fmt.word_spacing = ws;
  const float charSpacing = 0.0f;
  std::vector<ResolvedRun> resolved;
  for (auto& r : layoutRuns)
    resolved.push_back({!r.textUnchanged && emitOverride ? emitOverride : r.originalFont, r.style.size, r.style.hScale, false});
  auto glyphAdvance = [](FPDF_FONT font, uint32_t cp, float size) {
    float w = 0;
    if (font && FPDFFont_GetGlyphWidth(font, cp, size, &w) && w > 0) return w;
    return size * 0.5f;
  };
  auto advanceOf = [&](int ri, uint32_t cp) {
    const uint32_t measured = cp == 0x00A0 ? u' ' : cp;
    const float tw = measured == u' ' ? p.fmt.word_spacing : 0.0f;
    return (glyphAdvance(resolved[ri].font, measured, resolved[ri].emitSize) + charSpacing + tw) *
           resolved[ri].hScale;
  };
  auto srcAdvMatchesFont = [&](int ri) { return resolved[ri].font == layoutRuns[ri].originalFont; };
  const bool srcAdvOk = true;
${prepass}
  bool anyEdited = false;
  for (const auto& r : layoutRuns) if (!r.textUnchanged || !r.originalFont) anyEdited = true;
  std::vector<float> adv;
  std::vector<Token> tokens;
  for (size_t ri = 0; ri < layoutRuns.size(); ri++) {
    const std::u16string& text = layoutRuns[ri].text;
    const std::vector<float>* sa =
        (srcAdvOk && layoutRuns[ri].srcAdv.size() == text.size() && srcAdvMatchesFont(static_cast<int>(ri)))
            ? &layoutRuns[ri].srcAdv : nullptr;
    for (size_t ci = 0; ci < text.size(); ci++) {
      uint32_t cp = text[ci];
      const float ov = sa ? (*sa)[ci] : -1.0f;
      if (cp == u' ') {
        Token t;
        t.kind = Token::Space;
        const bool atomicNbr = false;
${expr}
        adv.push_back(t.width);
        tokens.push_back(t);
      } else {
        adv.push_back(ov >= 0 ? ov : advanceOf(static_cast<int>(ri), cp));
        tokens.push_back(Token());
      }
    }
  }
  (void)srcAdvOk;
  return adv;
}
`;

const HARNESS = () => `
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <utility>
#include <vector>
typedef void* FPDF_FONT;
typedef void* FPDF_PAGEOBJECT;
struct FakeFont { std::map<uint32_t, float> w; };
static int FPDFFont_GetGlyphWidth(FPDF_FONT f, uint32_t cp, float size, float* out) {
  const FakeFont* ff = static_cast<const FakeFont*>(f);
  auto it = ff->w.find(cp);
  if (it == ff->w.end()) return 0;
  *out = it->second * size / 1000.0f;
  return 1;
}
struct RunStyle { float size = 0; float hScale = 1; };
struct ParaRun {
  std::u16string text; RunStyle style; FPDF_FONT originalFont = nullptr;
  bool textUnchanged = false; std::vector<float> srcAdv; FPDF_PAGEOBJECT atomicObject = nullptr;
};
struct ResolvedRun { FPDF_FONT font; float emitSize; float hScale; bool complex; };
struct Fmt { float word_spacing = 0; };
struct Para { Fmt fmt; };
struct Token { enum Kind { Word, Space } kind = Word; float width = 0; };
static FPDF_FONT emitOverride = nullptr;

namespace post {
${slice(session.post, "std::vector<float> sliceSrcAdvAt(")}
${slice(session.post, "void appendEditedRun(")}
${slice(layout.post, "struct SpaceSampleRun {")}
${slice(layout.post, "std::vector<float> sourceNaturalSpaces(")}
${LAYOUT("post", slice(layout.post, "std::vector<float> naturalSpace;", "naturalSpace[ri] = -1.0f;") + "\n    }\n  }",
  slice(layout.post, "const bool naturalOk", "u' ');"))}
}
namespace just {
using namespace post;
${LAYOUT("just", slice(layout.post, "std::vector<float> naturalSpace;", "naturalSpace[ri] = -1.0f;") + "\n    }\n  }",
  slice(justLayout.post, "const bool naturalOk", "(naturalOk && afterWord ? base : 0.0f);"))}
}
namespace pre {
${slice(session.pre, "std::vector<float> sliceSrcAdvAt(")}
${slice(session.pre, "void appendEditedRun(")}
${LAYOUT("pre", "", slice(layout.pre, "t.width = (ov >= 0", "u' ');"))}
}

// tex has no space glyph; texsp is tex with one; texalt is a second font with
// tex's metrics.
static FakeFont tex, texsp, texalt;
static const float SIZE = 9.963f;
static const float GAP = 0.25f * SIZE;
static const float JUSTIFIED = 0.4f * SIZE;
static float own(char16_t c) { float w = 0; FPDFFont_GetGlyphWidth(&tex, c, SIZE, &w); return w; }
static std::u16string u16(const std::string& s) { return std::u16string(s.begin(), s.end()); }
// Source line as a TeX subset font shows it: no space glyph, the interword gap
// folded into the glyph before each space (space advance 0), "ft" kerned. With
// font texsp each space instead carries its own (justified) source advance.
static ParaRun source(const std::string& s, FakeFont* font = &tex) {
  ParaRun r; r.text = u16(s); r.style.size = SIZE; r.originalFont = font; r.textUnchanged = true;
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == ' ') { r.srcAdv.push_back(font == &texsp ? JUSTIFIED : 0.0f); continue; }
    float a = own(s[i]);
    if (font != &texsp && i + 1 < s.size() && s[i + 1] == ' ') a += GAP;
    if (s[i] == 'f' && i + 1 < s.size() && s[i + 1] == 't') a -= 0.2f;
    r.srcAdv.push_back(a);
  }
  return r;
}
static void list(const std::vector<float>& v) {
  std::printf("[");
  for (size_t i = 0; i < v.size(); i++) std::printf("%s%.3f", i ? "," : "", v[i]);
  std::printf("]");
}
// Ink-free interword gaps: from the end of a word's last glyph (its own font
// advance) to the origin of the next word.
static std::vector<float> gaps(const std::string& s, const std::vector<float>& adv) {
  std::vector<float> out;
  for (size_t i = 1; i + 1 < s.size(); i++) {
    if (s[i] != ' ' || s[i - 1] == ' ') continue;
    float g = adv[i - 1] - own(s[i - 1]);
    size_t j = i;
    while (j < s.size() && s[j] == ' ') g += adv[j++];
    out.push_back(g);
  }
  return out;
}
int main() {
  for (char c = 'a'; c <= 'z'; c++) tex.w[static_cast<uint32_t>(c)] = 400.0f + 10.0f * (c - 'a');
  tex.w[u'.'] = 250.0f; tex.w[u','] = 250.0f; tex.w[u':'] = 278.0f;
  tex.w[u'R'] = 667.0f; tex.w[u'F'] = 556.0f;
  texalt = texsp = tex; texsp.w[u' '] = 333.0f;
  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\\r') line.pop_back();
    if (line.empty()) continue;
    std::istringstream in(line);
    std::string cmd; in >> cmd;
    if (cmd == "edit" || cmd == "editx") {
      // editx space: source and edit in texsp; editx swap: the edited piece
      // resolves to texalt.
      std::string mode; if (cmd == "editx") in >> mode;
      float ws; in >> ws; in.get();
      std::string rest; std::getline(in, rest);
      const size_t bar = rest.find('|');
      const std::string before = rest.substr(0, bar), after = rest.substr(bar + 1);
      const ParaRun src = source(before, mode == "space" ? &texsp : &tex);
      emitOverride = mode == "swap" ? &texalt : nullptr;
      ParaRun r = src; r.text = u16(after); r.textUnchanged = false; r.srcAdv.clear();
      std::vector<ParaRun> a, b;
      pre::appendEditedRun(a, r, src);
      post::appendEditedRun(b, r, src);
      const std::vector<float> pa = pre::layout_pre(a, ws), pb = post::layout_post(b, ws);
      const std::vector<float> pj = just::layout_just(b, ws);
      std::printf("{\\"pre\\":{\\"gaps\\":"); list(gaps(after, pa));
      std::printf(",\\"adv\\":"); list(pa);
      std::printf("},\\"post\\":{\\"gaps\\":"); list(gaps(after, pb));
      std::printf(",\\"adv\\":"); list(pb);
      std::printf("},\\"just\\":{\\"gaps\\":"); list(gaps(after, pj));
      std::printf(",\\"adv\\":"); list(pj);
      std::printf("}}\\n");
    } else if (cmd == "slice") {
      size_t at, len; in >> at >> len; in.get();
      std::string s; std::getline(in, s);
      const ParaRun src = source(s);
      std::printf("{\\"src\\":"); list(src.srcAdv);
      std::printf(",\\"pre\\":"); list(pre::sliceSrcAdvAt(src, at, len));
      std::printf(",\\"post\\":"); list(post::sliceSrcAdvAt(src, at, len));
      std::printf("}\\n");
    } else if (cmd == "nat") {
      // One run "a a a ..." whose k-th space has source gap g_k on the space.
      float size; in >> size;
      std::vector<float> g; for (float x; in >> x;) g.push_back(x);
      std::u16string t = u"a"; std::vector<float> adv = {own(u'a') * size / SIZE};
      for (float x : g) { t += u" a"; adv.push_back(x); adv.push_back(own(u'a') * size / SIZE); }
      post::SpaceSampleRun sr;
      sr.font = &tex; sr.size = size; sr.text = &t; sr.adv = &adv;
      sr.own = [size](uint32_t cp) { float w = 0; FPDFFont_GetGlyphWidth(&tex, cp, size, &w); return w; };
      std::printf("%.3f\\n", post::sourceNaturalSpaces({sr})[0]);
    }
  }
}
`;

function compiler() {
  const native = spawnSync("g++", ["--version"], { encoding: "utf8" });
  if (native.status === 0) return { kind: "g++" };
  if (process.platform !== "win32") return null;
  const wsl = spawnSync("wsl.exe", ["-e", "g++", "--version"], { encoding: "utf8" });
  if (wsl.status === 0) {
    const path = (p) =>
      spawnSync("wsl.exe", ["-e", "wslpath", "-a", p.replaceAll("\\", "/")], { encoding: "utf8" }).stdout.trim();
    return { kind: "wsl", path };
  }
  const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  if (!existsSync(vswhere)) return null;
  const vs = spawnSync(vswhere, ["-latest", "-products", "*", "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" });
  const vcvars = join(vs.stdout.trim(), "VC", "Auxiliary", "Build", "vcvars64.bat");
  if (vs.status !== 0 || !existsSync(vcvars)) return null;
  return { kind: "msvc", vcvars };
}

let ran;
function run(lines) {
  if (ran === undefined) {
    const cc = compiler();
    if (!cc) return (ran = null);
    const dir = mkdtempSync(join(tmpdir(), "fpe-natural-space-"));
    const src = join(dir, "h.cpp");
    const exe = join(dir, cc.kind === "msvc" ? "h.exe" : "h.out");
    writeFileSync(src, HARNESS());
    let build;
    if (cc.kind === "msvc") {
      build = spawnSync("cmd.exe", ["/d", "/s", "/c",
        `"call "${cc.vcvars}" >nul && cl /nologo /std:c++17 /EHsc /W3 /Fo"${dir}\\\\" /Fe"${exe}" "${src}""`],
        { encoding: "utf8", windowsVerbatimArguments: true });
    } else {
      const args = ["-std=c++17", "-Wall", "-o"];
      build = cc.kind === "wsl"
        ? spawnSync("wsl.exe", ["-e", "g++", ...args, cc.path(exe), cc.path(src)], { encoding: "utf8" })
        : spawnSync("g++", [...args, exe, src], { encoding: "utf8" });
    }
    assert.equal(build.status, 0, (build.stdout || "") + (build.stderr || ""));
    ran = (input) => {
      const res = cc.kind === "wsl"
        ? spawnSync("wsl.exe", ["-e", cc.path(exe)], { input, encoding: "utf8" })
        : spawnSync(exe, [], { input, encoding: "utf8" });
      assert.equal(res.status, 0, res.stderr);
      return res.stdout.trim().split("\n").map((l) => JSON.parse(l.trim()));
    };
  }
  return ran && ran(lines.join("\n") + "\n");
}

const SIZE = 9.963;
const NATURAL = 0.25 * SIZE; // the stand-in source line's interword gap
const FALLBACK = 0.5 * SIZE; // glyphAdvance with no space glyph
const SPACE_GLYPH = 0.333 * SIZE; // texsp's own space width
const JUSTIFIED = 0.4 * SIZE; // texsp source space advance
const close = (got, want, what) =>
  assert.ok(got.length === want.length && got.every((g, i) => Math.abs(g - want[i]) < 0.01),
    `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want.map((w) => +w.toFixed(3)))}`);
const LINE = "the distribution shift induced by that improvement.";

test("folded boundary space and inserted spaces take the source natural gap", (t) => {
  const out = run([`edit 0 ${LINE}|the distribution shift that this improvement induces.`]);
  if (!out) return t.skip("no host C++ compiler");
  const [{ pre, post }] = out;
  close(post.gaps, Array(6).fill(NATURAL), "patched");
  // Unpatched engine: 3x at the unchanged/edited boundary, 2x when inserted.
  close(pre.gaps, [NATURAL, NATURAL, NATURAL + FALLBACK, FALLBACK, FALLBACK, FALLBACK], "unpatched");
});

test("explicit multiple spaces stay multiple natural spaces", (t) => {
  const out = run([`edit 0 ${LINE}|the distribution shift that  this improvement   induces.`]);
  if (!out) return t.skip("no host C++ compiler");
  const [{ pre, post }] = out;
  close(post.gaps, [1, 1, 1, 2, 1, 3].map((k) => k * NATURAL), "patched");
  assert.ok(Math.abs(pre.gaps[3] - 2 * FALLBACK) < 0.01, `unpatched double space ${pre.gaps[3]}`);
});

test("a kept suffix space whose gap was folded into a replaced glyph is measured", (t) => {
  const out = run(["edit 0 the cat sat on the mat.|the dog sat on the mat."]);
  if (!out) return t.skip("no host C++ compiler");
  const [{ pre, post }] = out;
  close(post.gaps, Array(5).fill(NATURAL), "patched");
  // Unpatched: 1.5x after the kept "the ", and the suffix space keeps its
  // folded 0 so "dog" touches "sat".
  close(pre.gaps, [NATURAL + FALLBACK, 0, NATURAL, NATURAL, NATURAL], "unpatched");
});

test("nonzero word spacing (justified/Tw) keeps the existing measurement", (t) => {
  const out = run([`edit 1.5 ${LINE}|the distribution shift that this improvement induces.`,
    `edit -0.8 ${LINE}|the distribution shift that this improvement induces.`]);
  if (!out) return t.skip("no host C++ compiler");
  for (const [k, { pre, post }] of out.entries()) {
    assert.deepEqual(post, pre);
    const tw = k === 0 ? 1.5 : -0.8;
    // Existing behaviour, kept: every space measured from the font plus Tw,
    // with the folded source gap still inside the kept prefix glyphs.
    close(post.gaps, Array(3).fill(NATURAL + FALLBACK + tw).concat(Array(3).fill(FALLBACK + tw)), `tw ${tw}`);
  }
});

test("non-space advances and source kerning are untouched", (t) => {
  const after = "the distribution shift that this improvement induces.";
  const out = run([`edit 0 ${LINE}|${after}`, "slice 0 23 " + LINE]);
  if (!out) return t.skip("no host C++ compiler");
  const [{ pre, post }, sl] = out;
  for (let i = 0; i < after.length; i++)
    if (after[i] !== " ") assert.equal(post.adv[i], pre.adv[i], `glyph ${i} '${after[i]}'`);
  // The kerned "f" of "shift" keeps its source advance in the kept prefix.
  const f = after.indexOf("ft");
  assert.equal(post.adv[f], sl.src[f]);
  assert.ok(Math.abs(sl.src[f] - (0.45 * SIZE - 0.2)) < 0.01, `kerned f ${sl.src[f]}`);
});

test("slicing: a cut glyph drops kerning, a cut space keeps its source advance", (t) => {
  const s = "shift induced by";
  const out = run([`slice 0 5 ${s}`, `slice 0 6 ${s}`, `slice 5 8 ${s}`, `slice 6 7 ${s}`]);
  if (!out) return t.skip("no host C++ compiler");
  const [glyph, space, lead, word] = out;
  assert.equal(glyph.pre.at(-1), -1); assert.equal(glyph.post.at(-1), -1);
  assert.deepEqual(glyph.post.slice(0, -1), glyph.src.slice(0, 4));
  assert.equal(space.pre.at(-1), -1); assert.equal(space.post.at(-1), 0);
  assert.deepEqual(space.post, space.src.slice(0, 6));
  // A leading space with its gap folded into the cut-off "t" gets measured.
  assert.equal(lead.pre[0], 0); assert.equal(lead.post[0], -1);
  assert.deepEqual(lead.post.slice(1, -1), lead.src.slice(6, 12));
  assert.deepEqual(word.post, word.pre);
});

test("no or disagreeing source evidence: no assumed space width", (t) => {
  const out = run(["edit 0 Results.|Final results here.", "nat 10 2.5 2.5 2.52", "nat 10 2.5 4.2", "nat 10 0.2"]);
  if (!out) return t.skip("no host C++ compiler");
  const [{ pre, post }, agree, disagree, tiny] = out;
  // No interword gap in the source line: the old font measurement stays.
  assert.deepEqual(post, pre);
  close(post.gaps, [FALLBACK, FALLBACK], "fallback");
  assert.ok(Math.abs(agree - 2.5) < 0.01, `agree ${agree}`);
  assert.equal(disagree, -1);
  assert.equal(tiny, -1);
});

test("a font with a working space glyph keeps its measured width over the source gap", (t) => {
  const out = run([`editx space 0 ${LINE}|the distribution shift that this improvement induces.`,
    `editx space 0 ${LINE}|the distribution shift that  this improvement   induces.`]);
  if (!out) return t.skip("no host C++ compiler");
  for (const { pre, post } of out) assert.deepEqual(post, pre);
  // Kept spaces keep their source (justified) advance; the cut boundary space
  // and edited spaces are measured from the font, as before the patch.
  close(out[0].post.gaps, [JUSTIFIED, JUSTIFIED].concat(Array(4).fill(SPACE_GLYPH)), "space glyph");
  close(out[1].post.gaps, [JUSTIFIED, JUSTIFIED].concat([1, 2, 1, 3].map((k) => k * SPACE_GLYPH)), "space glyph multi");
});

test("an edited piece resolved to another font does not borrow the source font's gap", (t) => {
  const out = run([`editx swap 0 ${LINE}|the distribution shift that this improvement induces.`]);
  if (!out) return t.skip("no host C++ compiler");
  const [{ pre, post }] = out;
  // Kept prefix: natural gaps, its folded boundary space kept at 0. Edited
  // piece in texalt: the existing font measurement (0.5 em fallback).
  close(post.gaps, [NATURAL, NATURAL, NATURAL, FALLBACK, FALLBACK, FALLBACK], "swapped font");
  close(pre.gaps, [NATURAL, NATURAL, NATURAL + FALLBACK, FALLBACK, FALLBACK, FALLBACK], "unpatched");
});

// rebrac-short-01 shape: a justified line re-justified by word spacing after a
// shorter replacement; Tw as solved for it (negative against the 0.5 em
// space fallback).
const SHORT = "is expensive or unsafe, but it makes policy improvement brittle:";
const SHORT_AFTER = "is costly or unsafe, but it makes policy improvement brittle:";

test("justified: under Tw the gap after an edited word keeps the source natural gap", (t) => {
  const out = run([`edit -3.08 ${SHORT}|${SHORT_AFTER}`, "edit 1.2 the cat sat on the mat.|the dog sat on the mat."]);
  if (!out) return t.skip("no host C++ compiler");
  const [short, cat] = out;
  const x = (tw) => NATURAL + FALLBACK + tw;
  // Before: the edited/kept boundary lacks the gap kept glyphs carry folded.
  close(short.post.gaps, [x(-3.08), FALLBACK - 3.08].concat(Array(7).fill(x(-3.08))), "natural-space only");
  close(short.just.gaps, Array(9).fill(x(-3.08)), "justified");
  close(cat.post.gaps, [x(1.2), FALLBACK + 1.2, x(1.2), x(1.2), x(1.2)], "cat natural-space only");
  close(cat.just.gaps, Array(5).fill(x(1.2)), "cat justified");
  // Glyph advances (and so source kerning) are untouched; each space token
  // still grows by exactly Tw, which the line-local width solve relies on.
  for (let i = 0; i < SHORT_AFTER.length; i++)
    if (SHORT_AFTER[i] !== " ") assert.equal(short.just.adv[i], short.post.adv[i], `glyph ${i}`);
});

test("justified: Tw on both sides of the edit and on inserted spaces, positive and negative", (t) => {
  const after = "the distribution shift that this improvement induces.";
  const out = run([`edit 1.5 ${LINE}|${after}`, `edit -0.8 ${LINE}|${after}`]);
  if (!out) return t.skip("no host C++ compiler");
  for (const [k, { post, just }] of out.entries()) {
    const tw = k === 0 ? 1.5 : -0.8;
    close(post.gaps, Array(3).fill(NATURAL + FALLBACK + tw).concat(Array(3).fill(FALLBACK + tw)), `before ${tw}`);
    close(just.gaps, Array(6).fill(NATURAL + FALLBACK + tw), `justified ${tw}`);
  }
});

test("justified: explicit multiple spaces under Tw stay that many full spaces", (t) => {
  const out = run([`edit 1.5 ${LINE}|the distribution shift that  this improvement   induces.`]);
  if (!out) return t.skip("no host C++ compiler");
  const [{ just }] = out;
  close(just.gaps, [1, 1, 1, 2, 1, 3].map((k) => k * (NATURAL + FALLBACK + 1.5)), "multi");
});

test("justified: zero Tw, a measured space glyph, another font and no evidence keep the natural-space result", (t) => {
  const after = "the distribution shift that this improvement induces.";
  const out = run([
    `edit 0 ${LINE}|${after}`,
    `edit 0 ${LINE}|the distribution shift that  this improvement   induces.`,
    "edit 0 the cat sat on the mat.|the dog sat on the mat.",
    `edit 0 ${SHORT}|${SHORT_AFTER}`,
    `editx space 1.5 ${LINE}|${after}`,
    `editx space -0.8 ${LINE}|${after}`,
    `editx swap 1.5 ${LINE}|${after}`,
    "edit 1.5 Results.|Final results here.",
  ]);
  if (!out) return t.skip("no host C++ compiler");
  for (const [k, { post, just }] of out.entries()) assert.deepEqual(just, post, `case ${k}`);
  // The measured space glyph (texsp): font width plus Tw everywhere.
  close(out[4].just.gaps, Array(6).fill(SPACE_GLYPH + 1.5), "space glyph tw");
  // Edited piece in texalt: kept prefix natural gaps, edited piece the
  // font fallback, as before.
  close(out[6].just.gaps, Array(3).fill(NATURAL + FALLBACK + 1.5).concat(Array(3).fill(FALLBACK + 1.5)), "swap tw");
  close(out[7].just.gaps, [FALLBACK + 1.5, FALLBACK + 1.5], "no evidence tw");
});

test("justified: leading (indent) spaces under Tw keep the font measurement", (t) => {
  const out = run(["edit 1.5   the cat sat on the mat.|  the dog sat on the mat."]);
  if (!out) return t.skip("no host C++ compiler");
  const [{ post, just }] = out;
  assert.deepEqual(just.adv.slice(0, 2), post.adv.slice(0, 2));
  close(just.adv.slice(0, 2), [FALLBACK + 1.5, FALLBACK + 1.5], "indent");
  close(just.gaps, Array(5).fill(NATURAL + FALLBACK + 1.5), "interword");
});
