use ash_fast_regex_search::FastRegexCaseSensitivity;
use ash_fast_regex_search::FastRegexPattern;
use ash_fast_regex_search::FastRegexQuery;
use ash_fast_regex_search::FastRegexSearchLimits;
use ash_fast_regex_search::FastRegexWorkerClient;
use ash_fast_regex_search::FastRegexWorkerCommand;
use ash_fast_regex_search::serve_worker_from_environment;
use ash_file_access::Dir;
use std::collections::BTreeSet;
use std::fs;
use std::hint::black_box;
use std::io::BufRead;
use std::io::BufReader;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;
use tempfile::TempDir;

const DEFAULT_FILE_COUNT: usize = 8_000;
const DEFAULT_RUN_COUNT: usize = 15;
const AGENT_RESULT_LIMIT: usize = 100;

#[derive(Clone, Copy)]
struct BenchmarkCase {
    name: &'static str,
    pattern: &'static str,
}

struct Measurement {
    source: &'static str,
    name: &'static str,
    mode: &'static str,
    candidates: usize,
    matches: usize,
    fast_p50: Duration,
    fast_p95: Duration,
    rg_p50: Duration,
    rg_p95: Duration,
}

struct RipgrepResult {
    rows: BTreeSet<(PathBuf, usize, String)>,
    limit_hit: bool,
}

struct IndexFileSizes {
    documents_bytes: u64,
    lookup_bytes: u64,
    postings_bytes: u64,
    delta_bytes: u64,
    published_index_bytes: u64,
    pending_generation_bytes: u64,
    peak_rebuild_disk_bytes: u64,
}

