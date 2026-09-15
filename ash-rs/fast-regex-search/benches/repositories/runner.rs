use ash_fast_regex_search::*;
use ash_file_access::Dir;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::time::Instant;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--fast-regex-worker") {
        serve_worker_from_environment().unwrap();
        return;
    }
    let root = Dir::open_local(&args[1]).unwrap();
    let storage = PathBuf::from(&args[2]);
    let command =
        FastRegexWorkerCommand::new(std::env::current_exe().unwrap(), ["--fast-regex-worker"]);
    let limits = FastRegexSearchLimits {
        max_results: 1_000_000,
        max_files: args.get(3).and_then(|v| v.parse().ok()).unwrap_or(250_000),
        ..Default::default()
    };
    let start = Instant::now();
    let index = FastRegexWorkerClient::open(command, &root, &storage, limits).unwrap();
    let open_ms = start.elapsed().as_secs_f64() * 1000.0;
    let start = Instant::now();
    let mut snap = index.snapshot().unwrap();
    if snap.generation == 0 {
        snap = index.rebuild().unwrap();
    }
    println!(
        "{}",
        serde_json::json!({"open_ms":open_ms,"build_ms":start.elapsed().as_secs_f64()*1000.0,"snapshot":snap,"pid":index.process_id()})
    );
    io::stdout().flush().unwrap();
    for line in io::stdin().lock().lines() {
        let v: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        let start = Instant::now();
        if v.get("refresh").is_some() {
            let path = root.canonical_path().join(v["refresh"].as_str().unwrap());
            println!(
                "{}",
                serde_json::json!({"refresh":format!("{:?}",index.refresh_observed_paths(&[path])),"ms":start.elapsed().as_secs_f64()*1000.0})
            );
        } else if v.get("reconcile").is_some() {
            println!(
                "{}",
                serde_json::json!({"reconcile":format!("{:?}",index.reconcile_dir()),"ms":start.elapsed().as_secs_f64()*1000.0})
            );
        } else {
            let q = FastRegexQuery {
                query: v["query"].as_str().unwrap().into(),
                pattern: if v["literal"].as_bool().unwrap_or(false) {
                    FastRegexPattern::Literal
                } else {
                    FastRegexPattern::Regex
                },
                case_sensitivity: if v["insensitive"].as_bool().unwrap_or(false) {
                    FastRegexCaseSensitivity::Insensitive
                } else {
                    FastRegexCaseSensitivity::Sensitive
                },
                scope: PathBuf::new(),
                include_patterns: Vec::new(),
                exclude_patterns: Vec::new(),
                max_results: v["limit"].as_u64().unwrap_or(1_000_000) as usize,
            };
            let result = index.search(&q);
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            match result {
                Ok(r) => {
                    let matches: Vec<_> = r
                        .matches
                        .iter()
                        .map(|m| {
                            serde_json::json!([m.path.to_string_lossy(), m.line_number, m.preview])
                        })
                        .collect();
                    println!(
                        "{}",
                        serde_json::json!({"ms":ms,"matches":matches,"limit_hit":r.limit_hit,"stats":r.statistics})
                    );
                }
                Err(e) => println!("{}", serde_json::json!({"ms":ms,"error":e.to_string()})),
            }
        }
        io::stdout().flush().unwrap();
    }
}
