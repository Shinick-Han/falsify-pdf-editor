// Source-level tests for patches/editcore-reedit-space.patch (stacked on the
// natural-space and justified-space patches; generated against native
// fa2411eb). They do NOT build PDFium or WASM. The patch's own C++ (the
// source-advance gate, the source word-spacing normalisation, the natural-gap
// pre-pass and space-token width of layoutParagraph, and the /ECFmt binding
// block of buildPageModel) is extracted verbatim from the patch's post-image
// (namespace fix) and its pre-image, which is the fa2411 engine (namespace
// base), and compiled against minimal stand-ins. sliceSrcAdvAt,
// appendEditedRun and sourceNaturalSpaces come from the natural-space patch's
// post-image, as in native-space.test.mjs; glyphAdvance, advanceOf and
// srcAdvMatchesFont (identity branch only) are transcribed from layout.cpp.
//
// Source stand-in, not an actual PDF: an editor-emitted ("gen1") line is
// modelled by laying out a TeX-like source line (no space glyph, interword
// gap folded into the glyph before the space) at a word spacing, and
// capturing the emitted advances as the next generation's source advances,
// either folded into the glyph before each space group (shape f) or carried
// by the spaces after the glyph's own advance (shape s), the two placements
// the capture in model.cpp produces. The bound source word spacing is the
// emitting step's ws, as /ECFmt persists it. Real text-object emission,
// capture, fonts, hScale read-back and line breaking need the rebuilt WASM
// and the actual gen1 PDF.
// Skipped when no host C++ compiler (g++, `wsl.exe -e g++` or MSVC) is found.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const DIR = "packages/pdfium/build/code/editcore/";
const read = (name) => readFileSync(new URL(`../patches/${name}`, import.meta.url), "utf8");
const text = read("editcore-reedit-space.patch");
const naturalText = read("editcore-natural-space.patch");
const justText = read("editcore-justified-space.patch");

function images(diff) {
  const files = {};
  let cur = null;
  for (const line of diff.split("\n")) {
    const m = /^diff --git a\/(\S+) b\/\S+$/.exec(line);
    if (m) {
      cur = files[m[1]] = { pre: [], post: [], removed: [], added: [] };
      continue;
    }
    if (!cur || line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("+")) { cur.post.push(line.slice(1)); cur.added.push(line.slice(1)); }
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
    if (end && j > i && lines[j].includes(end)) return lines.slice(i, j + 1).join("\n");
    for (const c of lines[j]) depth += c === "{" ? 1 : c === "}" ? -1 : 0;
    if (!end && j > i && depth === 0) return lines.slice(i, j + 1).join("\n");
  }
  assert.fail(`unterminated block from ${start}`);
}
const line = (lines, has) => {
  const l = lines.find((x) => x.includes(has));
  assert.ok(l, `patch image lacks ${has}`);
  return l.trim();
};

const files = images(text);
const layout = files[DIR + "layout.cpp"];
const model = files[DIR + "model.cpp"];
const session = files[DIR + "session.cpp"];
const header = files[DIR + "ec_internal.h"];
const natural = images(naturalText);
const natSession = natural[DIR + "session.cpp"];
const natLayout = natural[DIR + "layout.cpp"];
const justLayout = images(justText)[DIR + "layout.cpp"];

test("patch touches only editcore ec_internal.h, layout.cpp, model.cpp, session.cpp, LF", () => {
  assert.deepEqual(Object.keys(files).sort(),
    ["ec_internal.h", "layout.cpp", "model.cpp", "session.cpp"].map((f) => DIR + f));
  assert.ok(!text.includes("\r"), "patch must be LF");
  assert.ok(!text.includes("GIT binary patch"));
  // Layout: only the source-advance gate and the two readers of the source
  // advances change; the natural-space pre-pass and the justified space
  // token are otherwise the fa2411 code.
  assert.deepEqual(layout.removed.map((l) => l.trim()), [
    "std::abs(p.fmt.char_spacing - p.srcCharSpacing) < 0.005f;",
    "sr.adv = &lr.srcAdv;",
    "? &layoutRuns[ri].srcAdv",
  ]);
  assert.equal(slice(layout.pre, "const bool naturalOk", "(naturalOk && afterWord ? base : 0.0f);"),
    slice(layout.post, "const bool naturalOk", "(naturalOk && afterWord ? base : 0.0f);"));
  // The fa2411 space token is the justified-space patch's post-image.
  assert.equal(slice(layout.pre, "const bool naturalOk", "(naturalOk && afterWord ? base : 0.0f);").replace(/\s+/g, " "),
    slice(justLayout.post, "const bool naturalOk", "(naturalOk && afterWord ? base : 0.0f);").replace(/\s+/g, " "));
  // Session: only the duplicate carries the binding along; applyFormat (the
  // requested fmt) never touches it.
  assert.deepEqual(session.removed, []);
  assert.deepEqual(session.added.map((l) => l.trim()).filter((l) => !l.startsWith("//")),
    ["p.srcWordSpacing = src->srcWordSpacing;", "p.srcWordSpacingKnown = src->srcWordSpacingKnown;"]);
  assert.deepEqual(header.removed, []);
});

