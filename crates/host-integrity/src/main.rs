use std::io;
use std::io::Write;
use std::path::Path;
use std::process::ExitCode;

fn run() -> Result<(), Box<dyn std::error::Error>> {
    process_hardening::initialize()?;
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err("expected scan|checksum and a local path".into());
    }
    let path = Path::new(&args[1]);
    let mut output = io::stdout().lock();
    if args[0] == "scan" {
        serde_json::to_writer(&mut output, &ash_host_integrity::scan(path)?)?;
    } else if args[0] == "checksum" {
        write!(output, "{}", ash_host_integrity::checksum(path)?)?;
    } else {
        return Err("unknown integrity operation".into());
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
