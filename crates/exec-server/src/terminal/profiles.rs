use crate::terminal::TerminalArguments;
use crate::terminal::TerminalProfile;
use crate::terminal::TerminalProfileSelection;
use crate::terminal::command_status::CommandStatusMode;
use crate::terminal::environment::TerminalEnvironment;
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;

/// Frozen trusted shell catalog used by one local Terminal service.
pub(crate) struct TerminalProfileCatalog {
    environment: TerminalEnvironment,
    profiles: Vec<TerminalProfileSpec>,
}

impl TerminalProfileCatalog {
    pub(crate) fn discover() -> Self {
        let environment = TerminalEnvironment::from_process();
        let profiles = discover_profiles(environment.variables());
        Self {
            environment,
            profiles,
        }
    }

    pub(crate) fn environment(&self) -> &HashMap<String, String> {
        self.environment.variables()
    }

    pub(crate) fn list(&self) -> Vec<TerminalProfile> {
        self.profiles
            .iter()
            .map(TerminalProfileSpec::profile)
            .collect()
    }

    pub(crate) fn resolve(
        &self,
        selection: &TerminalProfileSelection,
    ) -> Option<Cow<'_, TerminalProfileSpec>> {
        match selection {
            TerminalProfileSelection::Default => self
                .profiles
                .iter()
                .find(|profile| profile.is_default)
                .map(Cow::Borrowed),
            TerminalProfileSelection::Profile { profile_id } => self
                .profiles
                .iter()
                .find(|profile| profile.profile_id == *profile_id)
                .map(Cow::Borrowed),
            TerminalProfileSelection::Custom { name, path, args } => {
                if name.trim().is_empty()
                    || name.len() > 256
                    || name.chars().any(char::is_control)
                    || path.is_empty()
                    || path.len() > 32
                    || !valid_arguments(args)
                    || path
                        .iter()
                        .any(|path| path.is_empty() || path.len() > 32768 || path.contains('\0'))
                {
                    return None;
                }
                let program = path.iter().find_map(|candidate| {
                    let path = Path::new(candidate);
                    let resolved = if path.is_absolute() {
                        Some(path.to_path_buf())
                    } else if path.components().count() == 1 {
                        resolve_on_path(self.environment(), candidate)
                    } else {
                        None
                    }?;
                    executable_file(&resolved).then_some(resolved)
                })?;
                Some(Cow::Owned(TerminalProfileSpec {
                    profile_id: format!("custom:{name}"),
                    title: name.clone(),
                    program: program.to_str()?.to_owned(),
                    args: args.clone(),
                    is_default: false,
                }))
            }
        }
    }

    pub(crate) fn default_command(&self, command: &str) -> (String, Vec<String>) {
        let profile = self
            .resolve(&TerminalProfileSelection::Default)
            .expect("discovery always installs one default Terminal profile");
        (profile.program.clone(), profile.command_args(command))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ShellKind {
    PowerShell,
    Bash,
    Zsh,
    Other,
}

#[derive(Clone)]
pub(crate) struct TerminalProfileSpec {
    pub(crate) profile_id: String,
    pub(crate) title: String,
    pub(crate) program: String,
    pub(crate) args: TerminalArguments,
    is_default: bool,
}

impl TerminalProfileSpec {
    pub(crate) fn profile(&self) -> TerminalProfile {
        TerminalProfile {
            profile_id: self.profile_id.clone(),
            title: self.title.clone(),
            is_default: self.is_default,
        }
    }

    pub(crate) fn launch_args(&self) -> TerminalArguments {
        self.args.clone()
    }

    pub(crate) fn shell_kind(&self) -> ShellKind {
        match Path::new(&self.program)
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "pwsh" | "powershell" => ShellKind::PowerShell,
            "bash" => ShellKind::Bash,
            "zsh" => ShellKind::Zsh,
            _ => ShellKind::Other,
        }
    }

    pub(crate) fn command_status_mode(&self) -> CommandStatusMode {
        match self.shell_kind() {
            ShellKind::PowerShell => CommandStatusMode::ShellIntegration,
            ShellKind::Bash | ShellKind::Zsh => CommandStatusMode::ShellIntegration,
            ShellKind::Other => CommandStatusMode::Disabled,
        }
    }

    pub(crate) fn command_args(&self, command: &str) -> Vec<String> {
        match profile_for_program(self.program.clone(), false)
            .profile_id
            .as_str()
        {
            "powershell" | "windows-powershell" => vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                command.into(),
            ],
            "command-prompt" => {
                vec!["/D".into(), "/S".into(), "/C".into(), command.into()]
            }
            _ => vec!["-lc".into(), command.into()],
        }
    }
}

