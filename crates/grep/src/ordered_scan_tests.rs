use super::scan;
use crate::CaseSensitivity;
use crate::Freshness;
use crate::Pattern;
use crate::Query;
use crate::ripgrep;
use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_install_context::ExecutableCandidates;
use ash_install_context::InstallContext;
use ash_install_context::ManagedExecutable;
use ash_shell_command::RipgrepExecutable;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

#[test]
fn ordered_scan_matches_cli_across_batches_and_limits() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    fs::create_dir(root.join("src")).unwrap();
    fs::create_dir(root.join("src/a")).unwrap();
    fs::write(root.join(".gitignore"), "ignored.rs\n").unwrap();
    fs::write(root.join("src/.rgignore"), "rgignored.rs\n").unwrap();
    for name in [
        "a/z.rs",
        "a.rs",
        "ignored.rs",
        "rgignored.rs",
        ".hidden.rs",
        "other.txt",
    ] {
        fs::write(
            root.join("src").join(name),
            "needle café needle\r\nnext\r\n",
        )
        .unwrap();
    }
    for n in 0..300 {
        fs::write(
            root.join(format!("src/b{n:03}.rs")),
            "needle café needle\r\nnext\r\n",
        )
        .unwrap();
    }
    fs::write(root.join("src/binary.rs"), b"needle\0").unwrap();
    fs::create_dir(root.join("src/m")).unwrap();
    fs::write(root.join("src/m/z.rs"), "needle café needle\r\nnext\r\n").unwrap();
    fs::write(root.join("src/m.rs"), "needle café needle\r\nnext\r\n").unwrap();
    fs::write(root.join("src/m/.ignore"), "omitted.rs\n").unwrap();
    fs::write(root.join("src/m/omitted.rs"), "needle\n").unwrap();
    let utf16: Vec<u8> = "\u{feff}needle café\n"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    fs::write(root.join("src/utf16.rs"), utf16).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("a.rs", root.join("src/link.rs")).unwrap();
    let dir = Dir::open_local(root).unwrap();
    let rg = match InstallContext::current().executable_candidates(ManagedExecutable::Ripgrep) {
        ExecutableCandidates::ExplicitOverride(value) => RipgrepExecutable::from_path(value.path()),
        ExecutableCandidates::SearchPaths(paths) => RipgrepExecutable::discover_candidates(paths),
    }
    .unwrap();
    let cancel = CancellationSource::new();
    let cancellation = cancel.token();
    for (scope, pattern, limit, include) in [
        ("", "needle", 100, false),
        ("src", "needle", 5000, true),
        ("src", "needle", 160, false),
        ("src", "needle", 5000, false),
        ("src", r"café needle\r?\nnext", 35, true),
        ("src", r"^needle|needle$", 32, false),
        ("src", "absent", 100, false),
    ] {
        let query = Query {
            query: pattern.into(),
            pattern: Pattern::Regex,
            case_sensitivity: CaseSensitivity::Sensitive,
            scope: PathBuf::from(scope),
            include_patterns: if include {
                vec!["src/**/*.rs".into()]
            } else {
                vec![]
            },
            exclude_patterns: vec!["src/b065.rs".into()],
            max_results: limit,
            freshness: Freshness::Current,
        };
        let regex = crate::service::validate(&query).unwrap();
        let expected = ripgrep::search(&rg, &dir, &query, regex.as_str(), &cancellation).unwrap();
        let actual = scan(&dir, &query, regex.as_str(), &cancellation, 4).unwrap();
        assert_eq!(
            actual, expected,
            "scope={scope}, pattern={pattern}, limit={limit}"
        );
        if scope.is_empty() {
            assert!(actual.limit_hit);
            assert_eq!(actual.matches[0].path, Path::new("src/a/z.rs"));
        }
    }

    // A case-insensitive filesystem can open an ignore file whose directory entry
    // has a different spelling. Match the CLI even when the parallel walker cannot
    // discover that file using its exact-name checks.
    fs::remove_file(root.join("src/m/.ignore")).unwrap();
    fs::write(root.join("src/m/.IGNORE"), "omitted.rs\n").unwrap();
    let query = Query {
        query: "needle".into(),
        pattern: Pattern::Regex,
        case_sensitivity: CaseSensitivity::Sensitive,
        scope: PathBuf::from("src"),
        include_patterns: vec![],
        exclude_patterns: vec![],
        max_results: 5000,
        freshness: Freshness::Current,
    };
    let regex = crate::service::validate(&query).unwrap();
    let expected = ripgrep::search(&rg, &dir, &query, regex.as_str(), &cancellation).unwrap();
    assert_eq!(
        scan(&dir, &query, regex.as_str(), &cancellation, 4).unwrap(),
        expected
    );
}
