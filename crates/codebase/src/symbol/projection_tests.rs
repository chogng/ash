use super::*;
use crate::Codebase;
use crate::CodebaseLimits;
use crate::IndexedSourceReference;
use crate::SourceRevision;
use crate::SymbolKind;
use crate::SymbolRange;
use ash_file_access::Dir;

#[test]
fn empty_file_churn_also_requests_compaction_at_the_file_budget() {
    let directory = tempfile::tempdir().unwrap();
    let codebase = Codebase::open_memory(
        Dir::open_local(directory.path()).unwrap(),
        CodebaseLimits::default(),
    )
    .unwrap();
    let snapshot = SymbolIndexSnapshot {
        root_id: codebase.root_id().clone(),
        generation: 1,
        source_generation: 1,
        indexed_source_count: 0,
        indexed_symbol_count: 0,
        symbol_limit_hit: false,
    };
    let mut projection = DiskProjection::new(snapshot, [], 2);
    for i in 0..=MAX_DELTA_FILES {
        let source = SourceSymbols {
            source: IndexedSourceReference {
                root_id: codebase.root_id().clone(),
                relative_path: format!("empty_{i}.rs").into(),
                source_revision: SourceRevision::parse(format!("sha256:{}", "a".repeat(64)))
                    .unwrap(),
                language: ash_language::LanguageId::RUST,
                source_bytes: 0,
            },
            symbols: Vec::new(),
            symbol_limit_hit: false,
        };
        let updated = projection.updated(&[], &[source]);
        if i == MAX_DELTA_FILES {
            assert!(updated.is_none());
        } else {
            projection = updated.unwrap();
            assert!(projection.delta.is_none());
        }
    }
}

#[test]
fn oversized_declaration_facts_request_compaction_before_delta_allocation() {
    let directory = tempfile::tempdir().unwrap();
    let codebase = Codebase::open_memory(
        Dir::open_local(directory.path()).unwrap(),
        CodebaseLimits::default(),
    )
    .unwrap();
    let snapshot = SymbolIndexSnapshot {
        root_id: codebase.root_id().clone(),
        generation: 1,
        source_generation: 1,
        indexed_source_count: 0,
        indexed_symbol_count: 0,
        symbol_limit_hit: false,
    };
    let range = SymbolRange {
        start_byte: 0,
        end_byte: 1,
        start_line: 0,
        start_column: 0,
        end_line: 0,
        end_column: 1,
    };
    let mut source = SourceSymbols {
        source: IndexedSourceReference {
            root_id: codebase.root_id().clone(),
            relative_path: "large.rs".into(),
            source_revision: SourceRevision::parse(format!("sha256:{}", "a".repeat(64))).unwrap(),
            language: ash_language::LanguageId::RUST,
            source_bytes: MAX_DELTA_FACT_BYTES + 1,
        },
        symbols: vec![SourceSymbol {
            ordinal: 0,
            name: "f".into(),
            kind: SymbolKind::Function,
            container_name: Some("x".repeat(MAX_DELTA_FACT_BYTES)),
            declaration_range: range.clone(),
            selection_range: range,
        }],
        symbol_limit_hit: false,
    };
    let projection = DiskProjection::new(snapshot.clone(), [], 2);
    assert!(
        projection
            .updated(&[], std::slice::from_ref(&source))
            .is_none()
    );
    // Retiring a large base payload also requests compaction so masks cannot hide an
    // unbounded amount of otherwise unreachable declaration data indefinitely.
    let projection = DiskProjection::new(snapshot, [source.clone()], 2);
    source.symbols.clear();
    assert!(projection.updated(&[], &[source]).is_none());
}
