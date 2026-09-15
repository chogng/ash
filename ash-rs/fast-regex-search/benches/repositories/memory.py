"""macOS process accounting, including compressed and swapped private pages."""
import ctypes,os,signal,subprocess,threading,time

class Usage(ctypes.Structure):
 _fields_=[('uuid',ctypes.c_ubyte*16),('user',ctypes.c_uint64),('system',ctypes.c_uint64),('wakeups',ctypes.c_uint64),('interrupts',ctypes.c_uint64),('pageins',ctypes.c_uint64),('wired',ctypes.c_uint64),('resident',ctypes.c_uint64),('footprint',ctypes.c_uint64),('started',ctypes.c_uint64),('exited',ctypes.c_uint64)]
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
lib.proc_pid_rusage.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_void_p]
def usage(pid):
 out=Usage()
 return {'rss':out.resident,'footprint':out.footprint} if lib.proc_pid_rusage(pid,0,ctypes.byref(out))==0 else None
def descendants(parent):
 rows=subprocess.check_output(['ps','-Ao','pid=,ppid='],text=True).splitlines()
 pairs=[tuple(map(int,r.split())) for r in rows];ids={parent}
 while True:
  before=len(ids);ids.update(pid for pid,ppid in pairs if ppid in ids)
  if len(ids)==before:return ids
class Monitor:
 def __init__(self,pid,limit=8*1024**3):
  self.pid=pid;self.limit=limit;self.stop=threading.Event();self.samples=[];self.failure=None
  self.thread=threading.Thread(target=self.run,daemon=True);self.thread.start()
 def run(self):
  while not self.stop.wait(.25):
   ids=descendants(self.pid);values=[u for pid in ids if (u:=usage(pid))]
   point={'time':time.monotonic(),'rss':sum(x['rss'] for x in values),'footprint':sum(x['footprint'] for x in values)}
   self.samples.append(point)
   if point['footprint']>self.limit:
    self.failure=f"process tree footprint exceeded {self.limit} bytes"
    for pid in ids:
     try:os.kill(pid,signal.SIGTERM)
     except ProcessLookupError:pass
    return
 def finish(self):
  self.stop.set();self.thread.join()
  return {'peak_rss':max((x['rss'] for x in self.samples),default=0),'peak_footprint':max((x['footprint'] for x in self.samples),default=0),'failure':self.failure,'samples':self.samples}
