use crate::Error;
use crate::Freshness;
use crate::Match;
use crate::MatchRange;
use crate::Query;
use crate::SearchResult;
use ash_async_utils::CancellationToken;
use ash_file_access::Dir;
use ash_shell_command::RipgrepExecutable;
use serde_json::Value;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::path::Component;
use std::path::Path;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub(super) fn search(
    executable: &RipgrepExecutable,
    dir: &Dir,
    query: &Query,
    pattern: &str,
    cancellation: &CancellationToken,
) -> Result<SearchResult, Error> {
    let mut command = Command::new(executable.path());
    command.current_dir(dir.canonical_path()).args([
        "--no-config",
        "--json",
        "--line-number",
        "--color=never",
        "--no-require-git",
        "--max-filesize=64M",
        "--sort=path",
    ]);
    for glob in &query.include_patterns {
        command.arg("--glob").arg(glob);
    }
    for glob in &query.exclude_patterns {
        command.arg("--glob").arg(format!("!{glob}"));
    }
    command
        .arg("--")
        .arg(pattern)
        .arg(if query.scope.as_os_str().is_empty() {
            Path::new(".")
        } else {
            &query.scope
        });
    let mut child = Process(
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?,
    );
    let stdout = child.0.stdout.take().expect("piped stdout");
    let stderr = child.0.stderr.take().expect("piped stderr");
    let max_results = query.max_results;
    let (sender, receiver) = mpsc::sync_channel(1);
    let parser = thread::spawn(move || {
        let result = parse(stdout, max_results);
        let _ = sender.send(result);
    });
    let errors = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut stderr = stderr;
        // Drain the pipe even after the retained error budget is exhausted.
        let _ = stderr.by_ref().take(65536).read_to_end(&mut bytes);
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let parsed = loop {
        if let Err(signal) = cancellation.check() {
            break Err(Error::Cancelled(signal.reason().to_string()));
        }
        if Instant::now() >= deadline {
            break Err(Error::Failed("grep request timed out".into()));
        }
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(result) => break result,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => break Err(Error::Failed("grep output reader stopped".into())),
        }
    };
    let stopped = parsed.as_ref().map_or(true, |result| result.limit_hit);
    if stopped {
        let _ = child.0.kill();
    }
    // A process can close stdout before exiting; keep cancellation and timeout active.
    let status = loop {
        match child.0.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(error) => break Err(Error::from(error)),
            Ok(None) => {}
        }
        if let Err(signal) = cancellation.check() {
            let _ = child.0.kill();
            break Err(Error::Cancelled(signal.reason().to_string()));
        }
        if Instant::now() >= deadline {
            let _ = child.0.kill();
            break Err(Error::Failed("grep request timed out".into()));
        }
        thread::sleep(Duration::from_millis(10));
    };
    let _ = child.0.wait();
    let _ = parser.join();
    let stderr = errors.join().unwrap_or_default();
    let result = parsed?;
    let status = status?;
    if !stopped && !matches!(status.code(), Some(0 | 1)) {
        return Err(Error::Failed(stderr.trim().to_owned()));
    }
    for m in &result.matches {
        if !m.path.starts_with(&query.scope)
            || !m
                .path
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
            || dir
                .canonical_path()
                .join(&m.path)
                .canonicalize()
                .is_ok_and(|p| !p.starts_with(dir.canonical_path()))
        {
            return Err(Error::Failed("grep returned an out-of-scope path".into()));
        }
    }
    Ok(result)
}
fn parse(stdout: impl Read, max_results: usize) -> Result<SearchResult, Error> {
    let mut reader = BufReader::new(stdout);
    let mut matches = Vec::new();
    let mut consumed = 0usize;
    loop {
        let mut line = String::new();
        let bytes = reader
            .by_ref()
            .take(64 * 1024 * 1024 + 1)
            .read_line(&mut line)?;
        if bytes == 0 {
            break;
        }
        consumed = consumed.saturating_add(bytes);
        if consumed > 64 * 1024 * 1024 {
            return Err(Error::Failed("grep output exceeded 64 MiB".into()));
        }
        let record: Value =
            serde_json::from_str(&line).map_err(|e| Error::Failed(e.to_string()))?;
        if record["type"] != "match" {
            continue;
        }
        if matches.len() == max_results {
            return Ok(SearchResult {
                matches,
                limit_hit: true,
                freshness: Freshness::Current,
            });
        }
        let data = &record["data"];
        let missing = || Error::Failed("grep returned an invalid UTF-8 match".into());
        let path = data["path"]["text"].as_str().ok_or_else(missing)?;
        let path = Path::new(path);
        let path = path.strip_prefix(".").unwrap_or(path).to_path_buf();
        let content = data["lines"]["text"]
            .as_str()
            .ok_or_else(missing)?
            .trim_end_matches(['\r', '\n'])
            .to_owned();
        let line_number = data["line_number"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or_else(missing)? as usize;
        let ranges = data["submatches"]
            .as_array()
            .ok_or_else(missing)?
            .iter()
            .map(|r| {
                let start = r["start"].as_u64().ok_or_else(missing)? as usize;
                let end = r["end"].as_u64().ok_or_else(missing)? as usize;
                if start > end || !content.is_char_boundary(start) || !content.is_char_boundary(end)
                {
                    return Err(missing());
                }
                Ok(MatchRange { start, end })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        matches.push(Match {
            path,
            line_number,
            content,
            ranges,
        });
    }
    Ok(SearchResult {
        matches,
        limit_hit: false,
        freshness: Freshness::Current,
    })
}
