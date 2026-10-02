"""Explore PSEC 1.1 network forms; this does not enable product support.

Wire layout follows the pinned Microsoft ProcessSecurityEnvironment.fbs.
Every environment and process is owned by this probe and closed in finally.
"""
import ctypes
import json
import os
import socket
import sys
import threading
import time
from ctypes import wintypes as w
from pathlib import Path

output = Path(__file__).resolve().parent.parent / '.build/acceptance/psec-network'
sys.path.insert(0, str(output / 'python-deps'))
import flatbuffers

root = output
root.mkdir(parents=True, exist_ok=True)

def specification(mode, port, work):
    b = flatbuffers.Builder(1024)
    def table(count, fields):
        b.StartObject(count)
        for index, value in fields:
            b.PrependUOffsetTRelativeSlot(index, value, 0)
        return b.EndObject()
    def vector(values):
        b.StartVector(4, len(values), 4)
        for value in reversed(values):
            b.PrependUOffsetTRelative(value)
        return b.EndVector()
    def strings(values):
        return vector([b.CreateString(value) for value in values])
    rw = strings([str(work)])
    ro = strings([os.environ['SystemRoot']])
    proxy = 0
    if mode.startswith('proxy'):
        proxy = table(1, [(0, b.CreateString(f'http://127.0.0.1:{port}'))])
    egress = 0
    if mode.startswith('direct'):
        address = b.CreateString('127.0.0.1')
        b.StartObject(2)
        b.PrependUOffsetTRelativeSlot(0, address, 0)
        b.PrependUint8Slot(1, 32, 0)
        subnet = b.EndObject()
        destination = table(2, [(0, subnet)])
        b.StartObject(3)
        b.PrependInt8Slot(0, 1, 0)  # TCP
        b.PrependUint16Slot(1, port, 0)
        port_rule = b.EndObject()
        destinations = vector([destination])
        ports = vector([port_rule])
        rule = table(2, [(0, destinations), (1, ports)])
        egress = table(3, [(1, vector([rule]))])
    elif mode == 'denied_control':
        egress = table(3, [])
    ingress = table(2, []) if mode != 'proxy_control' else 0
    peer = b.CreateString('MXC-Loopback') if mode != 'denied_control' else 0
    network = table(4, [(slot, value) for slot, value in
                          [(0, proxy), (1, egress), (2, peer), (3, ingress)] if value])
    capabilities = 'registryRead'
    if mode != 'denied_control':
        capabilities += ',privateNetworkClientServer,networkLoopback,internetClient'
    caps = b.CreateString(capabilities)
    b.StartObject(9)
    b.PrependUint64Slot(3, 0x9e, 0)
    for slot, value in [(1, caps), (4, rw), (5, ro), (7, network)]:
        b.PrependUOffsetTRelativeSlot(slot, value, 0)
    b.Prep(2, 4)
    b.PrependUint16(1)
    b.PrependUint16(1)
    b.PrependStructSlot(0, b.Offset(), 0)
    spec = b.EndObject()
    b.Finish(spec, file_identifier=b'PSEC')
    return bytes(b.Output())

class Startup(ctypes.Structure):
    _fields_ = [('cb', w.DWORD), ('reserved', w.LPWSTR), ('desktop', w.LPWSTR),
                ('title', w.LPWSTR), ('x', w.DWORD), ('y', w.DWORD),
                ('width', w.DWORD), ('height', w.DWORD), ('chars_x', w.DWORD),
                ('chars_y', w.DWORD), ('fill', w.DWORD), ('flags', w.DWORD),
                ('show', w.WORD), ('reserved_size', w.WORD),
                ('reserved_data', ctypes.c_void_p), ('stdin', w.HANDLE),
                ('stdout', w.HANDLE), ('stderr', w.HANDLE)]
class ExtendedStartup(ctypes.Structure):
    _fields_ = [('startup', Startup), ('attributes', ctypes.c_void_p)]
class ProcessInfo(ctypes.Structure):
    _fields_ = [('process', w.HANDLE), ('thread', w.HANDLE), ('pid', w.DWORD), ('tid', w.DWORD)]

kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_size_t)]
kernel.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, w.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
kernel.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
kernel.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL, w.DWORD, ctypes.c_void_p, w.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(ProcessInfo)]
kernel.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
kernel.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
kernel.TerminateProcess.argtypes = [w.HANDLE, w.UINT]
kernel.CloseHandle.argtypes = [w.HANDLE]

def launch(environment, work, script):
    size = ctypes.c_size_t()
    kernel.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
    attributes = ctypes.create_string_buffer(size.value)
    assert kernel.InitializeProcThreadAttributeList(attributes, 1, 0, ctypes.byref(size)), ctypes.get_last_error()
    info = ProcessInfo()
    try:
        value = w.HANDLE(environment)
        assert kernel.UpdateProcThreadAttribute(attributes, 0, 35 | 0x20000, ctypes.byref(value), ctypes.sizeof(value), None, None), ctypes.get_last_error()
        startup = ExtendedStartup()
        startup.startup.cb = ctypes.sizeof(startup)
        startup.attributes = ctypes.cast(attributes, ctypes.c_void_p)
        program = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
        command = ctypes.create_unicode_buffer(f'"{program}" -NoLogo -NoProfile -NonInteractive -File "{script}"')
        variables = {'SYSTEMROOT': os.environ['SystemRoot'], 'LOCALAPPDATA': str(work), 'TEMP': str(work)}
        block = ctypes.create_unicode_buffer('\0'.join(f'{k}={v}' for k, v in sorted(variables.items())) + '\0\0')
        assert kernel.CreateProcessW(str(program), command, None, None, False, 0x80000 | 0x400 | 0x8000000, block, str(work), ctypes.byref(startup), ctypes.byref(info)), ctypes.get_last_error()
        kernel.CloseHandle(info.thread)
        return info
    finally:
        kernel.DeleteProcThreadAttributeList(attributes)

