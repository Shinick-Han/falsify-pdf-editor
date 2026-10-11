// Concurrency regressions for the opt-in candidate loader. Real pinned
// baseline bytes, relabelled per candidate (JS default-export wrapper plus a
// WASM custom section), with mocked patch provenance: these establish
// module-graph and engine-instance isolation, not that any C++ was rebuilt.
// registerHooks hooks and the ESM cache are process-global, so every
// scenario runs in a fresh child process; the parent never touches its own
// env, globals or hooks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { CANDIDATE_ENV, PINS, readVerifiedRuntime, resolveRuntimeDir, resolveSourceRoot, sha256 } from "../src/runtime.mjs";
import { prepareCandidateRuntime } from "../scripts/prepare-candidate-runtime.mjs";

const SOURCE_ROOT = resolveSourceRoot();
const hasSource = existsSync(join(SOURCE_ROOT, PINS.bentopdf.path, "src", "js", "editcore", "core.js")) && existsSync(join(SOURCE_ROOT, PINS.engine.path, "packages"));
const hasRuntime = hasSource && existsSync(join(resolveRuntimeDir(), "editcore.wasm"));
const skip = !hasRuntime && "runtime not prepared";

const RUNTIME_URL = new URL("../src/runtime.mjs", import.meta.url).href;
const APP_SCOPE = pathToFileURL(join(SOURCE_ROOT, PINS.bentopdf.path, "src", "js")).href + "/";
// Static import graph of editcore/core.js, relative to src/js. Every loaded
// engine graph must load all of these under its own module tag.
const CORE_GRAPH = ["editcore/core.js", "editcore/engine-loader.js", "editcore/shadingsurgery.js", "editcore/type3surgery.js", "utils/freetext-script.ts"];
const BASELINE = Object.freeze({ label: null, manifest: null, jsSha256: PINS.engine.js.sha256, wasmSha256: PINS.engine.wasm.sha256 });

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "fpe-conc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A custom section (id 0) after the last section keeps the module valid, so
// the engine still instantiates, while the bytes and digest become per-label.
function labelledWasm(base, label) {
  const name = Buffer.from("fpe-label");
  const body = Buffer.concat([Buffer.from([name.length]), name, Buffer.from(label)]);
  assert.ok(body.length < 128);
  return Buffer.concat([Buffer.from(base), Buffer.from([0, body.length]), body]);
}

// Wraps the default export so each M records which JS module created it.
// Emscripten returns the moduleArg object as M, so M.wasmBinary is exactly
// the binary the loader handed to this factory.
const DEFAULT_EXPORT = "export default createPdfium;";
function labelledJs(base, label) {
  const src = Buffer.from(base).toString("utf8");
  assert.equal(src.split(DEFAULT_EXPORT).length, 2, "baseline JS has exactly one default export");
  const wrapper = [
    `const __fpeLabel = ${JSON.stringify(label)};`,
    "(globalThis.__fpeEvaluated ??= []).push({ label: __fpeLabel, url: import.meta.url });",
    "export default async function fpeLabelled(moduleArg) {",
    "  const M = await createPdfium(moduleArg);",
    "  M.__fpeJsLabel = __fpeLabel;",
    "  M.__fpeJsUrl = import.meta.url;",
    "  return M;",
    "}",
  ].join("\n");
  return Buffer.from(src.replace(DEFAULT_EXPORT, () => wrapper));
}

function stageCandidate(root, base, label, patch) {
  const inputs = join(root, `${label}-inputs`);
  const parent = join(root, `${label}-parent`);
  mkdirSync(inputs);
  mkdirSync(parent);
  const js = labelledJs(base.js.bytes, label);
  const wasm = labelledWasm(base.wasm.bytes, label);
  writeFileSync(join(inputs, "pdfium.js"), js);
  writeFileSync(join(inputs, "pdfium.wasm"), wasm);
  const { manifestPath } = prepareCandidateRuntime({
    parentDir: parent,
    jsPath: join(inputs, "pdfium.js"),
    wasmPath: join(inputs, "pdfium.wasm"),
    patchPaths: [patch],
    expectJsSha256: sha256(js),
    expectWasmSha256: sha256(wasm),
    note: "mock provenance only; no C++ was rebuilt",
  });
  return { label, manifest: manifestPath, jsSha256: sha256(js), wasmSha256: sha256(wasm) };
}

function fixture(t, labels) {
  const root = scratch(t);
  const base = readVerifiedRuntime(resolveRuntimeDir());
  const patch = join(root, "mock-editcore.patch");
  writeFileSync(patch, "mock provenance only; no C++ was rebuilt\n");
  return Object.fromEntries(labels.map((l) => [l, stageCandidate(root, base, l, patch)]));
}

