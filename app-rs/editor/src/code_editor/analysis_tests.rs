use super::*;

#[test]
fn shell_analysis_tracks_unicode_edits_incrementally() {
    let mut analysis = CodeEditorAnalysis::default();
    analysis.set_language(CodeEditorLanguage::Shell);
    let initial = "echo \"你好\"";
    let initial_line = 0..initial.len();
    assert!(
        !analysis
            .synchronize(initial, std::slice::from_ref(&initial_line))
            .syntax_tokens[0]
            .is_empty()
    );

    let changed = "echo \"你好世界\"";
    let changed_line = 0..changed.len();
    let snapshot = analysis.synchronize(changed, std::slice::from_ref(&changed_line));
    assert!(
        snapshot.syntax_tokens[0]
            .iter()
            .any(|token| token.range == (5..19))
    );
}

#[test]
fn plain_text_clears_parser_state_and_tokens() {
    let mut analysis = CodeEditorAnalysis::default();
    analysis.set_language(CodeEditorLanguage::Rust);
    let text = "pub fn main() {}";
    let line = 0..text.len();
    assert!(
        !analysis
            .synchronize(text, std::slice::from_ref(&line))
            .syntax_tokens[0]
            .is_empty()
    );
    analysis.set_language(CodeEditorLanguage::PlainText);
    let snapshot = analysis.synchronize(text, std::slice::from_ref(&line));
    assert!(snapshot.syntax_tokens[0].is_empty());
    assert!(snapshot.folding_ranges.is_empty());
}

#[test]
fn syntax_folding_ranges_are_projected_into_editor_source_rows() {
    let mut analysis = CodeEditorAnalysis::default();
    analysis.set_language(CodeEditorLanguage::Json);
    let text = "{\n  \"enabled\": true\n}\n";
    let lines = [0..1, 2..19, 20..21, 22..22];

    let snapshot = analysis.synchronize(text, &lines);

    assert!(
        snapshot
            .folding_ranges
            .contains(&CodeEditorFoldingRange::new(0, 2).unwrap())
    );
}