class Endpoint:
    def __init__(self, family=socket.AF_INET):
        self.socket = socket.socket(family)
        self.socket.bind(('127.0.0.1' if family == socket.AF_INET else '::1', 0))
        self.socket.listen()
        self.socket.settimeout(.2)
        self.port = self.socket.getsockname()[1]
        self.connections = 0
        self.running = True
        def serve():
            while self.running:
                try:
                    stream, _ = self.socket.accept()
                    self.connections += 1
                    with stream:
                        stream.settimeout(2)
                        stream.recv(4096)
                        stream.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nproxy-ok')
                except (OSError, TimeoutError):
                    pass
        self.thread = threading.Thread(target=serve, daemon=True)
        self.thread.start()
    def close(self):
        self.running = False
        self.socket.close()
        self.thread.join(3)

report = {'kind': 'PSEC 1.1 diagnostic; no product qualification', 'cases': []}
try:
    api = ctypes.WinDLL('processmodel.dll', use_last_error=True)
    create = api.CreateProcessSecurityEnvironment
    create.argtypes = [ctypes.c_void_p, w.DWORD, w.DWORD, ctypes.POINTER(w.HANDLE)]
    create.restype = ctypes.c_long
    close = api.CloseProcessSecurityEnvironment
    close.argtypes = [w.HANDLE]
    available, minor = ctypes.c_ubyte(), w.DWORD()
    query = api.IsProcessSecurityEnvironmentVersionSupported
    query.argtypes = [w.DWORD, ctypes.POINTER(ctypes.c_ubyte), ctypes.POINTER(w.DWORD)]
    status = query(1, ctypes.byref(available), ctypes.byref(minor))
    report['version'] = {'hresult': hex(status & 0xffffffff), 'available': available.value, 'minor': minor.value}
    if status or not available.value or minor.value < 1:
        report['status'] = 'unsupported-host'
    else:
        endpoints = [Endpoint(), Endpoint(), Endpoint(socket.AF_INET6)]
        try:
            for mode in ('denied_control', 'proxy_control', 'proxy_strict', 'direct_strict'):
                work = root / mode
                work.mkdir(exist_ok=True)
                script = work / 'probe.ps1'
                script.write_text('''$ErrorActionPreference='Stop'
function Connect($hostName,$port) {
    $family=if ($hostName.Contains(':')) { [Net.Sockets.AddressFamily]::InterNetworkV6 } else { [Net.Sockets.AddressFamily]::InterNetwork }
    $client=[Net.Sockets.TcpClient]::new($family)
    try { $task=$client.ConnectAsync($hostName,$port); if (!$task.Wait(1500)) { return $false }; return $client.Connected }
    catch { return $false } finally { $client.Dispose() }
}
$results=@{}
''' + f"$results.proxy=Connect '127.0.0.1' {endpoints[0].port}\n$results.otherPort=Connect '127.0.0.1' {endpoints[1].port}\n$results.ipv6=Connect '::1' {endpoints[2].port}\n" + "[IO.File]::WriteAllText((Join-Path $PWD 'result.json'),($results|ConvertTo-Json)); exit 125\n", encoding='utf-8-sig')
                blob = specification(mode, endpoints[0].port, work)
                (work / 'spec.psec').write_bytes(blob)
                environment = w.HANDLE()
                result = {'mode': mode, 'hresult': hex(create(blob, len(blob), 0, ctypes.byref(environment)) & 0xffffffff)}
                report['cases'].append(result)
                if environment:
                    process = None
                    before = [endpoint.connections for endpoint in endpoints]
                    try:
                        started = time.monotonic()
                        process = launch(environment.value, work, script)
                        wait = kernel.WaitForSingleObject(process.process, 30000)
                        code = w.DWORD()
                        assert kernel.GetExitCodeProcess(process.process, ctypes.byref(code)), ctypes.get_last_error()
                        result.update({'wait': wait, 'exitCode': code.value, 'elapsedMs': round((time.monotonic()-started)*1000)})
                        if (work / 'result.json').exists():
                            result['traffic'] = json.loads((work / 'result.json').read_text(encoding='utf-8-sig'))
                        result['hostConnections'] = [endpoint.connections - count for endpoint, count in zip(endpoints, before)]
                    except Exception as error:
                        result['error'] = str(error)
                    finally:
                        if process:
                            kernel.TerminateProcess(process.process, 1)
                            kernel.WaitForSingleObject(process.process, 5000)
                            kernel.CloseHandle(process.process)
                        close(environment)
                (root / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        finally:
            for endpoint in endpoints:
                endpoint.close()
        report['status'] = 'diagnostics-complete'
except (OSError, AttributeError) as error:
    report.update({'status': 'unsupported-api', 'error': str(error)})
finally:
    (root / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))
