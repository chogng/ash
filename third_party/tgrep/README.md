# tgrep runtime

Ash builds tgrep 1.0.12-ash.1 from the fixed upstream source archive and shared-worktree service patch in `runtime-lock.json`. The upstream commit is `ad8fffa01de96c8b3ce2505a306f8a255c1f4bfb`; the patch owns Ash's repository-scoped service protocol.

- Source and patch SHA-256 values are checked before applying or compiling. Cargo uses `--locked`; build caches are keyed by source, patch, toolchain and target and verify the resulting binary digest.
- Development, release and Remote packages use the same resolver. Builds require Rust and Git; searches do not download or compile the runtime.
- Packages retain `ash-resources/tgrep/tgrep[.exe]` and the upstream MIT license.
- `ash-tgrep` supervises the service and registers independent worktrees. Search correctness, base generations, admission and delta checkpoints belong to tgrep.
- To update the source, create `source.tar.gz` with `git archive` at the new exact upstream commit, update `shared-worktrees.patch`, refresh both lock digests, and verify the source build and real-engine integration tests. The archive is a source snapshot, not a platform executable.
