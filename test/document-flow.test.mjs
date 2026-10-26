import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRuntime } from '../src/runtime.mjs';
import { editPdf } from '../src/editor.mjs';
import { planDocumentLines } from '../src/document-flow.mjs';
import { inspectSavedPdf, capturePageLayout, expectedPageText } from '../src/quality.mjs';
import { deriveDocumentFlowBand, adjacentSourceRuns } from '../src/document-flow-band.mjs';
import { deriveNativeLinkMoves, deriveNativeFitRMoves, readLinkPageCharacters } from '../src/document-flow-links.mjs';
import { sourceUnderline } from '../src/document-flow-underlines.mjs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
test('source paragraph splits require baseline, paint order and bounded same-line gaps',()=>{
 const boxes={1:{x:204.987,y:205.001,w:5.608,h:5.68},2:{x:221.637,y:204.889,w:27.928,h:5.856},3:{x:221.581,y:195.366,w:31.968,h:5.856}};
 const engine={objectBounds:h=>boxes[h]};
 const a={baselines:[205.001],size:8,handles:[1],slots:[152]};
 const b={baselines:[205.001,195.478],size:8,handles:[2,3],slots:[153,154]};
 assert.equal(adjacentSourceRuns(engine,a,b),true);
 assert.equal(adjacentSourceRuns(engine,a,{...b,baselines:[204.9,195.478]}),false);
 assert.equal(adjacentSourceRuns(engine,a,{...b,slots:[151,154]}),false);
 boxes[2]={...boxes[2],x:240};
 assert.equal(adjacentSourceRuns(engine,a,b),false);
});
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

