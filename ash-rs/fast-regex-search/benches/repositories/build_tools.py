import os,pathlib,subprocess,sys
BASE=pathlib.Path(os.environ['EVAL_ROOT']).resolve()
SOURCE=pathlib.Path(__file__).resolve().parent
ASH=pathlib.Path(os.environ.get('ASH_DEPS',str(SOURCE.parents[3]/'.build/cargo/release/deps')))
mode=sys.argv[1]
source=SOURCE/('stress.rs' if mode=='stress' else 'runner.rs')
output=BASE/'bin'/('ash-'+mode)
output.parent.mkdir(parents=True,exist_ok=True)
deps=[('ash_fast_regex_search',ASH),('ash_file_access',ASH),('serde_json',ASH)]
cmd=['rustc','--edition=2024','-O',str(source),'-L','dependency='+str(ASH),'-o',str(output)]
for name,directory in deps:
 lib=max(directory.glob('lib'+name+'-*.rlib'),key=lambda p:p.stat().st_mtime)
 cmd+=['--extern',name+'='+str(lib)]
subprocess.run(cmd,check=True,cwd=SOURCE.parents[3])
