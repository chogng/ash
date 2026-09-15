"""Resource-bounded, real-corpus concurrency, update and crash-recovery exercise."""
import hashlib,json,math,os,pathlib,selectors,signal,statistics,subprocess,time
from memory import Monitor

BASE=pathlib.Path(os.environ['EVAL_ROOT']).resolve()
DEST=BASE/'stress';DEST.mkdir(exist_ok=True)
ROOT=BASE/'corpora/combined'
RESULT={'corpus':'combined','cases':[]}

def save():
 (DEST/'results.json').write_text(json.dumps(RESULT,indent=2))

class Client:
 def __init__(self,args):
  self.log=open(DEST/(str(time.time_ns())+'.stderr'),'w')
  self.p=subprocess.Popen([str(BASE/'bin/ash-stress'),*map(str,args)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.log,text=True)
  self.monitor=Monitor(self.p.pid)
  try:self.ready=self.read(1200)
  except Exception:
   (DEST/(str(self.p.pid)+"-failed-build-memory.json")).write_text(json.dumps(self.monitor.finish(),indent=2));raise
  self.build_memory=self.monitor.finish();self.monitor=Monitor(self.p.pid)
 def read(self,timeout=180):
  with selectors.DefaultSelector() as selector:
   selector.register(self.p.stdout,selectors.EVENT_READ)
   if not selector.select(timeout):raise TimeoutError('stress response')
  line=self.p.stdout.readline()
  if not line:raise RuntimeError('stress process exited '+str(self.p.poll()))
  return json.loads(line)
 def send(self,query):
  self.p.stdin.write(json.dumps(query)+'\n');self.p.stdin.flush()
 def call(self,query):
  self.send(query);return self.read()
 def close(self):
  self.p.stdin.close();self.p.wait(timeout=30);self.log.close();return self.monitor.finish()

def record(name,client,query,expected=None):
 value=client.call(query)
 samples=value['result'].get('samples',[])
 if expected is not None:
  assert samples and all('error' not in s and s['count']==expected for s in samples),value
 if samples:
  values=sorted(s['ms'] for s in samples)
  value['summary']={'p50':statistics.median(values),'p95':values[math.ceil(.95*len(values))-1],'p99':values[math.ceil(.99*len(values))-1],'queries':len(values),'qps':len(values)*1000/value['elapsed_ms']}
 RESULT['cases'].append({'name':name,'request':query,**value});save();print(name,value.get('summary',value['elapsed_ms']),flush=True)
 return value

def search(client,marker,count):
 result=client.call({'query':marker,'limit':10000,'rounds':1,'concurrency':1})['result']['samples'][0]
 assert 'error' not in result and result['count']==count and not result['limit_hit'],result
 return result

def main():
 ash=Client([ROOT,DEST/'ash-index'])
 RESULT['ash_init']=ash.ready;RESULT['ash_build_memory']=ash.build_memory;save()
 assert ash.ready['snapshot']['indexed_file_count']==json.loads((BASE/'manifests/combined.json').read_text())['files'],ash.ready
 tgindex=DEST/'tgrep-index'
 started=time.perf_counter()
 build=subprocess.Popen([str(BASE/'bin/tgrep'),'index',str(ROOT),'--index-path',str(tgindex)],stdout=open(DEST/'tgrep-build.log','w'),stderr=subprocess.STDOUT)
 monitor=Monitor(build.pid);code=build.wait(timeout=1200)
 RESULT['tgrep_build']={'seconds':time.perf_counter()-started,'exit':code,'memory':monitor.finish()};save();assert code==0
 server_log=open(DEST/'tgrep-server.log','w')
 server=subprocess.Popen([str(BASE/'bin/tgrep'),'serve',str(ROOT),'--index-path',str(tgindex),'--no-watch'],stdout=server_log,stderr=server_log)
 tgmonitor=Monitor(server.pid);remote=None
 original={};fixture=ROOT/'stress-fixture'
 try:
  deadline=time.monotonic()+120
  while not (tgindex/'serve.json').exists():
   assert time.monotonic()<deadline;time.sleep(.1)
  port=json.loads((tgindex/'serve.json').read_text())['port']
  remote=Client(['--tgrep-port',port])
  # Same Rust client language; both return the complete rare result set.
  cases=json.loads((BASE/'trigram/linux/results.json').read_text())['cases']
  rare=min((c for c in cases if c['matches']>0 and c['query']['name'].startswith('identifier')),key=lambda c:(c['matches'],c['query']['name']))['query']['pattern']
  reference=subprocess.run(['rg','--no-config','-n','--',rare,'.'],cwd=ROOT,capture_output=True,check=True).stdout
  count=len(reference.splitlines());assert count<100
  RESULT['rare_query']={'pattern':rare,'matches':count}
  for concurrency in [1,2,4,8,16,32]:
   request={'query':rare,'limit':100,'concurrency':concurrency,'rounds':max(10,100//concurrency)}
   # Alternate engine order across concurrency levels.
   engines=[('ash',ash),('tgrep',remote)]
   if concurrency in [2,8,32]:engines.reverse()
   for name,client in engines:record(f'{name}-rare-c{concurrency}',client,request,count)
  for concurrency in [1,4,16,32]:
   record(f'ash-common-c{concurrency}',ash,{'query':'return','limit':100,'concurrency':concurrency,'rounds':10},100)
  # End the read-only reference server before making changes to the test copy.
  remote.close();remote=None;server.terminate();server.wait(timeout=30)
  RESULT['tgrep_query_memory']=tgmonitor.finish();server_log.close()
  manifest=json.loads((BASE/'manifests/combined.json').read_text())
  paths=[e[0] for e in manifest['entries'] if 64<=e[1]<=16384][:1000]
  marker='ash_real_repository_stress_marker_87a191'
  search(ash,marker,0)
  for count in [1,100,1000]:
   for relative in paths[:count]:
    path=ROOT/relative
    if relative not in original:original[relative]=path.read_bytes()
    path.write_bytes(original[relative]+b'\n'+marker.encode()+b'\n')
   record(f'update-{count}',ash,{'refresh_paths':paths[:count]})
   found=search(ash,marker,count);assert set(found['paths'])==set(paths[:count])
  fixture.mkdir()
  added=fixture/'created.txt';added.write_text(marker+'\n')
  record('create',ash,{'refresh_paths':['stress-fixture/created.txt']});search(ash,marker,1001)
  renamed=fixture/'renamed.txt';added.rename(renamed)
  record('rename',ash,{'refresh_paths':['stress-fixture/created.txt','stress-fixture/renamed.txt']})
  found=search(ash,marker,1001);assert 'stress-fixture/renamed.txt' in found['paths'] and 'stress-fixture/created.txt' not in found['paths']
  renamed.unlink();record('delete',ash,{'refresh_paths':['stress-fixture/renamed.txt']});search(ash,marker,1000)
  for relative,content in original.items():(ROOT/relative).write_bytes(content)
  record('restore-1000',ash,{'refresh_paths':paths});search(ash,marker,0)
  for relative,content in original.items():assert hashlib.sha256((ROOT/relative).read_bytes()).digest()==hashlib.sha256(content).digest()
  original.clear();fixture.rmdir()
  record('reconcile',ash,{'reconcile':True});search(ash,marker,0)
  RESULT['ash_query_memory']=ash.close();ash=None
  ash=Client([ROOT,DEST/'ash-index']);RESULT['reopen']=ash.ready;search(ash,marker,0)
  # Interrupt only this harness's worker while rebuilding; preserve the last publication.
  worker=ash.ready['pid'];ash.send({'rebuild':True});time.sleep(1)
  scratch=list((DEST/'ash-index').glob('.build-*'));assert scratch
  os.kill(worker,signal.SIGKILL)
  response=ash.read();RESULT['interrupted_rebuild']=response
  assert 'Err' in response['result']['update'],response
  search(ash,marker,0)
  record('rebuild-after-crash',ash,{'rebuild':True});search(ash,marker,0)
  RESULT['scratch_after_recovery']=[str(p) for p in (DEST/'ash-index').glob('.build-*')]
  assert not RESULT['scratch_after_recovery']
  RESULT['index_bytes']={name:sum(p.stat().st_size for p in (DEST/(name+'-index')).rglob('*') if p.is_file()) for name in ['ash','tgrep']}
  RESULT['completed']=True;save()
 finally:
  for relative,content in original.items():(ROOT/relative).write_bytes(content)
  if fixture.exists():
   for path in fixture.iterdir():path.unlink()
   fixture.rmdir()
  if ash:RESULT['ash_final_memory']=ash.close()
  if remote:remote.close()
  if server.poll() is None:server.terminate();server.wait(timeout=30)
  RESULT['tgrep_final_memory']=tgmonitor.finish();save()

if __name__=='__main__':main()
