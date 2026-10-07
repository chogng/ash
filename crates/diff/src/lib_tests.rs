use std::ops::Range;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::{
    CaseSensitivity, DiffCancellation, DiffDocument, DiffEngine, DiffError, DiffLimits,
    DiffOptions, DiffRow, DiffRowKind, DiffSide, InlineDiffMode, LineEnding, LineEndingPolicy,
    WhitespacePolicy,
};

#[test]
fn maps_context_additions_removals_and_replacements_with_one_based_lines() {
    let diff = DiffDocument::from_text("same\nold\nremoved", "same\nnew\nadded\n").unwrap();

    assert_eq!(diff.old_line_count(), 3);
    assert_eq!(diff.new_line_count(), 3);
    assert_eq!(
        diff.rows()
            .iter()
            .map(|row| (row.kind(), row.old_line(), row.new_line_number()))
            .collect::<Vec<_>>(),
        vec![
            (DiffRowKind::Context, Some(1), Some(1)),
            (DiffRowKind::Modified, Some(2), Some(2)),
            (DiffRowKind::Modified, Some(3), Some(3)),
        ]
    );
    assert_eq!(diff.rows()[1].old_text(), Some("old"));
    assert_eq!(diff.rows()[1].new_text(), Some("new"));
}

#[test]
fn preserves_exact_line_endings_and_detects_missing_final_newline() {
    let diff = DiffDocument::from_text("a\r\nb\nc\r", "a\r\nb\nc").unwrap();

    assert_eq!(diff.rows()[0].old().unwrap().ending(), LineEnding::CrLf);
    assert_eq!(diff.rows()[1].new_line().unwrap().ending(), LineEnding::Lf);
    assert_eq!(diff.rows()[2].kind(), DiffRowKind::Modified);
    assert_eq!(diff.rows()[2].old().unwrap().ending(), LineEnding::Cr);
    assert_eq!(
        diff.rows()[2].new_line().unwrap().ending(),
        LineEnding::None
    );

    let ignored = DiffDocument::with_options(
        "a\n",
        "a",
        DiffOptions::default().with_line_endings(LineEndingPolicy::Ignore),
    )
    .unwrap();
    assert_eq!(ignored.rows()[0].kind(), DiffRowKind::Context);
}

#[test]
fn comparison_policy_can_ignore_whitespace_and_case_without_losing_source_text() {
    let exact = DiffDocument::from_text("  Hello   World  ", "hello world").unwrap();
    assert_eq!(exact.rows()[0].kind(), DiffRowKind::Modified);

    let normalized = DiffDocument::with_options(
        "  Hello   World  ",
        "hello world",
        DiffOptions::default()
            .with_whitespace(WhitespacePolicy::CollapseRuns)
            .with_case_sensitivity(CaseSensitivity::Insensitive),
    )
    .unwrap();
    assert_eq!(normalized.rows()[0].kind(), DiffRowKind::Context);
    assert_eq!(normalized.rows()[0].old_text(), Some("  Hello   World  "));
    assert_eq!(normalized.rows()[0].new_text(), Some("hello world"));
}

#[test]
fn modified_rows_expose_unicode_grapheme_aligned_inline_ranges() {
    let diff = DiffDocument::from_text("let value = 1; 👩‍💻", "let value = 20; 👩‍🔧").unwrap();
    let changes = diff.rows()[0].inline_changes();

    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0].old_range(), Range { start: 12, end: 13 });
    assert_eq!(changes[0].new_range(), Range { start: 12, end: 14 });
    assert_eq!(
        &diff.rows()[0].old_text().unwrap()[changes[1].old_range()],
        "👩‍💻"
    );
    assert_eq!(
        &diff.rows()[0].new_text().unwrap()[changes[1].new_range()],
        "👩‍🔧"
    );

    let disabled = DiffDocument::with_options(
        "old",
        "new",
        DiffOptions::default().with_inline(InlineDiffMode::Disabled),
    )
    .unwrap();
    assert!(disabled.rows()[0].inline_changes().is_empty());
}

#[test]
fn git_style_hunks_match_the_checked_in_zero_context_fixture() {
    let original = include_str!("fixtures/git_original.txt");
    let modified = include_str!("fixtures/git_modified.txt");
    let diff = DiffDocument::with_options(original, modified, DiffOptions::new(0)).unwrap();

    assert_eq!(diff.hunks().len(), 2);
    let first = diff.hunks()[0];
    let second = diff.hunks()[1];
    assert_eq!(
        (
            first.old_start(),
            first.old_count(),
            first.new_start(),
            first.new_count(),
        ),
        (2, 1, 2, 1)
    );
    assert_eq!(
        (
            second.old_start(),
            second.old_count(),
            second.new_start(),
            second.new_count(),
        ),
        (5, 1, 5, 1)
    );
    assert_eq!(diff.rows_for_hunk(first).len(), 1);
}

