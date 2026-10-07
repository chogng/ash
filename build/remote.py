#!/usr/bin/env python3
"""Build the Remote distribution declared by remote/package.json."""

import json
import sys
from pathlib import Path
from typing import Optional, Sequence

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from build.app_server import build_package, parse_arguments  # noqa: E402
from build.lib.targets import TARGETS, default_target  # noqa: E402


def main(arguments: Optional[Sequence[str]] = None) -> int:
    args = parse_arguments(arguments)
    configuration = json.loads(
        (ROOT / "remote/package.json").read_text(encoding="utf-8")
    )["ash"]
    targets = configuration["targets"]
    if (
        configuration["javascriptRuntime"] != "packaged-node"
        or not isinstance(targets, list)
        or not targets
        or any(
            not isinstance(target, str)
            or target not in TARGETS
            or TARGETS[target].is_windows
            for target in targets
        )
        or len(set(targets)) != len(targets)
    ):
        raise ValueError(
            "Remote packages require packaged Node and unique supported POSIX targets"
        )
    args.target = args.target or default_target()
    if args.target not in targets:
        raise ValueError(f"Remote package target is not supported: {args.target}")
    if args.javascript_runtime != configuration["javascriptRuntime"]:
        raise ValueError("Remote packages must include the packaged Node runtime")
    return build_package(args)


if __name__ == "__main__":
    raise SystemExit(main())
