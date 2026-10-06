use super::*;

#[test]
fn supported_agent_skills_frontmatter_parses() {
    let parsed = parse_frontmatter(
        br#"name: code-review
description: Reviews code and explains when to use the review workflow.
license: Apache-2.0
compatibility: Requires git.
metadata:
  acme/version: "1"
allowed-tools: Read Bash(git:*)
"#,
        &SkillName::new("code-review").unwrap(),
    )
    .unwrap();

    assert_eq!(
        parsed.description,
        "Reviews code and explains when to use the review workflow."
    );
    assert_eq!(parsed.metadata["acme/version"], "1");
    assert_eq!(parsed.allowed_tools.as_deref(), Some("Read Bash(git:*)"));
}

#[test]
fn bounded_yaml_block_scalars_remain_compatible() {
    let parsed = parse_frontmatter(
        b"name: review\ndescription: |\n  Reviews code.\n  * Use when review is requested.\n",
        &SkillName::new("review").unwrap(),
    )
    .unwrap();

    assert!(parsed.description.contains("* Use when"));
}

#[test]
fn name_description_and_unknown_fields_are_strictly_validated() {
    let expected = SkillName::new("review").unwrap();
    let wrong_name = parse_frontmatter(
        b"name: other\ndescription: Reviews code when requested.\n",
        &expected,
    )
    .unwrap_err();
    assert_eq!(wrong_name.code, SkillDiagnosticCode::InvalidSkillName);

    let empty_description =
        parse_frontmatter(b"name: review\ndescription: ''\n", &expected).unwrap_err();
    assert_eq!(
        empty_description.code,
        SkillDiagnosticCode::DescriptionInvalid
    );

    assert!(
        parse_frontmatter(
            b"name: review\ndescription: Reviews code when requested.\nfuture: true\n",
            &expected
        )
        .is_err()
    );
}

#[test]
fn aliases_deep_flow_and_oversized_lines_are_rejected_before_yaml_deserialization() {
    let expected = SkillName::new("review").unwrap();
    for source in [
        "name: &name review\ndescription: *name\n",
        "name: review\ndescription: [[[[[[[[[too-deep]]]]]]]]]\n",
    ] {
        assert_eq!(
            parse_frontmatter(source.as_bytes(), &expected)
                .unwrap_err()
                .code,
            SkillDiagnosticCode::InvalidFrontmatter
        );
    }

    let oversized = format!("name: review\ndescription: {}\n", "x".repeat(2049));
    assert!(parse_frontmatter(oversized.as_bytes(), &expected).is_err());
}