#[test]
fn pure_insertions_and_deletions_use_git_style_empty_side_anchors() {
    let new_file = DiffDocument::with_options("", "b\n", DiffOptions::new(0)).unwrap();
    let initial = new_file.hunks()[0];
    assert_eq!(
        (
            initial.old_start(),
            initial.old_count(),
            initial.new_start(),
            initial.new_count(),
        ),
        (0, 0, 1, 1)
    );

    let insertion = DiffDocument::with_options("a\n", "a\nb\n", DiffOptions::new(0)).unwrap();
    let inserted = insertion.hunks()[0];
    assert_eq!(
        (
            inserted.old_start(),
            inserted.old_count(),
            inserted.new_start(),
            inserted.new_count(),
        ),
        (1, 0, 2, 1)
    );

    let deletion = DiffDocument::with_options("a\nb\n", "a\n", DiffOptions::new(0)).unwrap();
    let removed = deletion.hunks()[0];
    assert_eq!(
        (
            removed.old_start(),
            removed.old_count(),
            removed.new_start(),
            removed.new_count(),
        ),
        (2, 1, 1, 0)
    );
}

#[test]
fn rejects_binary_invalid_utf8_and_oversized_inputs() {
    let engine = DiffEngine::default();
    assert_eq!(
        engine.compute_bytes(b"a\0b", b"text"),
        Err(DiffError::BinaryInput {
            side: DiffSide::Original
        })
    );
    assert_eq!(
        engine.compute_bytes(b"text", &[0xff]),
        Err(DiffError::InvalidUtf8 {
            side: DiffSide::Modified
        })
    );

    let limits = DiffLimits::default().with_max_input_bytes_per_side(3);
    let limited = DiffEngine::new(DiffOptions::default().with_limits(limits));
    assert_eq!(
        limited.compute("four", "ok"),
        Err(DiffError::InputTooLarge {
            side: DiffSide::Original,
            actual: 4,
            limit: 3,
        })
    );

    let line_limits = DiffLimits::default().with_max_lines_per_side(1);
    let line_limited = DiffEngine::new(DiffOptions::default().with_limits(line_limits));
    assert_eq!(
        line_limited.compute("one\ntwo", "one"),
        Err(DiffError::TooManyLines {
            side: DiffSide::Original,
            actual: 2,
            limit: 1,
        })
    );
}

#[test]
fn observes_cancellation_and_algorithm_complexity_limits() {
    struct Cancelled;
    impl DiffCancellation for Cancelled {
        fn is_cancelled(&self) -> bool {
            true
        }
    }

    assert_eq!(
        DiffEngine::default().compute_cancellable("old", "new", &Cancelled),
        Err(DiffError::Cancelled)
    );

    struct CancelAfter {
        calls: AtomicUsize,
        allowed_calls: usize,
    }
    impl DiffCancellation for CancelAfter {
        fn is_cancelled(&self) -> bool {
            self.calls.fetch_add(1, Ordering::Relaxed) >= self.allowed_calls
        }
    }
    let delayed = CancelAfter {
        calls: AtomicUsize::new(0),
        allowed_calls: 2,
    };
    let large_equal_input = "x".repeat(16 * 1024);
    assert_eq!(
        DiffEngine::default()
            .compute_cancellable(&large_equal_input, &large_equal_input, &delayed,),
        Err(DiffError::Cancelled)
    );

    let limits = DiffLimits::default().with_max_edit_distance(0);
    let engine = DiffEngine::new(DiffOptions::default().with_limits(limits));
    assert_eq!(
        engine.compute("old", "new"),
        Err(DiffError::EditDistanceLimit { limit: 0 })
    );

    let trace_limits = DiffLimits::default().with_max_trace_cells(1);
    let engine = DiffEngine::new(DiffOptions::default().with_limits(trace_limits));
    assert_eq!(
        engine.compute("old", "new"),
        Err(DiffError::TraceLimit { limit: 1 })
    );
}

#[test]
fn mapped_rows_reconstruct_both_inputs_across_representative_edits() {
    for (original, modified) in [
        ("", ""),
        ("", "new\n"),
        ("old\n", ""),
        ("a\nb\nc", "a\nB\nc"),
        ("α\nβ\nγ\n", "α\n新增\nβ\n"),
        ("same\r\nline\r\n", "same\nline\n"),
    ] {
        let diff = DiffDocument::from_text(original, modified).unwrap();
        assert_eq!(render_side(diff.rows(), Side::Old), original);
        assert_eq!(render_side(diff.rows(), Side::New), modified);
    }
}

#[test]
fn handles_large_mostly_equal_code_without_exceeding_default_trace_bounds() {
    let original = (0..5_000)
        .map(|line| format!("let value_{line} = {line};"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut modified_lines = original.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
    modified_lines[2_500] = "let value_2500 = changed();".to_owned();
    let modified = modified_lines.join("\n");

    let diff = DiffDocument::from_text(&original, &modified).unwrap();

    assert_eq!(diff.hunks().len(), 1);
    assert_eq!(diff.rows()[2_500].kind(), DiffRowKind::Modified);
    assert_eq!(diff.rows()[2_500].old_line(), Some(2_501));
    assert_eq!(diff.rows()[2_500].new_line_number(), Some(2_501));
}

#[derive(Clone, Copy)]
enum Side {
    Old,
    New,
}

fn render_side(rows: &[DiffRow], side: Side) -> String {
    let mut text = String::new();
    for row in rows {
        let line = match side {
            Side::Old => row.old(),
            Side::New => row.new_line(),
        };
        let Some(line) = line else {
            continue;
        };
        text.push_str(line.text());
        text.push_str(match line.ending() {
            LineEnding::Lf => "\n",
            LineEnding::CrLf => "\r\n",
            LineEnding::Cr => "\r",
            LineEnding::None => "",
        });
    }
    text
}