fn main() {
    let arguments = std::env::args().collect::<Vec<_>>();
    if arguments
        .iter()
        .any(|argument| argument == "--fast-regex-worker")
    {
        serve_worker_from_environment().expect("serve benchmark worker");
        return;
    }
    let require_faster = arguments
        .iter()
        .any(|argument| argument == "--require-faster");
    let file_count = environment_usize("FAST_REGEX_BENCH_FILES", DEFAULT_FILE_COUNT);
    let run_count = environment_usize("FAST_REGEX_BENCH_RUNS", DEFAULT_RUN_COUNT);
    let rg = std::env::var_os("RG").unwrap_or_else(|| "rg".into());
    let corpus = build_corpus(file_count);
    let storage = tempfile::tempdir().expect("benchmark index storage");
    assert!(
        file_count > 0 && run_count > 0,
        "benchmark counts must be positive"
    );
    let max_results = file_count.saturating_mul(32).max(AGENT_RESULT_LIMIT);
    let limits = FastRegexSearchLimits {
        max_files: file_count + 10,
        max_results,
        max_total_source_bytes: 2 * 1024 * 1024 * 1024,
        ..FastRegexSearchLimits::default()
    };
    let root = Dir::open_local(corpus.path()).expect("benchmark corpus root");
    let worker_command = FastRegexWorkerCommand::new(
        std::env::current_exe().expect("benchmark executable"),
        ["--fast-regex-worker"],
    );
    let cold_open_started = Instant::now();
    let index = FastRegexWorkerClient::open(
        worker_command.clone(),
        &root,
        storage.path(),
        limits.clone(),
    )
    .expect("open fast regex worker");
    let cold_open_elapsed = cold_open_started.elapsed();
    let build_started = Instant::now();
    let old_index_bytes = directory_size(storage.path());
    let snapshot = index.rebuild().expect("build fast regex index");
    let build_elapsed = build_started.elapsed();
    let index_sizes = index_file_sizes(storage.path(), snapshot.generation, old_index_bytes);
    let built_parent_rss = process_rss_kib(std::process::id());
    let built_worker_rss = index.process_id().and_then(process_rss_kib);
    let cases = [
        BenchmarkCase {
            name: "rare-prefix-suffix",
            pattern: r"request_authentication_[0-9]+_token",
        },
        BenchmarkCase {
            name: "rare-alternation",
            pattern: r"(?:alpha|beta)_rare_handler",
        },
        BenchmarkCase {
            name: "rare-no-match",
            pattern: r"missing_request_dispatch_.*_completion",
        },
        BenchmarkCase {
            name: "internal-literal",
            pattern: r".*alpha_rare_handler.*",
        },
        BenchmarkCase {
            name: "unselective-short",
            pattern: r"fn",
        },
    ];
    let mut measurements = Vec::new();
    for (mode, limit) in [("full", max_results), ("100", AGENT_RESULT_LIMIT)] {
        for case in cases {
            measurements.push(measure_case(
                "built",
                &index,
                corpus.path(),
                &rg,
                limit,
                run_count,
                mode,
                case,
            ));
        }
    }

    let changed_path = corpus.path().join("src/batch-0/module-1.rs");
    let mut changed_content = fs::read_to_string(&changed_path).expect("changed benchmark source");
    changed_content.push_str("fn incremental_refresh_marker() {}\n");
    fs::write(&changed_path, changed_content).expect("update benchmark source");
    let refresh_started = Instant::now();
    index
        .refresh_observed_paths(std::slice::from_ref(&changed_path))
        .expect("benchmark incremental refresh");
    let refresh_elapsed = refresh_started.elapsed();
    drop(index);
    let reopen_started = Instant::now();
    let reopened = FastRegexWorkerClient::open(worker_command, &root, storage.path(), limits)
        .expect("reopen fast regex index");
    let reopen_elapsed = reopen_started.elapsed();
    assert_ne!(reopened.snapshot().expect("snapshot").generation, 0);
    let warm_parent_rss = process_rss_kib(std::process::id());
    let warm_worker_rss = reopened.process_id().and_then(process_rss_kib);
    for (mode, limit) in [("full", max_results), ("100", AGENT_RESULT_LIMIT)] {
        for case in cases {
            measurements.push(measure_case(
                "reopened",
                &reopened,
                corpus.path(),
                &rg,
                limit,
                run_count,
                mode,
                case,
            ));
        }
    }

    println!(
        "cold worker open: {:.3} ms; indexed {} files / {} MiB in {:.3}s",
        milliseconds(cold_open_elapsed),
        snapshot.indexed_file_count,
        snapshot.indexed_source_bytes / (1024 * 1024),
        build_elapsed.as_secs_f64(),
    );
    println!(
        "index bytes documents/lookup/postings/delta/published/pending/peak: {}/{}/{}/{}/{}/{}/{}",
        index_sizes.documents_bytes,
        index_sizes.lookup_bytes,
        index_sizes.postings_bytes,
        index_sizes.delta_bytes,
        index_sizes.published_index_bytes,
        index_sizes.pending_generation_bytes,
        index_sizes.peak_rebuild_disk_bytes,
    );
    println!(
        "one-file refresh: {:.3} ms; validated reopen: {:.3} ms",
        milliseconds(refresh_elapsed),
        milliseconds(reopen_elapsed)
    );
    println!(
        "RSS KiB after build parent/worker: {}/{}; after warm reopen parent/worker: {}/{}",
        display_rss(built_parent_rss),
        display_rss(built_worker_rss),
        display_rss(warm_parent_rss),
        display_rss(warm_worker_rss),
    );
    println!(
        "{:<9} {:<24} {:>11} {:>9} {:>11} {:>11} {:>11} {:>11} {:>9}",
        "state/mode",
        "case",
        "candidates",
        "matches",
        "fast p50",
        "fast p95",
        "rg p50",
        "rg p95",
        "ratio"
    );
    for measurement in &measurements {
        println!(
            "{:<9} {:<24} {:>11} {:>9} {:>8.3} ms {:>8.3} ms {:>8.3} ms {:>8.3} ms {:>8.2}x",
            format!("{}/{}", measurement.source, measurement.mode),
            measurement.name,
            measurement.candidates,
            measurement.matches,
            milliseconds(measurement.fast_p50),
            milliseconds(measurement.fast_p95),
            milliseconds(measurement.rg_p50),
            milliseconds(measurement.rg_p95),
            measurement.rg_p50.as_secs_f64() / measurement.fast_p50.as_secs_f64(),
        );
    }
    if require_faster {
        let failures = measurements
            .iter()
            .filter(|measurement| measurement.fast_p50 >= measurement.rg_p50)
            .map(|measurement| measurement.name)
            .collect::<Vec<_>>();
        assert!(
            failures.is_empty(),
            "fast regex did not beat rg: {}",
            failures.join(", ")
        );
    }
}

