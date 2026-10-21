use ash_rust_analysis::WorkspaceMode;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let mode = match args.get(1).and_then(|arg| arg.to_str()) {
        None if args.len() == 1 => WorkspaceMode::Metadata,
        Some("--build-scripts") if args.len() == 2 => WorkspaceMode::BuildScripts,
        _ => {
            eprintln!("Usage: ash-rust-analysis <workspace> [--build-scripts]");
            return ExitCode::FAILURE;
        }
    };
    match ash_rust_analysis::serve(&PathBuf::from(&args[0]), mode) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("[rust-analysis] {error}");
            ExitCode::FAILURE
        }
    }
}
