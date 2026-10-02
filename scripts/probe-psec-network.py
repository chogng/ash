"""Record PSEC network prerequisites, without declaring Managed support.

A successful PSEC 1.0 execution does not establish independent ingress policy.
The ABI and NetworkIngress bit follow MXC's pinned process_container secenv.rs.
No environment or process is created by this inventory.
"""
import ctypes
import json
import sys
from ctypes import wintypes
from pathlib import Path


def inventory():
    report = {"scope": "PSEC network API inventory; no Managed qualification"}
    try:
        api = ctypes.WinDLL("processmodel.dll", winmode=0x800, use_last_error=True)
    except FileNotFoundError as error:
        report.update(status="unsupported-api", error=str(error))
        return report
    except OSError as error:
        report.update(status="failed", winerror=error.winerror, error=str(error))
        return report
    try:
        version = api.IsProcessSecurityEnvironmentVersionSupported
        support = api.QueryProcessSecurityEnvironmentSupport
    except AttributeError as error:
        report.update(status="unsupported-api", error=str(error))
        return report
    version.argtypes = [wintypes.DWORD, ctypes.POINTER(ctypes.c_ubyte),
                        ctypes.POINTER(wintypes.DWORD)]
    version.restype = ctypes.c_long
    support.argtypes = [ctypes.POINTER(ctypes.c_uint64)]
    support.restype = ctypes.c_long
    available, minor = ctypes.c_ubyte(), wintypes.DWORD()
    version_result = version(1, ctypes.byref(available), ctypes.byref(minor))
    flags = ctypes.c_uint64()
    support_result = support(ctypes.byref(flags))
    report.update(version={"hresult": hex(version_result & 0xffffffff),
                           "available": bool(available.value), "major": 1,
                           "minor": minor.value},
                  support={"hresult": hex(support_result & 0xffffffff),
                           "flags": hex(flags.value),
                           "networkIngress": bool(flags.value & 0x8)})
    if version_result < 0 or support_result < 0:
        report["status"] = "failed"
    else:
        report["status"] = ("advertised-ingress-api" if available.value and
                            minor.value >= 1 and flags.value & 0x8 else "unsupported-ingress-api")
    return report


if __name__ == "__main__":
    output = Path(__file__).resolve().parent.parent / ".build/acceptance/psec-network"
    output.mkdir(parents=True, exist_ok=True)
    report = inventory()
    (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))
    sys.exit(1 if report["status"] == "failed" else 0)
