fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    let result =
        if arguments.first().is_some_and(|value| value == "connect") && arguments.len() == 3 {
            arguments[2]
                .to_str()
                .ok_or_else(|| std::io::Error::other("invalid root"))
                .and_then(|root| {
                    dev_container_provider::connect(std::path::Path::new(&arguments[1]), root)
                })
        } else if arguments.is_empty() {
            external_ext_sdk::run_stdio(dev_container_provider::DevContainers::default())
                .map_err(std::io::Error::other)
        } else {
            Err(std::io::Error::other("invalid provider invocation"))
        };
    if let Err(error) = result {
        eprintln!("Dev Container Provider: {error}");
        std::process::exit(1);
    }
}
