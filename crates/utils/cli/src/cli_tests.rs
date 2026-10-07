use super::*;

#[derive(clap::Parser)]
struct Options {
    #[arg(long)]
    name: String,
}

#[test]
fn parse_preserves_arguments_and_returns_help_and_usage_exit_codes() {
    let ParseOutcome::Parsed(options) = parse_arguments::<Options>(["test", "--name", "a b"])
    else {
        panic!("expected parsed arguments");
    };
    assert_eq!(options.name, "a b");
    assert!(matches!(
        parse_arguments::<Options>(["test", "--help"]),
        ParseOutcome::Exit(0)
    ));
    assert!(matches!(
        parse_arguments::<Options>(["test", "--unknown"]),
        ParseOutcome::Exit(2)
    ));
}

#[test]
fn shell_display_preserves_empty_arguments_quotes_and_metacharacters() {
    assert_eq!(
        format_command(&[
            "ash".into(),
            "resume".into(),
            "a b".into(),
            "a'b".into(),
            "$HOME;echo".into(),
            "".into()
        ]),
        "ash resume 'a b' 'a'\\''b' '$HOME;echo' ''"
    );
}
