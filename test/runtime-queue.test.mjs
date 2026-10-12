// A caller-verified JS module can still throw during evaluation. The failed
// import must release the queue so another candidate/baseline can load.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { loadRuntime, PINS, resolveRuntimeDir, resolveSourceRoot } from '../src/runtime.mjs';
import { prepareCandidateRuntime } from '../scripts/prepare-candidate-runtime.mjs';
const dir=resolveRuntimeDir(), src=resolveSourceRoot();
const prepared=existsSync(join(dir,'editcore.wasm'))&&existsSync(join(src,PINS.bentopdf.path,'src/js/editcore/core.js'));
test('a queued module-evaluation rejection releases the importer for valid loads', {skip:!prepared&&'runtime not prepared'}, async t=>{
  const scratch=mkdtempSync(join(tmpdir(),'fpe-queue-rejection-'));
  t.after(()=>{
    assert.ok(resolve(scratch).startsWith(resolve(tmpdir())+sep));
    assert.ok(scratch.includes('fpe-queue-rejection-'));
    rmSync(scratch,{recursive:true,force:true});
  });
  const patch=join(scratch,'mock.patch');
  writeFileSync(patch,'mock caller provenance, not a source build\n');
  function stage(name,js){
    const input=join(scratch,name+'-inputs'), parent=join(scratch,name+'-parent');
    mkdirSync(input);mkdirSync(parent);
    writeFileSync(join(input,'pdfium.js'),js);
    writeFileSync(join(input,'pdfium.wasm'),readFileSync(join(dir,'editcore.wasm')));
    return prepareCandidateRuntime({parentDir:parent,jsPath:join(input,'pdfium.js'),wasmPath:join(input,'pdfium.wasm'),patchPaths:[patch],sourceRoot:src}).manifestPath;
  }
  const bad=stage('bad','throw new Error("QUEUE_IMPORT_SENTINEL");\nexport default function(){}\n');
  const good=stage('good',readFileSync(join(dir,'editcore.js')));
  const settled=await Promise.allSettled([
    loadRuntime({candidateManifest:bad,sourceRoot:src}),
    loadRuntime({candidateManifest:good,sourceRoot:src}),
    loadRuntime({candidateManifest:good,sourceRoot:src}),
    loadRuntime({candidateManifest:null,sourceRoot:src}),
  ]);
  assert.equal(settled[0].status,'rejected');
  assert.match(settled[0].reason.message,/QUEUE_IMPORT_SENTINEL/);
  for(const entry of settled.slice(1)){
    assert.equal(entry.status,'fulfilled',entry.reason?.stack);
    const engine=await entry.value.engineFactory();
    assert.equal(typeof engine.M._FPDF_InitLibraryWithConfig,'function');
    engine.close();
  }
  await assert.rejects(loadRuntime({candidateManifest:bad,sourceRoot:src}),/QUEUE_IMPORT_SENTINEL/);
  const later=await loadRuntime({candidateManifest:good,sourceRoot:src});
  assert.equal(later.info.wasmSha256,PINS.engine.wasm.sha256);
});