test("source word spacing is written only by the /ECFmt capture and the duplicate", () => {
  const writes = [];
  for (const [f, img] of Object.entries(files))
    for (const l of img.added) if (/\bsrcWordSpacing(Known)?\s*=[^=]/.test(l)) writes.push([f.slice(DIR.length), l.trim()]);
  assert.deepEqual(writes, [
    ["ec_internal.h", "float srcWordSpacing = 0;"],
    ["ec_internal.h", "bool srcWordSpacingKnown = true;"],
    ["model.cpp", "p.srcWordSpacing = ws2;"],
    ["model.cpp", "p.srcWordSpacingKnown = false;"],
    ["model.cpp", "if (foreignWs) p.srcWordSpacingKnown = false;"],
    ["session.cpp", "p.srcWordSpacing = src->srcWordSpacing;"],
    ["session.cpp", "p.srcWordSpacingKnown = src->srcWordSpacingKnown;"],
  ]);
});

const LAYOUT = (name, gate, norm, prepass, saTarget, expr) => `
static std::vector<float> layout_${name}(std::vector<ParaRun> layoutRuns, float ws, float srcWs, bool known) {
  Para p;
  p.fmt.word_spacing = ws;
  p.srcWordSpacing = srcWs;
  p.srcWordSpacingKnown = known;
  const float charSpacing = p.fmt.char_spacing;
  std::vector<ResolvedRun> resolved;
  for (auto& r : layoutRuns)
    resolved.push_back({!r.textUnchanged && emitOverride ? emitOverride : r.originalFont, r.style.size, r.style.hScale, false});
  auto advanceOf = [&](int ri, uint32_t cp) {
    const uint32_t measured = cp == 0x00A0 ? u' ' : cp;
    const float tw = measured == u' ' ? p.fmt.word_spacing : 0.0f;
    return (glyphAdvance(resolved[ri].font, measured, resolved[ri].emitSize) + charSpacing + tw) *
           resolved[ri].hScale;
  };
  auto srcAdvMatchesFont = [&](int ri) { return resolved[ri].font == layoutRuns[ri].originalFont; };
  int srcAdvUsed = 0;
${gate}
${norm}
${prepass}
  bool anyEdited = false;
  for (const auto& r : layoutRuns) if (!r.textUnchanged || !r.originalFont) anyEdited = true;
  std::vector<float> adv;
  std::vector<Token> tokens;
  for (size_t ri = 0; ri < layoutRuns.size(); ri++) {
    const std::u16string& text = layoutRuns[ri].text;
    const std::vector<float>* sa =
        (srcAdvOk && layoutRuns[ri].srcAdv.size() == text.size() && srcAdvMatchesFont(static_cast<int>(ri)))
            ${saTarget} : nullptr;
    if (sa) srcAdvUsed++;
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
  (void)srcAdvUsed;
  return adv;
}
`;

const PREPASS = (img) => slice(img, "std::vector<float> naturalSpace;", "naturalSpace[ri] = -1.0f;") + "\n    }\n  }";
const EXPR = (img) => slice(img, "const bool naturalOk", "(naturalOk && afterWord ? base : 0.0f);");

