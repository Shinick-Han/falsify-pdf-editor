// Opt-in candidate runtime tests. Synthetic bytes only; no PDFs. The
// real-engine cases reuse the pinned baseline files with a mocked patch
// list: they establish manifest/path/cache handling, not that any C++ was
// rebuilt. They run when pinned sources and a prepared .runtime exist.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CANDIDATE_ENV, CANDIDATE_MANIFEST_NAME, CANDIDATE_PINS, CANDIDATE_SCHEMA, PINS, loadRuntime, readCandidateRuntime, readVerifiedRuntime, resolveCandidateManifest, resolveRuntimeDir, resolveSourceRoot, sha256, validateCandidateManifest } from "../src/runtime.mjs";
import { CANDIDATE_DIR_NAME, parseArgs, prepareCandidateRuntime } from "../scripts/prepare-candidate-runtime.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "fpe-cand-"));
const PATCH_SHA = sha256(Buffer.from("mock patch provenance"));
const IMPORT_PROBE = Buffer.from("globalThis.__fpeCandidateImported = (globalThis.__fpeCandidateImported ?? 0) + 1;\nexport default () => {};\n");

const baseManifest = (jsSha, wasmSha) => ({
  schema: CANDIDATE_SCHEMA,
  upstream: { bentopdfCommit: PINS.bentopdf.commit, engineCommit: PINS.engine.commit, pdfiumCommit: CANDIDATE_PINS.pdfiumCommit },
  toolchain: { emsdk: CANDIDATE_PINS.emsdk },
  sourcePatches: [{ name: "mock.patch", sha256: PATCH_SHA }],
  artifacts: { js: { path: "editcore.js", sha256: jsSha }, wasm: { path: "editcore.wasm", sha256: wasmSha } },
  provenance: { note: "test fixture" },
});

// Writes a candidate folder whose JS records any import into a global.
function writeCandidate(dir, edit = (m) => m, { js = IMPORT_PROBE, wasm = Buffer.from("not really wasm") } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "editcore.js"), js);
  writeFileSync(join(dir, "editcore.wasm"), wasm);
  const path = join(dir, CANDIDATE_MANIFEST_NAME);
  writeFileSync(path, JSON.stringify(edit(baseManifest(sha256(js), sha256(wasm)))));
  return path;
}

async function withEnv(value, fn) {
  const saved = process.env[CANDIDATE_ENV];
  if (value === undefined) delete process.env[CANDIDATE_ENV];
  else process.env[CANDIDATE_ENV] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[CANDIDATE_ENV];
    else process.env[CANDIDATE_ENV] = saved;
  }
}

// ---------- manifest validation ----------

test("validateCandidateManifest accepts the pinned shape and rejects drift", () => {
  const ok = baseManifest("a".repeat(64), "b".repeat(64));
  assert.equal(validateCandidateManifest(ok), ok);
  const clone = () => structuredClone(ok);
  const cases = [
    ["CANDIDATE_INVALID", (m) => ({ ...m, schema: "other/1" })],
    ["CANDIDATE_INVALID", (m) => ({ ...m, rebuiltFromCpp: true })],
    ["CANDIDATE_INVALID", (m) => ({ ...m, provenance: { sourceBuildVerified: true } })],
    ["CANDIDATE_INVALID", (m) => ({ ...m, sourcePatches: [] })],
    ["CANDIDATE_INVALID", (m) => { delete m.sourcePatches; return m; }],
    ["CANDIDATE_INVALID", (m) => ({ ...m, sourcePatches: [{ name: "x", sha256: "A".repeat(64) }] })],
    ["CANDIDATE_INVALID", (m) => ({ ...m, sourcePatches: [m.sourcePatches[0], m.sourcePatches[0]] })],
    ["CANDIDATE_INVALID", (m) => { delete m.artifacts.wasm.sha256; return m; }],
    ["CANDIDATE_INVALID", (m) => { m.artifacts.js.sha256 = "abc"; return m; }],
    ["CANDIDATE_INVALID", (m) => { m.artifacts.js.path = "../editcore.js"; return m; }],
    ["CANDIDATE_INVALID", (m) => { m.artifacts.wasm.path = "C:/x/editcore.wasm"; return m; }],
    ["CANDIDATE_INVALID", (m) => { m.upstream.engineCommit = "short"; return m; }],
    ["CANDIDATE_PIN_MISMATCH", (m) => { m.upstream.engineCommit = "0".repeat(40); return m; }],
    ["CANDIDATE_PIN_MISMATCH", (m) => { m.upstream.bentopdfCommit = "0".repeat(40); return m; }],
    ["CANDIDATE_PIN_MISMATCH", (m) => { m.upstream.pdfiumCommit = "0".repeat(40); return m; }],
    ["CANDIDATE_PIN_MISMATCH", (m) => { m.toolchain.emsdk = "3.1.71"; return m; }],
    ["CANDIDATE_INVALID", () => null],
    ["CANDIDATE_INVALID", () => []],
  ];
  for (const [code, edit] of cases) assert.throws(() => validateCandidateManifest(edit(clone())), { code }, code + " " + edit);
});

