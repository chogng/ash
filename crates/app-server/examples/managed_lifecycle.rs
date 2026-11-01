//! Runs the real managed entrypoint and its terminal roles for lifecycle tests.

#[path = "managed_lifecycle/owned.rs"]
mod owned;

fn main() -> Result<(), String> {
    if let Some(result) = arg0::dispatch(std::env::args_os().skip(1)) {
        return result;
    }
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if let Some(result) = owned::dispatch(&arguments) {
        return result;
    }
    let managed = arguments.as_slice() == [ash_app_server_daemon::MANAGED_PROCESS_ARGUMENT];
    let _owned_process = if managed { owned::spawn()? } else { None };
    ash_app_server_runtime::run(
        arguments,
        ash_app_server_diff::compute,
        build_info::BuildInfo::new(None, None),
    )?;
    if managed {
        // Only a completed managed shutdown can acknowledge that all owners were dropped.
        let profile = ash_utils_home_dir::find_ash_home().map_err(|error| error.to_string())?;
        std::fs::write(profile.join("released"), b"released").map_err(|error| error.to_string())?;
    }
    Ok(())
}
