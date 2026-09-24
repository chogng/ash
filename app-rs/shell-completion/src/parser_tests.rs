use super::ParsedShellWord;
use super::ParsedWordKind;
use super::is_environment_assignment;
use super::normalized_shell_word;
use super::parse_shell_commands;

fn words(input: &str) -> Vec<Vec<(String, ParsedWordKind)>> {
    parse_shell_commands(input)
        .into_iter()
        .map(|command| {
            command
                .words
                .into_iter()
                .map(|word| (word.text, word.kind))
                .collect()
        })
        .collect()
}

#[test]
fn parser_keeps_quotes_and_resets_at_command_operators() {
    assert_eq!(
        words("echo 'hello world' | git status && cargo test"),
        vec![
            vec![
                ("echo".to_owned(), ParsedWordKind::Word),
                ("'hello world'".to_owned(), ParsedWordKind::Word),
            ],
            vec![
                ("git".to_owned(), ParsedWordKind::Word),
                ("status".to_owned(), ParsedWordKind::Word),
            ],
            vec![
                ("cargo".to_owned(), ParsedWordKind::Word),
                ("test".to_owned(), ParsedWordKind::Word),
            ],
        ]
    );
}

#[test]
fn parser_splits_flag_values_and_marks_redirection_targets() {
    assert_eq!(
        words("rg --glob=*.rs TODO 2> errors.log"),
        vec![vec![
            ("rg".to_owned(), ParsedWordKind::Word),
            ("--glob".to_owned(), ParsedWordKind::Word),
            ("*.rs".to_owned(), ParsedWordKind::Word),
            ("TODO".to_owned(), ParsedWordKind::Word),
            ("errors.log".to_owned(), ParsedWordKind::RedirectionTarget),
        ]]
    );
}

#[test]
fn parser_ignores_comments_and_empty_segments() {
    assert_eq!(
        words("git status # inspect\n\n cargo test;"),
        vec![
            vec![
                ("git".to_owned(), ParsedWordKind::Word),
                ("status".to_owned(), ParsedWordKind::Word),
            ],
            vec![
                ("cargo".to_owned(), ParsedWordKind::Word),
                ("test".to_owned(), ParsedWordKind::Word),
            ],
        ]
    );
}

#[test]
fn normalization_and_assignment_detection_are_shell_aware() {
    assert_eq!(normalized_shell_word("'hello world'"), "hello world");
    assert_eq!(normalized_shell_word("hello\\ world"), "hello world");
    assert!(is_environment_assignment("RUST_LOG=debug"));
    assert!(!is_environment_assignment("1INVALID=value"));
}

#[test]
fn spans_are_byte_offsets_into_the_original_input() {
    let commands = parse_shell_commands("echo 你好 --color=always");
    assert_eq!(
        commands[0].words,
        vec![
            ParsedShellWord {
                text: "echo".to_owned(),
                span: 0..4,
                kind: ParsedWordKind::Word,
            },
            ParsedShellWord {
                text: "你好".to_owned(),
                span: 5..11,
                kind: ParsedWordKind::Word,
            },
            ParsedShellWord {
                text: "--color".to_owned(),
                span: 12..19,
                kind: ParsedWordKind::Word,
            },
            ParsedShellWord {
                text: "always".to_owned(),
                span: 20..26,
                kind: ParsedWordKind::Word,
            },
        ]
    );
}