// Child scenario: an observer hook registered before the loader runs after
// the loader hooks, so it sees every app-scope module load the loader does
// not short-circuit. Runtimes load concurrently (Promise.all) or one after
// another; engines are then constructed interleaved: r0, r1, r0, r1.
const CHILD = `
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
const cfg = JSON.parse(process.argv[process.argv.length - 1]);
const loads = [];
const observer = registerHooks({
  load(url, context, next) {
    if (url.startsWith(cfg.scope)) loads.push(url);
    return next(url, context);
  },
});
try {
  const { loadRuntime } = await import(cfg.runtimeUrl);
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const load = (c) => loadRuntime({ candidateManifest: c });
  let rts;
  if (cfg.mode === "concurrent") rts = await Promise.all(cfg.manifests.map(load));
  else {
    rts = [];
    for (const c of cfg.manifests) rts.push(await load(c));
  }
  const order = [...rts.keys(), ...rts.keys()];
  const engines = await Promise.all(order.map(async (i) => {
    const engine = await rts[i].engineFactory();
    const M = engine.M;
    return { i, jsLabel: M.__fpeJsLabel ?? null, jsUrl: M.__fpeJsUrl ?? null, wasmSha256: sha(M.wasmBinary), initialized: typeof M._FPDF_InitLibraryWithConfig === "function" && typeof engine.open === "function" };
  }));
  const infos = rts.map((rt) => ({ jsSha256: rt.info.jsSha256, wasmSha256: rt.info.wasmSha256, moduleTag: rt.info.candidate?.moduleTag ?? "", moduleUrl: rt.info.candidate?.moduleUrl ?? null, sourceBuildVerified: rt.info.candidate?.sourceBuildVerified ?? null }));
  process.stdout.write("\\nFPE-RESULT " + JSON.stringify({ infos, engines, loads, evaluated: globalThis.__fpeEvaluated ?? [] }) + "\\n");
} finally {
  observer.deregister();
}
`;

function runScenario(mode, specs) {
  const env = { ...process.env };
  delete env[CANDIDATE_ENV];
  const cfg = { mode, runtimeUrl: RUNTIME_URL, scope: APP_SCOPE, manifests: specs.map((s) => s.manifest) };
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD, JSON.stringify(cfg)], { env, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("FPE-RESULT "));
  assert.ok(r.status === 0 && line, `${mode} child failed: status ${r.status} ${r.error ?? ""}\n${r.stderr}`);
  return JSON.parse(line.slice("FPE-RESULT ".length));
}

// Collects every isolation violation so a failure reports all of them.
function violations(result, specs) {
  const out = [];
  const check = (ok, msg) => ok || out.push(msg);
  const name = (i) => specs[i].label ?? "baseline";
  specs.forEach((s, i) => {
    const info = result.infos[i];
    check(info.jsSha256 === s.jsSha256, `${name(i)} info.jsSha256 ${info.jsSha256}`);
    check(info.wasmSha256 === s.wasmSha256, `${name(i)} info.wasmSha256 ${info.wasmSha256}`);
    if (s.label === null) check(info.moduleTag === "" && info.sourceBuildVerified === null, "baseline reported candidate info");
    else check(info.moduleTag !== "" && info.sourceBuildVerified === false, `${name(i)} candidate info missing or claims source build`);
  });
  const tags = result.infos.map((x) => x.moduleTag);
  check(new Set(tags).size === tags.length, `module tags collide: ${tags}`);

  for (const e of result.engines) {
    const s = specs[e.i];
    check(e.initialized, `${name(e.i)} engine not initialized`);
    check(e.jsLabel === s.label, `${name(e.i)} engine M built by JS ${e.jsLabel ?? "baseline"}`);
    check(e.jsUrl === result.infos[e.i].moduleUrl, `${name(e.i)} engine M built by ${e.jsUrl}`);
    check(e.wasmSha256 === s.wasmSha256, `${name(e.i)} engine M instantiated from wasm ${e.wasmSha256}`);
  }
  specs.forEach((s, i) => {
    if (s.label === null) return;
    const ev = result.evaluated.filter((x) => x.label === s.label);
    check(ev.length === 1 && ev[0].url === result.infos[i].moduleUrl, `${name(i)} JS evaluated as ${JSON.stringify(ev)}`);
  });

  // App-scope module graph per tag ("" = baseline): each runtime must have
  // loaded the whole core graph under its own tag, and nothing else.
  const byTag = new Map();
  for (const url of result.loads) {
    const [path, query = ""] = url.slice(APP_SCOPE.length).split("?");
    const tag = query.startsWith("fpe-candidate=") ? query.slice("fpe-candidate=".length) : query && `?${query}`;
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(path);
  }
  for (const [tag, paths] of byTag) {
    const i = tags.indexOf(tag);
    if (i === -1) check(false, `stray app-scope modules under tag ${tag}: ${paths}`);
    else check(JSON.stringify([...paths].sort()) === JSON.stringify(CORE_GRAPH), `${name(i)} graph loaded ${JSON.stringify([...paths].sort())}`);
  }
  tags.forEach((tag, i) => check(byTag.has(tag), `${name(i)} graph loaded nothing under its own tag`));
  return out;
}

function assertBaselineUntouched() {
  const rt = readVerifiedRuntime(resolveRuntimeDir());
  assert.equal(rt.js.sha256, PINS.engine.js.sha256);
  assert.equal(rt.wasm.sha256, PINS.engine.wasm.sha256);
}

test("two candidate folders loaded with Promise.all keep separate graphs and engines", { skip }, (t) => {
  const { A, B } = fixture(t, ["A", "B"]);
  const specs = [A, B];
  // Control: one after another in one process.
  assert.deepEqual(violations(runScenario("sequential", specs), specs), [], "sequential control");
  assert.deepEqual(violations(runScenario("concurrent", specs), specs), [], "concurrent Promise.all");
  assertBaselineUntouched();
});

test("baseline and candidate interleaved in one process stay isolated in both orders", { skip }, (t) => {
  const { C } = fixture(t, ["C"]);
  for (const specs of [[BASELINE, C], [C, BASELINE]]) {
    const order = specs.map((s) => s.label ?? "baseline").join("+");
    assert.deepEqual(violations(runScenario("sequential", specs), specs), [], `sequential control ${order}`);
    assert.deepEqual(violations(runScenario("concurrent", specs), specs), [], `concurrent ${order}`);
  }
  assertBaselineUntouched();
});
