use crate::terminal::TerminalProfile;
use crate::terminal::TerminalProfileSelection;
use crate::terminal::environment::TerminalEnvironment;
use std::collections::HashMap;
use std::collections::HashSet;
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
    ) -> Option<&TerminalProfileSpec> {
        match selection {
            TerminalProfileSelection::Default => {
                self.profiles.iter().find(|profile| profile.is_default)
            }
            TerminalProfileSelection::Profile { profile_id } => self
                .profiles
                .iter()
                .find(|profile| profile.profile_id == *profile_id),
        }
    }

    pub(crate) fn default_command(&self, command: &str) -> (String, Vec<String>) {
        let profile = self
            .resolve(&TerminalProfileSelection::Default)
            .expect("discovery always installs one default Terminal profile");
        (profile.program.clone(), profile.command_args(command))
    }
}

pub(crate) struct TerminalProfileSpec {
    pub(crate) profile_id: String,
    pub(crate) title: String,
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
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

    pub(crate) fn launch_args(&self) -> Vec<String> {
        match self.profile_id.as_str() {
            "powershell" | "windows-powershell" => vec![
                "-NoExit".into(),
                "-Command".into(),
                powershell_integration_script().into(),
            ],
            "command-prompt" => vec![
                "/Q".into(),
                "/K".into(),
                r"prompt $E]633;D$E\$E]633;A$E\$P$G$S".into(),
            ],
            _ => self.args.clone(),
        }
    }

    pub(crate) fn command_status_enabled(&self) -> bool {
        matches!(
            self.profile_id.as_str(),
            "powershell" | "windows-powershell" | "command-prompt"
        )
    }

    fn command_args(&self, command: &str) -> Vec<String> {
        match self.profile_id.as_str() {
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

fn powershell_integration_script() -> &'static str {
    r#"function global:prompt { $ashSuccess = $?; $ashExitCode = if ($ashSuccess) { 0 } elseif (($global:LASTEXITCODE -is [int]) -and $global:LASTEXITCODE -ne 0) { $global:LASTEXITCODE } else { 1 }; [Console]::Write("`e]633;D;$ashExitCode`a`e]633;A`a"); "PS $($executionContext.SessionState.Path.CurrentLocation)> " }"#
}

fn discover_profiles(environment: &HashMap<String, String>) -> Vec<TerminalProfileSpec> {
    let default_program = default_shell(environment);
    let mut candidates = vec![profile_for_program(default_program, true)];
    candidates.extend(platform_profiles(environment));
    let mut paths = HashSet::new();
    candidates
        .into_iter()
        .filter(|profile| paths.insert(normalized_program(&profile.program)))
        .collect()
}

#[cfg(windows)]
fn platform_profiles(environment: &HashMap<String, String>) -> Vec<TerminalProfileSpec> {
    let mut profiles = Vec::new();
    if let Some(program) = resolve_on_path(environment, "pwsh.exe") {
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
    profiles
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
        args: Vec::new(),
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
        args: Vec::new(),
        is_default,
    }
}

fn resolve_on_path(environment: &HashMap<String, String>, executable: &str) -> Option<PathBuf> {
    let path = environment_value(environment, "PATH")?;
    std::env::split_paths(path)
        .map(|directory| directory.join(executable))
        .find(|candidate| candidate.is_file())
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
