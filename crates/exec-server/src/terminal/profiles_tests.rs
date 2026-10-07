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

#[test]
fn powershell_store_paths_are_distinguished_from_other_windowsapps_frameworks() {
    for path in [
        r"C:\Users\user\AppData\Local\Microsoft\WindowsApps\pwsh.exe",
        r"C:\Users\user\AppData\Local\Microsoft\WindowsApps\PowerShell.exe",
        r"C:\Program Files\WindowsApps\Microsoft.PowerShell_test\pwsh.exe",
        r"C:\Program Files\wInDoWsApPs\Microsoft.PowerShellPreview_test\pwsh.exe",
    ] {
        assert!(store_powershell(Path::new(path)), "{path}");
    }
    for path in [
        r"C:\Program Files\WindowsApps\Ash.Runtime_test\dependencies\powershell\pwsh.exe",
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        r"C:\portable\NotWindowsApps\pwsh.exe",
    ] {
        assert!(!store_powershell(Path::new(path)), "{path}");
    }
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

#[cfg(windows)]
#[test]
fn discovery_skips_store_powershell_and_keeps_compatible_frameworks() {
    let root = tempfile::tempdir().unwrap();
    let alias = root.path().join("wInDoWsApPs");
    let package = alias.join("Microsoft.PowerShellPreview_test");
    let framework = alias.join("Ash.Runtime_test/dependencies/powershell");
    for directory in [&alias, &package, &framework] {
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(directory.join("pwsh.exe"), []).unwrap();
    }
    let environment = HashMap::from([(
        "PATH".into(),
        std::env::join_paths([&alias, &package, &framework])
            .unwrap()
            .into_string()
            .unwrap(),
    )]);
    let profiles = discover_profiles(&environment);
    let powershell = profiles
        .iter()
        .find(|profile| profile.profile_id == "powershell")
        .unwrap();
    assert_eq!(Path::new(&powershell.program), framework.join("pwsh.exe"));
}

#[cfg(windows)]
#[test]
fn discovery_uses_installed_powershell_when_path_only_has_a_store_alias() {
    let root = tempfile::tempdir().unwrap();
    let alias = root.path().join("WindowsApps");
    let installed = root.path().join("Program Files/PowerShell/7");
    for directory in [&alias, &installed] {
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(directory.join("pwsh.exe"), []).unwrap();
    }
    let environment = HashMap::from([
        ("PATH".into(), alias.to_str().unwrap().into()),
        (
            "PROGRAMFILES".into(),
            root.path().join("Program Files").to_str().unwrap().into(),
        ),
    ]);
    let profiles = discover_profiles(&environment);
    let powershell = profiles
        .iter()
        .find(|profile| profile.profile_id == "powershell")
        .unwrap();
    assert_eq!(Path::new(&powershell.program), installed.join("pwsh.exe"));
    std::fs::remove_file(installed.join("pwsh.exe")).unwrap();
    assert!(
        discover_profiles(&environment)
            .iter()
            .all(|profile| profile.profile_id != "powershell")
    );
}
