import os
import subprocess
import time

keys = 'PATH HOME USER LOGNAME SHELL TERM LANG LC_ALL LC_CTYPE TMPDIR TMP TEMP SystemRoot WINDIR PATHEXT COMSPEC USERPROFILE APPDATA LOCALAPPDATA CARGO_HOME RUSTUP_HOME JAVA_HOME GOPATH'.lower().split()
program = os.path.join(os.environ['SystemRoot'], 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
script = "$s=[Diagnostics.Stopwatch]::StartNew(); [Console]::WriteLine('engine-ready'); Write-Output 'output-ready'; [Console]::WriteLine('output-ms='+$s.ElapsedMilliseconds); Set-Content started yes; [Console]::WriteLine('write-ms='+$s.ElapsedMilliseconds)"
for name, env in [('filtered', {k:v for k,v in os.environ.items() if k.lower() in keys}), ('full', os.environ.copy())]:
    start = time.monotonic()
    result = subprocess.run([program, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], env=env, cwd=os.path.dirname(__file__), capture_output=True, timeout=30)
    print(name, time.monotonic()-start, result.returncode, result.stdout.decode(errors='replace'), result.stderr.decode(errors='replace'), flush=True)
