fn main() {
    let mut arguments = std::env::args_os().skip(1);
    if let Some(command) = arguments.next() {
        if command == "--stdio-adapter" {
            let (Some(message), Some(program)) = (arguments.next(), arguments.next()) else {
                std::process::exit(2);
            };
            if let Err(error) = ash_debug_lldb::run_adapter(program, arguments.collect()) {
                eprintln!("{}: {error}", message.to_string_lossy());
                std::process::exit(1);
            }
            return;
        }
        if command == "--prepare-runtime"
            && let Some(directory) = arguments.next()
            && arguments.next().is_none()
        {
            match ash_debug_lldb::prepare_runtime(directory.into()) {
                Ok(path) => println!("{}", serde_json::json!({ "executable": path })),
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            }
            return;
        }
        std::process::exit(2);
    }
    if external_ext_sdk::run_stdio(ash_debug_lldb::LldbExtension::default()).is_err() {
        std::process::exit(1);
    }
}