fn discover_profiles(environment: &HashMap<String, String>) -> Vec<TerminalProfileSpec> {
    let default_program = default_shell(environment);
    let mut candidates = vec![profile_for_program(default_program, true)];
    candidates.extend(platform_profiles(environment));
    let mut profiles: Vec<TerminalProfileSpec> = Vec::new();
    for candidate in candidates {
        // Distributions share wsl.exe; launch arguments are part of shell identity.
        if !profiles.iter().any(|profile| {
            normalized_program(&profile.program) == normalized_program(&candidate.program)
                && profile.args == candidate.args
        }) {
            profiles.push(candidate);
        }
    }
    profiles
}

#[cfg(windows)]
fn platform_profiles(environment: &HashMap<String, String>) -> Vec<TerminalProfileSpec> {
    let mut profiles = Vec::new();
    if let Some(program) = powershell_on_path(environment).or_else(|| {
        let program = Path::new(environment_value(environment, "PROGRAMFILES")?)
            .join("PowerShell/7/pwsh.exe");
        usable_powershell(&program).then_some(program)
    }) {
        profiles.push(profile("powershell", "PowerShell", program));
    }
    if let Some(system_root) = environment_value(environment, "SYSTEMROOT") {
        let windows_powershell = Path::new(system_root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if windows_powershell.is_file() {
            profiles.push(profile(
                "windows-powershell",
                "Windows PowerShell",
                windows_powershell,
            ));
        }
    }
    if let Some(comspec) = environment_value(environment, "COMSPEC") {
        profiles.push(profile(
            "command-prompt",
            "Command Prompt",
            PathBuf::from(comspec),
        ));
    }
    for root_key in ["PROGRAMFILES", "LOCALAPPDATA"] {
        let Some(root) = environment_value(environment, root_key) else {
            continue;
        };
        let git_bash = if root_key == "PROGRAMFILES" {
            Path::new(root).join("Git").join("bin").join("bash.exe")
        } else {
            Path::new(root)
                .join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe")
        };
        if git_bash.is_file() {
            profiles.push(profile("git-bash", "Git Bash", git_bash));
        }
    }
    if let Some(program) = resolve_on_path(environment, "zsh.exe") {
        profiles.push(profile("zsh", "Zsh", program));
    }
    if let Some(system_root) = environment_value(environment, "SYSTEMROOT") {
        let launcher = Path::new(system_root).join("System32/wsl.exe");
        if launcher.is_file() {
            // Reading the execution user's registrations avoids starting WSL (or
            // waiting for its first-run installer) while opening a terminal menu.
            if let Ok(registrations) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
                .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Lxss")
            {
                profiles.extend(wsl_profiles(&launcher, &registrations));
            }
        }
    }
    profiles
}

#[cfg(windows)]
fn wsl_profiles(launcher: &Path, registrations: &winreg::RegKey) -> Vec<TerminalProfileSpec> {
    let mut names = registrations
        .enum_keys()
        .take(128)
        .filter_map(Result::ok)
        .filter_map(|key| registrations.open_subkey(key).ok())
        .filter_map(|key| key.get_value::<String, _>("DistributionName").ok())
        .filter(|name| {
            !name.trim().is_empty() && name.len() <= 230 && !name.chars().any(char::is_control)
        })
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    names
        .into_iter()
        .map(|name| TerminalProfileSpec {
            profile_id: format!("wsl:{name}"),
            title: format!("{name} (WSL)"),
            program: launcher.to_string_lossy().into_owned(),
            args: TerminalArguments::Argv(vec!["--distribution".into(), name]),
            is_default: false,
        })
        .collect()
}

#[cfg(not(windows))]
fn platform_profiles(environment: &HashMap<String, String>) -> Vec<TerminalProfileSpec> {
    [
        ("bash", "Bash", "bash"),
        ("zsh", "Zsh", "zsh"),
        ("fish", "Fish", "fish"),
        ("sh", "Shell", "sh"),
    ]
    .into_iter()
    .filter_map(|(profile_id, title, executable)| {
        resolve_on_path(environment, executable).map(|program| profile(profile_id, title, program))
    })
    .collect()
}

fn profile(
    profile_id: impl Into<String>,
    title: impl Into<String>,
    program: PathBuf,
) -> TerminalProfileSpec {
    TerminalProfileSpec {
        profile_id: profile_id.into(),
        title: title.into(),
        program: program.to_string_lossy().into_owned(),
        args: TerminalArguments::Argv(Vec::new()),
        is_default: false,
    }
}

fn profile_for_program(program: String, is_default: bool) -> TerminalProfileSpec {
    let executable = Path::new(&program)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("shell")
        .to_ascii_lowercase();
    let (profile_id, title) = match executable.as_str() {
        "cmd" => ("command-prompt", "Command Prompt"),
        "powershell" => ("windows-powershell", "Windows PowerShell"),
        "pwsh" => ("powershell", "PowerShell"),
        "bash" => ("bash", "Bash"),
        "zsh" => ("zsh", "Zsh"),
        "fish" => ("fish", "Fish"),
        _ => ("default", "Default Shell"),
    };
    TerminalProfileSpec {
        profile_id: profile_id.into(),
        title: title.into(),
        program,
        args: TerminalArguments::Argv(Vec::new()),
        is_default,
    }
}

pub(crate) fn valid_arguments(args: &TerminalArguments) -> bool {
    match args {
        TerminalArguments::Argv(args) => {
            args.len() <= 1024
                && args
                    .iter()
                    .all(|value| value.len() <= 32768 && !value.contains('\0'))
        }
        TerminalArguments::CommandLine(value) => {
            cfg!(windows) && value.encode_utf16().count() < 32767 && !value.contains('\0')
        }
    }
}

fn resolve_on_path(environment: &HashMap<String, String>, executable: &str) -> Option<PathBuf> {
    let path = environment_value(environment, "PATH")?;
    std::env::split_paths(path)
        .map(|directory| directory.join(executable))
        .find(|candidate| candidate.is_file())
}

#[cfg(windows)]
fn powershell_on_path(environment: &HashMap<String, String>) -> Option<PathBuf> {
    let path = environment_value(environment, "PATH")?;
    std::env::split_paths(path)
        .map(|directory| directory.join("pwsh.exe"))
        .find(|candidate| usable_powershell(candidate))
}

#[cfg(windows)]
fn usable_powershell(path: &Path) -> bool {
    path.is_file()
        && !store_powershell(path)
        && std::fs::canonicalize(path).is_ok_and(|resolved| !store_powershell(&resolved))
}

#[cfg(any(windows, test))]
fn store_powershell(path: &Path) -> bool {
    // Store aliases and packaged PowerShell cannot start in PSEC. Other
    // framework executables under WindowsApps can still be usable.
    path.as_os_str()
        .to_string_lossy()
        .split(['\\', '/'])
        .skip_while(|component| !component.eq_ignore_ascii_case("WindowsApps"))
        .nth(1)
        .is_some_and(|component| {
            component.eq_ignore_ascii_case("pwsh.exe")
                || component.eq_ignore_ascii_case("powershell.exe")
                || component
                    .to_ascii_lowercase()
                    .starts_with("microsoft.powershell")
        })
}

fn environment_value<'a>(environment: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    environment
        .iter()
        .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.as_str())
}

fn normalized_program(program: &str) -> String {
    #[cfg(windows)]
    {
        program.replace('/', "\\").to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        program.to_owned()
    }
}

#[cfg(windows)]
fn default_shell(environment: &HashMap<String, String>) -> String {
    environment_value(environment, "COMSPEC")
        .map(str::to_owned)
        .unwrap_or_else(|| "cmd.exe".into())
}

#[cfg(not(windows))]
fn default_shell(environment: &HashMap<String, String>) -> String {
    environment
        .get("SHELL")
        .filter(|shell| shell.starts_with('/'))
        .cloned()
        .unwrap_or_else(|| "/bin/sh".into())
}

#[cfg(test)]
#[path = "profiles_tests.rs"]
mod tests;

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}