const HARNESS = () => `
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <functional>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <utility>
#include <vector>
typedef void* FPDF_FONT;
typedef void* FPDF_PAGEOBJECT;
typedef void* FPDF_PAGEOBJECTMARK;
typedef unsigned short FPDF_WCHAR;
static const int FPDF_PAGEOBJ_TEXT = 1;
struct FakeFont { std::map<uint32_t, float> w; };
static int FPDFFont_GetGlyphWidth(FPDF_FONT f, uint32_t cp, float size, float* out) {
  const FakeFont* ff = static_cast<const FakeFont*>(f);
  auto it = ff->w.find(cp);
  if (it == ff->w.end()) return 0;
  *out = it->second * size / 1000.0f;
  return 1;
}
static float glyphAdvance(FPDF_FONT font, uint32_t cp, float size) {
  float w = 0;
  if (font && FPDFFont_GetGlyphWidth(font, cp, size, &w) && w > 0) return w;
  return size * 0.5f;
}
struct RunStyle { float size = 0; float hScale = 1; };
struct ParaRun {
  std::u16string text; RunStyle style; FPDF_FONT originalFont = nullptr;
  bool textUnchanged = false; std::vector<float> srcAdv; FPDF_PAGEOBJECT atomicObject = nullptr;
};
struct ResolvedRun { FPDF_FONT font; float emitSize; float hScale; bool complex; };
struct Fmt {
  int align = 0; float line_spacing = 1.2f, char_spacing = 0, para_spacing = 0, word_spacing = 0;
  float first_indent = 0, hang_indent = 0; int dir = 0, list_level = 0;
};
struct OwnedObject { FPDF_PAGEOBJECT object = nullptr; };
struct Para {
  Fmt fmt; float srcCharSpacing = 0; float srcWordSpacing = 0; bool srcWordSpacingKnown = true;
  float srcHangIndent = 0; std::vector<ParaRun> runs; std::vector<OwnedObject> objects;
};
struct Token { enum Kind { Word, Space } kind = Word; float width = 0; };
static FPDF_FONT emitOverride = nullptr;

// Page-object marks for the /ECFmt block.
struct FakeMark { std::string name; bool hasF = false; std::string f; };
struct FakeObj { int type = FPDF_PAGEOBJ_TEXT; std::vector<FakeMark> marks; };
static int FPDFPageObj_GetType(FPDF_PAGEOBJECT o) { return static_cast<FakeObj*>(o)->type; }
static int FPDFPageObj_CountMarks(FPDF_PAGEOBJECT o) { return static_cast<int>(static_cast<FakeObj*>(o)->marks.size()); }
static FPDF_PAGEOBJECTMARK FPDFPageObj_GetMark(FPDF_PAGEOBJECT o, int i) { return &static_cast<FakeObj*>(o)->marks[i]; }
static int putWide(const std::string& s, FPDF_WCHAR* buf, unsigned long len, unsigned long* out) {
  *out = (s.size() + 1) * 2;
  if (len < *out) return 0;
  for (size_t i = 0; i < s.size(); i++) buf[i] = static_cast<unsigned char>(s[i]);
  buf[s.size()] = 0;
  return 1;
}
static int FPDFPageObjMark_GetName(FPDF_PAGEOBJECTMARK m, FPDF_WCHAR* buf, unsigned long len, unsigned long* out) {
  return putWide(static_cast<FakeMark*>(m)->name, buf, len, out);
}
static int FPDFPageObjMark_GetParamStringValue(FPDF_PAGEOBJECTMARK m, const char* key, FPDF_WCHAR* buf,
                                               unsigned long len, unsigned long* out) {
  const FakeMark* fm = static_cast<FakeMark*>(m);
  if (std::strcmp(key, "f") || !fm->hasF) return 0;
  return putWide(fm->f, buf, len, out);
}
static std::string utf16ToUtf8(const std::u16string& s) {
  std::string o; for (char16_t c : s) o.push_back(static_cast<char>(c)); return o;
}

namespace nat {
${slice(natSession.post, "std::vector<float> sliceSrcAdvAt(")}
${slice(natSession.post, "void appendEditedRun(")}
${slice(natLayout.post, "struct SpaceSampleRun {")}
${slice(natLayout.post, "std::vector<float> sourceNaturalSpaces(")}
}
using namespace nat;
namespace fix {
${LAYOUT("fix", slice(layout.post, "const bool srcAdvOk", ";"),
  slice(layout.post, "std::vector<std::vector<float>> srcAdvN("),
  PREPASS(layout.post), line(layout.post, "? &srcAdvN[ri]"), EXPR(layout.post))}
static void ecfmt(Para& p) {
${slice(model.post, "unsigned int th = 5381;", "if (foreignWs) p.srcWordSpacingKnown = false;")}
}
}
namespace base {
${LAYOUT("base", slice(layout.pre, "const bool srcAdvOk", ";"), "",
  PREPASS(layout.pre), line(layout.pre, "? &layoutRuns[ri].srcAdv"), EXPR(layout.pre))}
}

// tex has no space glyph; texsp is tex with one; texalt is a second font with
// tex's metrics.
static FakeFont tex, texsp, texalt;
static const float SIZE = 9.963f;
static const float GAP = 0.25f * SIZE;
static const float JUSTIFIED = 0.4f * SIZE;
static float own(FakeFont* f, char16_t c) { float w = 0; FPDFFont_GetGlyphWidth(f, c, SIZE, &w); return w; }
static std::u16string u16(const std::string& s) { return std::u16string(s.begin(), s.end()); }
// The TeX-like source line (as in native-space.test.mjs), drawn at scale h:
// no space glyph, the natural gap folded into the glyph before each space,
// "ft" kerned; with texsp each space carries its own (justified) advance.
static ParaRun source(const std::string& s, FakeFont* font, float h) {
  ParaRun r; r.text = u16(s); r.style.size = SIZE; r.style.hScale = h; r.originalFont = font; r.textUnchanged = true;
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == ' ') { r.srcAdv.push_back(font == &texsp ? JUSTIFIED : 0.0f); continue; }
    float a = own(font, s[i]) * h;
    if (font != &texsp && i + 1 < s.size() && s[i + 1] == ' ') a += GAP;
    if (s[i] == 'f' && i + 1 < s.size() && s[i + 1] == 't') a -= 0.2f;
    r.srcAdv.push_back(a);
  }
  return r;
}
// The emitted line captured back as source advances (see the file comment).
static ParaRun capture(const std::string& s, const std::vector<float>& e, char shape, FakeFont* font, float h) {
  ParaRun r; r.text = u16(s); r.style.size = SIZE; r.style.hScale = h; r.originalFont = font; r.textUnchanged = true;
  r.srcAdv = e;
  for (size_t i = 1; i < s.size(); i++) {
    if (s[i] != ' ' || s[i - 1] == ' ') continue;
    size_t j = i; float total = 0;
    while (j < s.size() && s[j] == ' ') total += e[j++];
    if (shape == 'f') {
      r.srcAdv[i - 1] += total;
      for (size_t k = i; k < j; k++) r.srcAdv[k] = 0.0f;
    } else {
      const float o = own(font, s[i - 1]) * h, extra = e[i - 1] - o;
      r.srcAdv[i - 1] = o;
      for (size_t k = i; k < j; k++) r.srcAdv[k] = (total + extra) / static_cast<float>(j - i);
    }
  }
  return r;
}
static void list(const std::vector<float>& v) {
  std::printf("[");
  for (size_t i = 0; i < v.size(); i++) std::printf("%s%.4f", i ? "," : "", v[i]);
  std::printf("]");
}
// Ink-free interword gaps: from the end of a word's last glyph (its own font
// advance at scale h) to the origin of the next word.
static std::vector<float> gaps(const std::string& s, const std::vector<float>& adv, float h) {
  std::vector<float> out;
  for (size_t i = 1; i + 1 < s.size(); i++) {
    if (s[i] != ' ' || s[i - 1] == ' ') continue;
    float g = adv[i - 1] - own(&tex, s[i - 1]) * h;
    size_t j = i;
    while (j < s.size() && s[j] == ' ') g += adv[j++];
    out.push_back(g);
  }
  return out;
}
static std::vector<std::string> split(const std::string& s, char c) {
  std::vector<std::string> out; std::string cur;
  for (char ch : s) { if (ch == c) { out.push_back(cur); cur.clear(); } else cur.push_back(ch); }
  out.push_back(cur);
  return out;
}
static unsigned int hashOf(const std::string& s) {
  unsigned int th = 5381;
  for (char c : s) if (c != ' ') th = th * 33u + static_cast<unsigned int>(c);
  return th;
}
int main() {
  for (char c = 'a'; c <= 'z'; c++) tex.w[static_cast<uint32_t>(c)] = 400.0f + 10.0f * (c - 'a');
  tex.w[u'.'] = 250.0f; tex.w[u','] = 250.0f; tex.w[u':'] = 278.0f;
  tex.w[u'R'] = 667.0f; tex.w[u'F'] = 556.0f;
  texalt = texsp = tex; texsp.w[u' '] = 333.0f;
  std::string ln;
  while (std::getline(std::cin, ln)) {
    if (!ln.empty() && ln.back() == '\\r') ln.pop_back();
    if (ln.empty()) continue;
    std::istringstream in(ln);
    std::string cmd; in >> cmd;
    if (cmd == "chain") {
      // chain MODE SHAPE H FONT paper|t1|ws1|t2|ws2|...: step k lays out t_k
      // at ws_k from the previous step's text (the paper source, else the
      // previous emission captured back) and binds that step's ws (0 for the
      // paper) as the source word spacing.
      std::string mode, shape, fontName; float h; in >> mode >> shape >> h >> fontName; in.get();
      std::string rest; std::getline(in, rest);
      const std::vector<std::string> parts = split(rest, '|');
      FakeFont* font = fontName == "texsp" ? &texsp : &tex;
      ParaRun src = source(parts[0], font, h);
      float srcWs = 0;
      std::printf("{\\"steps\\":[");
      for (size_t k = 1; k + 1 < parts.size(); k += 2) {
        const bool last = k + 3 >= parts.size();
        const std::string t = parts[k];
        const float ws = std::stof(parts[k + 1]);
        emitOverride = fontName == "swaplast" && last ? &texalt : nullptr;
        ParaRun r = src; r.text = u16(t); r.textUnchanged = false; r.srcAdv.clear();
        std::vector<ParaRun> runs;
        appendEditedRun(runs, r, src);
        bool known = true;
        float bound = srcWs;
        if (last && mode == "unknown") known = false;
        if (last && mode == "nan") bound = std::nanf("");
        if (mode == "zero") bound = 0;
        if (mode == "tiny") bound = 0.004f;
        if (last && mode == "cleared") { for (auto& x : runs) x.srcAdv.clear(); bound = 0; }
        const std::vector<float> adv = mode == "base" ? base::layout_base(runs, ws, bound, known)
                                                     : fix::layout_fix(runs, ws, bound, known);
        std::printf("%s{\\"adv\\":", k > 1 ? "," : ""); list(adv);
        std::printf(",\\"gaps\\":"); list(gaps(t, adv, h));
        float sum = 0; for (float a : adv) sum += a;
        std::printf(",\\"width\\":%.4f}", sum);
        src = capture(t, adv, shape[0], font, h);
        srcWs = ws;
      }
      std::printf("]}\\n");
    } else if (cmd == "raw") {
      // raw WS SRCWS text|a0,a1,...: one kept run with the given source
      // advances, laid out by the patched engine; ^ is a line break.
      float ws, srcWs; in >> ws >> srcWs; in.get();
      std::string rest; std::getline(in, rest);
      std::vector<std::string> parts = split(rest, '|');
      std::replace(parts[0].begin(), parts[0].end(), '^', '\\n');
      ParaRun r; r.text = u16(parts[0]); r.style.size = SIZE; r.originalFont = &tex; r.textUnchanged = true;
      for (const std::string& a : split(parts[1], ',')) r.srcAdv.push_back(std::stof(a));
      emitOverride = nullptr;
      std::printf("{\\"adv\\":"); list(fix::layout_fix({r}, ws, srcWs, true));
      std::printf("}\\n");
    } else if (cmd == "ecfmt") {
      // ecfmt text#mark#mark...: one text object per mark; a mark is
      // NAME:f-string, NAME! (no f) or NAME; {h} is the paragraph's hash.
      std::string rest; std::getline(in, rest);
      if (!rest.empty() && rest[0] == ' ') rest.erase(0, 1);
      const std::vector<std::string> parts = split(rest, '#');
      Para p;
      ParaRun r; r.text = u16(parts[0]); p.runs.push_back(r);
      char hb[16]; std::snprintf(hb, sizeof(hb), "%08x", hashOf(parts[0]));
      std::vector<FakeObj> objs(parts.size() - 1);
      for (size_t i = 1; i < parts.size(); i++) {
        std::string m = parts[i];
        FakeMark fm;
        const size_t colon = m.find(':');
        if (colon != std::string::npos) {
          fm.name = m.substr(0, colon); fm.hasF = true; fm.f = m.substr(colon + 1);
          const size_t hp = fm.f.find("{h}");
          if (hp != std::string::npos) fm.f.replace(hp, 3, hb);
        } else if (!m.empty() && m.back() == '!') {
          fm.name = m.substr(0, m.size() - 1);
        } else {
          fm.name = m;
        }
        objs[i - 1].marks.push_back(fm);
      }
      for (auto& o : objs) p.objects.push_back({&o});
      fix::ecfmt(p);
      std::printf("{\\"ws\\":%.4f,\\"src\\":", p.fmt.word_spacing);
      if (std::isfinite(p.srcWordSpacing)) std::printf("%.4f", p.srcWordSpacing); else std::printf("null");
      std::printf(",\\"known\\":%s}\\n", p.srcWordSpacingKnown ? "true" : "false");
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
    const dir = mkdtempSync(join(tmpdir(), "fpe-reedit-space-"));
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
const close = (got, want, what, tol = 0.01) =>
  assert.ok(got.length === want.length && got.every((g, i) => Math.abs(g - want[i]) < tol),
    `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want.map((w) => +w.toFixed(4)))}`);
const near = (got, want, what, tol = 0.01) =>
  assert.ok(Math.abs(got - want) < tol, `${what}: got ${got}, want ${+want.toFixed(4)}`);
const fill = (n, v) => Array(n).fill(v);

// rebrac-short-01 shape: the paper line, its first edit (gen1) and the
// costly -> pricey re-edit.
const PAPER = "is expensive or unsafe, but it makes policy improvement brittle:";
const GEN1 = "is costly or unsafe, but it makes policy improvement brittle:";
const GEN2 = "is pricey or unsafe, but it makes policy improvement brittle:";
const LINE = "the distribution shift induced by that improvement.";
const AFTER = "the distribution shift that this improvement induces.";
const MULTI = "the distribution shift that  this improvement   induces.";
const WS1 = -3.08;

test("gen1 re-laid out unedited at its own word spacing reproduces its emitted width and gaps", (t) => {
  const out = run([`chain fix f 1 tex ${PAPER}|${GEN1}|${WS1}|${GEN1}|${WS1}`,
    `chain fix s 1 tex ${PAPER}|${GEN1}|${WS1}|${GEN1}|${WS1}`,
    `chain base f 1 tex ${PAPER}|${GEN1}|${WS1}|${GEN1}|${WS1}`]);
  if (!out) return t.skip("no host C++ compiler");
  const [fold, spaced, base] = out;
  const S = FALLBACK + WS1;
  for (const [what, r] of [["folded capture", fold], ["spaced capture", spaced]]) {
    const [gen1, again] = r.steps;
    close(gen1.gaps, fill(9, NATURAL + S), `${what} gen1 emission`);
    close(again.gaps, gen1.gaps, `${what} re-layout`);
    near(again.width, gen1.width, `${what} width`);
  }
  // fa2411: every gap counts the source word spacing twice; the line grows
  // by one space measure per gap (the reported 10.27 pt overshoot shape).
  close(base.steps[1].gaps, fill(9, NATURAL + 2 * S), "fa2411 re-layout");
  near(base.steps[1].width - base.steps[0].width, 9 * S, "fa2411 overshoot");
  assert.deepEqual(base.steps[0], fold.steps[0], "first edit (paper, ws unbound = 0) unchanged");
});

test("gen1 re-edit costly -> pricey keeps the natural gap under the same word spacing", (t) => {
  const out = run([`chain fix f 1 tex ${PAPER}|${GEN1}|${WS1}|${GEN2}|${WS1}`,
    `chain fix s 1 tex ${PAPER}|${GEN1}|${WS1}|${GEN2}|${WS1}`,
    `chain base f 1 tex ${PAPER}|${GEN1}|${WS1}|${GEN2}|${WS1}`]);
  if (!out) return t.skip("no host C++ compiler");
  const S = FALLBACK + WS1;
  // Kept, edited/kept boundary and inserted gaps alike.
  close(out[0].steps[1].gaps, fill(9, NATURAL + S), "folded");
  close(out[1].steps[1].gaps, fill(9, NATURAL + S), "spaced");
  close(out[2].steps[1].gaps, fill(9, NATURAL + 2 * S), "fa2411");
  // Glyph advances away from spaces keep their (captured) source values.
  const [gen1, re] = out[0].steps;
  const k = GEN1.indexOf("unsafe");
  for (let i = k; i < GEN1.length; i++)
    if (GEN1[i] !== " " && GEN1[i + 1] !== " ") assert.equal(re.adv[i - GEN1.length + GEN2.length], gen1.adv[i], `glyph ${i}`);
});

test("a requested word spacing other than the source's: positive, negative and zero", (t) => {
  const lines = [];
  for (const ws of [-2, 1.5, 0]) for (const shape of ["f", "s"])
    lines.push(`chain fix ${shape} 1 tex ${PAPER}|${GEN1}|${WS1}|${GEN2}|${ws}`);
  const out = run(lines);
  if (!out) return t.skip("no host C++ compiler");
  let i = 0;
  for (const ws of [-2, 1.5, 0]) for (const shape of ["f", "s"]) {
    const want = ws === 0 ? NATURAL : NATURAL + FALLBACK + ws;
    close(out[i++].steps[1].gaps, fill(9, want), `ws ${ws} ${shape}`);
  }
});

test("positive source word spacing and horizontal scale", (t) => {
  const out = run([`chain fix f 0.98 tex ${PAPER}|${GEN1}|-3.279|${GEN1}|-3.279`,
    `chain fix s 0.98 tex ${PAPER}|${GEN1}|-3.279|${GEN2}|-3.279`,
    `chain fix f 1 tex ${LINE}|${LINE}|1.5|${AFTER}|1.5`,
    `chain fix f 0.98 tex ${LINE}|${LINE}|2.25|${AFTER}|-0.8`]);
  if (!out) return t.skip("no host C++ compiler");
  const S98 = (FALLBACK - 3.279) * 0.98;
  close(out[0].steps[0].gaps, fill(9, NATURAL + S98), "hScale gen1");
  close(out[0].steps[1].gaps, out[0].steps[0].gaps, "hScale unedited");
  near(out[0].steps[1].width, out[0].steps[0].width, "hScale width");
  close(out[1].steps[1].gaps, fill(9, NATURAL + S98), "hScale re-edit");
  close(out[2].steps[1].gaps, fill(6, NATURAL + FALLBACK + 1.5), "positive ws");
  close(out[3].steps[1].gaps, fill(6, NATURAL + (FALLBACK - 0.8) * 0.98), "positive source, negative new, hScale");
});

test("intentional multiple spaces stay that many spaces across generations", (t) => {
  const out = run([`chain fix f 1 tex ${LINE}|${MULTI}|1.5|${MULTI}|1.5|${MULTI}|-0.8`,
    `chain fix s 1 tex ${LINE}|${MULTI}|1.5|${MULTI}|1.5|${MULTI}|0`]);
  if (!out) return t.skip("no host C++ compiler");
  const k = [1, 1, 1, 2, 1, 3];
  for (const r of out) {
    close(r.steps[0].gaps, k.map((n) => n * (NATURAL + FALLBACK + 1.5)), "gen1");
    close(r.steps[1].gaps, r.steps[0].gaps, "unedited");
  }
  close(out[0].steps[2].gaps, k.map((n) => n * (NATURAL + FALLBACK - 0.8)), "re-spaced");
  // At zero word spacing each group falls back to its natural gaps.
  close(out[1].steps[2].gaps, k.map((n) => n * NATURAL), "zero ws");
});

test("repeated capture: the natural gap does not drift over generations", (t) => {
  const out = run([`chain fix f 1 tex ${PAPER}|${GEN1}|${WS1}|${GEN2}|-2.5|${GEN1}|0.75|${GEN1}|0.75`,
    `chain fix s 1 tex ${PAPER}|${GEN1}|${WS1}|${GEN2}|-2.5|${GEN1}|0.75|${GEN1}|0.75`,
    `chain base f 1 tex ${PAPER}|${GEN1}|${WS1}|${GEN2}|-2.5|${GEN1}|0.75`]);
  if (!out) return t.skip("no host C++ compiler");
  for (const r of out.slice(0, 2)) {
    const [g1, g2, g3, g4] = r.steps;
    close(g1.gaps, fill(9, NATURAL + FALLBACK + WS1), "gen1");
    close(g2.gaps, fill(9, NATURAL + FALLBACK - 2.5), "gen2");
    close(g3.gaps, fill(9, NATURAL + FALLBACK + 0.75), "gen3");
    close(g4.gaps, g3.gaps, "gen3 unedited");
    near(g4.width, g3.width, "gen3 width");
  }
  // fa2411 accumulates every generation's space measure.
  close(out[2].steps[2].gaps, fill(9, NATURAL + 3 * FALLBACK + WS1 - 2.5 + 0.75), "fa2411 drift");
});

test("zero source word spacing (the paper, no /ECFmt or ws 0) keeps the fa2411 result", (t) => {
  // The native-space.test.mjs edits as one-step chains, plus multi-step
  // chains run with the source word spacing forced to 0 or below threshold.
  const one = [
    `0 ${LINE}|${AFTER}`, `0 ${LINE}|${MULTI}`, "0 the cat sat on the mat.|the dog sat on the mat.",
    "1.5 " + `${LINE}|${AFTER}`, "-0.8 " + `${LINE}|${AFTER}`, "0 Results.|Final results here.",
    `-3.08 ${PAPER}|${GEN1}`, "1.2 the cat sat on the mat.|the dog sat on the mat.", `1.5 ${LINE}|${MULTI}`,
    `0 ${PAPER}|${GEN1}`, "1.5 Results.|Final results here.",
    "1.5   the cat sat on the mat.|  the dog sat on the mat.",
  ];
  const lines = [];
  for (const c of one) {
    const sp = c.indexOf(" "), ws = c.slice(0, sp), [a, b] = c.slice(sp + 1).split("|");
    for (const [font, shape] of [["tex", "f"], ["texsp", "s"], ["swaplast", "f"]])
      for (const mode of ["fix", "base"]) lines.push(`chain ${mode} ${shape} 1 ${font} ${a}|${b}|${ws}`);
  }
  for (const mode of ["zero", "tiny", "base"])
    for (const shape of ["f", "s"])
      lines.push(`chain ${mode} ${shape} 1 tex ${PAPER}|${GEN1}|${WS1}|${GEN2}|-2|${GEN1}|0`);
  const out = run(lines);
  if (!out) return t.skip("no host C++ compiler");
  const n = one.length * 3;
  for (let i = 0; i < n; i++) assert.deepEqual(out[2 * i], out[2 * i + 1], lines[2 * i]);
  const multi = out.slice(2 * n);
  for (let i = 0; i < 4; i++) assert.deepEqual(multi[i], multi[4 + (i % 2)], lines[2 * n + i]);
});

test("a font with a usable space glyph keeps its source advances", (t) => {
  const out = run([`chain fix s 1 texsp ${PAPER}|${GEN1}|${WS1}|${GEN1}|${WS1}|${GEN2}|0`,
    `chain base s 1 texsp ${PAPER}|${GEN1}|${WS1}|${GEN1}|${WS1}|${GEN2}|0`,
    `chain fix s 1 texsp ${LINE}|${MULTI}|1.5|${AFTER}|-0.8`,
    `chain base s 1 texsp ${LINE}|${MULTI}|1.5|${AFTER}|-0.8`]);
  if (!out) return t.skip("no host C++ compiler");
  assert.deepEqual(out[0], out[1]);
  assert.deepEqual(out[2], out[3]);
});

test("an edited piece resolved to another font: kept pieces normalised, the edit measured as before", (t) => {
  const out = run([`chain fix f 1 swaplast ${LINE}|${LINE}|1.5|${AFTER}|1.5`,
    `chain fix s 1 swaplast ${LINE}|${LINE}|1.5|${AFTER}|1.5`,
    `chain base f 1 swaplast ${LINE}|${LINE}|1.5|${AFTER}|1.5`]);
  if (!out) return t.skip("no host C++ compiler");
  const S = FALLBACK + 1.5;
  close(out[0].steps[1].gaps, [...fill(3, NATURAL + S), ...fill(3, S)], "folded");
  close(out[1].steps[1].gaps, [...fill(3, NATURAL + S), ...fill(3, S)], "spaced");
  close(out[2].steps[1].gaps, [...fill(3, NATURAL + 2 * S), ...fill(3, S)], "fa2411");
});

test("unknown or non-finite source word spacing: no source advance is used", (t) => {
  const lines = [];
  for (const shape of ["f", "s"])
    for (const mode of ["unknown", "nan", "cleared"])
      lines.push(`chain ${mode} ${shape} 1 tex ${PAPER}|${GEN1}|${WS1}|${GEN2}|${WS1}`);
  const out = run(lines);
  if (!out) return t.skip("no host C++ compiler");
  for (const k of [0, 3]) {
    assert.deepEqual(out[k], out[k + 2], lines[k]);
    assert.deepEqual(out[k + 1], out[k + 2], lines[k + 1]);
  }
  // Measured from the font: no natural gap, no source kerning.
  close(out[2].steps[1].gaps, fill(9, FALLBACK + WS1), "measured");
});

test("space groups that cannot be split safely are measured; uncaptured line ends untouched", (t) => {
  const own = (c) => (400 + 10 * (c.charCodeAt(0) - 97)) * SIZE / 1000;
  const S = FALLBACK - 3;
  const a = own("a"), b = own("b"), c = own("c"), d = own("d");
  const out = run([
    // Folded gap: natural 1.2 + S on "b".
    `raw -3 -3 ab cd|${a},${b + 1.2 + S},0,${c},${d}`,
    // Uncaptured spaces (cut line end): "b" keeps its advance.
    `raw -3 -3 ab cd|${a},${b + 0.7},-1,${c},${d}`,
    // One space captured, one not: both and "b" measured.
    `raw -3 -3 ab  cd|${a},${b + 3},-1,0.4,${c},${d}`,
    // Less than one space measure in the gap: negative natural, measured.
    `raw -3 -3 ab cd|${a},${b + 0.5 * S},0,${c},${d}`,
    // Glyph before the space with unknown metrics ("R" is known, "Z" not).
    `raw -3 -3 aZ cd|${a},5,0,${c},${d}`,
    // Gap on the space: give the measure back from the space.
    `raw -3 -3 ab cd|${a},${b},${1.2 + S},${c},${d}`,
    // Gap on the space but smaller than the measure: the rest from the fold.
    `raw -3 -3 ab cd|${a},${b + 1.0},${S - 0.5},${c},${d}`,
    // Indent after a line break keeps its captured advances (at Tw 0 a kept
    // indent space is its source advance, as in fa2411).
    `raw 0 -3 ab^  cd|${a},${b},-1,${S},${S},${c},${d}`,
  ]);
  if (!out) return t.skip("no host C++ compiler");
  const [fold, cut, mixed, neg, unk, onSpace, partial, indent] = out.map((o) => o.adv);
  close(fold, [a, b + 1.2, S, c, d], "folded");
  close(cut, [a, b + 0.7, S, c, d], "cut line end");
  close(mixed, [a, b, S, S, c, d], "mixed");
  close(neg, [a, b, S, c, d], "negative natural");
  close(unk, [a, FALLBACK, S, c, d], "unknown metrics");
  // Natural 1.2 sits on the space: the kept token adds it only where the
  // natural gap is known (sampled), as fa2411 does for any kept space.
  close([onSpace[0], onSpace[1], onSpace[3], onSpace[4]], [a, b, c, d], "on space glyphs");
  near(onSpace[2], S + 1.2, "on space");
  near(partial[1], b + 0.5, "partial fold");
  close(indent.slice(3, 5), [S, S], "indent after a line break");
});

test("/ECFmt binding: the matching mark binds ws; any other nonzero or unreadable mark makes it unknown", (t) => {
  const F = (ws, h = "{h}") => `ECFmt:1|a0|ls1.2000|cs0.0000|ps0.000|ws${ws}|fi0.00|hi0.00|d0|ll0|h${h}`;
  const T = "is costly or unsafe";
  const out = run([
    `ecfmt ${T}#${F("-3.2791")}`,
    `ecfmt ${T}#${F("-3.2791", "00000000")}`,
    `ecfmt ${T}#${F("0.0000", "00000000")}`,
    `ecfmt ${T}#${F("-3.2791")}#${F("1.5000", "00000000")}`,
    `ecfmt ${T}#${F("0.0000")}#${F("0.0030", "00000000")}`,
    `ecfmt ${T}#ECFmt:1|a0|junk`,
    `ecfmt ${T}#ECFmt!`,
    `ecfmt ${T}#${F("250.0000")}`,
    `ecfmt ${T}#${F("nan")}`,
    `ecfmt ${T}`,
    `ecfmt ${T}#P#Span:x`,
    `ecfmt ${T}#${F("2.5000")}`,
    // The bound mark repeated (another object of the same emission).
    `ecfmt ${T}#${F("-3.2791")}#${F("-3.2791")}`,
    // Same hash, another word spacing.
    `ecfmt ${T}#${F("-3.2791")}#${F("-2.0000")}`,
  ]);
  if (!out) return t.skip("no host C++ compiler");
  const want = [
    [-3.2791, -3.2791, true], [0, 0, false], [0, 0, true], [-3.2791, -3.2791, false],
    [0, 0, true], [0, 0, false], [0, 0, false], [0, 0, false], [0, 0, false],
    [0, 0, true], [0, 0, true], [2.5, 2.5, true], [-3.2791, -3.2791, true], [-3.2791, -3.2791, false],
  ];
  for (const [i, [ws, src, known]] of want.entries()) {
    near(out[i].ws, ws, `case ${i} fmt ws`, 1e-4);
    near(out[i].src, src, `case ${i} src`, 1e-4);
    assert.equal(out[i].known, known, `case ${i} known`);
  }
});
