use ash_fast_regex_search::*;
use ash_file_access::Dir;
use serde_json::json;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::time::Instant;

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.iter().any(|a| a == "--fast-regex-worker") {
        serve_worker_from_environment().unwrap();
        return;
    }
    if args[1] == "--tgrep-port" {
        remote(args[2].parse().unwrap());
        return;
    }
    let root = Dir::open_local(&args[1]).unwrap();
    let limits = FastRegexSearchLimits {
        max_results: 1_000_000,
        ..Default::default()
    };
    let start = Instant::now();
    let index = FastRegexWorkerClient::open(
        FastRegexWorkerCommand::new(std::env::current_exe().unwrap(), ["--fast-regex-worker"]),
        &root,
        &PathBuf::from(&args[2]),
        limits,
    )
    .unwrap();
    if index.snapshot().unwrap().generation == 0 {
        index.rebuild().unwrap();
    }
    println!(
        "{}",
        json!({"ready_ms":start.elapsed().as_secs_f64()*1000.0,"snapshot":index.snapshot().unwrap(),"pid":index.process_id()})
    );
    io::stdout().flush().unwrap();
    for input in io::stdin().lock().lines() {
        let v: serde_json::Value = serde_json::from_str(&input.unwrap()).unwrap();
        let start = Instant::now();
        let result = if let Some(paths) = v.get("refresh_paths") {
            let paths = paths
                .as_array()
                .unwrap()
                .iter()
                .map(|p| root.canonical_path().join(p.as_str().unwrap()))
                .collect::<Vec<_>>();
            json!({"update":format!("{:?}",index.refresh_observed_paths(&paths)),"snapshot":index.snapshot().unwrap()})
        } else if v.get("rebuild").is_some() {
            json!({"update":format!("{:?}",index.rebuild()),"snapshot":index.snapshot().unwrap()})
        } else if v.get("reconcile").is_some() {
            json!({"update":format!("{:?}",index.reconcile_dir()),"snapshot":index.snapshot().unwrap()})
        } else {
            let query = FastRegexQuery {
                query: v["query"].as_str().unwrap().into(),
                pattern: FastRegexPattern::Regex,
                case_sensitivity: FastRegexCaseSensitivity::Sensitive,
                scope: PathBuf::new(),
                include_patterns: Vec::new(),
                exclude_patterns: Vec::new(),
                max_results: v["limit"].as_u64().unwrap_or(100) as usize,
            };
            let concurrency = v["concurrency"].as_u64().unwrap_or(1) as usize;
            let rounds = v["rounds"].as_u64().unwrap_or(1) as usize;
            let barrier = std::sync::Barrier::new(concurrency);
            let samples = std::thread::scope(|scope| {
                let jobs=(0..concurrency).map(|_| {
                    let index=&index;let query=&query;let barrier=&barrier;
                    scope.spawn(move || {
                        barrier.wait();
                        (0..rounds).map(|_| {
                            let begin=Instant::now();let found=index.search(query);let ms=begin.elapsed().as_secs_f64()*1000.0;
                            match found {
                                Ok(r)=>json!({"ms":ms,"count":r.matches.len(),"limit_hit":r.limit_hit,"generation":r.statistics.generation,"paths":if rounds==1 && concurrency==1 { r.matches.iter().map(|m|m.path.to_string_lossy().into_owned()).collect::<Vec<_>>() } else {vec![]}}),
                                Err(e)=>json!({"ms":ms,"error":e.to_string()}),
                            }
                        }).collect::<Vec<_>>()
                    })
                }).collect::<Vec<_>>();
                jobs.into_iter()
                    .flat_map(|j| j.join().unwrap())
                    .collect::<Vec<_>>()
            });
            json!({"samples":samples})
        };
        println!(
            "{}",
            json!({"elapsed_ms":start.elapsed().as_secs_f64()*1000.0,"result":result})
        );
        io::stdout().flush().unwrap();
    }
}

fn remote(port: u16) {
    println!("{}", json!({"ready":true}));
    io::stdout().flush().unwrap();
    for input in io::stdin().lock().lines() {
        let value: serde_json::Value = serde_json::from_str(&input.unwrap()).unwrap();
        let concurrency = value["concurrency"].as_u64().unwrap() as usize;
        let rounds = value["rounds"].as_u64().unwrap() as usize;
        let request=serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,"method":"search","params":{"pattern":value["query"],"detail":true,"positions":true}})).unwrap();
        let barrier = std::sync::Barrier::new(concurrency);
        let start = Instant::now();
        let samples = std::thread::scope(|scope| {
            let jobs=(0..concurrency).map(|_| {let request=&request;let barrier=&barrier;
                scope.spawn(move || {barrier.wait();(0..rounds).map(|_| {
                    let start=Instant::now();
                    let response=(|| -> Result<serde_json::Value,Box<dyn std::error::Error>> {
                        let mut socket=std::net::TcpStream::connect(("127.0.0.1",port))?;
                        socket.set_read_timeout(Some(std::time::Duration::from_secs(120)))?;
                        socket.write_all(request)?;socket.write_all(b"\n")?;
                        let mut line=String::new();io::BufReader::new(socket).read_line(&mut line)?;
                        Ok(serde_json::from_str(&line)?)
                    })();
                    match response {Ok(v) if v.get("result").is_some()=>json!({"ms":start.elapsed().as_secs_f64()*1000.0,"count":v["result"]["matches"].as_array().unwrap().len()}),v=>json!({"ms":start.elapsed().as_secs_f64()*1000.0,"error":format!("{v:?}")})}
                }).collect::<Vec<_>>()})
            }).collect::<Vec<_>>();
            jobs.into_iter()
                .flat_map(|j| j.join().unwrap())
                .collect::<Vec<_>>()
        });
        println!(
            "{}",
            json!({"elapsed_ms":start.elapsed().as_secs_f64()*1000.0,"result":{"samples":samples}})
        );
        io::stdout().flush().unwrap();
    }
}
