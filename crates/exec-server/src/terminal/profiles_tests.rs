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
fn configured_shell_injection_preserves_explicit_commands_and_raw_arguments() {
    use crate::terminal::shell_integration::ShellIntegration;

    for (program, flag) in [
        ("pwsh.exe", "-Command"),
        ("powershell.exe", "-EncodedCommand"),
        ("pwsh", "-File"),
        ("bash", "-lc"),
        ("bash.exe", "--rcfile"),
        ("zsh", "-c"),
    ] {
        let profile = TerminalProfileSpec {
            profile_id: "custom:configured".into(),
            title: "Configured shell".into(),
            program: program.into(),
            args: TerminalArguments::Argv(vec![flag.into(), "literal value".into()]),
            is_default: false,
        };
        assert!(profile.command_status_mode() == CommandStatusMode::ShellIntegration);
        let launch = ShellIntegration::prepare(&profile, &HashMap::new()).unwrap();
        assert_eq!(launch.args, profile.args);
        assert!(launch.environment.is_empty());

        let profile = TerminalProfileSpec {
            args: TerminalArguments::CommandLine(" /quoted \"literal value\" ".into()),
            ..profile
        };
        let launch = ShellIntegration::prepare(&profile, &HashMap::new()).unwrap();
        assert_eq!(launch.args, profile.args);
        assert!(launch.environment.is_empty());
    }
}

#[test]
fn powershell_uses_host_markers_and_cmd_keeps_its_standard_launch() {
    let command_prompt = TerminalProfileSpec {
        profile_id: "command-prompt".into(),
        title: "Command Prompt".into(),
        program: "cmd.exe".into(),
        args: TerminalArguments::Argv(Vec::new()),
        is_default: true,
    };
    assert!(command_prompt.command_status_mode() == CommandStatusMode::Disabled);
    assert!(command_prompt.launch_args() == TerminalArguments::Argv(Vec::new()));

    let powershell = TerminalProfileSpec {
        profile_id: "powershell".into(),
        title: "PowerShell".into(),
        program: "pwsh.exe".into(),
        args: TerminalArguments::Argv(Vec::new()),
        is_default: false,
    };
    assert!(powershell.command_status_mode() == CommandStatusMode::ShellIntegration);
    let integration =
        crate::terminal::shell_integration::ShellIntegration::prepare(&powershell, &HashMap::new())
            .unwrap();
    let TerminalArguments::Argv(args) = &integration.args else {
        panic!("expected argv");
    };
    let path = args
        .last()
        .unwrap()
        .strip_prefix(". '")
        .unwrap()
        .strip_suffix('\'')
        .unwrap()
        .replace("''", "'");
    let command = std::fs::read_to_string(path).unwrap();
    assert!(
        !args
            .iter()
            .any(|arg| arg.contains(integration.nonce.as_ref().unwrap()))
    );
    assert!(command.contains("633;C"));
    assert!(command.contains("633;D"));
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

#[test]
fn custom_profiles_choose_the_first_executable_and_preserve_literal_arguments() {
    let catalog = TerminalProfileCatalog::discover();
    let discovered = catalog.resolve(&TerminalProfileSelection::Default).unwrap();
    let program = discovered.program.clone();
    let selection = TerminalProfileSelection::Custom {
        name: "Profile with spaces".into(),
        path: vec!["/definitely/missing/ash-shell".into(), program.clone()],
        args: TerminalArguments::Argv(vec!["argument with spaces".into(), "literal;$HOME".into()]),
    };
    let resolved = catalog.resolve(&selection).unwrap();
    assert_eq!(resolved.program, program);
    assert_eq!(
        resolved.args,
        TerminalArguments::Argv(vec!["argument with spaces".into(), "literal;$HOME".into()])
    );
    assert_eq!(resolved.profile_id, "custom:Profile with spaces");
    assert_eq!(resolved.title, "Profile with spaces");
    assert!(!resolved.is_default);
}

#[test]
fn custom_profiles_reject_invalid_names_candidates_and_arguments() {
    let catalog = TerminalProfileCatalog::discover();
    let program = catalog
        .resolve(&TerminalProfileSelection::Default)
        .unwrap()
        .program
        .clone();
    for (name, path, args) in [
        ("bad\nname", vec![program.clone()], vec![]),
        ("", vec![program.clone()], vec![]),
        ("custom", vec![], vec![]),
        ("custom", vec!["relative/unknown-shell".into()], vec![]),
        ("custom", vec![program.clone()], vec!["nul\0arg".into()]),
        ("custom", vec!["nul\0path".into()], vec![]),
    ] {
        assert!(
            catalog
                .resolve(&TerminalProfileSelection::Custom {
                    name: name.into(),
                    path,
                    args: TerminalArguments::Argv(args)
                })
                .is_none()
        );
    }
}

#[test]
fn raw_profile_arguments_are_windows_only_and_preserve_original_quoting() {
    let catalog = TerminalProfileCatalog::discover();
    let program = catalog
        .resolve(&TerminalProfileSelection::Default)
        .unwrap()
        .program
        .clone();
    for raw in [r#"/d /s /c "echo two words & literal;$HOME""#, ""] {
        let selection = TerminalProfileSelection::Custom {
            name: "Raw shell".into(),
            path: vec![program.clone()],
            args: TerminalArguments::CommandLine(raw.into()),
        };
        let resolved = catalog.resolve(&selection);
        if cfg!(windows) {
            assert_eq!(
                resolved.unwrap().launch_args(),
                TerminalArguments::CommandLine(raw.into())
            );
        } else {
            assert!(resolved.is_none());
        }
    }
    for raw in ["invalid\0argument".into(), "x".repeat(32769)] {
        assert!(!valid_arguments(&TerminalArguments::CommandLine(raw)));
    }
}

#[test]
fn shell_nonce_rotates_per_launch_and_is_not_exported_to_children_or_read_snapshots() {
    use crate::terminal::command_status::TerminalCommandStatusTracker;
    use crate::terminal::shell_integration::ShellIntegration;
    for program in ["bash", "zsh", "pwsh.exe"] {
        let profile = TerminalProfileSpec {
            profile_id: "custom:configured".into(),
            title: "Configured".into(),
            program: program.into(),
            args: TerminalArguments::Argv(Vec::new()),
            is_default: false,
        };
        let first = ShellIntegration::prepare(&profile, &HashMap::new()).unwrap();
        let second = ShellIntegration::prepare(&profile, &HashMap::new()).unwrap();
        let old = first.nonce.as_ref().unwrap();
        let new = second.nonce.as_ref().unwrap();
        assert_eq!(old.len(), 64);
        assert_ne!(old, new);
        assert!(!first.environment.values().any(|value| value.contains(old)));
        let mut tracker = TerminalCommandStatusTracker::new(
            CommandStatusMode::ShellIntegration,
            Some(new.clone()),
        );
        let parsed = tracker.parse_output(format!("\x1b]633;E;stale;{old}\x07").into_bytes());
        assert!(
            matches!(&parsed[0], crate::terminal::command_status::ParsedTerminalOutput::CommandLine(command, false) if command == "stale")
        );
    }
}
