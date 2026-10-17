var TG = 64,
  EG = 16;
function* DG(e, t) {
  let n = 0;
  yield { marker: ue, kind: `start`, transferId: t.transferId, sequence: n };
  let r = OG(e, Math.max(1, Math.floor(t.batchTargetBytes / 4))),
    i = null;
  for (;;) {
    let e = [],
      a = 0;
    for (;;) {
      let n = i == null ? r.next() : { done: !1, value: i };
      if (((i = null), n.done)) break;
      let o = AG(n.value);
      if (e.length > 0 && a + o > t.batchTargetBytes) {
        i = n.value;
        break;
      }
      (e.push(n.value), (a += o));
    }
    if (e.length === 0) break;
    ((n += 1), yield { marker: ue, kind: `chunk`, transferId: t.transferId, sequence: n, tokens: e });
  }
  ((n += 1), yield { marker: ue, kind: `end`, transferId: t.transferId, sequence: n });
}
function* OG(e, t) {
  let n = new WeakSet(),
    r = [{ type: `value`, value: e }];
  for (; r.length > 0;) {
    let e = r.pop();
    if (e == null) return;
    if (e.type === `token`) {
      yield e.token;
      continue;
    }
    if (e.type === `leave`) {
      n.delete(e.value);
      continue;
    }
    if (e.type === `string`) {
      yield* kG(e.value, e.target, t);
      continue;
    }
    if (e.type === `values`) {
      let t = e.values.next();
      t.done || r.push(e, { type: `value`, value: t.value });
      continue;
    }
    if (e.type === `entries`) {
      let t = e.entries.next();
      t.done ||
        r.push(e, { type: `value`, value: t.value[1] }, { type: `string`, value: t.value[0], target: `key` });
      continue;
    }
    let i = e.value;
    if (typeof i == `string`) {
      yield* kG(i, `value`, t);
      continue;
    }
    if (i == null || typeof i == `number` || typeof i == `boolean` || i === void 0) {
      yield { type: `value`, value: i };
      continue;
    }
    if (typeof i != `object`) throw Error(`Unsupported chunked message value: ${typeof i}`);
    if (n.has(i)) throw Error(`Chunked messages cannot contain cyclic values`);
    if ((n.add(i), o.w(i) || Array.isArray(i))) {
      (yield { type: `array-start` },
        r.push(
          { type: `leave`, value: i },
          { type: `token`, token: { type: `container-end` } },
          { type: `values`, values: o.w(i) ? jG(i) : i.values() },
        ));
      continue;
    }
    (yield { type: `object-start` },
      r.push(
        { type: `leave`, value: i },
        { type: `token`, token: { type: `container-end` } },
        { type: `entries`, entries: Object.entries(i).values() },
      ));
  }
}
function* kG(e, t, n) {
  if (e.length <= n) {
    t === `key` ? yield { type: `key`, value: e } : yield { type: `value`, value: e };
    return;
  }
  yield { type: `string-start`, target: t };
  for (let t = 0; t < e.length; t += n) yield { type: `string-chunk`, value: e.slice(t, t + n) };
  yield { type: `string-end` };
}
function AG(e) {
  let t = null;
  return (
    (e.type === `key` || e.type === `value` || e.type === `string-chunk`) && (t = e.value),
    TG + (typeof t == `string` ? t.length * 2 : EG)
  );
}
function* jG(e) {
  for (let t of e.chunks) yield* t;
}

const {performance}=require('node:perf_hooks');
const ue='codex-host-chunked-message-v1';
const o={w:()=>false};
function median(a){return a.sort((x,y)=>x-y)[Math.floor(a.length/2)]}
function measure(fn){let times=[];for(let i=0;i<5;i++){global.gc();let t=performance.now();fn();times.push(performance.now()-t)}return +median(times).toFixed(2)}
function chunks(x){let it=DG(x,{batchTargetBytes:2097152,transferId:'bench'});let max=0,total=0,count=0;for(;;){let t=performance.now(),r=it.next(),dt=performance.now()-t;max=Math.max(dt,max);total+=dt;if(r.done)break;count++}return {parts:count,maxNextMs:+max.toFixed(2),totalNextMs:+total.toFixed(2)}}
console.log(JSON.stringify({node:process.version,arch:process.arch,note:'isolated synthetic benchmark, not live Owl/UI profiling'}));
for(let size of [4,16,64]){
 const item={id:'message-1',role:'assistant',text:'x'.repeat(960)}, count=Math.ceil(size*1048576/1024);
 const wire=JSON.stringify({id:1,result:{thread:{turns:Array.from({length:count},()=>item)}}});
 const raw=Buffer.from(wire), bufs=[];for(let p=0;p<raw.length;p+=65536)bufs.push(raw.subarray(p,p+65536));
 const parsed=JSON.parse(wire);
 const parseMs=measure(()=>JSON.parse(wire));
 const concatDecodeParseMs=measure(()=>JSON.parse(Buffer.concat(bufs,raw.length).toString('utf8')));
 global.gc(); const chunking=chunks(parsed);
 console.log(JSON.stringify({scenario:'nested transcript',MiB:+(raw.length/1048576).toFixed(2),parseMs,concatDecodeParseMs,chunking}));
}
{
 const obj={};for(let i=0;i<200000;i++)obj['field'+i]=i;
 global.gc();const it=OG(obj,524288);it.next();let t=performance.now();it.next();console.log(JSON.stringify({scenario:'200k-key object',secondTokenMs:+(performance.now()-t).toFixed(2),includes:'eager Object.entries before the second token'}));
}
