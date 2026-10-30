use crate::Product;
use crate::Registry;
use crate::RemovalMode;
use crate::RemovalReport;
use crate::files;
use crate::invalid;
use crate::registry_directory;
use fs2::FileExt;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
#[cfg(windows)]
use std::time::Duration;

/// Runs product-neutral maintenance before the daemon acquires a package lease.
/// The normal daemon command path continues to own process identity and stopping.
pub fn run_command(
    arguments: impl IntoIterator<Item = String>,
    stop: impl FnMut(&Path) -> io::Result<()>,
) -> io::Result<()> {
    let arguments = arguments.into_iter().collect::<Vec<_>>();
    let result = run(&arguments, stop);
    if let Err(error) = &result {
        if arguments
            .windows(2)
            .any(|pair| pair == ["--self-clean", "yes"])
        {
            if let Some(pair) = arguments.windows(2).find(|pair| pair[0] == "--root") {
                record_pending_failure(Path::new(&pair[1]), error);
            }
        }
    }
    result
}

fn record_pending_failure(root: &Path, error: &io::Error) {
    let record = || -> io::Result<()> {
        let root = crate::absolute_path(root)?;
        let directory = files::real_directory(&registry_directory()?)?;
        let path = report_path(&directory, &root);
        let previous: serde_json::Value =
            serde_json::from_slice(&files::read_bounded(&path)?).map_err(invalid)?;
        if previous["status"] == "pending" {
            ash_utils_path::write_atomically(&path, &serde_json::to_vec_pretty(&json!({"status":"failed","report":{"removed":[],"retained":[],"failures":[error.to_string()]}})).map_err(invalid)?)?;
        }
        Ok(())
    };
    if let Err(error) = record() {
        eprintln!("could not record uninstall failure: {error}");
    }
}

fn run(arguments: &[String], stop: impl FnMut(&Path) -> io::Result<()>) -> io::Result<()> {
    let mut args = arguments.iter().cloned();
    let operation = args
        .next()
        .ok_or_else(|| invalid("missing installation operation"))?;
    let mut options = BTreeMap::new();
    for key in args.by_ref().collect::<Vec<_>>().chunks(2) {
        if key.len() != 2
            || ![
                "--product",
                "--root",
                "--launcher-dir",
                "--profile",
                "--user-data",
                "--mode",
                "--wait-stdin",
                "--self-clean",
                "--incoming",
            ]
            .contains(&key[0].as_str())
            || options.insert(key[0].clone(), key[1].clone()).is_some()
        {
            return Err(invalid("invalid installation arguments"));
        }
    }
    for key in ["--wait-stdin", "--self-clean"] {
        if options.get(key).is_some_and(|value| value != "yes") {
            return Err(invalid("invalid installation handoff flag"));
        }
    }
    if options.contains_key("--user-data") && !options.contains_key("--profile") {
        return Err(invalid("user data requires an explicit profile"));
    }
    if options.get("--wait-stdin").map(String::as_str) == Some("yes") {
        // The invoking CLI closes this pipe when it exits, releasing its package
        // lease. This also works when the CLI is forcibly terminated.
        io::stdin().take(1).read_to_end(&mut Vec::new())?;
    }
    let product = match options.get("--product").map(String::as_str) {
        Some("desktop") => Product::Desktop,
        Some("cli") => Product::Cli,
        _ => return Err(invalid("product must be desktop or cli")),
    };
    let root = PathBuf::from(
        options
            .get("--root")
            .ok_or_else(|| invalid("missing installation root"))?,
    );
    let _helper = HelperCleanup(options.get("--self-clean").map(String::as_str) == Some("yes"));
    let mut registry = Registry::open(&registry_directory()?)?;
    if operation == "prepare-upgrade" {
        if root.exists() {
            let active = registry.use_lock(&files::real_directory(&root)?)?;
            active
                .try_lock_exclusive()
                .map_err(|_| invalid("close Ash before upgrading this installation"))?;
        }
        // Keep the old application closed even if cleanup or native file
        // replacement fails partway through. Registration completes recovery.
        ash_utils_path::write_atomically(
            &registry.operation_path(&crate::absolute_path(&root)?),
            b"{\"operation\":\"upgrade\"}",
        )?;
        return crate::upgrade::prepare(
            &root,
            Path::new(
                options
                    .get("--incoming")
                    .ok_or_else(|| invalid("missing incoming installation manifest"))?,
            ),
        );
    }
    if operation == "finish-uninstall" && product == Product::Desktop {
        return finish_uninstall(&mut registry, &root);
    }
    if operation == "lease" {
        registry.require_launchable(&files::real_directory(&root)?)?;
        registry.register(
            product,
            &root,
            None,
            options.get("--profile").map(|profile| {
                (
                    Path::new(profile),
                    options.get("--user-data").map(Path::new),
                )
            }),
        )?;
        let lease = registry.use_lock(&files::real_directory(&root)?)?;
        FileExt::lock_shared(&lease)?;
        drop(registry);
        println!("ready");
        io::stdout().flush()?;
        io::copy(&mut io::stdin(), &mut io::sink())?;
        return Ok(());
    }
    let result = match operation.as_str() {
        "register" => registry
            .register(
                product,
                &root,
                options.get("--launcher-dir").map(Path::new),
                options.get("--profile").map(|profile| {
                    (
                        Path::new(profile),
                        options.get("--user-data").map(Path::new),
                    )
                }),
            )
            .and_then(|()| registry.finish_operation(&files::real_directory(&root)?)),
        "uninstall" | "prepare-uninstall" => {
            if product == Product::Desktop && operation == "uninstall" {
                return Err(invalid(
                    "Desktop files must be removed by the platform installer",
                ));
            }
            let mode = match options
                .get("--mode")
                .map(String::as_str)
                .unwrap_or("keep-data")
            {
                "keep-data" => RemovalMode::KeepData,
                "purge" => RemovalMode::Purge,
                _ => return Err(invalid("removal mode must be keep-data or purge")),
            };
            uninstall(
                &mut registry,
                product,
                &root,
                mode,
                operation == "uninstall",
                stop,
            )
        }
        _ => Err(invalid("unknown installation operation")),
    };
    drop(registry);
    result
}

