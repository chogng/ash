"""Prepare external build inputs for one selected Cargo dependency graph."""

import os
from collections.abc import Mapping
from pathlib import Path

from build.lib.grammars import resolve_grammars_cargo_env
from build.lib.sherpa import resolve_sherpa_cargo_env
from build.lib.targets import TargetSpec
from build.lib.v8 import DEFAULT_CACHE as DEFAULT_V8_CACHE
from build.lib.v8 import DEFAULT_LOCK as DEFAULT_V8_LOCK
from build.lib.v8 import resolve_v8_cargo_env


def cargo_environment(
    spec: TargetSpec,
    packages: set[str],
    *,
    environ: Mapping[str, str] | None = None,
    v8_lock_path: Path = DEFAULT_V8_LOCK,
    v8_cache_root: Path = DEFAULT_V8_CACHE,
) -> dict[str, str]:
    """Copy the caller's environment and prepare the graph's required resources.

    Callers also include dependencies of any helper executable they build outside
    the selected graph. Protocol generation stays outside Cargo's build lock in
    the owning entrypoint; this function only prepares external link inputs.
    """
    environment = dict(os.environ if environ is None else environ)
    if "ash-grammars" in packages:
        environment.update(resolve_grammars_cargo_env(spec.target))
    if "v8" in packages:
        environment.update(
            resolve_v8_cargo_env(
                spec,
                environ=environment,
                lock_path=v8_lock_path,
                cache_root=v8_cache_root,
            )
        )
    if "sherpa-onnx-sys" in packages:
        environment.update(resolve_sherpa_cargo_env(spec, environ=environment))
    return environment
