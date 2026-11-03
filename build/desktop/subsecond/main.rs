#[cfg(not(debug_assertions))]
compile_error!("Subsecond is available only in a development build");

// Reuse the production entry point, including hardening and internal helper dispatch.
include!("../../app-server-host/src/main.rs");

mod ash_app_server {
    use ash_app_server_protocol::protocol::error::AppServerError;
    use dioxus_devtools::DevserverMsg;
    use serde_json::Value;
    use subsecond::HotFn;

    fn compute(params: &Value) -> Result<Value, AppServerError> {
        HotFn::current(ash_app_server_diff::compute).call((params,))
    }

    pub(super) fn run(arguments: impl IntoIterator<Item = String>) -> Result<(), String> {
        let mut arguments = arguments.into_iter().peekable();
        if arguments
            .peek()
            .is_some_and(|argument| argument == "--managed")
        {
            // Internal helper processes also run this binary. Only the managed
            // server may register its PID with dx's single native patch target.
            dioxus_devtools::connect(|message| match message {
                DevserverMsg::HotReload(message) if message.for_pid == Some(std::process::id()) => {
                    if let Some(table) = message.jump_table {
                        let previous = HotFn::current(ash_app_server_diff::compute).ptr_address();
                        // The loopback driver is the developer's trusted native compiler.
                        match unsafe { subsecond::apply_patch(table) } {
                            Ok(())
                                if previous
                                    != HotFn::current(ash_app_server_diff::compute)
                                        .ptr_address() =>
                            {
                                eprintln!(
                                    "[ash-subsecond] Diff patch applied to {}",
                                    std::process::id()
                                );
                            }
                            Ok(()) => eprintln!("[ash-subsecond] Diff entry missing from patch"),
                            Err(error) => eprintln!("[ash-subsecond] Patch rejected: {error}"),
                        }
                    }
                }
                DevserverMsg::FullReloadCommand => {
                    eprintln!("[ash-subsecond] Full rebuild required");
                }
                _ => {}
            });
        }
        ash_app_server_runtime::run(arguments, compute, build_identity::current())
    }
}
