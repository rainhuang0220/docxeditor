"""Frozen desktop backend entry. PyInstaller runs this file, not uvicorn."""

from __future__ import annotations

import multiprocessing
import os
import sys


def _fix_macos_framework_lookup() -> None:
    """PyInstaller sets DYLD_LIBRARY_PATH, which makes find_library miss Security.framework."""
    if sys.platform != "darwin":
        return
    import ctypes.util

    original = ctypes.util.find_library

    def find_library(name: str):
        if name in {"Security", "CoreFoundation"}:
            path = f"/System/Library/Frameworks/{name}.framework/{name}"
            if os.path.exists(path):
                return path
        return original(name)

    ctypes.util.find_library = find_library


if __name__ == "__main__":
    multiprocessing.freeze_support()
    _fix_macos_framework_lookup()
    from backend.desktop_runtime import main

    main()
