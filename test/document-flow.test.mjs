import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRuntime } from '../src/runtime.mjs';
import { editPdf } from '../src/editor.mjs';
import { planDocumentLines } from '../src/document-flow.mjs';
import { inspectSavedPdf } from '../src/quality.mjs';

export function flowFixture({pages=3,foreign=false,mixed=true,denseAll=false,table=false,singleStream=false}={}) {
 const objects=['<< /Type /Catalog /Pages 2 0 R >>',''];
 const add=s=>(objects.push(s),objects.length);
 const fonts=['Helvetica','Times-Roman'].map(name=>add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} >>`));
 const kids=[];
 for(let p=0;p<pages;p++){
   const streams=[],raw=[];
   const texts=[`Source page ${p} begins the same long column with a small synthetic sentence.`, `Another paragraph on source page ${p} keeps its own font and original text.`];
   for(let k=0;k<2;k++){
    const dense=(p===0||denseAll)&&k===1?Array.from({length:denseAll?35:18},(_,i)=>`BT /F1 11 Tf 50 ${648-i*14} Td (The unchanged line ${i} preserves enough body text to fill the original source page.) Tj ET\n`).join(''):'';
    const s=`BT /F1 11 Tf 50 ${700-k*24} Td (${texts[k]}) Tj ET\n`+dense+(k===0?`BT /F1 8 Tf 50 760 Td (Synthetic running header) Tj ET\nBT /F1 8 Tf 290 30 Td (${p+1}) Tj ET\n`:'')+(foreign&&p===1&&k===1?'50 400 400 2 re f\n':'')+(table&&p===1&&k===1?'BT /F1 11 Tf 50 500 Td (Left cell) Tj ET\nBT /F1 11 Tf 350 500 Td (Right cell) Tj ET\n':'');
    raw.push(s);if(!singleStream)streams.push(add(`<< /Length ${s.length} >>\nstream\n${s}endstream`));
   }
   if(singleStream){const s=raw.join('');streams.push(add(`<< /Length ${s.length} >>\nstream\n${s}endstream`));}
   kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 ${fonts[mixed?p%2:0]} 0 R >> >> /Contents [${streams.map(i=>i+' 0 R').join(' ')}] >>`));
 }
 objects[1]=`<< /Type /Pages /Count ${pages} /Kids [${kids.map(i=>i+' 0 R').join(' ')}] >>`;
 let s='%PDF-1.4\n';const offsets=[];
 objects.forEach((o,i)=>{offsets.push(s.length);s+=`${i+1} 0 obj\n${o}\nendobj\n`;});
 const x=s.length;s+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
 return new Uint8Array(Buffer.from(s));
}
const band={bodyTop:700,flowTop:700,floor:100,x0:50,x1:500};
test('document planner uses existing destinations before terminal pages and preserves all line indices',()=>{
 const lines=Array.from({length:50},(_,i)=>({top:700-14*i,bottom:690-14*i,gap:14}));
 const pages=planDocumentLines(lines,[band,band],2);
 assert.equal(pages.length,2);assert.deepEqual(pages.flatMap(p=>p.lines.map(l=>l.index)),Array.from({length:50},(_,i)=>i));
});
let runtime;try{runtime=await loadRuntime();}catch{}
const real={skip:!runtime&&'candidate runtime unavailable'};
const before='Source page 0 begins';
const after=before+' A carefully preserved synthetic sentence travels into the next original source page.'.repeat(35);
test('native transfer negative regression: original stream index defeats insertion order',real,async()=>{
 const e=await runtime.engineFactory(flowFixture({pages:2}));
 try{
  const M=e.M;e.loadPage(0);const a=e.page;
  const moved=Array.from({length:M._FPDFPage_CountObjects(a)},(_,i)=>M._FPDFPage_GetObject(a,i)).find(h=>{const b=e.objectBounds(h);return b&&b.y>670&&b.y<680;});
  assert.ok(moved);e.pinnedPages=new Set([0,1]);e.loadPage(1);const b=e.page;
  assert.equal(M._FPDFPage_RemoveObject(a,moved),1);
  M._FPDFPageObj_Transform(moved,1,0,0,1,0,48);
  assert.equal(M._FPDFPage_InsertObjectAtIndex(b,moved,0),1);
  assert.ok(M._FPDFPage_GenerateContent(a));assert.ok(M._FPDFPage_GenerateContent(b));
  const saved=await runtime.engineFactory(e.save());
  try{
   saved.loadPage(1);const S=saved.M,tp=S._FPDFText_LoadPage(saved.page);let text='';
   for(let i=0;i<S._FPDFText_CountChars(tp);i++)text+=String.fromCharCode(S._FPDFText_GetUnicode(tp,i));
   S._FPDFText_ClosePage(tp);
   assert.ok(text.indexOf('Source page 1 begins')<text.indexOf('Another paragraph on source page 0'));
  }finally{saved.close();}
 }finally{e.close();}
});
test('real mixed fonts/streams compact overflow into existing next original page',real,async()=>{
 const result=await editPdf({sourceBytes:flowFixture(),edits:[{id:'grow',pageIndex:0,before,after}],reflow:true},{documentFlow:true,engineFactory:runtime.engineFactory,includeFlowText:true});
 assert.equal(result.report.ok,true,JSON.stringify(result.report.selfCheck));
 assert.ok(result.report.pagination.flowGroups.length);
 assert.equal(result.report.pagination.addedPages,0);
 assert.deepEqual(result.report.pagination.sourcePageMap.map(m=>m.outputPageIndex),[0,1,2]);
 assert.ok(result.report.pagination.sourcePageMap[0].contentOutputPageIndices.includes(1));
});
test('real body figure on next page refuses with no returned document',real,async()=>{
 await assert.rejects(editPdf({sourceBytes:flowFixture({foreign:true}),edits:[{id:'grow',pageIndex:0,before,after}],reflow:true},{documentFlow:true,engineFactory:runtime.engineFactory}),e=>e.code==='LAYOUT_UNSUPPORTED');
});
test('compatible-groups retains a barrier staging group with an explicit warning',real,async()=>{
 const result=await editPdf({sourceBytes:flowFixture({foreign:true,singleStream:true}),edits:[{id:'grow',pageIndex:0,before,after}],reflow:true},{documentFlow:'compatible-groups',engineFactory:runtime.engineFactory,draft:true});
 assert.equal(result.report.ok,true,JSON.stringify({fail:result.report.selfCheck.failures,map:result.report.pagination.sourcePageMap}));
 assert.equal(result.report.pagination.flowGroups.length,0);
 assert.ok(result.report.pagination.addedPages>0);
 assert.ok(result.report.warnings.some(w=>w.code==='document_flow_barrier_not_compacted'&&w.pageIndex===0&&w.reason==='document_flow_foreign_object_unsupported'));
});
test('borderless table cells refuse rather than entering a text chain',real,async()=>{
 await assert.rejects(editPdf({sourceBytes:flowFixture({table:true}),edits:[{id:'grow',pageIndex:0,before,after}],reflow:true},{documentFlow:true,engineFactory:runtime.engineFactory}),e=>e.code==='LAYOUT_UNSUPPORTED');
});
test('multiple source edits retain original bindings before compaction',real,async()=>{
 const edits=[{id:'grow',pageIndex:0,before,after},{id:'second',pageIndex:1,before:'Source page 1 begins',after:'Source page 1 starts with an independently edited phrase'}];
 const result=await editPdf({sourceBytes:flowFixture(),edits,reflow:true},{documentFlow:true,engineFactory:runtime.engineFactory});
 assert.equal(result.report.ok,true);assert.deepEqual(result.report.edits.map(e=>e.status),['applied','applied']);
 assert.ok(result.report.pagination.flowGroups.length);
});
test('terminal excess alone adds a page after all existing original destinations',real,async()=>{
 const result=await editPdf({sourceBytes:flowFixture({pages:2,denseAll:true}),edits:[{id:'grow',pageIndex:0,before,after}],reflow:true},{documentFlow:true,engineFactory:runtime.engineFactory});
 assert.equal(result.report.ok,true);assert.ok(result.report.pagination.addedPages>0);
 assert.deepEqual(result.report.pagination.sourcePageMap.map(m=>m.outputPageIndex),[0,1]);
 assert.equal(result.report.pagination.sourcePageMap[0].continuationPageIndices.length,0);
 assert.ok(result.report.pagination.sourcePageMap[1].continuationPageIndices.length>0);
});
test('saved group QA rejects forged membership and moved fixed edges',real,async()=>{
 const sourceBytes=flowFixture(),edits=[{id:'grow',pageIndex:0,before,after}];
 const result=await editPdf({sourceBytes,edits,reflow:true},{documentFlow:true,engineFactory:runtime.engineFactory});
 const {sourcePageMap,flowGroups}=result.report.pagination;
 const forged=structuredClone(flowGroups);forged[0].sourcePages[1].sourcePageIndex=2;
 let check=await inspectSavedPdf(runtime.engineFactory,sourceBytes,result.pdf,edits,{sourcePageMap,flowGroups:forged});
 assert.equal(check.ok,false);assert.ok(check.failures.some(f=>f.code==='document_flow_map_invalid'));
 const duplicate=structuredClone(flowGroups);duplicate.push(structuredClone(flowGroups[0]));
 check=await inspectSavedPdf(runtime.engineFactory,sourceBytes,result.pdf,edits,{sourcePageMap,flowGroups:duplicate});
 assert.equal(check.ok,false);assert.ok(check.failures.some(f=>f.code==='document_flow_map_invalid'));
 const e=await runtime.engineFactory(result.pdf);
 try{
  e.loadPage(1);const M=e.M;
  for(let i=0;i<M._FPDFPage_CountObjects(e.page);i++){
    const h=M._FPDFPage_GetObject(e.page,i),b=e.objectBounds(h);
    if(b&&b.y>740){e.translateObject(h,0,-5);break;}
  }
  e._pageDirty=true;const changed=e.save();
  check=await inspectSavedPdf(runtime.engineFactory,sourceBytes,changed,edits,{sourcePageMap,flowGroups});
  assert.equal(check.ok,false);assert.ok(check.failures.some(f=>f.code==='document_flow_fixed_content_changed'));
 }finally{e.close();}
 const recolored=await runtime.engineFactory(result.pdf);
 try{
  recolored.loadPage(1);const M=recolored.M;
  for(let i=0;i<M._FPDFPage_CountObjects(recolored.page);i++){
   const h=M._FPDFPage_GetObject(recolored.page,i),b=recolored.objectBounds(h);
   if(b&&b.y>100&&b.y<700){assert.ok(M._FPDFPageObj_SetFillColor(h,255,0,0,255));break;}
  }
  recolored._pageDirty=true;
  check=await inspectSavedPdf(runtime.engineFactory,sourceBytes,recolored.save(),edits,{sourcePageMap,flowGroups});
  assert.equal(check.ok,false);assert.ok(check.failures.some(f=>/style_mismatch/.test(f.code)));
 }finally{recolored.close();}
});
test('native apply failure discards the transaction and preserves source bytes',real,async()=>{
 const sourceBytes=flowFixture(),copy=Buffer.from(sourceBytes);let calls=0;
 const engineFactory=async bytes=>{
  const e=await runtime.engineFactory(bytes);calls++;
  // First factory edits, second reads immutable source, third compacts.
  if(calls===3)e.M._FPDFPage_InsertObjectAtIndex=()=>0;
  return e;
 };
 await assert.rejects(editPdf({sourceBytes,edits:[{id:'grow',pageIndex:0,before,after}],reflow:true},{documentFlow:true,engineFactory}),e=>e.code==='LAYOUT_UNSUPPORTED'&&e.details.cause==='document_flow_insert_failed');
 assert.deepEqual(Buffer.from(sourceBytes),copy);
});
test('immutable source bands reject output-only, source-only and jointly forged floors',real,async()=>{
 // Preserve exact PDF offsets while removing only footer number operators.
 // The legitimate source floor is 80 on these 800pt no-footer pages.
 const raw=Buffer.from(flowFixture()).toString('latin1').replace(/BT \/F1 8 Tf 290 30 Td \(\d+\) Tj ET/g,s=>' '.repeat(s.length));
 const sourceBytes=new Uint8Array(Buffer.from(raw,'latin1')),edits=[{id:'grow',pageIndex:0,before,after}];
 const result=await editPdf({sourceBytes,edits,reflow:true},{documentFlow:true,engineFactory:runtime.engineFactory});
 const {sourcePageMap,flowGroups}=result.report.pagination;
 assert.equal(result.report.ok,true);assert.ok(flowGroups[0].sourcePages.every(b=>b.floor===80));
 const e=await runtime.engineFactory(result.pdf);let output;
 try{
  e.loadPage(0);const M=e.M;let chosen;
  for(let i=0;i<M._FPDFPage_CountObjects(e.page);i++){
   const h=M._FPDFPage_GetObject(e.page,i),b=e.objectBounds(h);
   if(b&&b.y>75&&b.y<700&&(!chosen||b.y<chosen.b.y))chosen={h,b};
  }
  assert.ok(chosen);e.translateObject(chosen.h,0,40-chosen.b.y);e._pageDirty=true;output=e.save();
 }finally{e.close();}
 const baseline=await inspectSavedPdf(runtime.engineFactory,sourceBytes,output,edits,{sourcePageMap,flowGroups});
 assert.equal(baseline.ok,false);
 for(const target of ['output','source','both']){
  const groups=structuredClone(flowGroups),map=structuredClone(sourcePageMap);
  for(const group of groups){
   if(target!=='output')for(const b of group.sourcePages)b.floor=30;
   if(target!=='source')for(const b of group.outputPages)b.floor=30;
  }
  if(target==='both')for(const row of map)if(row.floor!==undefined)row.floor=30;
  const check=await inspectSavedPdf(runtime.engineFactory,sourceBytes,output,edits,{sourcePageMap:map,flowGroups:groups});
  assert.equal(check.ok,false,target);assert.ok(check.failures.some(f=>f.code==='document_flow_map_invalid'),target);
 }
 const forged=structuredClone(flowGroups);forged[0].sourcePages[1].sourcePageIndex=2;
 const membership=await inspectSavedPdf(runtime.engineFactory,sourceBytes,output,edits,{sourcePageMap,flowGroups:forged});
 assert.equal(membership.ok,false);assert.ok(membership.failures.some(f=>f.code==='document_flow_map_invalid'));
});
