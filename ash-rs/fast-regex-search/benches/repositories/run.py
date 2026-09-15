"""End-to-end evaluation over frozen real repositories; all raw samples retained."""
import concurrent.futures,hashlib,json,math,os,pathlib,random,selectors,socket,statistics,subprocess,sys,time,shutil
from memory import Monitor
BASE=pathlib.Path(os.environ['EVAL_ROOT']).resolve()
RG=shutil.which('rg') or 'rg'
TG=str(BASE/'bin/tgrep')
RUNS=int(os.environ.get('RUNS','5'))
LABEL=os.environ.get('LABEL','phase1')

def summary(values):
 return {'p50':statistics.median(values),'p95':sorted(values)[math.ceil(.95*len(values))-1],'samples':values} if values else None
def canonical(rows):
 return sorted((str(p).removeprefix('./'),int(n),text) for p,n,text in rows)
def digest(rows,normalize=False):
 rows=canonical(rows)
 if normalize:rows=[(p,n,text.removesuffix('\r')) for p,n,text in rows]
 return hashlib.sha256(json.dumps(rows,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()

class Ash:
 def __init__(self,root,storage):
  self.log=open(str(storage)+'.stderr','w')
  self.p=subprocess.Popen([str(BASE/'bin'/('ash-'+LABEL)),str(root),str(storage)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.log,text=True)
  self.monitor=Monitor(self.p.pid)
  try:self.init=self.read(1200)
  except Exception:
   pathlib.Path(str(storage)+'.build-memory.json').write_text(json.dumps(self.monitor.finish(),indent=2));raise
  self.build_memory=self.monitor.finish()
  pathlib.Path(str(storage)+'.build-memory.json').write_text(json.dumps(self.build_memory,indent=2))
  self.monitor=Monitor(self.p.pid)
  print('ASH',self.init,flush=True)
 def read(self,timeout=180):
  with selectors.DefaultSelector() as sel:
   sel.register(self.p.stdout,selectors.EVENT_READ)
   if not sel.select(timeout):raise TimeoutError('Ash response timeout')
  line=self.p.stdout.readline()
  if not line:raise RuntimeError('Ash exited '+str(self.p.poll()))
  return json.loads(line)
 def query(self,q,limit):
  self.p.stdin.write(json.dumps({'query':q['pattern'],'literal':q['kind']=='literal','limit':limit})+'\n');self.p.stdin.flush()
  return self.read()
 def close(self):
  self.p.stdin.close();self.p.wait(timeout=15);self.log.close();return self.monitor.finish()

def rg(q,root,limit=None):
 cmd=[RG,'--no-config','--color','never','--no-heading','-n']
 if q['kind']=='literal':cmd+=['-F']
 cmd+=['--',q['pattern'],'.']
 start=time.perf_counter()
 if limit is None:
  p=subprocess.run(cmd,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180)
  assert p.returncode in [0,1],p.stderr
  output=p.stdout
 else:
  p=subprocess.Popen(cmd,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  lines=[]
  for line in p.stdout:
   if len(lines)==limit:p.kill();break
   lines.append(line)
  p.stdout.close();p.stdout=None
  _,err=p.communicate(timeout=180)
  assert len(lines)==limit or p.returncode in [0,1],err
  output=b''.join(lines)
 elapsed=(time.perf_counter()-start)*1000
 rows=[]
 for line in output.split(b'\n'):
  if not line:continue
  path,number,text=line.decode().split(':',2)
  rows.append([path.removeprefix('./'),int(number),text])
 return elapsed,rows

def large_case(q,root,ash):
 # After a full-output resource failure, validate the limited contract with a
 # streaming reference instead of constructing another multi-million-row JSON.
 limited=ash.query(q,100)
 wanted={(p,n,t.removesuffix('\r')) for p,n,t in canonical(limited.get('matches',[]))}
 remaining=set(wanted);count=0;files=set();checksum=0
 cmd=[RG,'--no-config','--color','never','--no-heading','-n']
 if q['kind']=='literal':cmd+=['-F']
 cmd+=['--',q['pattern'],'.']
 process=subprocess.Popen(cmd,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 for line in process.stdout:
  path,number,text=line.rstrip(b'\n').decode().split(':',2)
  row=(path.removeprefix('./'),int(number),text.removesuffix('\r'))
  count+=1;files.add(row[0]);remaining.discard(row)
  checksum=(checksum+int.from_bytes(hashlib.sha256(json.dumps(row,ensure_ascii=False).encode()).digest(),'big'))%(1<<256)
 assert process.wait(timeout=180) in [0,1]
 ok='error' not in limited and not remaining and len(limited['matches'])==min(100,count) and limited['limit_hit']==(count>100)
 times={'ash_100':[],'rg_100':[]}
 for repetition in range(RUNS):
  methods=['ash_100','rg_100'] if repetition%2 else ['rg_100','ash_100']
  for method in methods:
   if method=='ash_100' and ok:times[method].append(ash.query(q,100)['ms'])
   if method=='rg_100':times[method].append(rg(q,root,100)[0])
 return {'query':q,'matches':count,'matching_files':len(files),'reference_multiset_sha256_sum':f'{checksum:064x}',
  'ash_correct':None,'tgrep_correct':None,'ash_100_correct':ok,'ash_error':None,'ash_stats':limited.get('stats'),
  'complete_status':'not rerun: over 200000 Linux matches after an 8 GiB full-output resource failure',
  'timings':{'ash_full':None,'tgrep_rpc_full':None,'rg_full':None,**{k:summary(v) for k,v in times.items()}},'failures':[]}

def run(name):
 root=pathlib.Path(os.environ.get('CORPUS_ROOT',str(BASE/'corpora')))/name;dest=BASE/LABEL/name;dest.mkdir(parents=True,exist_ok=True)
 manifest=json.loads((pathlib.Path(os.environ.get('MANIFEST_ROOT',str(BASE/'manifests')))/(name+'.json')).read_text())
 tgidx=dest/'tgrep-index' if os.environ.get('CORPUS_ROOT') else BASE/'baseline'/name/'tgrep-index'
 if (tgidx/'meta.json').exists():
  clone=dest/'tgrep-index'
  if not clone.exists():
   subprocess.run(['cp','-cR',str(tgidx),str(clone)],check=True)
   (clone/'serve.json').unlink(missing_ok=True)
  tgidx=clone
 if not (tgidx/'meta.json').exists():
  tgidx=dest/'tgrep-index'
  if not tgidx.exists():
   start=time.perf_counter()
   with open(dest/'tgrep-build.log','wb') as buildlog:
    build=subprocess.Popen([TG,'index',str(root),'--index-path',str(tgidx)],stdout=buildlog,stderr=buildlog)
    monitor=Monitor(build.pid);code=build.wait(timeout=1200)
   (dest/'tgrep-build-time.json').write_text(json.dumps({'seconds':time.perf_counter()-start,'exit':code,'memory':monitor.finish()},indent=2));assert code==0
 ash=Ash(root,dest/'ash-index')
 assert ash.init['snapshot']['indexed_file_count']==manifest['files'],ash.init
 log=open(dest/'tgrep-server.log','w')
 server=subprocess.Popen([TG,'serve',str(root),'--index-path',str(tgidx),'--no-watch'],stdout=log,stderr=log)
 tg_memory=Monitor(server.pid)
 def rpc(q):
  start=time.perf_counter()
  with socket.create_connection(('127.0.0.1',port),timeout=180) as sock:
   sock.sendall((json.dumps({'jsonrpc':'2.0','id':1,'method':'search','params':{'pattern':q['pattern'],'fixed_string':q['kind']=='literal','detail':True,'positions':True}})+'\n').encode())
   r=json.loads(sock.makefile('rb').readline())
  ms=(time.perf_counter()-start)*1000
  if 'error' in r:return ms,[],r
  result=r['result']; rows=[[m['file'],m['line'],m['content']] for m in result['matches']]
  return ms,rows,{'server_ms':result['elapsed_ms']}
 result={'host_load_start':os.getloadavg(),'name':name,'label':LABEL,'files':manifest['files'],'bytes':manifest['bytes'],'ash_init':ash.init,'runs':RUNS,'cases':[]}
 try:
  deadline=time.monotonic()+180
  while True:
   try:
    port=json.loads((tgidx/'serve.json').read_text())['port'];rpc({'pattern':'readiness_absent_427ae','kind':'literal'});break
   except (OSError,ValueError):
    if time.monotonic()>deadline:raise
    time.sleep(.1)
  queries=json.loads((BASE/'queries'/(name+'.json')).read_text())
  if 'QUERY_LIMIT' in os.environ:queries=queries[:int(os.environ['QUERY_LIMIT'])]
  if 'QUERY_NAMES' in os.environ:queries=[q for q in queries if q['name'] in os.environ['QUERY_NAMES'].split(',')]
  for q in queries:
   if name=='linux' and q['name'] in ['short','common','class','anchor','no-literal','optional','unicode']:
    count_args=[RG,'--no-config','--count','--',q['pattern'],'.']
    counted=subprocess.run(count_args,cwd=root,capture_output=True,check=False)
    assert counted.returncode in [0,1]
    count=sum(int(line.rsplit(b':',1)[1]) for line in counted.stdout.splitlines())
    if count>200000:
     item=large_case(q,root,ash);result['cases'].append(item)
     (dest/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
     print(name,q['name'],count,'complete: resource budget; limited:',item['ash_100_correct'],flush=True)
     continue
   expected_ms,expected=rg(q,root);ref=digest(expected);semantic_ref=digest(expected,True);expected_set=set(map(tuple,canonical(expected))); normalized_expected={(p,n,t.removesuffix('\r')) for p,n,t in expected_set}
   a=ash.query(q,1_000_000); t_ms,t_rows,t_extra=rpc(q)
   a_ok='error' not in a and not a['limit_hit'] and digest(a['matches'],True)==semantic_ref
   t_ok='error' not in t_extra and digest(t_rows,True)==semantic_ref
   if not a_ok or not t_ok:
    print('CORRECTNESS',name,q['name'],'ash',a_ok,'tgrep',t_ok,flush=True)
   limited=ash.query(q,100)
   limited_ok='error' not in limited and len(limited['matches'])==min(len(expected),100) and {(p,n,t.removesuffix('\r')) for p,n,t in canonical(limited['matches'])}.issubset(normalized_expected) and limited['limit_hit']==(len(expected)>100)
   item={'query':q,'matches':len(expected),'matching_files':len({r[0] for r in expected}),'reference_sha256':ref,'ash_correct':a_ok,'tgrep_correct':t_ok,'ash_exact_text':digest(a.get('matches',[]))==ref,'tgrep_exact_text':digest(t_rows)==ref,'ash_100_correct':limited_ok,'ash_error':a.get('error'),'ash_stats':a.get('stats'),'timings':{},'failures':[]}
   if not a_ok or not t_ok:
    item['differences']={'ash_missing':list(expected_set-set(map(tuple,canonical(a.get('matches',[])))))[:5], 'tgrep_missing':list(expected_set-set(map(tuple,canonical(t_rows))))[:5]}
   times={k:[] for k in ['ash_full','ash_100','tgrep_rpc_full','rg_full','rg_100']}
   rng=random.Random(47)
   for repetition in range(RUNS):
    methods=list(times);rng.shuffle(methods)
    for method in methods:
     if method=='ash_full' and not a_ok:continue
     if method=='ash_100' and not limited_ok:continue
     if method=='tgrep_rpc_full' and not t_ok:continue
     if method.startswith('ash'):
      value=ash.query(q,100 if method.endswith('100') else 1_000_000)
      if 'error' in value:item['failures'].append(value['error']);continue
      ms=value['ms']
     elif method=='tgrep_rpc_full':ms=rpc(q)[0]
     else:ms=rg(q,root,100 if method.endswith('100') else None)[0]
     times[method].append(ms)
   item['timings']={k:summary(v) for k,v in times.items()}
   result['cases'].append(item)
   (dest/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
   print(name,q['name'],len(expected),{k:round(v['p50'],3) for k,v in item['timings'].items() if v},flush=True)
  result['index_bytes']=sum(p.stat().st_size for p in (dest/'ash-index').rglob('*') if p.is_file())
  result['tgrep_index_bytes']=sum(p.stat().st_size for p in tgidx.rglob('*') if p.is_file())
  (dest/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
 finally:
  result['host_load_end']=os.getloadavg();result['ash_memory']=ash.close();server.terminate();server.wait(timeout=30);log.close();result['tgrep_memory']=tg_memory.finish()
  (dest/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))

if __name__ == "__main__":
 for name in sys.argv[1:]:run(name)