test('native link association uses partial intersections and stable source ranges across earlier edits',real,async()=>{
 const source=await runtime.engineFactory(flowFixture());
 try {
  const bands=[0,1].map(i=>deriveDocumentFlowBand(source,i,capturePageLayout));
  const body=band=>readLinkPageCharacters(source,band.sourcePageIndex).filter(c=>c.u>32&&c.box&&(c.box.b+c.box.t)/2>=band.floor-.5&&(c.box.b+c.box.t)/2<=band.bodyTop+.5);
  const pages=bands.map(body),raw=pages[1].map(c=>String.fromCharCode(c.u)).join(''),at=raw.indexOf('Another');
  const label=pages[1].slice(at,at+7),rect=[label[0].box.l+.1,Math.min(...label.map(c=>c.box.b)),label.at(-1).box.r-.1,Math.max(...label.map(c=>c.box.t))];
  assert.ok(label[0].box.l<rect[0]&&label.at(-1).box.r>rect[2]);
  const model={annotations:[{sourcePageIndex:1,annotationIndex:0,rect,kind:'link',eligible:true,destination:{type:'uri'},internalDestinationSourcePageIndices:[]}]};
  const target=pages.flatMap((cs,page)=>cs.map(c=>({...c,outputPageIndex:page?2:0,box:{l:c.box.l+3,r:c.box.r+3,b:c.box.b-28,t:c.box.t-28}})));
  let moves=deriveNativeLinkMoves(source,bands,target,[],model,expectedPageText);
  assert.equal(moves.length,1);assert.equal(moves[0].outputPageIndex,2);assert.ok(Math.abs(moves[0].dx-3)<.001&&Math.abs(moves[0].dy+28)<.001);
  // A preceding selected Before->After changes character counts, but never
  // rebinds the later identical label by a text search.
  const needle='Sourcepage0begins',replacement='Seed';
  const prefix=needle.length;
  const edited=[...[...replacement].map(ch=>({...target[0],u:ch.charCodeAt(0)})),...target.slice(prefix)];
  moves=deriveNativeLinkMoves(source,bands,edited,[{id:'earlier',pageIndex:0,before:'Source page 0 begins',after:replacement}],model,expectedPageText);
  assert.equal(moves.length,1);assert.equal(moves[0].outputPageIndex,2);
  const repeatedAt=pages[0].map(c=>String.fromCharCode(c.u)).join('').indexOf('Another'),repeated=pages[0].slice(repeatedAt,repeatedAt+7);
  const repeatedDescriptor={...model.annotations[0],sourcePageIndex:0,rect:[repeated[0].box.l,Math.min(...repeated.map(c=>c.box.b)),repeated.at(-1).box.r,Math.max(...repeated.map(c=>c.box.t))]};
  const repeatedMoves=deriveNativeLinkMoves(source,bands,target,[],{annotations:[repeatedDescriptor,...model.annotations]},expectedPageText);
  assert.deepEqual(repeatedMoves.map(m=>[m.sourcePageIndex,m.outputPageIndex]),[[0,0],[1,2]]);
  const edgeChars=readLinkPageCharacters(source,1).filter(c=>c.box&&c.box.b>740).slice(0,5);
  const edge={...model.annotations[0],annotationIndex:1,rect:[edgeChars[0].box.l,Math.min(...edgeChars.map(c=>c.box.b)),edgeChars.at(-1).box.r,Math.max(...edgeChars.map(c=>c.box.t))]};
  const withFixedEdge=deriveNativeLinkMoves(source,bands,target,[],{annotations:[...model.annotations,edge]},expectedPageText);
  assert.equal(withFixedEdge.length,1);assert.equal(withFixedEdge[0].annotationIndex,0);
  const duplicated={annotations:[...model.annotations,{...model.annotations[0],annotationIndex:1}]};
  assert.throws(()=>deriveNativeLinkMoves(source,bands,target,[],duplicated,expectedPageText),e=>e.code==='document_flow_link_overlapping_ownership');
  const internal={annotations:[{...model.annotations[0],destination:{type:'internal',targetSourcePageIndex:0},internalDestinationSourcePageIndices:[0]}]};
  assert.throws(()=>deriveNativeLinkMoves(source,bands,target,[],internal,expectedPageText),e=>e.code==='document_flow_link_target_in_changed_body');
  const split=structuredClone(target);split[pages[0].length+at+1].outputPageIndex=3;
  assert.throws(()=>deriveNativeLinkMoves(source,bands,split,[],model,expectedPageText),e=>e.code==='document_flow_link_split_page');
  const nonRigid=structuredClone(target);nonRigid[pages[0].length+at+1].box.l+=1;
  assert.throws(()=>deriveNativeLinkMoves(source,bands,nonRigid,[],model,expectedPageText),e=>e.code==='document_flow_link_not_rigid_translation');
  const editedLabel=[...target.slice(0,pages[0].length+at),...target.slice(pages[0].length+at+7)];
  assert.throws(()=>deriveNativeLinkMoves(source,bands,editedLabel,[{id:'label',pageIndex:1,before:'Another',after:''}],model,expectedPageText),e=>e.code==='document_flow_link_edited_label');
 } finally {source.close();}
});

test('FitR glyph association only accepts a wholly owned rigid source object',real,async()=>{
 const source=await runtime.engineFactory(flowFixture());
 try {
  const bands=[0,1].map(i=>deriveDocumentFlowBand(source,i,capturePageLayout));
  const pages=bands.map(b=>readLinkPageCharacters(source,b.sourcePageIndex).filter(c=>c.u>32&&c.box&&(c.box.b+c.box.t)/2>=b.floor-.5&&(c.box.b+c.box.t)/2<=b.bodyTop+.5));
  const obj=pages[1][0].object,chars=pages[1].filter(c=>c.object===obj);
  const rect=[Math.min(...chars.map(c=>c.box.l)),Math.min(...chars.map(c=>c.box.b)),Math.max(...chars.map(c=>c.box.r)),Math.max(...chars.map(c=>c.box.t))];
  const d={id:1,kind:'FitR',targetSourcePageIndex:1,operands:rect};
  const model={annotations:[{internalDestinations:[d]},{internalDestinations:[d]}]};
  const target=pages.flatMap((cs,page)=>cs.map(c=>({...c,outputPageIndex:page?2:0,box:{l:c.box.l+3,r:c.box.r+3,b:c.box.b-28,t:c.box.t-28}})));
  const moves=deriveNativeFitRMoves(source,bands,target,[],model,expectedPageText);
  assert.equal(moves.length,1);assert.equal(moves[0].outputPageIndex,2);assert.ok(Math.abs(moves[0].dy+28)<.001);
  const partial={annotations:[{internalDestinations:[{...d,operands:[rect[0]+1,...rect.slice(1)]}]}]};
  assert.throws(()=>deriveNativeFitRMoves(source,bands,target,[],partial,expectedPageText),e=>e.code==='document_flow_destination_ownership_ambiguous');
  const outside={annotations:[{internalDestinations:[{...d,operands:[rect[0]-10,rect[1],rect[2],rect[3]]}]}]};
  assert.throws(()=>deriveNativeFitRMoves(source,bands,target,[],outside,expectedPageText),e=>e.code==='document_flow_destination_ownership_ambiguous');
  const split=structuredClone(target);split[pages[0].length+1].outputPageIndex=3;
  assert.throws(()=>deriveNativeFitRMoves(source,bands,split,[],model,expectedPageText),e=>e.code==='document_flow_destination_not_rigid');
 }finally{source.close();}
});

