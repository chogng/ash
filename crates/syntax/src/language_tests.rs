use std::sync::Arc;

use tree_sitter::Parser;

use super::LanguageConfiguration;
use super::SyntaxLanguage;

#[test]
fn concurrent_documents_share_queries_and_keep_independent_parsers() {
    for language in [
        SyntaxLanguage::Javascript,
        SyntaxLanguage::Javascriptreact,
        SyntaxLanguage::Json,
        SyntaxLanguage::Jsonc,
        SyntaxLanguage::Rust,
        SyntaxLanguage::Shell,
        SyntaxLanguage::Typescript,
        SyntaxLanguage::Typescriptreact,
    ] {
        let workers = (0..8)
            .map(|_| {
                std::thread::spawn(move || {
                    let mut parser = Parser::new();
                    let configuration = LanguageConfiguration::load(language, &mut parser).unwrap();
                    let tree = parser.parse("", None).unwrap();
                    assert!(!tree.root_node().has_error());
                    configuration
                })
            })
            .collect::<Vec<_>>();
        let configurations = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert!(
            configurations
                .iter()
                .all(|configuration| Arc::ptr_eq(configuration, &configurations[0]))
        );
    }
    let javascript =
        LanguageConfiguration::load(SyntaxLanguage::Javascript, &mut Parser::new()).unwrap();
    let jsx =
        LanguageConfiguration::load(SyntaxLanguage::Javascriptreact, &mut Parser::new()).unwrap();
    assert!(Arc::ptr_eq(&javascript, &jsx));
    let typescript =
        LanguageConfiguration::load(SyntaxLanguage::Typescript, &mut Parser::new()).unwrap();
    let tsx =
        LanguageConfiguration::load(SyntaxLanguage::Typescriptreact, &mut Parser::new()).unwrap();
    assert!(!Arc::ptr_eq(&typescript, &tsx));
}

#[test]
fn every_registered_language_compiles_its_queries_and_resolves_its_identity() {
    for &language in super::TEST_LANGUAGES {
        let mut parser = Parser::new();
        LanguageConfiguration::load(language, &mut parser).unwrap();
        assert!(parser.parse("", None).is_some(), "{language:?}");
        assert_eq!(SyntaxLanguage::for_injection(language.id()), Some(language));
    }
}
