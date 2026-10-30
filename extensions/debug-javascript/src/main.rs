fn main() {
    if let Some(executable) = std::env::var_os("ASH_JS_DEBUG_NODE_RUNTIME") {
        let result = run_node_runtime(executable.into());
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--auto-attach") {
        ash_debug_javascript::auto_attach_helper();
        return;
    }
    if external_ext_sdk::run_stdio(ash_debug_javascript::Extension::default()).is_err() {
        std::process::exit(1);
    }
}

fn run_node_runtime(executable: std::path::PathBuf) -> std::io::Result<()> {
    if !executable.is_absolute()
        || executable.canonicalize()? == std::env::current_exe()?.canonicalize()?
    {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    let mut command = std::process::Command::new(executable);
    command
        .args(std::env::args_os().skip(1))
        .env_remove("ASH_JS_DEBUG_NODE_RUNTIME")
        .env("ELECTRON_RUN_AS_NODE", "1");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Replace the shim so DAP launch ownership, signals and the target PID
        // still describe the Node process. Windows retains the owned child tree.
        Err(command.exec())
    }
    #[cfg(windows)]
    {
        std::process::exit(command.status()?.code().unwrap_or(1));
    }
}
