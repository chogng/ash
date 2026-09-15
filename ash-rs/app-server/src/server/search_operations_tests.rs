use super::*;
use grep::Match as ContentSearchMatch;
use grep::MatchRange as ContentSearchMatchRange;

#[test]
fn maps_protocol_query_to_content_search_query() {
    let query = search_query(ContentSearchStartParams {
        dir_id: None,
        session_directory: None,
        query: "needle".into(),
        pattern_kind: ContentSearchPatternKind::Regex,
        freshness: Some(ContentSearchFreshness::Indexed),
        case_sensitivity: ContentSearchProtocolCaseSensitivity::Insensitive,
        include_patterns: vec!["src/**".into()],
        exclude_patterns: vec!["**/*.test.rs".into()],
        max_results: 400,
    });

    assert_eq!(
        query,
        ContentSearchQuery {
            query: "needle".into(),
            pattern: ContentSearchPattern::Regex,
            case_sensitivity: ContentSearchCaseSensitivity::Insensitive,
            include_patterns: vec!["src/**".into()],
            exclude_patterns: vec!["**/*.test.rs".into()],
            max_results: 400,
            scope: Default::default(),
            freshness: grep::Freshness::Indexed,
        }
    );
}

#[test]
fn maps_content_search_page_to_protocol_result() {
    let result = search_page(
        "search-1".into(),
        ContentSearchPage {
            matches: vec![ContentSearchMatch {
                path: "src/lib.rs".into(),
                line_number: 7,
                content: "let 搜索 = \"needle\";".into(),
                ranges: vec![ContentSearchMatchRange { start: 14, end: 20 }],
            }],
            next_match: 1,
            completed: true,
            limit_hit: false,
            error: None,
            freshness: Some(grep::Freshness::Current),
        },
    );

    assert_eq!(result.search_id, "search-1");
    assert_eq!(result.matches.len(), 1);
    assert_eq!(
        result.matches[0].path,
        std::path::PathBuf::from("src/lib.rs")
    );
    assert_eq!(
        result.matches[0].ranges,
        [ContentSearchProtocolMatchRange { start: 10, end: 16 }]
    );
    assert_eq!(result.next_match, 1);
    assert!(result.completed);
    assert!(!result.limit_hit);
    assert_eq!(result.error, None);
    assert_eq!(result.freshness, Some(ContentSearchFreshness::Current));
}

#[test]
fn omitted_freshness_preserves_current_disk_search() {
    let params = serde_json::from_value::<ContentSearchStartParams>(serde_json::json!({
        "query": "needle", "patternKind": "literal", "caseSensitivity": "sensitive",
        "includePatterns": [], "excludePatterns": [], "maxResults": 100
    }))
    .unwrap();
    assert_eq!(search_query(params).freshness, grep::Freshness::Current);
}