fn measure_case(
    source: &'static str,
    index: &FastRegexWorkerClient,
    root: &Path,
    rg: &std::ffi::OsStr,
    max_results: usize,
    run_count: usize,
    mode: &'static str,
    case: BenchmarkCase,
) -> Measurement {
    let query = FastRegexQuery {
        query: case.pattern.into(),
        pattern: FastRegexPattern::Regex,
        case_sensitivity: FastRegexCaseSensitivity::Sensitive,
        scope: PathBuf::new(),
        include_patterns: Vec::new(),
        exclude_patterns: Vec::new(),
        max_results,
    };
    let fast_warmup = index.search(&query).expect("fast regex warmup");
    let complete = run_rg(root, rg, case.pattern, usize::MAX);
    let fast_rows = matched_rows(&fast_warmup.matches);
    assert_eq!(
        fast_rows.len(),
        complete.rows.len().min(max_results),
        "line count differs: {}",
        case.name
    );
    assert!(
        fast_rows.is_subset(&complete.rows),
        "line contents differ: {}",
        case.name
    );
    assert_eq!(fast_warmup.limit_hit, complete.rows.len() > max_results);
    let rg_warmup = run_rg(root, rg, case.pattern, max_results);
    assert_eq!(rg_warmup.rows.len(), fast_rows.len());
    assert!(rg_warmup.rows.is_subset(&complete.rows));
    assert_eq!(rg_warmup.limit_hit, fast_warmup.limit_hit);
    let mut fast_samples = Vec::with_capacity(run_count);
    let mut rg_samples = Vec::with_capacity(run_count);
    for round in 0..run_count {
        // Alternate execution order so one backend is not always measured first.
        for fast_first in [round % 2 == 0, round % 2 != 0] {
            let started = Instant::now();
            if fast_first {
                black_box(index.search(black_box(&query)).expect("fast regex query"));
                fast_samples.push(started.elapsed());
            } else {
                black_box(run_rg(root, rg, black_box(case.pattern), max_results));
                rg_samples.push(started.elapsed());
            }
        }
    }
    Measurement {
        source,
        mode,
        name: case.name,
        candidates: fast_warmup.statistics.candidate_file_count,
        matches: fast_warmup.matches.len(),
        fast_p50: percentile(&mut fast_samples, 50),
        fast_p95: percentile(&mut fast_samples, 95),
        rg_p50: percentile(&mut rg_samples, 50),
        rg_p95: percentile(&mut rg_samples, 95),
    }
}

