// Runtime loader for the pinned BentoPDF editcore engine.
//
// The engine JS/WASM are prepared by scripts/prepare-runtime.mjs from pinned
// git blobs into the ignored .runtime/ directory. The upstream PdfEngine
// (src/js/editcore/core.js) is imported unmodified from the pinned BentoPDF
// submodule; a scoped, temporary Node resolver hook supplies the two
// specifiers that only Vite resolves in the browser build.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
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

const loaded = new Map();

async function importEngine(sourceRoot, runtime) {
  const coreDir = join(sourceRoot, PINS.bentopdf.path, "src", "js", "editcore");
  const corePath = join(coreDir, "core.js");
  if (!existsSync(corePath)) {
    throw new RuntimeError("SOURCE_MISSING", "Pinned BentoPDF editcore source is missing; run git submodule update --init or set FALSIFY_EDITOR_SOURCE_ROOT");
  }
  const scope = pathToFileURL(coreDir).href + "/";
  const jsUrl = pathToFileURL(runtime.js.path).href;
  const wasmUrl = pathToFileURL(runtime.wasm.path).href;
  const inScope = (context) => typeof context.parentURL === "string" && context.parentURL.startsWith(scope);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (inScope(context)) {
        if (specifier === "../utils/freetext-script") return nextResolve("../utils/freetext-script.ts", context);
        if (specifier === "bentopdf-pdfium") return { url: jsUrl, format: "module", shortCircuit: true };
        if (specifier === "bentopdf-pdfium/editcore.wasm") return { url: wasmUrl, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    const { default: createModule } = await import(jsUrl);
    const core = await import(pathToFileURL(corePath).href);
    return { createModule, PdfEngine: core.PdfEngine, build: core.EC_BUILD };
  } finally {
    hooks.deregister();
  }
}

// Returns { engineFactory, info }. engineFactory(bytes?) creates a fresh,
// library-initialized upstream PdfEngine; when bytes are given it is opened.
export async function loadRuntime({ sourceRoot, runtimeDir, print } = {}) {
  const root = resolveSourceRoot(sourceRoot);
  const dir = resolveRuntimeDir(runtimeDir);
  const runtime = readVerifiedRuntime(dir);
  const key = root + "|" + dir;
  if (!loaded.has(key)) {
    // Recheck the app pin right before importing: sources may have changed
    // since prepare-runtime ran.
    verifyAppSource(root);
    loaded.set(key, importEngine(root, runtime));
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
  return {
    engineFactory,
    info: { build: mod.build, wasmSha256: runtime.wasm.sha256, jsSha256: runtime.js.sha256, bentopdfCommit: PINS.bentopdf.commit, engineCommit: PINS.engine.commit },
  };
}
