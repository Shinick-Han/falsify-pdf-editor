// Runtime loader for the pinned BentoPDF editcore engine.
//
// The engine JS/WASM are prepared by scripts/prepare-runtime.mjs from pinned
// git blobs into the ignored .runtime/ directory. The upstream PdfEngine
// (src/js/editcore/core.js) is imported unmodified from the pinned BentoPDF
// submodule; a scoped, temporary Node resolver hook supplies the two
// specifiers that only Vite resolves in the browser build.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PINS = Object.freeze({
  bentopdf: Object.freeze({
    path: "upstream/bentopdf",
    commit: "3a5f146d1b89d54dc7ca576aa6797c8bd3e42b97",
    // Tracked sources loaded at runtime; they must match the pinned commit.
    trackedSources: Object.freeze(["src/js/editcore", "src/js/utils/freetext-script.ts"]),
  }),
  engine: Object.freeze({
    path: "upstream/engine",
    commit: "813903c93c758dfb8df46dbd34ace3b7f7a8538b",
    js: Object.freeze({
      blob: "packages/pdfium/src/vendor/pdfium.js",
      out: "editcore.js",
      sha256: "6e6989a9994715951720e05355111aca7eab898e92b519ebea160167875bb3eb",
    }),
    wasm: Object.freeze({
      blob: "packages/pdfium/src/vendor/pdfium.wasm",
      out: "editcore.wasm",
      sha256: "1860f0b33a1c7d231b78fa9bfedace19739f06e80b1d5f654dd2ea77a7a893ce",
    }),
  }),
});

export class RuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Source root holds the upstream/ submodules. Defaults to this module's root;
// FALSIFY_EDITOR_SOURCE_ROOT overrides it (e.g. for a git worktree whose
// submodules are not checked out).
export function resolveSourceRoot(sourceRoot) {
  return resolve(sourceRoot ?? process.env.FALSIFY_EDITOR_SOURCE_ROOT ?? MODULE_ROOT);
}

export function resolveRuntimeDir(runtimeDir) {
  return resolve(runtimeDir ?? join(MODULE_ROOT, ".runtime"));
}

export function git(cwd, args, encoding = "utf8") {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new RuntimeError("GIT_UNAVAILABLE", `git could not be run: ${r.error.message}`);
  return r;
}

export function checkPinnedCheckout(sourceRoot, pin) {
  const repo = join(sourceRoot, pin.path);
  const head = git(repo, ["rev-parse", "HEAD"]);
  if (head.status !== 0) throw new RuntimeError("SOURCE_MISSING", `${pin.path} is not a checked-out git repository; run git submodule update --init`);
  const actual = head.stdout.trim();
  if (actual !== pin.commit) throw new RuntimeError("PIN_MISMATCH", `${pin.path} HEAD ${actual} does not match pinned ${pin.commit}`);
  return repo;
}

// The upstream app pin must be checked out and its loaded core sources must
// be byte-identical (modulo git line-ending normalization) to the pin, with
// no untracked files in those paths.
export function verifyAppSource(sourceRoot, pins = PINS) {
  const app = checkPinnedCheckout(sourceRoot, pins.bentopdf);
  const tracked = pins.bentopdf.trackedSources;
  const listed = git(app, ["ls-files", "--error-unmatch", "--", ...tracked]);
  if (listed.status !== 0) throw new RuntimeError("SOURCE_MISSING", "Pinned BentoPDF core sources are not tracked at the expected paths");
  const diff = git(app, ["diff", "--quiet", pins.bentopdf.commit, "--", ...tracked]);
  if (diff.status !== 0) throw new RuntimeError("SOURCE_MODIFIED", `${pins.bentopdf.path} core sources differ from pinned ${pins.bentopdf.commit}`);
  const untracked = git(app, ["ls-files", "--others", "--", ...tracked]);
  if (untracked.status !== 0 || untracked.stdout.trim()) throw new RuntimeError("SOURCE_MODIFIED", `${pins.bentopdf.path} core source paths contain untracked files`);
  return app;
}

export function readVerifiedRuntime(runtimeDir, pins = PINS) {
  const out = {};
  for (const key of ["js", "wasm"]) {
    const spec = pins.engine[key];
    const path = join(runtimeDir, spec.out);
    if (!existsSync(path)) {
      throw new RuntimeError("RUNTIME_MISSING", `Runtime file ${spec.out} is missing; run npm run prepare:runtime`);
    }
    const bytes = readFileSync(path);
    const actual = sha256(bytes);
    if (actual !== spec.sha256) {
      throw new RuntimeError("RUNTIME_HASH_MISMATCH", `Runtime file ${spec.out} has sha256 ${actual}, expected pinned ${spec.sha256}`);
    }
    out[key] = { path, bytes: new Uint8Array(bytes), sha256: actual };
  }
  return out;
}