test("readCandidateRuntime enforces path rules and hashes both artifacts", () => {
  const dir = tmp();
  const path = writeCandidate(dir);
  const rt = readCandidateRuntime(path);
  assert.equal(rt.js.sha256, sha256(IMPORT_PROBE));
  assert.equal(rt.candidate.trust, "caller-expected-digests");
  assert.equal(rt.candidate.sourceBuildVerified, false);
  assert.equal(rt.candidate.manifestSha256, sha256(readFileSync(path)));
  assert.throws(() => readCandidateRuntime("rel/" + CANDIDATE_MANIFEST_NAME), { code: "CANDIDATE_INVALID" });
  assert.throws(() => readCandidateRuntime(join(dir, "manifest.json")), { code: "CANDIDATE_INVALID" });
  assert.throws(() => readCandidateRuntime(join(tmp(), CANDIDATE_MANIFEST_NAME)), { code: "CANDIDATE_MISSING" });
  writeFileSync(join(dir, "editcore.js"), Buffer.concat([IMPORT_PROBE, Buffer.from("//x")]));
  assert.throws(() => readCandidateRuntime(path), { code: "CANDIDATE_HASH_MISMATCH" });
  const d2 = tmp();
  const p2 = writeCandidate(d2);
  writeFileSync(join(d2, "editcore.wasm"), "tampered");
  assert.throws(() => readCandidateRuntime(p2), { code: "CANDIDATE_HASH_MISMATCH" });
  const d3 = tmp();
  writeFileSync(join(d3, CANDIDATE_MANIFEST_NAME), "{not json");
  assert.throws(() => readCandidateRuntime(join(d3, CANDIDATE_MANIFEST_NAME)), { code: "CANDIDATE_INVALID" });
});

// ---------- loader: rejection happens before any import ----------

test("loadRuntime rejects bad candidates before importing any code", async () => {
  delete globalThis.__fpeCandidateImported;
  const src = tmp(); // not a pinned checkout: import would also need verifyAppSource
  const make = (edit, files) => writeCandidate(tmp(), edit, files);
  const tamperJs = () => {
    const d = tmp();
    const p = writeCandidate(d);
    writeFileSync(join(d, "editcore.js"), "globalThis.__fpeCandidateImported = 99; export default 1;");
    return p;
  };
  const tamperWasm = () => {
    const d = tmp();
    const p = writeCandidate(d);
    writeFileSync(join(d, "editcore.wasm"), "tampered");
    return p;
  };
  const cases = [
    ["CANDIDATE_MISSING", join(tmp(), CANDIDATE_MANIFEST_NAME)],
    ["CANDIDATE_PIN_MISMATCH", make((m) => { m.upstream.engineCommit = "1".repeat(40); return m; })],
    ["CANDIDATE_INVALID", make((m) => { delete m.artifacts.js.sha256; return m; })],
    ["CANDIDATE_INVALID", make((m) => ({ ...m, sourcePatches: [] }))],
    ["CANDIDATE_HASH_MISMATCH", tamperJs()],
    ["CANDIDATE_HASH_MISMATCH", tamperWasm()],
    ["CANDIDATE_INVALID", "relative/" + CANDIDATE_MANIFEST_NAME],
  ];
  for (const [code, candidateManifest] of cases) {
    await assert.rejects(loadRuntime({ sourceRoot: src, candidateManifest }), { code }, code);
  }
  // A valid candidate still requires the pinned app sources before import.
  await assert.rejects(loadRuntime({ sourceRoot: src, candidateManifest: make() }), (e) => ["SOURCE_MISSING", "PIN_MISMATCH"].includes(e.code));
  await assert.rejects(loadRuntime({ sourceRoot: src, runtimeDir: tmp(), candidateManifest: make() }), { code: "CANDIDATE_CONFLICT" });
  assert.equal(globalThis.__fpeCandidateImported, undefined);
});

