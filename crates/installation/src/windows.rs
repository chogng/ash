use crate::Product;
use crate::command::hidden_command;
use crate::invalid;
use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;

/// System cleanup uses exact application roots, never display-name matching.
/// Sandbox helpers retain authority over account SIDs, WFP rules and the service.
pub(crate) fn cleanup(
    product: Product,
    root: &Path,
    program_roots: &[PathBuf],
    profiles: &[PathBuf],
    remove_sandbox: bool,
) -> io::Result<Vec<PathBuf>> {
    let bin = match product {
        Product::Desktop => root.join("resources/bin"),
        Product::Cli => crate::command::selected_cli_package(root)?.join("bin"),
    };
    let temporary = tempfile::Builder::new()
        .prefix("ash-system-cleanup-")
        .tempdir()?;
    let request = temporary.path().join("request.json");
    let mut roots = program_roots.to_vec();
    for profile in profiles {
        let packages = profile.join("app-server-packages");
        if packages.exists() {
            roots.push(crate::files::real_directory(&packages)?);
        }
    }
    fs::write(
        &request,
        serde_json::to_vec(
            &serde_json::json!({"roots": roots, "bin": bin, "removeSandbox": remove_sandbox}),
        )
        .map_err(invalid)?,
    )?;
    let shell = PathBuf::from(
        std::env::var_os("SystemRoot").ok_or_else(|| invalid("SystemRoot is unavailable"))?,
    )
    .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let output = hidden_command(&shell)
        // Execute the fixed embedded command, keeping caller paths in JSON.
        // No downloaded script or execution-policy setting is involved.
        .args(["-NoProfile", "-NonInteractive", "-Command"])
        .arg(format!(
            "& {{ {} }} -RequestPath $env:ASH_INSTALLATION_CLEANUP_REQUEST",
            include_str!("windows_cleanup.ps1")
        ))
        .env("ASH_INSTALLATION_CLEANUP_REQUEST", request)
        .output()?;
    if !output.status.success() {
        return Err(invalid(String::from_utf8_lossy(&output.stderr)));
    }
    serde_json::from_slice(&output.stdout).map_err(invalid)
}
