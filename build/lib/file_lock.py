"""Exclusive file leases shared by build publication and source compilation."""

import os
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def exclusive_lock(path: Path, *, create: bool = False, blocking: bool = True):
    """Use the same OS locks as ash-package-store's fs2 process leases."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class Overlapped(ctypes.Structure):
            _fields_ = [
                ("internal", ctypes.c_size_t),
                ("internal_high", ctypes.c_size_t),
                ("offset", wintypes.DWORD),
                ("offset_high", wintypes.DWORD),
                ("event", wintypes.HANDLE),
            ]

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateFileW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.c_void_p,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.HANDLE,
        ]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.LockFileEx.argtypes = [
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.POINTER(Overlapped),
        ]
        kernel.LockFileEx.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        # Share deletion so cleanup can remove a directory while holding its lease.
        handle = kernel.CreateFileW(
            str(path), 0xC0000000, 0x7, None, 4 if create else 3, 0x80, None
        )
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            overlapped = Overlapped()
            locked = kernel.LockFileEx(
                handle,
                2 | (0 if blocking else 1),
                0,
                0xFFFFFFFF,
                0xFFFFFFFF,
                ctypes.byref(overlapped),
            )
            if not locked:
                error = ctypes.get_last_error()
                if blocking or error != 33:  # ERROR_LOCK_VIOLATION
                    raise ctypes.WinError(error)
            yield bool(locked)
        finally:
            kernel.CloseHandle(handle)
    else:
        import fcntl

        with path.open("a+b" if create else "r+b") as file:
            try:
                fcntl.flock(file, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            except BlockingIOError:
                yield False
            else:
                yield True