fn run_rg(root: &Path, rg: &std::ffi::OsStr, pattern: &str, limit: usize) -> RipgrepResult {
    let mut child = Command::new(rg)
        .current_dir(root)
        .args([
            "--no-config",
            "--no-heading",
            "--line-number",
            "--color",
            "never",
            "--",
        ])
        .arg(pattern)
        .arg(".")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("execute rg benchmark baseline");
    let stdout = child.stdout.take().expect("rg stdout");
    let mut rows = BTreeSet::new();
    let mut limit_hit = false;
    for line in BufReader::new(stdout).lines() {
        let line = line.expect("rg line");
        if rows.len() == limit {
            limit_hit = true;
            break;
        }
        let mut fields = line.splitn(3, ':');
        let path = fields.next().expect("rg path").trim_start_matches("./");
        let number = fields
            .next()
            .expect("rg line number")
            .parse()
            .expect("numeric line");
        let text = fields.next().expect("rg text").to_owned();
        rows.insert((PathBuf::from(path), number, text));
    }
    if limit_hit {
        // A global limit requires stopping the process; rg -m limits each file.
        let _ = child.kill();
    }
    let output = child.wait_with_output().expect("wait for rg");
    assert!(
        limit_hit || output.status.success() || output.status.code() == Some(1),
        "rg failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    RipgrepResult { rows, limit_hit }
}

fn matched_rows(
    matches: &[ash_fast_regex_search::FastRegexMatch],
) -> BTreeSet<(PathBuf, usize, String)> {
    matches
        .iter()
        .map(|found| (found.path.clone(), found.line_number, found.preview.clone()))
        .collect()
}

fn build_corpus(file_count: usize) -> TempDir {
    let directory = tempfile::tempdir().expect("benchmark directory");
    fs::create_dir(directory.path().join(".git")).expect("git marker");
    for file_index in 0..file_count {
        let relative = PathBuf::from(format!(
            "src/batch-{}/module-{file_index}.rs",
            file_index / 100
        ));
        let absolute = directory.path().join(relative);
        fs::create_dir_all(absolute.parent().expect("module parent")).expect("module directory");
        let mut content = String::with_capacity(2_048);
        for line_index in 0..24 {
            if line_index == 0 {
                content.push_str(&format!(
                    "fn common_request_function(value: usize) -> usize {{ value + {file_index} }}\n"
                ));
            } else {
                content.push_str(&format!(
                    "let common_request_value_{line_index}: usize = {file_index};\n"
                ));
            }
        }
        if file_index % 1_997 == 0 {
            content.push_str(&format!(
                "let request_authentication_{file_index}_token = authorize();\n"
            ));
        }
        if file_index % 2_003 == 0 {
            let branch = if file_index % 2 == 0 { "alpha" } else { "beta" };
            content.push_str(&format!("fn {branch}_rare_handler() {{}}\n"));
        }
        fs::write(absolute, content).expect("benchmark source");
    }
    directory
}

fn environment_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn percentile(samples: &mut [Duration], percentile: usize) -> Duration {
    samples.sort_unstable();
    let index = samples
        .len()
        .saturating_mul(percentile)
        .div_ceil(100)
        .saturating_sub(1);
    samples[index]
}

fn milliseconds(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn index_file_sizes(storage: &Path, generation: u64, old_index_bytes: u64) -> IndexFileSizes {
    let base = storage.join("bases").join(format!("{generation:020}"));
    let layer = storage.join("layers").join(format!("{generation:020}"));
    let documents_bytes = file_size(&base.join("documents.bin"));
    let lookup_bytes = file_size(&base.join("lookup.bin"));
    let postings_bytes = file_size(&base.join("postings.bin"));
    let delta_bytes = file_size(&layer.join("delta.bin"));
    let pending_generation_bytes = directory_size(&base).saturating_add(directory_size(&layer));
    let published_index_bytes = directory_size(storage);
    IndexFileSizes {
        documents_bytes,
        lookup_bytes,
        postings_bytes,
        delta_bytes,
        published_index_bytes,
        pending_generation_bytes,
        peak_rebuild_disk_bytes: old_index_bytes.saturating_add(pending_generation_bytes),
    }
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).expect("index file metadata").len()
}

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => directory_size(&entry.path()),
            Ok(kind) if kind.is_file() => file_size(&entry.path()),
            _ => 0,
        })
        .sum()
}

#[cfg(unix)]
fn process_rss_kib(process_id: u32) -> Option<u64> {
    let output = Command::new("ps")
        .args(["-o", "rss=", "-p", &process_id.to_string()])
        .output()
        .ok()?;
    output.status.success().then_some(())?;
    String::from_utf8(output.stdout).ok()?.trim().parse().ok()
}

#[cfg(not(unix))]
fn process_rss_kib(_process_id: u32) -> Option<u64> {
    None
}

fn display_rss(rss: Option<u64>) -> String {
    rss.map_or_else(|| "unavailable".to_owned(), |rss| rss.to_string())
}
