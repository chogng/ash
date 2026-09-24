use super::*;
use clap::CommandFactory;
use clap::error::ErrorKind;

#[test]
fn command_graph_is_valid_and_defaults_to_interactive() {
    Cli::command().debug_assert();
    assert!(Cli::try_parse_from(["ash"]).unwrap().command.is_none());
}

#[test]
fn help_and_version_do_not_dispatch_commands() {
    for command in [
        "exec",
        "ask",
        "resume",
        "sessions",
        "fork",
        "archive",
        "unarchive",
        "login",
        "logout",
        "mcp",
        "plugin",
        "doctor",
        "app-server",
        "remote",
        "update",
    ] {
        let error = Cli::try_parse_from(["ash", command, "--help"])
            .err()
            .unwrap();
        assert_eq!(error.kind(), ErrorKind::DisplayHelp, "{command}");
    }
    assert_eq!(
        Cli::try_parse_from(["ash", "--version"])
            .err()
            .unwrap()
            .kind(),
        ErrorKind::DisplayVersion
    );
}

#[test]
fn invalid_commands_and_missing_identities_are_usage_errors() {
    for args in [
        vec!["ash", "unknown"],
        vec!["ash", "resume", "session"],
        vec!["ash", "resume", "session", "thread", "extra"],
        vec!["ash", "fork", "session"],
        vec!["ash", "mcp", "add", "server"],
        vec![
            "ash",
            "mcp",
            "add",
            "server",
            "--url",
            "https://example.test",
            "--",
            "server",
        ],
    ] {
        assert_eq!(Cli::try_parse_from(args).err().unwrap().exit_code(), 2);
    }
    assert!(matches!(
        Cli::try_parse_from(["ash", "resume", "session", "thread"])
            .unwrap()
            .command,
        Some(Command::Resume { .. })
    ));
}

#[test]
fn server_and_remote_arguments_reach_their_owners_unchanged() {
    for command in ["app-server", "remote"] {
        let args = ["ash", command, "connect", "--name", "a host", "--check"];
        let parsed = Cli::try_parse_from(args).unwrap();
        let arguments = match parsed.command.unwrap() {
            Command::AppServer(args) | Command::Remote(args) => args.arguments,
            _ => unreachable!(),
        };
        assert_eq!(arguments, args[2..]);
    }
    let parsed = Cli::try_parse_from(["ash", "app-server", "--listen", "stdio://"]).unwrap();
    let Some(Command::AppServer(args)) = parsed.command else {
        unreachable!()
    };
    assert_eq!(args.arguments, ["--listen", "stdio://"]);
}
