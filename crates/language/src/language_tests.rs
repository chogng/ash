use std::path::Path;

use super::LanguageId;
use super::detect_language;

#[test]
fn package_associations_match_the_editor_conformance_cases() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/languages/associations.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let path = case["path"].as_str().unwrap();
        assert_eq!(
            detect_language(Path::new(path), case["firstLine"].as_str()).as_str(),
            case["language"].as_str().unwrap(),
            "{path}"
        );
    }
}

#[test]
fn identities_preserve_external_languages_and_normalize_legacy_grammar_ids() {
    assert_eq!(LanguageId::parse("shell").unwrap().as_str(), "shellscript");
    assert_eq!(
        LanguageId::parse("gitcommit").unwrap().as_str(),
        "git-commit"
    );
    assert_eq!(
        LanguageId::parse("custom.language").unwrap().as_str(),
        "custom.language"
    );
    for invalid in ["", "has spaces", "a/b", "a\n"] {
        assert!(LanguageId::parse(invalid).is_err());
    }
    assert!(LanguageId::parse(&"a".repeat(129)).is_err());
}
