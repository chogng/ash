use exec_server::ExecListener;
use exec_server::LocalEnvironment;
use exec_server_protocol::FileAccess;
use exec_server_protocol::NetworkAccess;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

fn main() {
    if let Err(error) = process_hardening::initialize() {
        eprintln!("exec-server hardening failed: {error}");
        std::process::exit(1);
    }
    let _package_lease = match std::env::current_exe()
        .and_then(ash_package_store::acquire_package_lease_for_executable)
    {
        Ok(lease) => lease,
        Err(error) => {
            eprintln!("could not lease the running package: {error}");
            std::process::exit(1);
        }
    };
    let result = match arg0::dispatch(std::env::args_os().skip(1)) {
        Some(result) => result,
        None => run(),
    };
    if let Err(error) = result {
        eprintln!("exec-server: {error}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let [
        listen,
        address,
        root_flag,
        root,
        id_flag,
        id,
        token_flag,
        token_file,
        access_flag,
        access,
    ] = args.as_slice()
    else {
        return Err("usage: ash-exec-server --listen 127.0.0.1:0 --root PATH --environment ID --token-file PATH --access read-only|read-write".into());
    };
    if (
        listen.as_str(),
        root_flag.as_str(),
        id_flag.as_str(),
        token_flag.as_str(),
        access_flag.as_str(),
    ) != (
        "--listen",
        "--root",
        "--environment",
        "--token-file",
        "--access",
    ) {
        return Err("invalid arguments".into());
    }
    let access = match access.as_str() {
        "read-only" => FileAccess::ReadOnly,
        "read-write" => FileAccess::ReadWrite,
        _ => return Err("invalid access".into()),
    };
    let token = std::fs::read_to_string(token_file).map_err(|error| error.to_string())?;
    let environment = Arc::new(
        LocalEnvironment::open(
            id.clone(),
            Path::new(root),
            access,
            NetworkAccess::Denied,
            Arc::new(
                exec_server::LocalSandbox::new(ash_install_context::InstallContext::current())
                    .with_pty_helper(std::env::current_exe().map_err(|error| error.to_string())?)
                    .build(),
            ),
        )
        .map_err(|error| error.to_string())?,
    );
    let listener = ExecListener::bind(
        address.parse().map_err(|_| "invalid address")?,
        token.trim(),
        environment.clone(),
    )
    .map_err(|error| error.to_string())?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let _entered = runtime.enter();
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|error| error.to_string())?;
    #[cfg(unix)]
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .map_err(|error| error.to_string())?;
    println!(
        "{}",
        serde_json::json!({"address": listener.address().to_string(), "environment": environment.info(), "version": exec_server_protocol::VERSION})
    );
    std::io::stdout()
        .flush()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async {
        #[cfg(unix)]
        tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {} }
        #[cfg(not(unix))]
        tokio::signal::ctrl_c()
            .await
            .map_err(|error| error.to_string())?;
        Ok::<(), String>(())
    })?;
    drop(listener);
    drop(environment);
    Ok(())
}
