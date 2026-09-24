use super::SkillDiagnosticWarnings;
use ash_app_server_protocol::protocol::skills::SkillDiagnosticCodeDto;
use ash_app_server_protocol::protocol::skills::SkillDiagnosticDto;

fn diagnostic(subject: Option<&str>, message: &str) -> SkillDiagnosticDto {
    SkillDiagnosticDto {
        source: "user:skill-source:personal".into(),
        subject: subject.map(str::to_owned),
        code: SkillDiagnosticCodeDto::InvalidFrontmatter,
        message: message.into(),
    }
}

#[test]
fn reports_only_new_diagnostics_and_uses_the_source_when_subject_is_absent() {
    let mut warnings = SkillDiagnosticWarnings::default();
    let diagnostics = vec![
        diagnostic(Some("broken/SKILL.md"), "frontmatter is invalid"),
        diagnostic(None, "skill source is unavailable"),
    ];

    assert_eq!(
        warnings.update(&diagnostics),
        vec![
            "Skill catalog reported 2 new errors.",
            "broken/SKILL.md: frontmatter is invalid",
            "user:skill-source:personal: skill source is unavailable",
        ]
    );
    assert!(warnings.update(&diagnostics).is_empty());
}

#[test]
fn reemits_a_diagnostic_after_it_clears_or_its_message_changes() {
    let mut warnings = SkillDiagnosticWarnings::default();
    let initial = diagnostic(Some("broken/SKILL.md"), "frontmatter is invalid");
    let changed = diagnostic(Some("broken/SKILL.md"), "description is missing");

    warnings.update(std::slice::from_ref(&initial));
    assert_eq!(
        warnings.update(std::slice::from_ref(&changed)),
        vec![
            "Skill catalog reported 1 new error.",
            "broken/SKILL.md: description is missing",
        ]
    );
    assert!(warnings.update(&[]).is_empty());
    assert_eq!(
        warnings.update(std::slice::from_ref(&initial)),
        vec![
            "Skill catalog reported 1 new error.",
            "broken/SKILL.md: frontmatter is invalid",
        ]
    );
}

#[test]
fn clearing_history_allows_an_active_diagnostic_to_be_reported_again() {
    let mut warnings = SkillDiagnosticWarnings::default();
    let diagnostic = diagnostic(Some("broken/SKILL.md"), "frontmatter is invalid");

    warnings.update(std::slice::from_ref(&diagnostic));
    warnings.clear();

    assert!(
        !warnings
            .update(std::slice::from_ref(&diagnostic))
            .is_empty()
    );
}
