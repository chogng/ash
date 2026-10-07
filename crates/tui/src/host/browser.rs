//! Platform browser handoff for user-driven authorization URLs.

use std::process::Command;

pub(crate) fn open_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") || url.contains(char::is_control) {
        return Err("browser URL is invalid".into());
    }
    let status = platform_command(url)
        .status()
        .map_err(|error| format!("could not open browser: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("browser did not accept the authorization URL".into())
    }
}

#[cfg(target_os = "macos")]
fn platform_command(url: &str) -> Command {
    let mut command = Command::new("open");
    command.arg(url);
    command
}

#[cfg(target_os = "windows")]
fn platform_command(url: &str) -> Command {
    let mut command = Command::new("rundll32.exe");
    command.arg("url.dll,FileProtocolHandler").arg(url);
    command
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn platform_command(url: &str) -> Command {
    let mut command = Command::new("xdg-open");
    command.arg(url);
    command
}
