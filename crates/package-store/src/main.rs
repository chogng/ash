use std::path::PathBuf;
use std::process::ExitCode;

use ash_package_store::PackageStore;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishOutput {
    package_root: PathBuf,
    sequence: u64,
}

fn main() -> ExitCode {
    match run(std::env::args().skip(1)) {
        Ok(output) => {
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("ash-package-store: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: impl Iterator<Item = String>) -> Result<String, String> {
    let arguments = arguments.collect::<Vec<_>>();
    let [command, root_flag, root, staging_flag, staging] = arguments.as_slice() else {
        return Err(usage());
    };
    if command != "publish" || root_flag != "--root" || staging_flag != "--staging" {
        return Err(usage());
    }
    let published = PackageStore::open(root)
        .map_err(|error| error.to_string())?
        .publish(staging)
        .map_err(|error| error.to_string())?;
    if let Some(error) = published.cleanup_error {
        eprintln!(
            "ash-package-store: package published, but stale package cleanup failed: {error}"
        );
    }
    serde_json::to_string(&PublishOutput {
        package_root: published.package_root,
        sequence: published.sequence,
    })
    .map_err(|error| error.to_string())
}

fn usage() -> String {
    "usage: ash-package-store publish --root <store-root> --staging <package-directory>".into()
}