fn finish_uninstall(registry: &mut Registry, root: &Path) -> io::Result<()> {
    let root = crate::absolute_path(root)?;
    let path = report_path(&registry.directory, &root);
    let mut result: serde_json::Value =
        serde_json::from_slice(&files::read_bounded_with_limit(&path, 16 * 1024 * 1024)?)
            .map_err(invalid)?;
    if result["status"] != "prepared" {
        return Err(invalid("uninstall cleanup was not prepared"));
    }
    let completion = (|| {
        let files = result["programFiles"]
            .as_array()
            .ok_or_else(|| invalid("uninstall has no program-file inventory"))?;
        for value in files {
            let file = Path::new(
                value
                    .as_str()
                    .ok_or_else(|| invalid("invalid program-file inventory"))?,
            );
            if !file.starts_with(&root)
                || file
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir))
            {
                return Err(invalid("invalid program-file inventory"));
            }
            match fs::symlink_metadata(file) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
                Ok(_) => {
                    return Err(invalid(format!(
                        "native uninstaller left program file: {}",
                        file.display()
                    )));
                }
            }
        }
        registry.release(Product::Desktop, &root)?;
        registry.finish_operation(&root)
    })();
    result["status"] = if completion.is_ok() {
        "complete"
    } else {
        "failed"
    }
    .into();
    if let Err(error) = &completion {
        result["report"]["failures"] = json!([error.to_string()]);
    }
    ash_utils_path::write_atomically(&path, &serde_json::to_vec_pretty(&result).map_err(invalid)?)?;
    completion
}

struct HelperCleanup(bool);

impl Drop for HelperCleanup {
    fn drop(&mut self) {
        if self.0 {
            if let Err(error) = cleanup_helper() {
                eprintln!("uninstall helper cleanup: {error}");
            }
        }
    }
}

