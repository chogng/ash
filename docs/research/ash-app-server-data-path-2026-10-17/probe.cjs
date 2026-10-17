const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm'), ts=require('typescript'), crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const root=process.cwd(), output=path.join(root,'.build/investigations/app-server-pipeline-2026-10-17');
const sourceName='src/ash/platform/agentHost/browser/appServerSocketTransport.ts';
const source=fs.readFileSync(sourceName,'utf8');
const ast=ts.createSourceFile(sourceName,source,ts.ScriptTarget.Latest,true);
const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name.text==='AppServerSocketTransport');
const methods=['acceptData','append'].map(name=>cls.members.find(n=>n.name?.getText(ast)===name).getText(ast)).join('\n');
let copied=0,conCats=0;
class VSBuffer {
 constructor(buffer){this.buffer=buffer;this.byteLength=buffer.length}
 static wrap(b){return new VSBuffer(b)}
 static concat(parts,totalLength=parts.reduce((s,p)=>s+p.byteLength,0)){copied+=totalLength;conCats++;const out=new Uint8Array(totalLength);let n=0;for(const p of parts){out.set(p.buffer,n);n+=p.byteLength}return new VSBuffer(out)}
 slice(a,b){return new VSBuffer(this.buffer.subarray(a,b))}
}
const script=ts.transpileModule(`class Framer { parts=[];bufferedBytes=0;socket={};emit(){};disconnect(){throw new Error('unexpected disconnect')};${methods}};module.exports=Framer`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const Framer=new Function('VSBuffer','WEB_APP_SERVER_FRAME_EVENT','WEB_APP_SERVER_CLOSED_EVENT','module',script+';return module.exports')(VSBuffer,'frame','closed',{});
const records=[];function log(v){records.push(v);console.log(JSON.stringify(v))}
log({kind:'environment',node:process.version,v8:process.versions.v8,source:sourceName,sha256:crypto.createHash('sha256').update(source).digest('hex'),scope:'source-extracted methods, Uint8Array VSBuffer-equivalent adapter; no Electron/actual UI/IPC timing'});
for(const mb of [4,16,64]){
 const bytes=new TextEncoder().encode(JSON.stringify({id:1,result:{text:'x'.repeat(mb*1048576)}})+'\n');
 for(const packet of [8192,65536]){
  const runs=[];for(let run=0;run<5;run++){
   global.gc();copied=0;conCats=0;const f=new Framer();let frames=0;f.emit=(event,payload)=>{if(event==='frame'){frames++;if(payload.frame.length!==bytes.length-1)throw new Error('bad frame')}};
   let maxSlice=0,totalMs=0;
   for(let i=0;i<bytes.length;i+=packet){const t=performance.now();f.acceptData(VSBuffer.wrap(bytes.subarray(i,i+packet)));const dt=performance.now()-t;totalMs+=dt;maxSlice=Math.max(maxSlice,dt)}
   if(frames!==1||f.bufferedBytes!==0)throw new Error('incomplete');
   // append's Uint8Array.slice accounts for one extra payload copy, beyond concat counters.
   runs.push({totalMs,maxSlice,copiedBytes:copied+bytes.length-1,conCats});
  }
  runs.sort((a,b)=>a.totalMs-b.totalMs);const r=runs[2];log({kind:'framing',payloadMiB:mb,packetBytes:packet,totalMs:+r.totalMs.toFixed(2),maxSliceMs:+r.maxSlice.toFixed(2),copyAmplification:+(r.copiedBytes/(bytes.length-1)).toFixed(2),concatCalls:r.conCats,samples:runs});
 }
}

// Candidate only: one ownership copy into fixed-size pages, one final flatten.
class PagedFramer extends Framer {
 append(data){
  if(this.bufferedBytes+data.byteLength>320*1048576)throw new Error('capacity');
  if(!data.byteLength)return true;
  if(this.bufferedBytes===0){this.page=null;this.used=0}
  this.bufferedBytes+=data.byteLength;
  for(let offset=0;offset<data.byteLength;){
   if(!this.page||this.used===65536){this.page=new Uint8Array(65536);this.used=0;this.parts.push(VSBuffer.wrap(this.page.subarray(0,0)))}
   const take=Math.min(65536-this.used,data.byteLength-offset);
   this.page.set(data.buffer.subarray(offset,offset+take),this.used);copied+=take;
   this.used+=take;offset+=take;this.parts[this.parts.length-1]=VSBuffer.wrap(this.page.subarray(0,this.used));
  }
  return true;
 }
}
{
 const wire=JSON.stringify({id:1,result:{text:'x'.repeat(64*1048576)}}), bytes=new TextEncoder().encode(wire+'\n');
 const runs=[];for(let run=0;run<5;run++){
  global.gc();copied=0;conCats=0;const f=new PagedFramer();let received;
  f.emit=(event,payload)=>{if(event==='frame')received=payload.frame};
  let maxSlice=0,totalMs=0;
  for(let i=0;i<bytes.length;i+=65536){const t=performance.now();f.acceptData(VSBuffer.wrap(bytes.subarray(i,i+65536)));const dt=performance.now()-t;totalMs+=dt;maxSlice=Math.max(maxSlice,dt)}
  if(received!==wire)throw new Error('candidate changed bytes');
  runs.push({totalMs,maxSlice,copiedBytes:copied,conCats});
 }
 runs.sort((a,b)=>a.totalMs-b.totalMs);const r=runs[2];log({kind:'framing-candidate',variant:'fixed 64KiB pages, same source acceptData',payloadMiB:64,packetBytes:65536,totalMs:+r.totalMs.toFixed(2),maxSliceMs:+r.maxSlice.toFixed(2),copyAmplification:+(r.copiedBytes/(bytes.length-1)).toFixed(2),concatCalls:r.conCats,samples:runs});
}
const modules=new Map();function load(p){p=path.resolve(p);if(modules.has(p))return modules.get(p).exports;let code=fs.readFileSync(p,'utf8');const m={exports:{}};modules.set(p,m);code=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;new Function('require','module','exports',code)(name=>load(path.resolve(path.dirname(p),name.replace(/\.js$/,'.ts'))),m,m.exports);return m.exports}
const base=path.join(root,'.build/protocol/typescript'),decoder=load(path.join(base,'AppServerProtocolDecoder.ts'));
const defs=Object.assign({},...[0,1,2,3].map(i=>load(path.join(base,`AppServerProtocolSchema${i}.ts`)).definitions));
function minimal(s,depth=0){if(depth>50)throw new Error('schema recursion');if(s.$ref)return minimal(defs[s.$ref.split('/').at(-1)],depth+1);if(Object.hasOwn(s,'const'))return s.const;if(s.enum)return s.enum[0];if(s.oneOf)return minimal(s.oneOf[0],depth+1);if(s.anyOf)return minimal(s.anyOf[0],depth+1);const type=Array.isArray(s.type)?s.type[0]:s.type;switch(type){case'object':return Object.fromEntries((s.required||[]).map(k=>[k,minimal(s.properties[k],depth+1)]));case'array':return [];case'integer':case'number':return s.minimum||0;case'boolean':return false;case'null':return null;case'string':return 'x'.repeat(Math.max(1,s.minLength||0));default:return null}}
function resultFor(method){return minimal(defs.ClientResultSchema.oneOf.find(s=>s.properties.method.const===method).properties.result)}
function median(values){return [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]}
function timing(fn){const samples=[];for(let i=0;i<5;i++){global.gc();const t=performance.now();fn();samples.push(performance.now()-t)}return {medianMs:+median(samples).toFixed(2),samples}}
const baseline=resultFor('session/thread/read');decoder.decodeAppServerResponse('session/thread/read',{jsonrpc:'2.0',id:1,result:baseline});
for(const n of [1000,10000,50000]){
 const result=structuredClone(baseline);result.transcript.entries=Array.from({length:n},(_,i)=>({type:'toolOutput',entryId:'entry-'+i,turnId:'turn-1',toolCallId:'call-1',stream:'stdout',text:'x'.repeat(960)}));
 const message={jsonrpc:'2.0',id:1,result};decoder.decodeAppServerResponse('session/thread/read',message);
 const frame=JSON.stringify(message),encoded=new TextEncoder().encode(frame);
 log({kind:'protocol',method:'session/thread/read',entries:n,wireMiB:+(encoded.length/1048576).toFixed(2),reencodeForLength:timing(()=>new TextEncoder().encode(frame)),parse:timing(()=>JSON.parse(frame)),validation:timing(()=>decoder.decodeAppServerResponse('session/thread/read',message))});
}
fs.writeFileSync(path.join(output,'probe-results.json'),JSON.stringify(records,null,2)+'\n');