// ---------- opt-in candidate runtime ----------
//
// A candidate is a locally rebuilt editcore JS/WASM pair described by a
// manifest. It is used only when the caller passes candidateManifest or sets
// FALSIFY_EDITOR_CANDIDATE_MANIFEST; a manifest is never picked up because it
// exists. The manifest digests are the caller's expectations, not an
// independent release signature: they bind the loaded bytes to what the
// caller built, but do not prove those bytes were built from the listed
// sources, patches or toolchain. See docs/CANDIDATE_RUNTIME.md.
export const CANDIDATE_ENV = "FALSIFY_EDITOR_CANDIDATE_MANIFEST";
export const CANDIDATE_SCHEMA = "falsify-editor-candidate-runtime/1";
export const CANDIDATE_MANIFEST_NAME = "candidate-manifest.json";
export const CANDIDATE_PINS = Object.freeze({
  pdfiumCommit: "fce2b000cc7a9e2cabc92db41cd57ca03233f07d",
  emsdk: "3.1.70",
  js: "editcore.js",
  wasm: "editcore.wasm",
});
const CANDIDATE_MANIFEST_MAX_BYTES = 256 * 1024;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

// Validates manifest shape, digest shape and pin consistency. Unknown fields
// are rejected, so a manifest cannot assert extra verification (for example
// a "rebuiltFromCpp": true flag); provenance values may only be strings.
export function validateCandidateManifest(manifest, pins = PINS) {
  const invalid = (msg) => {
    throw new RuntimeError("CANDIDATE_INVALID", `Candidate manifest ${msg}`);
  };
  const mismatch = (msg) => {
    throw new RuntimeError("CANDIDATE_PIN_MISMATCH", `Candidate manifest ${msg}`);
  };
  const fields = (obj, where, required, optional = []) => {
    if (!isPlainObject(obj)) invalid(`${where} must be an object`);
    for (const k of Object.keys(obj)) if (!required.includes(k) && !optional.includes(k)) invalid(`${where} has unexpected field ${k}`);
    for (const k of required) if (!Object.hasOwn(obj, k)) invalid(`${where} is missing ${k}`);
  };
  const digest = (v, where) => {
    if (typeof v !== "string" || !HEX64.test(v)) invalid(`${where} must be a lowercase 64-hex sha256`);
  };
  fields(manifest, "root", ["schema", "upstream", "toolchain", "sourcePatches", "artifacts"], ["provenance"]);
  if (manifest.schema !== CANDIDATE_SCHEMA) invalid(`schema must be ${CANDIDATE_SCHEMA}`);

  const up = manifest.upstream;
  fields(up, "upstream", ["bentopdfCommit", "engineCommit", "pdfiumCommit"]);
  for (const k of ["bentopdfCommit", "engineCommit", "pdfiumCommit"]) {
    if (typeof up[k] !== "string" || !HEX40.test(up[k])) invalid(`upstream.${k} must be a lowercase 40-hex commit`);
  }
  if (up.bentopdfCommit !== pins.bentopdf.commit) mismatch(`upstream.bentopdfCommit ${up.bentopdfCommit} does not match pinned ${pins.bentopdf.commit}`);
  if (up.engineCommit !== pins.engine.commit) mismatch(`upstream.engineCommit ${up.engineCommit} does not match pinned ${pins.engine.commit}`);
  if (up.pdfiumCommit !== CANDIDATE_PINS.pdfiumCommit) mismatch(`upstream.pdfiumCommit ${up.pdfiumCommit} does not match pinned ${CANDIDATE_PINS.pdfiumCommit}`);

  fields(manifest.toolchain, "toolchain", ["emsdk"]);
  if (manifest.toolchain.emsdk !== CANDIDATE_PINS.emsdk) mismatch(`toolchain.emsdk must be ${CANDIDATE_PINS.emsdk}`);

  const patches = manifest.sourcePatches;
  if (!Array.isArray(patches) || patches.length === 0) invalid("sourcePatches must be a non-empty array");
  if (patches.length > 256) invalid("sourcePatches has too many entries");
  const names = new Set();
  patches.forEach((p, i) => {
    fields(p, `sourcePatches[${i}]`, ["name", "sha256"]);
    if (typeof p.name !== "string" || !p.name || p.name.length > 200 || /[\u0000-\u001f]/.test(p.name)) invalid(`sourcePatches[${i}].name must be a short non-empty string`);
    if (names.has(p.name)) invalid(`sourcePatches has duplicate name ${p.name}`);
    names.add(p.name);
    digest(p.sha256, `sourcePatches[${i}].sha256`);
  });

  fields(manifest.artifacts, "artifacts", ["js", "wasm"]);
  for (const key of ["js", "wasm"]) {
    const a = manifest.artifacts[key];
    fields(a, `artifacts.${key}`, ["path", "sha256"]);
    if (a.path !== CANDIDATE_PINS[key]) invalid(`artifacts.${key}.path must be exactly ${CANDIDATE_PINS[key]} (next to the manifest)`);
    digest(a.sha256, `artifacts.${key}.sha256`);
  }

  if (Object.hasOwn(manifest, "provenance")) {
    const prov = manifest.provenance;
    if (!isPlainObject(prov)) invalid("provenance must be an object");
    const entries = Object.entries(prov);
    if (entries.length > 32) invalid("provenance has too many fields");
    for (const [k, v] of entries) {
      if (typeof v !== "string" || v.length > 2000) invalid(`provenance.${k} must be a string of at most 2000 characters`);
    }
  }
  return manifest;
}