fn uninstall(
    registry: &mut Registry,
    product: Product,
    root: &Path,
    mode: RemovalMode,
    remove_product: bool,
    mut stop: impl FnMut(&Path) -> io::Result<()>,
) -> io::Result<()> {
    let root = files::real_directory(root)?;
    let original = registry.receipts.installations.clone();
    let program_files = if product == Product::Desktop {
        crate::upgrade::installed_files(&root)?
    } else {
        Vec::new()
    };
    let installation = original
        .iter()
        .find(|item| item.root == root && item.product == product)
        .ok_or_else(|| invalid("installation has no receipt"))?
        .clone();
    let outcome = (|| {
        if product == Product::Desktop && !crate::upgrade::eligible(&root)? {
            return Err(invalid(
                "installation contains links or repositories; native removal is unsafe",
            ));
        }
        let active = registry.use_lock(&root)?;
        active
            .try_lock_exclusive()
            .map_err(|_| invalid("close Ash before uninstalling this installation"))?;
        drop(active); // The registry lock prevents a new client from registering.
        // Do not erase user data before discovering that a live CLI still owns
        // the package. Hold every generation lease through the whole removal.
        let update_lock = if product == Product::Cli {
            selected_cli_package(&root)?;
            Some(lock_file(&root.join("update.lock"))?)
        } else {
            None
        };
        let _launcher_lock = if product == Product::Cli {
            installation
                .launcher_directory
                .as_ref()
                .map(|directory| {
                    files::real_directory(directory)?;
                    lock_file(&directory.join(".ash-launcher.lock"))
                })
                .transpose()?
        } else {
            None
        };
        let leases = if product == Product::Cli {
            lease_cli_packages(&root)?
        } else {
            Vec::new()
        };
        let exclusive = installation
            .profiles
            .iter()
            .filter(|profile| {
                !profile.legacy
                    && !original.iter().any(|other| {
                        other.root != root && crate::profile_overlaps_installation(profile, other)
                    })
            })
            .map(|profile| profile.root.clone())
            .collect::<Vec<_>>();
        // Stop all exclusive profiles before removing any system or data objects.
        for profile in &exclusive {
            stop(profile)?;
        }
        #[cfg(windows)]
        let program_roots = match product {
            Product::Desktop => vec![root.clone()],
            Product::Cli => leases.iter().map(|(package, _)| package.clone()).collect(),
        };
        #[cfg(windows)]
        let shared_system = crate::windows::cleanup(
            product,
            &root,
            &program_roots,
            &exclusive,
            registry.directory == crate::default_registry_directory()?
                && original.len() == 1
                && dirs::home_dir().is_some_and(|home| exclusive.contains(&home.join(".ash")))
                && installation.profiles.iter().all(|profile| !profile.legacy),
        )?;
        let mut report = registry.remove(product, &root, mode, |_| Ok(()))?;
        #[cfg(windows)]
        report.retained.extend(shared_system);
        if remove_product {
            match product {
                Product::Cli => remove_cli(
                    &root,
                    installation.launcher_directory.as_deref(),
                    installation.launcher_sha256.as_deref(),
                    &mut report,
                    leases,
                )?,
                Product::Desktop => {
                    return Err(invalid(
                        "Desktop files must be removed by the platform installer",
                    ));
                }
            }
            drop(update_lock);
            files::remove_owned_tree(&root.join("update.lock"), &mut report)?;
            remove_empty(&root)?;
            if report.failures.is_empty() {
                registry.release(product, &root)?;
            }
        }
        Ok::<_, io::Error>(report)
    })();
    let mut report = match outcome {
        Ok(report) => report,
        Err(error) => RemovalReport {
            failures: vec![error.to_string()],
            ..RemovalReport::default()
        },
    };
    if !report.failures.is_empty() {
        registry.receipts.installations = original;
        registry.save()?;
    }
    report.retained.sort();
    report.retained.dedup();
    if !remove_product && report.failures.is_empty() {
        // Keep new Desktop processes out between this helper returning and the
        // native uninstaller finishing. A crash retains the guard for recovery.
        ash_utils_path::write_atomically(
            &registry.operation_path(&root),
            b"{\"operation\":\"uninstall\"}",
        )?;
    }
    let result = json!({"status": if !report.failures.is_empty() { "failed" } else if remove_product { "complete" } else { "prepared" }, "report": report, "programFiles": program_files});
    ash_utils_path::write_atomically(
        &report_path(&registry.directory, &root),
        &serde_json::to_vec_pretty(&result).map_err(invalid)?,
    )?;
    println!("{}", serde_json::to_string(&result).map_err(invalid)?);
    if report.failures.is_empty() {
        Ok(())
    } else {
        Err(invalid(
            "installation cleanup failed; see the removal report",
        ))
    }
}

pub(crate) fn report_path(registry: &Path, root: &Path) -> PathBuf {
    let id = format!(
        "{:x}",
        Sha256::digest(root.as_os_str().to_string_lossy().as_bytes())
    );
    registry.join(format!("removal-{id}.json"))
}

