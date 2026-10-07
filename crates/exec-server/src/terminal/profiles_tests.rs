use super::*;

#[test]
fn discovered_profiles_have_one_default_and_unique_programs() {
    let catalog = TerminalProfileCatalog::discover();
    let profiles = catalog.list();
    assert_eq!(
        profiles.iter().filter(|profile| profile.is_default).count(),
        1
    );
    let programs = catalog
        .profiles
        .iter()
        .map(|profile| normalized_program(&profile.program))
        .collect::<HashSet<_>>();
    assert_eq!(programs.len(), profiles.len());
}

#[test]
fn tracked_windows_shells_launch_with_shell_integration_markers() {
    let command_prompt = TerminalProfileSpec {
        profile_id: "command-prompt".into(),
        title: "Command Prompt".into(),
        program: "cmd.exe".into(),
        args: Vec::new(),
        is_default: true,
    };
    assert!(command_prompt.command_status_enabled());
    assert!(command_prompt.launch_args().join(" ").contains("633;D"));

    let powershell = TerminalProfileSpec {
        profile_id: "powershell".into(),
        title: "PowerShell".into(),
        program: "pwsh.exe".into(),
        args: Vec::new(),
        is_default: false,
    };
    assert!(powershell.command_status_enabled());
    assert!(powershell.launch_args().join(" ").contains("633;A"));
    assert_eq!(
        powershell.command_args("Get-Location"),
        [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-Location"
        ]
    );
    assert_eq!(
        command_prompt.command_args("echo ready"),
        ["/D", "/S", "/C", "echo ready"]
    );
}

#[cfg(windows)]
#[test]
fn windows_discovers_zsh_from_path() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("zsh.exe"), []).unwrap();
    let mut environment = HashMap::new();
    environment.insert(
        "PATH".to_owned(),
        directory.path().to_string_lossy().into_owned(),
    );

    let profiles = platform_profiles(&environment);
    assert!(profiles.iter().any(|profile| profile.profile_id == "zsh"));
}
