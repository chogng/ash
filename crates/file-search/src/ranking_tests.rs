use crate::Error;
use crate::ranking::Ranking;
use crate::ranking::rank;
use ash_async_utils::CancellationToken;
use std::path::Path;
use std::path::PathBuf;
use std::time::Instant;

fn rank_paths<P: AsRef<Path>>(
    paths: impl IntoIterator<Item = Result<P, Error>>,
    query: &str,
    max_results: usize,
    cancellation: &CancellationToken,
) -> Result<Ranking, Error> {
    rank(paths, query, max_results, || {
        cancellation
            .check()
            .map_err(|reason| Error::Cancelled(reason.reason().to_string()))
    })
}

#[test]
fn discovered_paths_are_ranked_before_truncation_without_disk_access() {
    let paths: Vec<PathBuf> = [
        "tests/s_r_c.rs",
        "docs/src-notes.md",
        "src/中文.rs",
        "target/src.rs",
        "target",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    let token = ash_async_utils::CancellationSource::new().token();
    let all = rank_paths(paths.iter().map(Ok), "SRC", 100, &token).unwrap();
    let best = rank_paths(paths.iter().map(Ok), "SRC", 1, &token).unwrap();
    assert_eq!(best.matches, all.matches[..1]);
    assert_eq!(best.total_match_count, 4);
    let contiguous = all
        .matches
        .iter()
        .find(|matched| matched.path == Path::new("docs/src-notes.md"))
        .unwrap();
    let spread = all
        .matches
        .iter()
        .find(|matched| matched.path == Path::new("tests/s_r_c.rs"))
        .unwrap();
    assert!(contiguous.score > spread.score);
    assert_eq!(contiguous.indices, [5, 6, 7]);
    assert_eq!(
        rank_paths(paths.iter().map(Ok), "中文", 100, &token)
            .unwrap()
            .matches[0]
            .path,
        Path::new("src/中文.rs")
    );
    assert!(
        rank_paths(paths.iter().map(Ok), "target", 100, &token)
            .unwrap()
            .matches
            .iter()
            .any(|matched| matched.path == Path::new("target"))
    );
}

#[test]
fn discovered_paths_have_stable_ties_and_honor_cancellation_even_when_empty() {
    let token = ash_async_utils::CancellationSource::new().token();
    let paths = [PathBuf::from("b.rs"), PathBuf::from("a.rs")];
    assert_eq!(
        rank_paths(paths.iter().map(Ok), "", 1, &token)
            .unwrap()
            .matches[0]
            .path,
        Path::new("a.rs")
    );
    for paths in [
        [PathBuf::from("a.rs"), PathBuf::from("a/z")],
        [PathBuf::from("a/z"), PathBuf::from("a.rs")],
    ] {
        let all = rank_paths(paths.iter().map(Ok), "", 2, &token).unwrap();
        let best = rank_paths(paths.iter().map(Ok), "", 1, &token).unwrap();
        assert_eq!(best.matches, all.matches[..1]);
    }
    let cancellation = ash_async_utils::CancellationSource::new();
    cancellation.cancel();
    assert!(matches!(
        rank_paths(
            std::iter::empty::<Result<PathBuf, Error>>(),
            "query",
            1,
            &cancellation.token()
        ),
        Err(Error::Cancelled(_))
    ));
}

#[test]
fn a_path_stream_failure_discards_the_partial_ranked_result() {
    let paths = [
        Ok(PathBuf::from("best-match.rs")),
        Err(Error::Failed("path snapshot changed".into())),
    ];
    let token = ash_async_utils::CancellationSource::new().token();
    assert!(
        matches!(rank_paths(paths, "best", 1, &token), Err(Error::Failed(message)) if message == "path snapshot changed")
    );
}

#[test]
#[ignore = "manual path scoring measurement"]
fn shared_path_scoring_benchmark() {
    let paths: Vec<PathBuf> = (0..10_000)
        .map(|index| PathBuf::from(format!("src/component_{index:05}/main.rs")))
        .collect();
    let token = ash_async_utils::CancellationSource::new().token();
    let mut timings = Vec::new();
    for _ in 0..20 {
        let start = Instant::now();
        let result = rank_paths(paths.iter().map(Ok), "main", 100, &token).unwrap();
        assert_eq!(result.total_match_count, paths.len());
        assert_eq!(result.matches.len(), 100);
        timings.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    timings.sort_by(f64::total_cmp);
    eprintln!(
        "paths={} scoring_ms median={:.3} p95={:.3}",
        paths.len(),
        timings[10],
        timings[18]
    );
}
