# ash-text-file

1. 在 App 进程内持有 UTF-8 文件的保存基线、磁盘版本和待处理外部快照。
2. 根据编辑器当前文本判断 dirty、reload 和冲突，生成带磁盘版本条件的保存请求。
3. 由 EditorHost 和 Workbench 消费；文本编辑由编辑器负责，实际读写由文件能力执行。

Cross-crate placement and product composition are documented in
[`docs/ash-rs-architecture.md`](../../docs/ash-rs-architecture.md); this README owns the implementation contract.

## Ownership

| Concern | Owner | Status |
| --- | --- | --- |
| Saved text baseline, disk version and read-only state | `TextFileLifecycle` | ✅ |
| Dirty/reload/conflict classification | `TextFileLifecycle::status` | ✅ |
| Optimistic save and explicit conflict-overwrite payloads | `TextFileLifecycle::save_request` / `overwrite_request` | ✅ |
| Pending external snapshot reconciliation | `TextFileLifecycle::observe_external` | ✅ |
| Mutable document, caret, selection, syntax and folding | Editor implementation | 委托 |
| Filesystem reads, metadata validation and writes | Host filesystem adapter | 委托 |
| Tabs, active document, close confirmation and rendering | Product host | 委托 |

The crate has no dependency on `ash-editor`, Native, App Server, or a filesystem executor. Adding
one of those dependencies would be architectural drift.

## Public contract and execution path

`TextFileSnapshot` binds directory-relative path, UTF-8 content and `TextFileDiskVersion` captured
by a host read. `TextFileLifecycle::new` retains that content only as the saved baseline; the host
keeps authoritative mutable editor text and supplies it to lifecycle operations.

```text
filesystem adapter → TextFileSnapshot
                   → host creates editor document + TextFileLifecycle
editor text        → status / save_request
external read      → observe_external → synchronized or pending reload
user keeps editor  → overwrite_request using the observed external version
successful write   → mark_saved
host-approved load → take_pending_external
```

`TextFileSaveRequest` contains the expected disk version. Ordinary saves use the last saved version;
`overwrite_request` is only available for dirty text with a pending external snapshot and uses that
observed external version. The adapter must compare the expected version with current
metadata before writing and report a mismatch. This is only a preflight unless the backend offers an
atomic compare-and-swap write, so adapters must not present it as a stronger guarantee. The crate
performs no I/O and therefore has no transport errors. A snapshot for another path returns
`TextFileObserveResult::PathMismatch` without changing retained state.

## Integration obligations

- Construct a snapshot from content and metadata belonging to the same logical read.
- Keep paths in the directory-relative identity form selected by the host; the crate compares them
  lexically and does not canonicalize or authorize them.
- Do not mutate the editor document when merely observing an external snapshot. Reload is an explicit
  host decision using `take_pending_external`.
- Call `overwrite_request` only after an explicit user decision to keep editor text. It remains an
  optimistic write and must fail if the file changed again.
- Call `mark_saved` only after a successful write and pass the metadata returned for that write.

## Tests and modification impact

Run `just check ash-text-file --locked`, `just test ash-text-file --locked`, and
`just rust-warnings ash-text-file --locked`. `lifecycle_tests.rs` covers dirty/save state, explicit optimistic
overwrite, read-only behavior, reload/conflict classification, baseline synchronization and path
mismatch rejection.

Changes to disk-version equality require matching adapter preflight tests. Changes to status rules
require host presentation and close-safety tests. Adding binary data, encoding detection, merge logic,
autosave or durable recovery is future work and must not be documented as current behavior.
