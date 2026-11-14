use super::*;
use crate::SourceSymbol;
use ash_async_utils::CancellationSource;
use ash_file_access::Dir;

#[test]
fn bounded_delta_matches_full_engine_scores_order_and_indices() {
    let directory = tempfile::tempdir().unwrap();
    let codebase = crate::Codebase::open_memory(
        Dir::open_local(directory.path()).unwrap(),
        crate::CodebaseLimits::default(),
    )
    .unwrap();
    let range = SymbolRange {
        start_byte: 0,
        end_byte: 10,
        start_line: 0,
        start_column: 0,
        end_line: 0,
        end_column: 10,
    };
    let mut sources = Vec::new();
    for path in ["a.rs", "b.rs", "c.rs"] {
        let source = IndexedSourceReference {
            root_id: codebase.root_id().clone(),
            relative_path: path.into(),
            source_revision: crate::SourceRevision::parse(format!("sha256:{}", "a".repeat(64)))
                .unwrap(),
            language: ash_language::LanguageId::RUST,
            source_bytes: 10,
        };
        let names = [
            "transform99",
            "transform98",
            "Transform99",
            "café",
            "cafe\u{301}",
            "中文",
            "line\r\nbreak",
            "foo_bar",
        ];
        sources.push(SourceSymbols {
            source,
            symbol_limit_hit: false,
            symbols: names
                .into_iter()
                .enumerate()
                .map(|(ordinal, name)| SourceSymbol {
                    ordinal,
                    name: name.into(),
                    kind: SymbolKind::Function,
                    container_name: None,
                    declaration_range: range.clone(),
                    selection_range: range.clone(),
                })
                .collect(),
        });
    }
    let mut full = SymbolMatcher::new(sources.clone(), 2);
    let mut delta = SymbolDeltaMatcher::new(sources);
    let active = CancellationSource::new();
    for excluded in [BTreeSet::new(), BTreeSet::from([PathBuf::from("a.rs")])] {
        for query in [
            "",
            "transform99",
            "tr9",
            "^transform99$",
            "!transform99 transform",
            "café",
            "cafe\u{301}",
            "中文",
            "foo bar",
        ] {
            let expected = rank_candidates(
                full.candidates(query, 8, &active.token(), &excluded)
                    .unwrap(),
                query,
                2,
            );
            let actual = rank_candidates(
                delta
                    .candidates(query, 8, &active.token(), &excluded)
                    .unwrap(),
                query,
                2,
            );
            assert_eq!(actual, expected, "query={query:?}, excluded={excluded:?}");
        }
    }
    active.cancel();
    assert!(matches!(
        delta.candidates("", 8, &active.token(), &BTreeSet::new()),
        Err(SymbolIndexError::Cancelled(_))
    ));
}

#[test]
fn empty_matcher_returns_no_hits_and_observes_cancellation() {
    let mut matcher = SymbolMatcher::new([], 2);
    let cancellation = CancellationSource::new();
    for query in ["", "missing"] {
        assert!(
            matcher
                .search(query, 10, &cancellation.token())
                .unwrap()
                .is_empty()
        );
    }
    cancellation.cancel();
    assert!(matches!(
        matcher.search("", 10, &cancellation.token()),
        Err(SymbolIndexError::Cancelled(_))
    ));
}

#[test]
fn compact_and_wide_coordinates_round_trip_without_truncation() {
    for value in [0, 17, u32::MAX as usize, usize::MAX] {
        let declaration = SymbolRange {
            start_byte: 0,
            end_byte: value,
            start_line: 1,
            start_column: 2,
            end_line: value,
            end_column: 3,
        };
        let selection = SymbolRange {
            start_byte: value,
            end_byte: value,
            start_line: value,
            start_column: value,
            end_line: value,
            end_column: value,
        };
        let packed = CandidateRanges::new(declaration.clone(), selection.clone());
        assert_eq!(packed.expand(), [declaration, selection]);
        if value <= u32::MAX as usize {
            assert!(matches!(packed, CandidateRanges::Compact(_)));
        } else {
            assert!(matches!(packed, CandidateRanges::Wide(_)));
        }
    }
    #[cfg(target_pointer_width = "64")]
    assert!(std::mem::size_of::<CandidateRanges>() < std::mem::size_of::<[SymbolRange; 2]>());
}

#[test]
fn searches_preserve_ascii_and_original_unicode_spelling() {
    let directory = tempfile::tempdir().unwrap();
    let root = Dir::open_local(directory.path()).unwrap();
    let range = SymbolRange {
        start_byte: 0,
        end_byte: 30,
        start_line: 0,
        start_column: 0,
        end_line: 0,
        end_column: 30,
    };
    let source = IndexedSourceReference {
        root_id: crate::IndexRootId::from_root(&root),
        relative_path: "names.rs".into(),
        source_revision: crate::SourceRevision::new("fixture".into()),
        language: ash_language::LanguageId::RUST,
        source_bytes: 30,
    };
    // Combining marks are intentionally not normalized in returned domain data.
    let names = [
        "MixedCaseASCII",
        "café",
        "cafe\u{301}",
        "中文名称",
        "windows\r\nline",
    ];
    let symbols = names
        .iter()
        .enumerate()
        .map(|(ordinal, name)| SourceSymbol {
            ordinal,
            name: (*name).into(),
            kind: SymbolKind::Function,
            container_name: None,
            declaration_range: range.clone(),
            selection_range: range.clone(),
        })
        .collect();
    let mut matcher = SymbolMatcher::new(
        [SourceSymbols {
            source,
            symbols,
            symbol_limit_hit: false,
        }],
        2,
    );
    let active = CancellationSource::new();
    let hits = matcher.search("", 10, &active.token()).unwrap();
    assert_eq!(hits.len(), names.len());
    for hit in hits {
        assert_eq!(hit.symbol.name, names[hit.symbol.reference.ordinal]);
        assert_eq!(hit.symbol.reference.declaration_range, range);
    }
    assert_eq!(
        matcher
            .search("mixedcaseascii", 1, &active.token())
            .unwrap()[0]
            .symbol
            .name,
        names[0]
    );
    assert_eq!(
        matcher.search("中文", 1, &active.token()).unwrap()[0]
            .symbol
            .name,
        names[3]
    );
}