pub(crate) fn executable(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

pub(crate) fn selected_cli_package(root: &Path) -> io::Result<PathBuf> {
    let marker: serde_json::Value =
        serde_json::from_slice(&files::read_bounded(&root.join("install.json"))?)
            .map_err(invalid)?;
    if marker["schemaVersion"] != 1 || marker["repository"] != "chogng/ash" {
        return Err(invalid("unrecognized CLI installation"));
    }
    #[cfg(windows)]
    let package = {
        let name =
            String::from_utf8(files::read_bounded(&root.join("current"))?).map_err(invalid)?;
        let name = name.trim();
        if name.is_empty()
            || Path::new(name).components().count() != 1
            || !matches!(
                Path::new(name).components().next(),
                Some(std::path::Component::Normal(_))
            )
        {
            return Err(invalid("invalid CLI version selection"));
        }
        root.join("versions").join(name)
    };
    #[cfg(unix)]
    let package = {
        let target = fs::read_link(root.join("current"))?;
        if target.is_absolute() || target.parent() != Some(Path::new("versions")) {
            return Err(invalid("unmanaged CLI version selection"));
        }
        root.join(target)
    };
    files::real_directory(&package)
}

fn lease_cli_packages(root: &Path) -> io::Result<Vec<(PathBuf, ash_package_store::PackageLease)>> {
    let versions = root.join("versions");
    files::real_directory(&versions)?;
    let mut packages = Vec::new();
    // Preflight all owned packages and leases before mutating the launcher.
    for entry in fs::read_dir(&versions)? {
        let entry = entry?;
        let package = entry.path();
        if !entry.file_type()?.is_dir()
            || !package.join(".lease").is_file()
            || ash_package_store::validate_package_identity(&package).is_err()
        {
            continue;
        }
        files::real_directory(&package)?;
        let lease = ash_package_store::PackageLease::try_exclusive(&package)?
            .ok_or_else(|| invalid("an Ash CLI process is still using this installation"))?;
        packages.push((package, lease));
    }
    Ok(packages)
}

fn remove_cli(
    root: &Path,
    launcher: Option<&Path>,
    launcher_sha256: Option<&str>,
    report: &mut RemovalReport,
    packages: Vec<(PathBuf, ash_package_store::PackageLease)>,
) -> io::Result<()> {
    let versions = root.join("versions");
    if let Some(launcher) = launcher {
        remove_launcher(root, launcher, launcher_sha256, report)?;
    }
    for (package, lease) in packages {
        for entry in fs::read_dir(&package)? {
            let entry = entry?;
            if entry.file_name() != ".lease" {
                files::remove_owned_tree(&entry.path(), report)?;
            }
        }
        drop(lease);
        files::remove_owned_tree(&package.join(".lease"), report)?;
        remove_empty(&package)?;
    }
    // `current` is an owned symlink on Unix; remove the link, never its target.
    fs::remove_file(root.join("current"))?;
    for name in [
        "install.json",
        "update-status.json",
        "last-update-check-latest",
        "last-update-check-stable",
        ".current-next",
    ] {
        let path = root.join(name);
        if path.exists() {
            files::remove_owned_tree(&path, report)?;
        }
    }
    remove_empty(&versions)?;
    if versions.exists() {
        report.retained.push(versions);
    }
    remove_empty(root)
}

fn lock_file(path: &Path) -> io::Result<fs::File> {
    files::require_regular_or_missing(path)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    lock.try_lock_exclusive()
        .map_err(|_| invalid("another Ash installation operation is still running"))?;
    Ok(lock)
}

fn remove_launcher(
    root: &Path,
    directory: &Path,
    expected_digest: Option<&str>,
    report: &mut RemovalReport,
) -> io::Result<()> {
    files::real_directory(directory)?;
    #[cfg(unix)]
    {
        let _ = expected_digest;
        let launcher = directory.join("ash");
        if fs::read_link(&launcher).ok().as_deref() == Some(root.join("current/bin/ash").as_path())
        {
            fs::remove_file(&launcher)?;
            report.removed.push(launcher);
        } else {
            report.retained.push(launcher);
        }
    }
    #[cfg(windows)]
    {
        let binding = directory.join("ash-launcher.json");
        if !binding.exists() {
            return Ok(());
        }
        let value: serde_json::Value =
            serde_json::from_slice(&files::read_bounded(&binding)?).map_err(invalid)?;
        let owner = value["installRoot"]
            .as_str()
            .map(Path::new)
            .map(crate::absolute_path)
            .transpose()?;
        if value["schemaVersion"] != 1 || owner.as_deref() != Some(root) {
            report.retained.push(binding);
            return Ok(());
        }
        let command = directory.join("ash.cmd");
        let adapter = directory.join("ash-launcher.exe");
        if adapter.exists() && expected_digest != Some(files::file_hash(&adapter)?.as_str()) {
            report.retained.extend([command, binding, adapter]);
            return Ok(());
        }
        let expected = b"@echo off\r\nsetlocal DisableDelayedExpansion\r\n\"%~dp0ash-launcher.exe\" %*\r\nexit /b %errorlevel%\r\n";
        if command.exists() && files::read_bounded(&command)? != expected {
            report
                .retained
                .extend([command, binding, directory.join("ash-launcher.exe")]);
            return Ok(());
        }
        for path in [command, directory.join("ash-launcher.exe"), binding] {
            // The immutable adapter exits immediately after its child CLI. Allow
            // that exact executable to finish without killing unrelated clients.
            let mut attempt = 0;
            while path.exists() {
                files::require_regular_or_missing(&path)?;
                match fs::remove_file(&path) {
                    Ok(()) => {
                        report.removed.push(path.clone());
                        break;
                    }
                    Err(error)
                        if matches!(error.raw_os_error(), Some(5 | 32 | 33)) && attempt < 50 =>
                    {
                        attempt += 1;
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    Err(error) => return Err(error),
                }
            }
        }
    }
    Ok(())
}

fn remove_empty(path: &Path) -> io::Result<()> {
    if path.exists() && fs::read_dir(path)?.next().is_none() {
        fs::remove_dir(path)?;
    }
    Ok(())
}

pub(crate) fn hidden_command(program: &Path) -> Command {
    let command = Command::new(program);
    #[cfg(windows)]
    let command = {
        use std::os::windows::process::CommandExt;
        let mut command = command;
        command.creation_flags(0x08000000);
        command
    };
    command
}

/// Starts removal outside the selected CLI package. The caller must exit after
/// returning the report path; the helper waits for its inherited stdin to close.
pub fn schedule_cli_removal(root: &Path, mode: RemovalMode) -> io::Result<PathBuf> {
    let root = files::real_directory(root)?;
    let package = selected_cli_package(&root)?;
    ash_package_store::validate_package_identity(&package)?;
    let registry = Registry::open(&registry_directory()?)?;
    if !registry
        .receipts
        .installations
        .iter()
        .any(|install| install.product == Product::Cli && install.root == root)
    {
        return Err(invalid("CLI installation has no receipt"));
    }
    let report = report_path(&registry.directory, &root);
    ash_utils_path::write_atomically(&report, b"{\"status\":\"pending\"}\n")?;
    let temporary = tempfile::Builder::new()
        .prefix("ash-uninstall-")
        .tempdir()?;
    let helper = temporary.path().join(executable("ash-app-server-daemon"));
    fs::copy(
        package
            .join("bin")
            .join(executable("ash-app-server-daemon")),
        &helper,
    )?;
    let mut child = hidden_command(&helper)
        .args(["installation", "uninstall", "--product", "cli", "--root"])
        .arg(&root)
        .args([
            "--mode",
            if mode == RemovalMode::Purge {
                "purge"
            } else {
                "keep-data"
            },
            "--wait-stdin",
            "yes",
            "--self-clean",
            "yes",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    // Keep the pipe until process exit, including through the Windows adapter.
    // ChildStdin is intentionally retained: the process owns this handoff.
    std::mem::forget(
        child
            .stdin
            .take()
            .ok_or_else(|| invalid("missing uninstall handoff pipe"))?,
    );
    let _ = temporary.keep();
    Ok(report)
}

fn cleanup_helper() -> io::Result<()> {
    let executable = std::env::current_exe()?;
    let directory = executable
        .parent()
        .ok_or_else(|| invalid("uninstall helper has no directory"))?;
    let temporary = dunce::canonicalize(std::env::temp_dir())?;
    let directory = files::real_directory(directory)?;
    if directory.parent() != Some(temporary.as_path())
        || !directory
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("ash-uninstall-"))
    {
        return Err(invalid(
            "uninstall helper is outside its temporary directory",
        ));
    }
    #[cfg(unix)]
    {
        fs::remove_file(executable)?;
        fs::remove_dir(directory)
    }
    #[cfg(windows)]
    {
        let quote = |path: &Path| format!("'{}'", path.display().to_string().replace('\'', "''"));
        let script = format!(
            "$p = Get-Process -Id {} -ErrorAction SilentlyContinue; if ($p) {{ $p.WaitForExit() }}; Remove-Item -LiteralPath {} -Force; Remove-Item -LiteralPath {}",
            std::process::id(),
            quote(&executable),
            quote(&directory)
        );
        let powershell = PathBuf::from(
            std::env::var_os("SystemRoot").ok_or_else(|| invalid("SystemRoot is unavailable"))?,
        )
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        hidden_command(&powershell)
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "command_tests.rs"]
mod tests;