const regularFile = (path, code, what) => {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) throw new RuntimeError(code, `${what} is missing`);
  if (st.isSymbolicLink() || !st.isFile()) throw new RuntimeError("CANDIDATE_INVALID", `${what} must be a regular file, not a link or directory`);
  return st;
};

// Reads and validates the manifest, then reads and hashes both artifacts.
// Nothing is imported here; callers import only after this returns.
export function readCandidateRuntime(manifestPath, pins = PINS) {
  if (typeof manifestPath !== "string" || !isAbsolute(manifestPath)) {
    throw new RuntimeError("CANDIDATE_INVALID", "Candidate manifest path must be an absolute path");
  }
  const path = resolve(manifestPath);
  if (basename(path) !== CANDIDATE_MANIFEST_NAME) {
    throw new RuntimeError("CANDIDATE_INVALID", `Candidate manifest must be named ${CANDIDATE_MANIFEST_NAME}`);
  }
  const st = regularFile(path, "CANDIDATE_MISSING", "Candidate manifest");
  if (st.size > CANDIDATE_MANIFEST_MAX_BYTES) throw new RuntimeError("CANDIDATE_INVALID", "Candidate manifest is too large");
  const manifestBytes = readFileSync(path);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new RuntimeError("CANDIDATE_INVALID", "Candidate manifest is not valid JSON");
  }
  validateCandidateManifest(manifest, pins);
  const dir = dirname(path);
  const out = {};
  for (const key of ["js", "wasm"]) {
    const spec = manifest.artifacts[key];
    const file = join(dir, spec.path);
    regularFile(file, "CANDIDATE_MISSING", `Candidate ${spec.path}`);
    const bytes = readFileSync(file);
    const actual = sha256(bytes);
    if (actual !== spec.sha256) {
      throw new RuntimeError("CANDIDATE_HASH_MISMATCH", `Candidate ${spec.path} has sha256 ${actual}, manifest expects ${spec.sha256}`);
    }
    out[key] = { path: file, bytes: new Uint8Array(bytes), sha256: actual };
  }
  out.candidate = {
    manifestPath: path,
    manifestSha256: sha256(manifestBytes),
    schema: manifest.schema,
    upstream: { ...manifest.upstream },
    toolchain: { ...manifest.toolchain },
    sourcePatches: manifest.sourcePatches.map((p) => ({ name: p.name, sha256: p.sha256 })),
    provenance: { ...(manifest.provenance ?? {}) },
    // What was checked: artifact bytes equal the manifest's caller-supplied
    // digests, and the manifest's pins equal this module's pins. What was
    // not: that the artifacts were built from those sources and patches.
    trust: "caller-expected-digests",
    sourceBuildVerified: false,
  };
  return out;
}

// undefined -> FALSIFY_EDITOR_CANDIDATE_MANIFEST (unset or empty: baseline);
// null -> baseline regardless of the environment.
export function resolveCandidateManifest(candidateManifest) {
  const value = candidateManifest !== undefined ? candidateManifest : process.env[CANDIDATE_ENV];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new RuntimeError("CANDIDATE_INVALID", "Candidate manifest path must be an absolute path");
  }
  return resolve(value);
}

const loaded = new Map();

// registerHooks hooks are process-global: while importEngine awaits import(),
// its resolver also sees module loads started by any other concurrent
// importEngine, so two overlapping windows cross-wire their app graphs (one
// graph's editcore children resolved under the other's tag). Only the
// register/import/deregister window is serialized; engineFactory calls and
// PDF work stay parallel. A rejected import releases the queue.
let importQueue = Promise.resolve();
function serializeImport(fn) {
  const run = importQueue.then(fn);
  importQueue = run.then(
    () => {},
    () => {},
  );
  return run;
}