// Optional app-owned raw dictionary adapter; explicit path injects the
// already-vendored runtime without adding a second engine dependency here.
let annotationRuntime;
if(process.env.FALSIFY_ANNOTATION_ADAPTER_ROOT){
 const root=process.env.FALSIFY_ANNOTATION_ADAPTER_ROOT;
 const mupdf=await import(pathToFileURL(resolve(root,'app/dist/browser-pdf-vendor/mupdf.js')).href);
 const {createAnnotationTransport}=await import(pathToFileURL(resolve(root,'app/src/document-flow-annotations.mjs')).href);
 annotationRuntime={mupdf,adapter:createAnnotationTransport({mupdf})};
}
const annotationsReal={skip:(!runtime||!annotationRuntime)&&'native runtime and explicit raw annotation adapter required'};
async function annotatedFixture({underlines=false,variant='normal',denseAll=false,targetPage=3}={}){
 const bytes=flowFixture({pages:4,denseAll}),e=await runtime.engineFactory(bytes),descriptors=[];
 try{
  for(const [pageIndex,needle,last,edge]of [[0,'Theunchangedline17',true,false],[1,'Another',false,false],[1,'Synthetic',false,true]]){
   const chars=readLinkPageCharacters(e,pageIndex).filter(c=>c.box&&(edge?c.box.b>740:c.box.b>80&&c.box.t<720)),raw=chars.map(c=>String.fromCharCode(c.u)).join(''),at=last?raw.lastIndexOf(needle):raw.indexOf(needle),label=chars.slice(at,at+(edge?9:variant==='longlabel'&&!last?needle.length:3));
   assert.ok(at>=0);descriptors.push({pageIndex,rect:[label[0].box.l+.1,Math.min(...label.map(c=>c.box.b)),label.at(-1).box.r-.1+(variant==='oversized'&&last?100:0),Math.max(...label.map(c=>c.box.t))],edge});
  }
 }finally{e.close();}
 const {mupdf}=annotationRuntime,d=new mupdf.PDFDocument(bytes);
 try{
  const pages=Array.from({length:4},(_,i)=>d.findPage(i));
  if(underlines){
   // Match a normal citation's independently painted label object, as on
   // real papers, so the existing staging pagination can bind its underline.
   const contents=pages[0].get('Contents'),old=contents.get(1),buffer=old.readStream();let text;
   try{text=new TextDecoder().decode(buffer.asUint8Array());}finally{buffer.destroy();}
   text=text.replace('(The unchanged line 17','(The) Tj ( unchanged line 17');
   contents.put(1,d.addStream(new TextEncoder().encode(text),{}));
   if(variant==='longlabel'){
    const other=pages[1].get('Contents'),buffer=other.get(1).readStream();let text;
    try{text=new TextDecoder().decode(buffer.asUint8Array());}finally{buffer.destroy();}
    other.put(1,d.addStream(new TextEncoder().encode(text.replace('(Another paragraph','(Another) Tj ( paragraph')),{}));
   }
  }
  d.getTrailer().get('Root').put('Dests',{outsideTarget:[pages[targetPage],'XYZ',50,700,null]});
  for(const [i,{pageIndex,rect,edge}]of descriptors.entries()){
   const [l,b,r,t]=rect,action={S:'URI',URI:d.newString(`https://example.invalid/never-open-${i}`),PrivateUnknown:{Keep:true,Value:d.newString('preserved-private-value')},Next:{S:'URI',URI:d.newString('https://other.invalid/never-open')}};
   const object={Type:'Annot',Subtype:'Link',Rect:rect,QuadPoints:[l,t,r,t,l,b,r,b],Border:[0,0,0],F:4,P:pages[pageIndex],PrivateUnknown:{Keep:true}};
   if(i===1)object.Dest=d.newString('outsideTarget');else object.A=action;
   const old=pages[pageIndex].get('Annots'),array=old.isArray()?old:d.newArray();array.push(d.addObject(object));pages[pageIndex].put('Annots',array);
   if(underlines&&!edge&&!(variant==='stroke'&&i===0)){
    const clip=variant==='clip'?`${l} ${b} ${(r-l)/2} 1 re W n `:'';
    const shape=variant==='curve'?`${l} ${b+.25} m ${l} ${b} ${r} ${b} ${r} ${b+.25} c`:variant==='grid'?`${l} ${b} 20 20 re`:variant==='stroke'?`${l} ${b+.25} m ${r} ${b+.25} l`:`${l} ${b+.25} m ${variant==='long'?r+200:r} ${b+.25} l ${l} ${b+.25} l h`;
    const path=`q ${clip}0 0 1 rg 0 0 1 RG 0.4 w ${variant==='dash'?'[1 1] 0 d ':''}${shape} ${variant==='stroke'?'S':'f'} Q\n`;
    const stream=d.addStream(new TextEncoder().encode(path),{}),content=pages[pageIndex].get('Contents');
    const contents=content.isArray()?content:d.newArray();if(!content.isArray())contents.push(content);
    contents.push(stream);if(variant==='duplicate')contents.push(stream);pages[pageIndex].put('Contents',contents);
   }
  }
  const out=d.saveToBuffer('garbage=0,compress=false');try{return out.asUint8Array().slice();}finally{out.destroy();}
 }finally{d.destroy();}
}
test('real raw link dictionaries move with source glyph spans while fixed edge and outside named target stay intact',annotationsReal,async()=>{
 const sourceBytes=await annotatedFixture(),edits=[{id:'grow',pageIndex:0,before,after},{id:'second',pageIndex:1,before:'Source page 1 begins',after:'Source page 1 starts with an independently edited phrase'}];
 const result=await editPdf({sourceBytes,edits,reflow:true},{documentFlow:true,engineFactory:runtime.engineFactory,annotationAdapter:annotationRuntime.adapter});
 assert.equal(result.report.ok,true);assert.equal(result.report.selfCheck.annotationCheck.ok,true);
 const moves=result.report.pagination.annotationMoves;
 assert.equal(moves.length,2);assert.equal(moves.find(m=>m.sourcePageIndex===0).outputPageIndex,1);
 assert.ok(!moves.some(m=>m.sourcePageIndex===1&&m.annotationIndex===1));
 const map=result.report.pagination.sourcePageMap,groups=result.report.pagination.flowGroups;
 const mutate=callback=>{const doc=new annotationRuntime.mupdf.PDFDocument(result.pdf);try{callback(doc);const b=doc.saveToBuffer('garbage=0,compress=false');try{return b.asUint8Array().slice();}finally{b.destroy();}}finally{doc.destroy();}};
 const moved=moves.find(m=>m.sourcePageIndex===0);
 // The named destination annotation remains first on p1; the moved p0 URI
 // annotation is located by its private URI only within this test fixture.
 const findUri=d=>{const arr=d.findPage(moved.outputPageIndex).get('Annots');for(let i=0;i<arr.length;i++){const a=arr.get(i);if(a.get('A','URI').asString()==='https://example.invalid/never-open-0')return a;}throw Error('missing test URI');};
 for(const corrupt of [
  d=>findUri(d).get('A').put('URI',d.newString('https://changed.invalid/never-open')),
  d=>{const a=findUri(d),q=a.get('QuadPoints');q.put(0,q.get(0).asNumber()+1);},
  d=>{const page=d.findPage(moved.outputPageIndex),arr=page.get('Annots'),keep=d.newArray(),chosen=findUri(d);for(let i=0;i<arr.length;i++)if(arr.get(i).asIndirect()!==chosen.asIndirect())keep.push(arr.get(i));page.put('Annots',keep);},
 ]){
  const check=await inspectSavedPdf(runtime.engineFactory,sourceBytes,mutate(corrupt),edits,{sourcePageMap:map,flowGroups:groups,annotationAdapter:annotationRuntime.adapter});
  assert.equal(check.ok,false);assert.equal(check.annotationCheck.ok,false);
 }
});
test('tiny supported link underlines clone with the exact glyph/link translation and saved path corruption fails',annotationsReal,async()=>{
 const sourceBytes=await annotatedFixture({underlines:true}),edits=[{id:'grow',pageIndex:0,before,after}];
 const result=await editPdf({sourceBytes,edits,reflow:true},{documentFlow:true,engineFactory:runtime.engineFactory,annotationAdapter:annotationRuntime.adapter});
 assert.equal(result.report.ok,true);assert.equal(result.report.pagination.annotationMoves.length,2);
 const visibleSource=await annotatedFixture({underlines:true,variant:'stroke'});
 const visible=await editPdf({sourceBytes:visibleSource,edits,reflow:true},{documentFlow:true,engineFactory:runtime.engineFactory,annotationAdapter:annotationRuntime.adapter});
 assert.equal(visible.report.ok,true);
 // Exact independent-review regression: all geometry/colors remain equal,
 // but moving the saved stroked path before its source-owned label changes
 // rendered pixels. Its relation to unrelated page text is not the rule.
 const reordered=await runtime.engineFactory(visible.pdf);let changedPaint;
 try{
  reordered.loadPage(1);const M=reordered.M,objects=Array.from({length:M._FPDFPage_CountObjects(reordered.page)},(_,i)=>M._FPDFPage_GetObject(reordered.page,i)),h=objects.find(h=>M._FPDFPageObj_GetType(h)===2);
  assert.ok(objects.indexOf(h)>0);assert.ok(M._FPDFPage_RemoveObject(reordered.page,h));assert.ok(M._FPDFPage_InsertObjectAtIndex(reordered.page,h,0));
  reordered._pageDirty=true;changedPaint=reordered.save();
 }finally{reordered.close();}
 const paintCheck=await inspectSavedPdf(runtime.engineFactory,visibleSource,changedPaint,edits,{sourcePageMap:visible.report.pagination.sourcePageMap,flowGroups:visible.report.pagination.flowGroups,annotationAdapter:annotationRuntime.adapter});
 assert.equal(paintCheck.ok,false);assert.ok(paintCheck.failures.some(f=>f.code==='document_flow_underline_paint_order_mismatch'));
 const {sourcePageMap,flowGroups}=result.report.pagination;
 for(const mutation of ['shift','color','remove']){
  const e=await runtime.engineFactory(result.pdf);let changed;
  try{
   e.loadPage(1);const M=e.M,h=Array.from({length:M._FPDFPage_CountObjects(e.page)},(_,i)=>M._FPDFPage_GetObject(e.page,i)).find(h=>M._FPDFPageObj_GetType(h)===2);
   assert.ok(h);
   if(mutation==='shift')e.translateObject(h,0,1);
   else if(mutation==='color')assert.ok(M._FPDFPageObj_SetFillColor(h,255,0,0,255));
   else{assert.ok(M._FPDFPage_RemoveObject(e.page,h));M._FPDFPageObj_Destroy(h);}
   e._pageDirty=true;changed=e.save();
  }finally{e.close();}
  const check=await inspectSavedPdf(runtime.engineFactory,sourceBytes,changed,edits,{sourcePageMap,flowGroups,annotationAdapter:annotationRuntime.adapter});
  assert.equal(check.ok,false,mutation);assert.ok(check.failures.some(f=>f.code==='document_flow_underline_saved_mismatch'),mutation);
 }
 for(const variant of ['long','dash','duplicate','curve','clip','grid']){
  await assert.rejects(editPdf({sourceBytes:await annotatedFixture({underlines:true,variant}),edits,reflow:true},{documentFlow:true,engineFactory:runtime.engineFactory,annotationAdapter:annotationRuntime.adapter}),e=>e.code==='LAYOUT_UNSUPPORTED');
 }
});
test('long source-owned link underline moves, while an oversized link path is rejected',annotationsReal,async()=>{
 const edits=[{id:'grow',pageIndex:0,before,after}];
 const sourceBytes=await annotatedFixture({underlines:true,variant:'longlabel'});
 const result=await editPdf({sourceBytes,edits,reflow:true},{documentFlow:true,engineFactory:runtime.engineFactory,annotationAdapter:annotationRuntime.adapter});
 assert.equal(result.report.ok,true);assert.equal(result.report.selfCheck.annotationCheck.ok,true);
 assert.ok(result.report.pagination.annotationMoves.some(m=>m.sourcePageIndex===1));
 const oversized=await annotatedFixture({underlines:true,variant:'oversized'});
 const model=await annotationRuntime.adapter.inspect({sourceBytes:oversized,sourceSha256:createHash('sha256').update(oversized).digest('hex')});
 const engine=await runtime.engineFactory(oversized);
 try{
  engine.loadPage(0);const M=engine.M,h=Array.from({length:M._FPDFPage_CountObjects(engine.page)},(_,i)=>M._FPDFPage_GetObject(engine.page,i)).find(h=>M._FPDFPageObj_GetType(h)===2);
  assert.throws(()=>sourceUnderline(engine,h,0,model),e=>e.code==='document_flow_underline_too_long');
 }finally{engine.close();}
 await assert.rejects(editPdf({sourceBytes:oversized,edits,reflow:true},{documentFlow:true,engineFactory:runtime.engineFactory,annotationAdapter:annotationRuntime.adapter}),e=>e.code==='LAYOUT_UNSUPPORTED');
});
test('internal target page stops an eligible text prefix and terminal tail preserves target identity and coordinates',annotationsReal,async()=>{
 const sourceBytes=await annotatedFixture({denseAll:true,targetPage:2}),edits=[{id:'grow',pageIndex:0,before,after}];
 const result=await editPdf({sourceBytes,edits,reflow:true},{documentFlow:true,engineFactory:runtime.engineFactory,annotationAdapter:annotationRuntime.adapter});
 assert.equal(result.report.ok,true);const p=result.report.pagination;
 assert.deepEqual(p.flowGroups[0].sourcePages.map(b=>b.sourcePageIndex),[0,1]);
 assert.ok(p.sourcePageMap[1].continuationPageIndices.length>0);assert.equal(p.sourcePageMap[2].outputPageIndex,2+p.addedPages);
 assert.ok(result.report.warnings.some(w=>w.code==='document_flow_internal_target_boundary'&&w.boundarySourcePageIndex===2));
 assert.equal(result.report.selfCheck.pages.find(p=>p.pageIndex===2).text_equal,true);
 const {mupdf}=annotationRuntime,old=new mupdf.PDFDocument(sourceBytes),out=new mupdf.PDFDocument(result.pdf);
 try{
  const a=old.getTrailer().get('Root','Dests','outsideTarget'),b=out.getTrailer().get('Root','Dests','outsideTarget');
  assert.equal(b.get(0).asIndirect(),out.findPage(p.sourcePageMap[2].outputPageIndex).asIndirect());
  for(let i=1;i<a.length;i++)assert.equal(b.get(i).toString(),a.get(i).toString());
 }finally{old.destroy();out.destroy();}
});