test("candidate is opt-in only: env is honored, null and absence keep the pinned baseline", async () => {
  delete globalThis.__fpeCandidateImported;
  const src = tmp();
  const d = tmp();
  const manifest = writeCandidate(d);
  writeFileSync(join(d, "editcore.wasm"), "tampered");
  assert.equal(resolveCandidateManifest(undefined) === null, !process.env[CANDIDATE_ENV]);
  await withEnv("", () => assert.equal(resolveCandidateManifest(undefined), null));
  await withEnv(manifest, async () => {
    assert.equal(resolveCandidateManifest(undefined), manifest);
    await assert.rejects(loadRuntime({ sourceRoot: src }), { code: "CANDIDATE_HASH_MISMATCH" });
    // Explicit null opts out of the environment and uses the baseline dir.
    await assert.rejects(loadRuntime({ sourceRoot: src, candidateManifest: null, runtimeDir: tmp() }), { code: "RUNTIME_MISSING" });
  });
  await withEnv("relative/" + CANDIDATE_MANIFEST_NAME, () => assert.rejects(loadRuntime({ sourceRoot: src }), { code: "CANDIDATE_INVALID" }));

  // A valid manifest next to rebuilt files in a baseline runtime dir is ignored:
  // the baseline still demands the exact pinned hashes.
  await withEnv(undefined, async () => {
    const rtDir = tmp();
    writeCandidate(rtDir);
    assert.throws(() => readVerifiedRuntime(rtDir), { code: "RUNTIME_HASH_MISMATCH" });
    await assert.rejects(loadRuntime({ sourceRoot: src, runtimeDir: rtDir }), { code: "RUNTIME_HASH_MISMATCH" });
  });
  assert.equal(globalThis.__fpeCandidateImported, undefined);
});

// ---------- prepare-candidate-runtime output safety ----------

test("prepareCandidateRuntime refuses unsafe or unproven input before writing", () => {
  const parent = tmp();
  const inputs = tmp();
  writeFileSync(join(inputs, "a.js"), "export default 1;");
  writeFileSync(join(inputs, "a.wasm"), "wasm");
  writeFileSync(join(inputs, "x.patch"), "diff");
  const base = { parentDir: parent, jsPath: join(inputs, "a.js"), wasmPath: join(inputs, "a.wasm"), patchPaths: [join(inputs, "x.patch")], sourceRoot: tmp() };
  assert.throws(() => prepareCandidateRuntime({ ...base, patchPaths: [] }), { code: "CANDIDATE_INVALID" });
  assert.throws(() => prepareCandidateRuntime({ ...base, parentDir: "relative" }), { code: "UNSAFE_OUTPUT" });
  assert.throws(() => prepareCandidateRuntime({ ...base, parentDir: join(parent, "nope") }), { code: "UNSAFE_OUTPUT" });
  assert.throws(() => prepareCandidateRuntime({ ...base, expectWasmSha256: "0".repeat(64) }), { code: "CANDIDATE_HASH_MISMATCH" });
  assert.throws(() => prepareCandidateRuntime({ ...base, expectJsSha256: "nothex" }), { code: "CANDIDATE_INVALID" });
  assert.throws(() => prepareCandidateRuntime({ ...base, patchPaths: [join(inputs, "missing.patch")] }), { code: "CANDIDATE_MISSING" });
  // Not a pinned checkout: refused before anything is written.
  assert.throws(() => prepareCandidateRuntime(base), (e) => ["SOURCE_MISSING", "PIN_MISMATCH"].includes(e.code));
  assert.deepEqual(readdirSync(parent), []);
  mkdirSync(join(parent, CANDIDATE_DIR_NAME));
  writeFileSync(join(parent, CANDIDATE_DIR_NAME, "user-notes.txt"), "keep");
  assert.throws(() => prepareCandidateRuntime(base), { code: "UNSAFE_OUTPUT" });
  assert.equal(readFileSync(join(parent, CANDIDATE_DIR_NAME, "user-notes.txt"), "utf8"), "keep");
  assert.deepEqual(parseArgs(["--parent", parent, "--js", base.jsPath, "--patch", "p1", "--patch", "p2"]).patchPaths.length, 2);
  assert.throws(() => parseArgs(["--js", "a", "--js", "b"]), { code: "CANDIDATE_INVALID" });
  assert.throws(() => parseArgs(["--bogus", "x"]), { code: "CANDIDATE_INVALID" });
});

// ---------- real engine: identical baseline bytes, mocked provenance ----------

const SOURCE_ROOT = resolveSourceRoot();
const hasSource = existsSync(join(SOURCE_ROOT, PINS.bentopdf.path, "src", "js", "editcore", "core.js")) && existsSync(join(SOURCE_ROOT, PINS.engine.path, "packages"));
const hasRuntime = hasSource && existsSync(join(resolveRuntimeDir(), "editcore.wasm"));

