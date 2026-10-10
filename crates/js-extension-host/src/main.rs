//! Dedicated Rust/V8 extension process. stdout contains only the existing bounded host protocol.
mod isolation;
mod package;
mod runtime;

fn main() {
    if let Err(error) = run() {
        eprintln!("JavaScript extension host: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let (package, offset) = if matches!(arguments.len(), 2 | 8) && arguments[0] == "--builtin" {
        (package::Package::product(&arguments[1])?, 2)
    } else {
        if !matches!(arguments.len(), 6 | 8 | 12 | 14)
            || arguments[0] != "--extension-id"
            || arguments[2] != "--package"
            || arguments[4] != "--entry"
        {
            return Err("expected --extension-id ID --package ABSOLUTE_PATH --entry RELATIVE_ESM_PATH, or --builtin NAME".into());
        }
        let vscode = matches!(arguments.len(), 8 | 14);
        if vscode && (arguments[6] != "--api" || arguments[7] != "vscode") {
            return Err("expected --api vscode".into());
        }
        let read = if vscode {
            package::Package::read_vscode
        } else {
            package::Package::read
        };
        (
            read(
                arguments[1].clone(),
                arguments[3].clone().into(),
                arguments[5].clone(),
            )?,
            if vscode { 8 } else { 6 },
        )
    };
    let memory = if arguments.len() == offset + 6 {
        if arguments[offset] != "--isolation"
            || arguments[offset + 1]
                != if package.origin == package::PackageOrigin::Product {
                    "product-javascript"
                } else {
                    "javascript"
                }
            || arguments[offset + 2] != "--heap-bytes"
            || arguments[offset + 4] != "--array-buffer-bytes"
        {
            return Err("expected JavaScript isolation and memory budgets".into());
        }
        Some(runtime::MemoryLimits {
            heap_bytes: arguments[offset + 3]
                .parse()
                .map_err(|_| "invalid heap budget")?,
            array_buffer_bytes: arguments[offset + 5]
                .parse()
                .map_err(|_| "invalid ArrayBuffer budget")?,
        })
    } else {
        None
    };
    runtime::run(package, memory)
}