test('FitR target is proven against planned and saved glyphs and transported to its final page',annotationsReal,async()=>{
 const original=await annotatedFixture({targetPage:1}), source=await runtime.engineFactory(original);
 let rect;
 try {
  const chars=readLinkPageCharacters(source,1).filter(c=>c.u>32&&c.box&&c.box.b>80&&c.box.t<720);
  const owned=chars.filter(c=>c.object===chars[0].object);
  rect=[Math.min(...owned.map(c=>c.box.l)),Math.min(...owned.map(c=>c.box.b)),Math.max(...owned.map(c=>c.box.r)),Math.max(...owned.map(c=>c.box.t))];
 } finally {source.close();}
 const doc=new annotationRuntime.mupdf.PDFDocument(original);let sourceBytes;
 try {
  doc.getTrailer().get('Root').get('Dests').put('outsideTarget',[doc.findPage(1),'FitR',...rect]);
  const b=doc.saveToBuffer('garbage=0,compress=false');try{sourceBytes=b.asUint8Array().slice();}finally{b.destroy();}
 } finally {doc.destroy();}
 const edits=[{id:'grow',pageIndex:0,before,after}], calls=[];
 const adapter={...annotationRuntime.adapter,
  async transport(args){calls.push({type:'transport',moves:structuredClone(args.destinationMoves)});return annotationRuntime.adapter.transport(args);},
  async validate(args){calls.push({type:'validate',moves:structuredClone(args.destinationMoves)});return annotationRuntime.adapter.validate(args);}
 };
 const result=await editPdf({sourceBytes,edits,reflow:true},{documentFlow:true,engineFactory:runtime.engineFactory,annotationAdapter:adapter});
 assert.equal(result.report.ok,true);
 assert.equal(calls.length,2);assert.equal(calls[0].moves.length,1);assert.deepEqual(calls[0].moves,calls[1].moves);
 const move=calls[0].moves[0];assert.equal(move.sourcePageIndex,1);assert.ok(Number.isInteger(move.outputPageIndex));assert.ok(Math.abs(move.dy)>.1);
 const out=new annotationRuntime.mupdf.PDFDocument(result.pdf);try{
  const dest=out.getTrailer().get('Root').get('Dests').get('outsideTarget');
  assert.equal(dest.get(0).asIndirect(),out.findPage(move.outputPageIndex).asIndirect());
  for(let i=0;i<4;i++)assert.ok(Math.abs(dest.get(i+2).asNumber()-(rect[i]+(i%2?move.dy:move.dx)))<.05);
 }finally{out.destroy();}
 const corrupt=new annotationRuntime.mupdf.PDFDocument(result.pdf);let damaged;
 try {
  const dest=corrupt.getTrailer().get('Root').get('Dests').get('outsideTarget');dest.put(2,dest.get(2).asNumber()+5);
  const b=corrupt.saveToBuffer('garbage=0,compress=false');try{damaged=b.asUint8Array().slice();}finally{b.destroy();}
 }finally{corrupt.destroy();}
 const check=await inspectSavedPdf(runtime.engineFactory,sourceBytes,damaged,edits,{sourcePageMap:result.report.pagination.sourcePageMap,flowGroups:result.report.pagination.flowGroups,annotationAdapter:annotationRuntime.adapter});
 assert.equal(check.ok,false);assert.equal(check.annotationCheck.ok,false);
 const partial=new annotationRuntime.mupdf.PDFDocument(sourceBytes);let unsafe;
 try{
  const dest=partial.getTrailer().get('Root').get('Dests').get('outsideTarget');dest.put(2,rect[0]+1);
  const b=partial.saveToBuffer('garbage=0,compress=false');try{unsafe=b.asUint8Array().slice();}finally{b.destroy();}
 }finally{partial.destroy();}
 await assert.rejects(editPdf({sourceBytes:unsafe,edits,reflow:true},{documentFlow:true,engineFactory:runtime.engineFactory,annotationAdapter:annotationRuntime.adapter}),e=>e.code==='LAYOUT_UNSUPPORTED');
});
