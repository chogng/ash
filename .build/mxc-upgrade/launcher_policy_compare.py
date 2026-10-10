import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

baseline = '''(version 1)
(deny default)
(allow process-fork process-exec)
(allow signal (target same-sandbox))
(allow sysctl-read file-read-metadata)
(allow mach-lookup
 (global-name "com.apple.system.notification_center")
 (global-name "com.apple.system.logger")
 (global-name "com.apple.distributed_notifications@Uv3")
 (global-name "com.apple.CoreServices.coreservicesd")
 (global-name "com.apple.FSEvents"))
(allow file-read* (subpath "/"))
(allow file-read* file-write* (literal "/dev/null") (literal "/dev/zero")
 (literal "/dev/random") (literal "/dev/urandom"))
(allow file-read* (subpath "/dev/fd"))
(allow file-read* file-write* file-ioctl (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))
(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd")
 (global-name "com.apple.windowserver.active") (global-name "com.apple.windowserver.session"))
(deny system-fcntl (fcntl-command 80 110))
'''
mapdb = '(allow mach-lookup (global-name "com.apple.lsd.mapdb"))\n'
process = '(allow process-info* (target same-sandbox))\n'
libinfo = '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))\n'
dirhelper = '(allow mach-lookup (global-name "com.apple.bsd.dirhelper"))\n'
cases = [('baseline', ''), ('dirhelper', dirhelper), ('dirhelper+libinfo', dirhelper + libinfo),
         ('dirhelper+mapdb', dirhelper + mapdb)]
programs = [['/usr/bin/python3', '-c', "import sys; assert sys.stdin.buffer.read() == b''; print('python-started')"],
            ['/usr/bin/git', '--version'], ['/usr/bin/xcrun', '--find', 'python3']]
allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
           'CARGO_HOME', 'RUSTUP_HOME', 'JAVA_HOME', 'GOPATH']
environment = {key: os.environ[key] for key in allowed if key in os.environ}
for name, additions in cases:
    for program in programs:
        with tempfile.TemporaryDirectory(prefix='ash-launcher-compare-') as root:
            root = str(Path(root).resolve())
            profile = baseline + additions + '(allow file-read* file-write* network-bind network-outbound (subpath "' + root + '"))\n'
            env = dict(environment, TMPDIR=root, TMP=root, TEMP=root)
            start = time.monotonic()
            child = subprocess.Popen(['/usr/bin/sandbox-exec', '-p', profile, *program], cwd=root,
                env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                start_new_session=True)
            try:
                out, err = child.communicate(timeout=8)
                status = child.returncode
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                out, err = child.communicate()
                status = 'timeout'
            print(name, program[0], f'{time.monotonic()-start:.3f}s', status,
                  'cache=', Path(root, 'xcrun_db').exists(), repr(out[:512]), repr(err[:512]), flush=True)
