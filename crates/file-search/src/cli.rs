use ash_file_search::PathMatch;

use ash_file_search::PathSearchOptions;
use ash_file_search::PathSearchSnapshot;
use clap::Parser;
use serde_json::json;
use std::io::IsTerminal;
use std::io::Write;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;

#[derive(Debug, Parser)]
#[command(version, about = "Fuzzy-match file paths below a directory directory")]
struct Cli {
    /// Emit one JSON object per match.
    #[arg(long)]
    json: bool,

    /// Maximum number of matches to print.
    #[arg(long, short = 'l', default_value = "64")]
    limit: NonZeroUsize,

    /// Directory directory to search.
    #[arg(long, short = 'C')]
    cwd: Option<PathBuf>,

    /// Include fuzzy-match character indices in JSON and highlight them on a TTY.
    #[arg(long)]
    compute_indices: bool,

    /// Number of directory-walker and Nucleo worker threads.
    #[arg(long, default_value = "2")]
    threads: NonZeroUsize,

    /// Fuzzy pattern. Omitting it lists directory files.
    pattern: Option<String>,
}

pub(super) fn run() -> Result<(), String> {
    let cli = Cli::parse();
    let terminal_output = if std::io::stdout().is_terminal() {
        TerminalOutput::Ansi
    } else {
        TerminalOutput::Plain
    };
    execute(
        cli,
        &mut std::io::stdout().lock(),
        &mut std::io::stderr().lock(),
        terminal_output,
    )
}

fn execute(
    cli: Cli,
    output: &mut dyn Write,
    warnings: &mut dyn Write,
    terminal_output: TerminalOutput,
) -> Result<(), String> {
    let output_style = match (cli.json, cli.compute_indices, terminal_output) {
        (true, true, _) => OutputStyle::JsonWithIndices,
        (true, false, _) => OutputStyle::Json,
        (false, true, TerminalOutput::Ansi) => OutputStyle::Highlighted,
        (false, _, _) => OutputStyle::Plain,
    };
    let root = match cli.cwd {
        Some(root) => root,
        None => std::env::current_dir()
            .map_err(|error| format!("could not resolve the current directory: {error}"))?,
    };
    let options = PathSearchOptions::default()
        .with_result_limit(cli.limit)
        .with_worker_threads(cli.threads);
    let (handle, snapshots) = ash_file_search::Service
        .start(root, options)
        .map_err(|error| format!("could not start path search: {error}"))?;
    let query = cli.pattern.unwrap_or_default();
    let query_revision = handle.update_query(&query);
    let snapshot = final_snapshot(&snapshots, query_revision)?;

    for matched in &snapshot.matches {
        write_match(output, matched, output_style)
            .map_err(|error| format!("could not write search result: {error}"))?;
    }
    if snapshot.total_match_count > snapshot.matches.len() {
        write_truncation(warnings, &snapshot, output_style)
            .map_err(|error| format!("could not write truncation warning: {error}"))?;
    }
    Ok(())
}

fn final_snapshot(
    snapshots: &Receiver<PathSearchSnapshot>,
    query_revision: u64,
) -> Result<PathSearchSnapshot, String> {
    loop {
        let snapshot = snapshots
            .recv()
            .map_err(|_| "path-search workers stopped before completion".to_owned())?;
        if snapshot.query_revision == query_revision && snapshot.search_complete {
            return Ok(snapshot);
        }
    }
}

fn write_match(
    output: &mut dyn Write,
    matched: &PathMatch,
    style: OutputStyle,
) -> std::io::Result<()> {
    if matches!(style, OutputStyle::Json | OutputStyle::JsonWithIndices) {
        let mut value = json!({
            "score": matched.score,
            "path": matched.path,
        });
        if style == OutputStyle::JsonWithIndices {
            value["indices"] = json!(matched.indices);
        }
        return writeln!(output, "{value}");
    }
    if style == OutputStyle::Highlighted {
        return write_highlighted_path(output, matched);
    }
    writeln!(output, "{}", matched.path.display())
}

fn write_highlighted_path(output: &mut dyn Write, matched: &PathMatch) -> std::io::Result<()> {
    let path = matched.path.to_string_lossy();
    let mut indices = matched.indices.iter().peekable();
    for (index, character) in path.chars().enumerate() {
        if indices.peek().is_some_and(|next| **next == index as u32) {
            write!(output, "\x1b[1m{character}\x1b[0m")?;
            indices.next();
        } else {
            write!(output, "{character}")?;
        }
    }
    writeln!(output)
}

fn write_truncation(
    warnings: &mut dyn Write,
    snapshot: &PathSearchSnapshot,
    style: OutputStyle,
) -> std::io::Result<()> {
    if matches!(style, OutputStyle::Json | OutputStyle::JsonWithIndices) {
        return writeln!(
            warnings,
            "{}",
            json!({
                "matches_truncated": true,
                "shown_match_count": snapshot.matches.len(),
                "total_match_count": snapshot.total_match_count,
            })
        );
    }
    writeln!(
        warnings,
        "Warning: showing {} of {} matches; refine the pattern or increase --limit.",
        snapshot.matches.len(),
        snapshot.total_match_count
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TerminalOutput {
    Plain,
    Ansi,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OutputStyle {
    Plain,
    Highlighted,
    Json,
    JsonWithIndices,
}

#[cfg(test)]
#[path = "cli_tests.rs"]
mod tests;
