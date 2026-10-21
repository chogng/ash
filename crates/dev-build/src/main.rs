use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if std::env::var_os("ASH_RUST_CHECK_CAPTURE").is_some() {
        return match ash_dev_build::rustc_wrapper(&args) {
            Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
            Err(error) => {
                eprintln!("[ash-build] {error}");
                ExitCode::FAILURE
            }
        };
    }
    if args.len() == 4 && args[0] == "--serve-functions" {
        return outcome(ash_dev_build::serve_functions(
            &PathBuf::from(&args[1]),
            &PathBuf::from(&args[2]),
            &PathBuf::from(&args[3]),
        ));
    }
    if args
        .first()
        .is_some_and(|argument| argument == "--evaluate")
        && args.len() >= 5
    {
        let result = (|| {
            let path = args[3].to_str().ok_or("source path must be UTF-8")?;
            let offset = args[4]
                .to_str()
                .ok_or("invalid offset")?
                .parse::<u32>()
                .map_err(|error| error.to_string())?;
            let arguments = args[5..]
                .iter()
                .map(|value| {
                    value
                        .to_str()
                        .ok_or_else(|| "invalid scalar argument".to_string())
                        .and_then(|value| value.parse::<u64>().map_err(|error| error.to_string()))
                })
                .collect::<Result<Vec<_>, _>>()?;
            let value = ash_dev_build::evaluate(
                &PathBuf::from(&args[1]),
                &PathBuf::from(&args[2]),
                path,
                offset,
                &arguments,
            )?;
            println!("{value}");
            Ok(())
        })();
        return outcome(result);
    }
    if args.len() == 4 && args[2] == "--serve" {
        return outcome(ash_dev_build::serve_diff(
            &PathBuf::from(&args[0]),
            &PathBuf::from(&args[1]),
            &PathBuf::from(&args[3]),
        ));
    }
    if args.len() != 2 {
        eprintln!(
            "Usage: ash-build <repository> <module-directory> [--serve <analysis-executable>]\n       ash-build --serve-functions <repository> <image-directory> <analysis-executable>\n       ash-build --evaluate <repository> <analysis-executable> <source.rs> <byte-offset> [u64-bits ...]"
        );
        return ExitCode::FAILURE;
    }
    outcome(ash_dev_build::build_diff(
        &PathBuf::from(&args[0]),
        &PathBuf::from(&args[1]),
    ))
}

fn outcome(result: Result<(), String>) -> ExitCode {
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("[ash-build] {error}");
            ExitCode::FAILURE
        }
    }
}
