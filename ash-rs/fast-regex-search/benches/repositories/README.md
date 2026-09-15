# Real repository evaluation

These macOS harnesses exercise the real worker protocol and tgrep TCP server. They require Python 3.9+, Rust, ripgrep, a release tgrep binary, and local writable storage. They do not edit the source checkouts. All mutation tests run on a disposable APFS clone under `EVAL_ROOT/corpora/combined`.

## Freeze the corpus

Set `EVAL_ROOT` to a new result directory and `CHECKOUT_ROOT` to the parent of local `ash`, `vscode`, `zed`, and `codex` checkouts. Create `downloads`, `manifests`, `queries`, and `bin` below `EVAL_ROOT`.

Download official source archives into `downloads`: `linux-v6.16.tar.gz` from `https://codeload.github.com/torvalds/linux/tar.gz/refs/tags/v6.16`, `rust-1.89.0.tar.gz` from `https://codeload.github.com/rust-lang/rust/tar.gz/refs/tags/1.89.0`, and `kubernetes-v1.34.0.tar.gz` from `https://codeload.github.com/kubernetes/kubernetes/tar.gz/refs/tags/v1.34.0`. The preparation script records archive digests and local commits.

Run `python3 prepare.py ash vscode zed codex linux rust kubernetes` from this directory. It exports non-hidden regular UTF-8 files, excludes NUL-containing content and files above 16 MiB, retains vendor/test code, removes ignore-control files, and emits a content-hashed manifest plus deterministic real identifiers and regex queries. Case-colliding archive paths are relocated with their original name recorded. This is a common text corpus, not a benchmark of each tool's default ignore policy. Delete an existing manifest only when intentionally preparing a new corpus: preparation otherwise leaves it untouched.

## Build and run

From the Ash root, run `cargo bench -p ash-fast-regex-search --no-run`. Set `ASH_DEPS` if using a nondefault Cargo target directory. Back in this directory, run `python3 build_tools.py final` and copy a separately built tgrep release binary to `$EVAL_ROOT/bin/tgrep`. Record tool versions, executable hashes, source revisions, and local source changes alongside the result.

For the initial coverage run use `LABEL=trigram RUNS=3 python3 run.py ash vscode zed codex linux rust kubernetes`. tgrep rejects some text files by binary-looking extension; `--files` alone does not prove identical content eligibility. Preserve these coverage differences. Then set `TG_CHECKOUT` to the exact tgrep checkout and run `python3 common.py` once in a fresh result directory. It removes only those extension-filtered paths from disposable clones, records them, and creates the combined stress tree.

For sequential common-corpus timing use `CORPUS_ROOT="$EVAL_ROOT/common-corpora" MANIFEST_ROOT="$EVAL_ROOT/common-manifests" LABEL=final RUNS=7 python3 run.py ash vscode zed codex linux rust kubernetes`. `QUERY_NAMES` can select a comma-separated, predeclared category subset for repeated timings after the full correctness round. Keep performance runs sequential; record competing host load rather than calling a busy machine isolated. Failed builds retain memory samples and stderr.

`run.py` compares complete results to rg and checks every limited result against that reference. CRLF trailing-CR presentation is normalized separately from the exact-text digest. Ash complete worker output and 100-result requests are distinct; tgrep RPC returns complete results. `rg_100` stops after reading the 101st line. Timed Ash requests include Rust UDS JSON work; timed tgrep RPC includes Python TCP JSON work; rg includes process startup. These are client-path comparisons, not pure engine latency rankings. Small-result concurrency tests use Rust clients for both indexed engines.

Large complete responses can exceed Ash's 32 MiB worker response cap. Record them as unsupported complete results and omit their timing, while independently checking the 100-result request. Never count an error as a fast answer. For Linux patterns above 200,000 matching lines, the harness applies a predeclared full-output resource budget after the recorded 8 GiB stress failure: it streams an rg reference to validate every returned 100-result row and records full-output timings as not run. These cases remain in the report; they are not wins or correctness passes for complete output. A p95 from three samples is descriptive only; use the longer stress series for tails.

## Algorithm control and stress

`cargo bench -p ash-fast-regex-search --bench algorithms -- "$EVAL_ROOT" linux` compares sparse covering, all sparse grams, plain trigrams, and masked trigrams using the same HIR plan and files. It verifies candidate retention against per-line regex matches. The trigram timing includes conversion to a BTreeMap for this harness; use end-to-end builds to evaluate implementation speed. Full vocabulary counting deliberately allocates memory proportional to distinct grams and is separate from production memory measurements.

`common.py` prepares the combined stress tree and manifest. Run the full trigram coverage first (the stress selector reads `trigram/linux/results.json`), then `python3 build_tools.py stress` and `python3 stress.py`. It exercises 1–32 concurrent requests, 1/100/1,000 real-file updates, create/rename/delete, restoration, reconciliation, reopen, and interrupted-rebuild recovery. A `finally` block restores modified contents; use a disposable clone regardless.

`memory.py` samples process trees every 250 ms with macOS `proc_pid_rusage`, records RSS and physical footprint (including compressed/swapped private pages), and stops only the monitored tree at 8 GiB footprint. This is a sampled guard, not an exact peak or a machine power-loss test. OS file caches are not purged.