// tag is empty for the pinned baseline. For a candidate it is derived from
// the manifest path and content, appended as a query to the engine JS and
// the editcore module graph so a changed or relocated candidate never reuses
// an already-imported module. The candidate JS source is served from the
// already-hashed bytes, so the file is not re-read after verification.
async function importEngine(sourceRoot, runtime, tag = "") {
  const coreDir = join(sourceRoot, PINS.bentopdf.path, "src", "js", "editcore");
  const corePath = join(coreDir, "core.js");
  if (!existsSync(corePath)) {
    throw new RuntimeError("SOURCE_MISSING", "Pinned BentoPDF editcore source is missing; run git submodule update --init or set FALSIFY_EDITOR_SOURCE_ROOT");
  }
  const scope = pathToFileURL(coreDir).href + "/";
  const tagged = (url) => (tag && url.startsWith("file:") && !url.includes("?") ? `${url}?fpe-candidate=${tag}` : url);
  const tagResult = (r) => (tag && r && typeof r.url === "string" ? { ...r, url: tagged(r.url) } : r);
  const jsUrl = tagged(pathToFileURL(runtime.js.path).href);
  const wasmUrl = pathToFileURL(runtime.wasm.path).href;
  const inScope = (context) => typeof context.parentURL === "string" && context.parentURL.startsWith(scope);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (tag && specifier === jsUrl) return { url: jsUrl, format: "module", shortCircuit: true };
      if (inScope(context)) {
        if (specifier === "../utils/freetext-script") return tagResult(nextResolve("../utils/freetext-script.ts", context));
        if (specifier === "bentopdf-pdfium") return { url: jsUrl, format: "module", shortCircuit: true };
        if (specifier === "bentopdf-pdfium/editcore.wasm") return { url: wasmUrl, shortCircuit: true };
        if (tag) return tagResult(nextResolve(specifier, context));
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (tag && url === jsUrl) return { format: "module", source: Buffer.from(runtime.js.bytes).toString("utf8"), shortCircuit: true };
      return nextLoad(url, context);
    },
  });
  try {
    const { default: createModule } = await import(jsUrl);
    const core = await import(tagged(pathToFileURL(corePath).href));
    return { createModule, PdfEngine: core.PdfEngine, build: core.EC_BUILD };
  } finally {
    hooks.deregister();
  }
}

// Returns { engineFactory, info }. engineFactory(bytes?) creates a fresh,
// library-initialized upstream PdfEngine; when bytes are given it is opened.
// candidateManifest (absolute path) or FALSIFY_EDITOR_CANDIDATE_MANIFEST opts
// in to a verified locally rebuilt runtime instead of the pinned baseline.
export async function loadRuntime({ sourceRoot, runtimeDir, candidateManifest, print } = {}) {
  const root = resolveSourceRoot(sourceRoot);
  const manifestPath = resolveCandidateManifest(candidateManifest);
  if (manifestPath !== null && runtimeDir !== undefined) {
    throw new RuntimeError("CANDIDATE_CONFLICT", "runtimeDir and a candidate manifest cannot be combined");
  }
  let runtime;
  let key;
  let tag = "";
  if (manifestPath === null) {
    const dir = resolveRuntimeDir(runtimeDir);
    runtime = readVerifiedRuntime(dir);
    key = root + "|" + dir;
  } else {
    runtime = readCandidateRuntime(manifestPath);
    tag = sha256(runtime.candidate.manifestPath + "\n" + runtime.candidate.manifestSha256);
    key = root + "|candidate|" + tag;
  }
  // Rechecked on every call, cache hit or not: the pinned app sources the
  // engine graph was imported from may have changed since.
  verifyAppSource(root);
  if (!loaded.has(key)) {
    loaded.set(key, serializeImport(() => importEngine(root, runtime, tag)));
  }
  let mod;
  try {
    mod = await loaded.get(key);
  } catch (err) {
    loaded.delete(key);
    throw err;
  }
  const sink = typeof print === "function" ? print : () => {};
  const engineFactory = async (bytes) => {
    // Same library configuration as PdfEngine.create(); the verified WASM
    // bytes are passed directly so no path is re-read after hashing.
    const M = await mod.createModule({ wasmBinary: runtime.wasm.bytes, print: sink, printErr: sink });
    const cfg = M._malloc(48);
    M.HEAPU8.fill(0, cfg, cfg + 48);
    M.HEAPU32[cfg >> 2] = 2;
    M._FPDF_InitLibraryWithConfig(cfg);
    M._free(cfg);
    const engine = new mod.PdfEngine(M);
    if (bytes) engine.open(new Uint8Array(bytes));
    return engine;
  };
  const info = { build: mod.build, wasmSha256: runtime.wasm.sha256, jsSha256: runtime.js.sha256, bentopdfCommit: PINS.bentopdf.commit, engineCommit: PINS.engine.commit };
  if (runtime.candidate) info.candidate = { ...runtime.candidate, moduleTag: tag, moduleUrl: `${pathToFileURL(runtime.js.path).href}?fpe-candidate=${tag}` };
  return { engineFactory, info };
}
