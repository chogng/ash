use super::*;

#[test]
fn compiles_a_paper_fragment_to_pdf() {
    let outcome = TypstCompiler::new()
        .compile("= A Paper\n\nA formula: $x^2 + y^2 = z^2$.")
        .unwrap();

    let TypstCompileOutcome::Success(success) = outcome else {
        panic!("valid source should compile");
    };
    assert!(success.pdf.starts_with(b"%PDF-"));
}

#[test]
fn reports_source_diagnostics_with_byte_ranges() {
    let outcome = TypstCompiler::new().compile("#let =").unwrap();

    let TypstCompileOutcome::Failed { diagnostics } = outcome else {
        panic!("invalid source should return diagnostics");
    };
    assert!(!diagnostics.is_empty());
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.range.is_some())
    );
}

#[test]
fn denies_host_file_access() {
    let outcome = TypstCompiler::new()
        .compile("#read(\"secret.txt\")")
        .unwrap();

    let TypstCompileOutcome::Failed { diagnostics } = outcome else {
        panic!("host file access should fail");
    };
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("access denied"))
    );
}

#[test]
fn rejects_sources_over_the_byte_limit() {
    let source = "a".repeat(MAX_TYPST_SOURCE_BYTES + 1);
    assert_eq!(
        TypstCompiler::new().compile(&source),
        Err(TypstCompileError::SourceTooLarge {
            actual_bytes: MAX_TYPST_SOURCE_BYTES + 1,
            max_bytes: MAX_TYPST_SOURCE_BYTES,
        })
    );
}
