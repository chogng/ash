use super::*;

#[test]
fn parser_stops_reductions_and_backtracking_that_make_no_forward_progress() {
    let mut progress = ParseProgress::new(0);
    assert!(progress.advance(1_000).is_continue());
    for index in 1..MAX_STALLED_PARSE_CHECKS {
        // Alternating between positions must not replenish the work budget.
        assert!(progress.advance(999 + index % 2).is_continue());
    }
    assert!(progress.advance(1_000).is_break());
}

#[test]
fn forward_progress_replenishes_the_parse_budget() {
    let mut progress = ParseProgress::new(0);
    for offset in 1..10 {
        assert!(progress.advance(offset).is_continue());
        for _ in 1..MAX_STALLED_PARSE_CHECKS {
            assert!(progress.advance(offset).is_continue());
        }
    }
}

#[test]
fn cancelled_parse_releases_partial_state_before_parsing_different_text() {
    let mut parser = Parser::new();
    let _configuration = LanguageConfiguration::load(SyntaxLanguage::Javascript, &mut parser)
        .expect("JavaScript grammar");
    let interrupted = Rope::from_str(&"const unfinished = 1;\n".repeat(1_000));
    let mut cancel = |_: &ParseState| ControlFlow::Break(());
    assert!(matches!(
        parse_rope_with_options(
            &mut parser,
            &interrupted,
            None,
            ParseOptions::new().progress_callback(&mut cancel),
        ),
        Err(SyntaxError::ParseCancelled)
    ));

    let replacement = Rope::from_str("function recovered() { return 42; }\n");
    let tree = parse_rope(&mut parser, &replacement, None).expect("fresh parse after cancellation");
    assert!(!tree.root_node().has_error());
    assert_eq!(tree.root_node().end_byte(), replacement.len_bytes());
    assert_eq!(
        tree.root_node().named_child(0).unwrap().kind(),
        "function_declaration"
    );
}
