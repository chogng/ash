# tgrep runtime

Ash builds tgrep 1.0.12-ash.e9d55db.1 from upstream commit `e9d55dbbf232f0e228695f15a640cf207d4b3348`, after v1.0.11 and before the official v1.0.12 release. [`runtime-lock.json`](runtime-lock.json) fixes the source archive and [`ash-runtime.patch`](ash-runtime.patch) by SHA-256. Keep this commit fixed until v1.0.12 is released, then review its source and protocol differences before updating.

- Source and patch SHA-256 values are checked before applying or compiling. Cargo uses `--locked`; build caches are keyed by source, patch, toolchain and target and verify the resulting binary digest.
- Compilation uses a temporary source and target directory, removed on success or failure. The cache retains only the executable, its digest manifest and the build lock. Reusing a verified executable also removes its legacy compiler target directory under the same lock.
- Development, release and Remote packages use the same resolver. Builds require Rust and Git; searches do not download or compile the runtime.
- Packages retain `ash-resources/tgrep/tgrep[.exe]` and the upstream MIT license.
- `ash-tgrep` supervises upstream `serve --shared` and owns each worktree lease. Ordinary directories, unborn repositories and directory subroots use upstream single-directory `serve`. Search correctness, base generations, admission, watchers and delta checkpoints belong to tgrep.
- The Ash patch supplies the packaging version, `identity` command, path-ordered global `max_results` (1–5001), a shared status file count, consistent candidate statistics and error code `-32002` for invalidated/not-ready snapshots. Permanent shared errors retain `-32001`. Ash reconciles only the readiness errors within the original request deadline.
- The patch contains no shared-service implementation. Upstream source changes are made only in Ash's temporary build inputs; the sibling tgrep checkout is read-only.
- To update the source, create `source.tar.gz` with `git archive` at the new exact upstream commit, update `ash-runtime.patch`, refresh both lock digests, and verify the source build and real-engine integration tests. The archive is a source snapshot, not a platform executable.
