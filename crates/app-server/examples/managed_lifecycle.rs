//! Runs the real managed entrypoint and its terminal roles for lifecycle tests.

fn main() -> Result<(), String> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let managed = arguments.as_slice() == [ash_app_server_daemon::MANAGED_PROCESS_ARGUMENT];
    ash_app_server_runtime::run(arguments, ash_app_server_diff::compute)?;
    if managed {
        // Only a completed managed shutdown can acknowledge that all owners were dropped.
        let profile = ash_utils_home_dir::find_ash_home().map_err(|error| error.to_string())?;
        std::fs::write(profile.join("released"), b"released").map_err(|error| error.to_string())?;
    }
    Ok(())
}
