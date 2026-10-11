// Extracts the pinned editcore JS/WASM from git blobs of the upstream engine
// submodule (never the working-tree text, which may be CRLF-converted),
// verifies SHA-256 pins, verifies the BentoPDF app pin and its tracked core
// sources are unmodified, then writes <moduleRoot>/.runtime. Nothing is
// downloaded.
//
// Output safety: the only writable target is the dedicated .runtime
// directory directly inside a validated module root. Staging uses mkdtemp;
// an existing .runtime is only replaced when it holds nothing but known
// generated files, is moved aside first and restored on failure, and is
// cleaned file-by-file (no recursive removal).
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODULE_ROOT, PINS, RuntimeError, checkPinnedCheckout, git, resolveSourceRoot, sha256, verifyAppSource } from "../src/runtime.mjs";

const PACKAGE_NAME = "falsify-pdf-editor";
const RUNTIME_NAME = ".runtime";
const GENERATED = Object.freeze(["editcore.js", "editcore.wasm", "package.json", "manifest.json"]);

const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

// Accepts only a real (non-symlinked) directory that is not a filesystem
// root or the home directory and carries this package's package.json.
export function validateModuleRoot(moduleRoot) {
  const abs = resolve(moduleRoot);
  const bad = (msg) => {
    throw new RuntimeError("UNSAFE_OUTPUT", msg);
  };
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    bad("Module root does not exist");
  }
  if (st.isSymbolicLink() || !st.isDirectory()) bad("Module root must be a real directory");
  if (!same(realpathSync.native(abs), abs)) bad("Module root must not be reached through a link");
  if (same(parse(abs).root, abs) || same(abs, resolve(homedir()))) bad("Module root must not be a filesystem root or home directory");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(abs, "package.json"), "utf8"));
  } catch {
    bad("Module root has no readable package.json");
  }
  if (pkg?.name !== PACKAGE_NAME) bad(`Module root package.json is not ${PACKAGE_NAME}`);
  return abs;
}

// Existing .runtime must be a real directory holding only generated files.
function inspectExisting(target) {
  let st;
  try {
    st = lstatSync(target);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new RuntimeError("UNSAFE_OUTPUT", `${RUNTIME_NAME} exists and is not a plain directory; refusing to replace it`);
  const entries = readdirSync(target, { withFileTypes: true });
  for (const e of entries) {
    if (!GENERATED.includes(e.name) || !e.isFile()) {
      throw new RuntimeError("UNSAFE_OUTPUT", `${RUNTIME_NAME} contains unexpected entry ${e.name}; refusing to replace it`);
    }
  }
  return entries.map((e) => e.name);
}

// Removes a directory created by this script, file by file, never recursing.
function removeGeneratedDir(dir) {
  for (const name of readdirSync(dir)) {
    if (!GENERATED.includes(name)) throw new RuntimeError("UNSAFE_OUTPUT", `Refusing to remove unexpected file ${name}`);
    unlinkSync(join(dir, name));
  }
  rmdirSync(dir);
}

export function prepareRuntime({ moduleRoot = MODULE_ROOT, sourceRoot, pins = PINS } = {}) {
  const root = validateModuleRoot(moduleRoot);
  const target = join(root, RUNTIME_NAME);
  inspectExisting(target);
  const src = resolveSourceRoot(sourceRoot);

  verifyAppSource(src, pins);
  checkPinnedCheckout(src, pins.engine);
  const engine = join(src, pins.engine.path);
  const blobs = {};
  for (const key of ["js", "wasm"]) {
    const spec = pins.engine[key];
    const r = git(engine, ["cat-file", "blob", `${pins.engine.commit}:${spec.blob}`], "buffer");
    if (r.status !== 0) throw new RuntimeError("SOURCE_MISSING", `Pinned blob ${spec.blob} is unavailable in ${pins.engine.path}`);
    const actual = sha256(r.stdout);
    if (actual !== spec.sha256) throw new RuntimeError("RUNTIME_HASH_MISMATCH", `${spec.blob} sha256 ${actual} does not match pinned ${spec.sha256}`);
    blobs[key] = r.stdout;
  }
  inspectExisting(target);

  const manifest = {
    bentopdf: { commit: pins.bentopdf.commit, trackedSources: [...pins.bentopdf.trackedSources], trackedSourcesClean: true },
    engine: {
      commit: pins.engine.commit,
      js: { blob: pins.engine.js.blob, sha256: pins.engine.js.sha256 },
      wasm: { blob: pins.engine.wasm.blob, sha256: pins.engine.wasm.sha256 },
    },
    rebuiltFromCpp: false,
  };
  const staging = mkdtempSync(join(root, RUNTIME_NAME + "-staging-"));
  let backupDir = null;
  let backup = null;
  try {
    writeFileSync(join(staging, pins.engine.js.out), blobs.js, { flag: "wx" });
    writeFileSync(join(staging, pins.engine.wasm.out), blobs.wasm, { flag: "wx" });
    writeFileSync(join(staging, "package.json"), JSON.stringify({ type: "module", private: true }) + "\n", { flag: "wx" });
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    if (inspectExisting(target)) {
      backupDir = mkdtempSync(join(root, RUNTIME_NAME + "-backup-"));
      backup = join(backupDir, "previous");
      renameSync(target, backup);
    }
    try {
      renameSync(staging, target);
    } catch (err) {
      if (backup) renameSync(backup, target);
      throw err;
    }
  } catch (err) {
    try {
      if (lstatSync(staging, { throwIfNoEntry: false })) removeGeneratedDir(staging);
    } catch {}
    if (backupDir) {
      try {
        rmdirSync(backupDir); // non-recursive: only succeeds when empty
      } catch {}
    }
    throw err;
  }
  if (backup) {
    removeGeneratedDir(backup);
    rmdirSync(backupDir);
  }
  return { outDir: target, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { manifest } = prepareRuntime();
    console.log(JSON.stringify({ ok: true, engine: manifest.engine.commit, bentopdf: manifest.bentopdf.commit }));
  } catch (err) {
    console.error(`prepare-runtime: ${err.code ?? "ERROR"}: ${err.message}`);
    process.exit(1);
  }
}