test("real engine: candidate loads via option and env, cache follows content identity", { skip: !hasRuntime && "runtime not prepared" }, async () => {
  const base = readVerifiedRuntime(resolveRuntimeDir());
  const inputs = tmp();
  const patch = join(inputs, "mock-editcore.patch");
  writeFileSync(patch, "mock provenance only; no C++ was rebuilt\n");
  const write = (name, bytes) => {
    const p = join(inputs, name);
    writeFileSync(p, bytes);
    return p;
  };
  const wasmPath = write("pdfium.wasm", base.wasm.bytes);
  const parentA = tmp();
  writeFileSync(join(parentA, "sibling.txt"), "untouched");
  const optsA = { parentDir: parentA, jsPath: write("pdfium.js", base.js.bytes), wasmPath, patchPaths: [patch], expectJsSha256: base.js.sha256, expectWasmSha256: base.wasm.sha256 };
  prepareCandidateRuntime(optsA);
  const { manifestPath: manifestA } = prepareCandidateRuntime(optsA); // replaces only its own output
  assert.deepEqual(readdirSync(parentA).sort(), [CANDIDATE_DIR_NAME, "sibling.txt"]);
  assert.deepEqual(readdirSync(join(parentA, CANDIDATE_DIR_NAME)).sort(), [CANDIDATE_MANIFEST_NAME, "editcore.js", "editcore.wasm"]);

  await withEnv(undefined, async () => {
    const rt = await loadRuntime({ candidateManifest: manifestA });
    assert.equal(rt.info.wasmSha256, PINS.engine.wasm.sha256);
    assert.equal(rt.info.candidate.sourceBuildVerified, false);
    assert.equal(rt.info.candidate.sourcePatches[0].name, "mock-editcore.patch");
    const engine = await rt.engineFactory();
    assert.equal(typeof engine.open, "function");
    const baseline = await loadRuntime();
    assert.equal(baseline.info.candidate, undefined);
    assert.equal(baseline.info.jsSha256, PINS.engine.js.sha256);
  });
  // Env opt-in is what unchanged editPdf/CLI rely on (they call loadRuntime without candidateManifest).
  await withEnv(manifestA, async () => {
    const rt = await loadRuntime();
    assert.equal(rt.info.candidate.manifestPath, manifestA);
  });

  // Identical manifest content in another folder: distinct module identity.
  const dirC = join(tmp(), CANDIDATE_DIR_NAME);
  mkdirSync(dirC);
  for (const f of [CANDIDATE_MANIFEST_NAME, "editcore.js", "editcore.wasm"]) copyFileSync(join(parentA, CANDIDATE_DIR_NAME, f), join(dirC, f));
  await withEnv(undefined, async () => {
    const a = await loadRuntime({ candidateManifest: manifestA });
    const c = await loadRuntime({ candidateManifest: join(dirC, CANDIDATE_MANIFEST_NAME) });
    assert.equal(a.info.candidate.manifestSha256, c.info.candidate.manifestSha256);
    assert.notEqual(a.info.candidate.moduleTag, c.info.candidate.moduleTag);
    assert.notEqual(a.info.candidate.moduleUrl, c.info.candidate.moduleUrl);
  });

  // Same folder, changed JS content: new identity, new module instance.
  const parentB = tmp();
  const marked = (tag) => Buffer.concat([Buffer.from(base.js.bytes), Buffer.from(`\n;globalThis.__fpeCandidateMarker = ${JSON.stringify(tag)};\n`)]);
  await withEnv(undefined, async () => {
    const { manifestPath } = prepareCandidateRuntime({ parentDir: parentB, jsPath: write("one.js", marked("one")), wasmPath, patchPaths: [patch] });
    const one = await loadRuntime({ candidateManifest: manifestPath });
    assert.equal(globalThis.__fpeCandidateMarker, "one");
    prepareCandidateRuntime({ parentDir: parentB, jsPath: write("two.js", marked("two")), wasmPath, patchPaths: [patch] });
    const two = await loadRuntime({ candidateManifest: manifestPath });
    assert.equal(globalThis.__fpeCandidateMarker, "two");
    assert.notEqual(one.info.candidate.manifestSha256, two.info.candidate.manifestSha256);
    assert.notEqual(one.info.candidate.moduleUrl, two.info.candidate.moduleUrl);
    assert.match(two.info.candidate.moduleUrl, new RegExp(`\\?fpe-candidate=${two.info.candidate.moduleTag}$`));
    assert.equal(typeof (await two.engineFactory()).open, "function");

    // The baseline loader refuses the rebuilt (marked) JS outright.
    const rtDir = tmp();
    writeFileSync(join(rtDir, "editcore.js"), marked("three"));
    writeFileSync(join(rtDir, "editcore.wasm"), base.wasm.bytes);
    await assert.rejects(loadRuntime({ runtimeDir: rtDir }), { code: "RUNTIME_HASH_MISMATCH" });
  });
});
