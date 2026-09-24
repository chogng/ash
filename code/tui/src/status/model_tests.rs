use super::*;
use crate::status::ProcessCpuCurrent;
use crate::status::ProcessMemoryCurrent;
use crate::status::ProcessUsageView;
use crate::thread::TurnApprovalModes;
use ash_app_server_protocol::protocol::config::ModelRefDto;
use ash_app_server_protocol::protocol::git::GitDiffStatisticsDto;
use ash_app_server_protocol::protocol::git::GitHeadDto;
use ash_app_server_protocol::protocol::git::GitStatusResult;
use ash_protocol::ApprovalMode;
use ash_protocol::ModelMoneyAmount;
use ash_protocol::ModelReferenceCostSummary;
use ash_protocol::ModelUsageSummary;
use ash_protocol::StreamInstanceId;

#[test]
fn status_line_combines_plan_subagents_model_branch_and_changes() {
    let mut status_line = StatusLineModel::new();
    status_line.apply_model_label("claude-sonnet");
    status_line.apply_git_status(&git_status(1));

    assert_eq!(
        status_line.top_text_for_width(
            100,
            StatusLineRuntime {
                plan: Some((1, 3)),
                subagents: 1,
                ..StatusLineRuntime::default()
            }
        ),
        "plan 1/3 · subagents 1 · claude-sonnet · main · 1 change"
    );
    assert_eq!(
        status_line.policy_text_for_width(100, ApprovalMode::AskPermissions),
        "⏸ ask permissions on"
    );
}

#[test]
fn memory_and_cpu_are_opt_in_and_use_compact_text_when_space_is_tight() {
    let mut settings = StatusLineSettings::default();
    for item in StatusLineItem::ALL {
        settings.set(
            item,
            matches!(item, StatusLineItem::Memory | StatusLineItem::Cpu),
        );
    }
    let mut status_line = StatusLineModel::new();
    status_line.apply_settings(settings);
    let runtime = StatusLineRuntime {
        process_resources: ProcessUsageView {
            memory: ProcessMemoryCurrent::Available(146_590_924),
            cpu: ProcessCpuCurrent::Available(124),
        },
        ..StatusLineRuntime::default()
    };

    assert_eq!(
        status_line.top_text_for_width(40, runtime),
        "memory 139.8 MiB · cpu 12.4%"
    );
    assert_eq!(
        status_line.top_text_for_width(20, runtime),
        "mem 140M · cpu 12%"
    );
    assert_eq!(
        status_line.visible_process_resources(40, runtime),
        Some(ProcessResourceMetrics::MemoryAndCpu)
    );
    assert_eq!(
        status_line.visible_process_resources(9, runtime),
        Some(ProcessResourceMetrics::Memory)
    );
    assert_eq!(status_line.visible_process_resources(1, runtime), None);
}

#[test]
fn runtime_status_hides_resource_demand_when_it_uses_the_available_width() {
    let mut settings = StatusLineSettings::default();
    for item in StatusLineItem::ALL {
        settings.set(item, matches!(item, StatusLineItem::Memory));
    }
    let mut status_line = StatusLineModel::new();
    status_line.apply_settings(settings);
    let runtime = StatusLineRuntime {
        plan: Some((1, 3)),
        ..StatusLineRuntime::default()
    };

    assert_eq!(status_line.top_text_for_width(8, runtime), "plan 1/3");
    assert_eq!(status_line.visible_process_resources(8, runtime), None);
}

#[test]
fn git_changes_can_show_added_and_deleted_lines() {
    let mut settings = StatusLineSettings::default();
    settings.set_show_git_changes_as_diff(true);
    let mut status_line = StatusLineModel::new();
    status_line.apply_settings(settings);
    status_line.apply_git_status(&git_status(2));

    assert!(status_line.request_status_line_git_text_diff());
    assert_eq!(
        status_line.top_text_for_width(80, StatusLineRuntime::default()),
        "main"
    );

    status_line.apply_git_text_diff(
        git_status(2),
        GitDiffStatisticsDto {
            files: 2,
            additions: 14,
            deletions: 3,
        },
    );

    assert_eq!(
        status_line.top_text_for_width(80, StatusLineRuntime::default()),
        "main · +14 -3"
    );
    assert_eq!(
        status_line
            .top_segments_for_width(80, StatusLineRuntime::default())
            .iter()
            .map(|segment| (segment.text(), segment.kind()))
            .collect::<Vec<_>>(),
        vec![
            ("main", StatusLineSegmentKind::Chrome),
            (" · ", StatusLineSegmentKind::Chrome),
            ("+14", StatusLineSegmentKind::Inserted),
            (" ", StatusLineSegmentKind::Chrome),
            ("-3", StatusLineSegmentKind::Removed),
        ]
    );
    assert!(!status_line.request_status_line_git_text_diff());
}

#[test]
fn stale_git_line_statistics_do_not_replace_a_newer_status() {
    let mut settings = StatusLineSettings::default();
    settings.set_show_git_changes_as_diff(true);
    let mut status_line = StatusLineModel::new();
    status_line.apply_settings(settings);
    let mut stale = git_status(1);
    stale.revision = 3;
    status_line.apply_git_status(&stale);
    assert!(status_line.request_status_line_git_text_diff());
    let mut current = git_status(2);
    current.revision = 4;
    status_line.apply_git_status(&current);

    status_line.apply_git_text_diff(
        stale,
        GitDiffStatisticsDto {
            files: 1,
            additions: 7,
            deletions: 2,
        },
    );

    assert_eq!(
        status_line.top_text_for_width(80, StatusLineRuntime::default()),
        "main"
    );
    assert!(status_line.request_status_line_git_text_diff());
}

#[test]
fn status_line_shows_thread_cache_hit_rate_and_exact_reference_cost() {
    let mut status_line = StatusLineModel::new();
    status_line.apply_settings(accounting_settings());
    let mut usage = ModelUsageSummary::default();
    usage.model_invocations = 2;
    usage.input_tokens.reported = 10_000;
    usage.cached_input_tokens.reported = 7_500;
    status_line.apply_thread_accounting(
        &usage,
        &ModelReferenceCostSummary {
            known_amounts: vec![ModelMoneyAmount {
                currency: "USD".into(),
                pico_units: "10080000000".into(),
            }],
            complete: true,
        },
    );

    assert_eq!(
        status_line.top_text_for_width(80, StatusLineRuntime::default()),
        "cache hit 75.0% · cost $0.01008"
    );
}

#[test]
fn status_line_marks_incomplete_thread_accounting_without_inventing_values() {
    let mut status_line = StatusLineModel::new();
    status_line.apply_settings(accounting_settings());
    let mut usage = ModelUsageSummary::default();
    usage.model_invocations = 2;
    usage.input_tokens.complete = false;
    usage.cached_input_tokens.complete = false;
    status_line.apply_thread_accounting(
        &usage,
        &ModelReferenceCostSummary {
            known_amounts: vec![ModelMoneyAmount {
                currency: "USD".into(),
                pico_units: "1000000000".into(),
            }],
            complete: false,
        },
    );

    assert_eq!(
        status_line.top_text_for_width(80, StatusLineRuntime::default()),
        "cache hit unknown · cost ≥$0.001"
    );
}

fn accounting_settings() -> StatusLineSettings {
    let mut settings = StatusLineSettings::default();
    settings.set(StatusLineItem::CacheHitRate, true);
    settings.set(StatusLineItem::ReferenceCost, true);
    settings.set(StatusLineItem::Permissions, false);
    settings.set(StatusLineItem::Model, false);
    settings.set(StatusLineItem::GitBranch, false);
    settings.set(StatusLineItem::GitChanges, false);
    settings
}

#[test]
fn approval_modes_use_pause_fast_forward_and_play_symbols() {
    let status_line = StatusLineModel::new();

    assert_eq!(
        status_line.policy_text_for_width(80, ApprovalMode::AskPermissions),
        "⏸ ask permissions on"
    );
    assert_eq!(
        status_line.policy_text_for_width(80, ApprovalMode::AutoReview),
        "⏩ auto review on"
    );
    assert_eq!(
        status_line.policy_text_for_width(80, ApprovalMode::BypassPermissions),
        "▶ bypass permissions on"
    );
}

#[test]
fn running_turn_and_next_turn_are_both_explicit_when_the_modes_differ() {
    let status_line = StatusLineModel::new();

    assert_eq!(
        status_line.policy_text_for_width(
            100,
            TurnApprovalModes {
                current: Some(ApprovalMode::AskPermissions),
                next: ApprovalMode::AutoReview,
            },
        ),
        "⏸ current: ask permissions on · ⏩ next: auto review on"
    );
}

#[test]
fn configured_items_can_be_hidden_independently() {
    let mut status_line = StatusLineModel::new();
    status_line.apply_model_label("claude-sonnet");
    status_line.apply_git_status(&git_status(1));
    let mut settings = StatusLineSettings::default();
    settings.set(StatusLineItem::Permissions, false);
    settings.set(StatusLineItem::GitBranch, false);
    status_line.apply_settings(settings);

    assert_eq!(
        status_line.top_text_for_width(80, StatusLineRuntime::default()),
        "claude-sonnet · 1 change"
    );
    assert_eq!(
        status_line.policy_text_for_width(80, ApprovalMode::AutoReview),
        ""
    );
}

#[test]
fn base_git_updates_remain_independent_of_status_line_items() {
    let mut settings = StatusLineSettings::default();
    for item in StatusLineItem::ALL {
        settings.set(item, false);
    }
    settings.set_show_git_changes_as_diff(true);
    let mut status_line = StatusLineModel::new();
    status_line.apply_settings(settings.clone());

    status_line.apply_git_status(&git_status(2));

    assert_eq!(
        status_line.top_text_for_width(80, StatusLineRuntime::default()),
        ""
    );
    assert!(!status_line.request_status_line_git_text_diff());

    settings.set(StatusLineItem::GitBranch, true);
    settings.set(StatusLineItem::GitChanges, true);
    status_line.apply_settings(settings);

    assert_eq!(
        status_line.top_text_for_width(80, StatusLineRuntime::default()),
        "main"
    );
    assert!(status_line.request_status_line_git_text_diff());
}

#[test]
fn narrow_status_line_keeps_configured_order_and_uses_compact_values() {
    let mut status_line = StatusLineModel::new();
    status_line.apply_model_label("claude-sonnet");
    status_line.apply_git_status(&git_status(1));
    let mut settings = StatusLineSettings::default();
    settings.set(StatusLineItem::Permissions, false);
    status_line.apply_settings(settings);

    assert_eq!(
        status_line.top_text_for_width(24, StatusLineRuntime::default()),
        "claude-sonnet · main · *"
    );
}

#[test]
fn status_line_with_every_item_disabled_is_empty() {
    let mut status_line = StatusLineModel::new();
    let mut settings = StatusLineSettings::default();
    for item in StatusLineItem::ALL {
        settings.set(item, false);
    }
    status_line.apply_settings(settings);

    assert_eq!(
        status_line.top_text_for_width(80, StatusLineRuntime::default()),
        ""
    );
    assert_eq!(
        status_line.policy_text_for_width(80, ApprovalMode::AskPermissions),
        ""
    );
}

#[test]
fn very_narrow_status_line_truncates_on_character_boundaries() {
    let mut status_line = StatusLineModel::new();
    status_line.apply_model_label("模型alpha");
    let mut settings = StatusLineSettings::default();
    for item in StatusLineItem::ALL {
        settings.set(item, item == StatusLineItem::Model);
    }
    status_line.apply_settings(settings);

    assert_eq!(
        status_line.top_text_for_width(5, StatusLineRuntime::default()),
        "模型…"
    );
    assert_eq!(
        status_line.top_text_for_width(1, StatusLineRuntime::default()),
        "…"
    );
    assert_eq!(
        status_line.top_text_for_width(0, StatusLineRuntime::default()),
        ""
    );
}

fn git_status(change_count: usize) -> GitStatusResult {
    GitStatusResult {
        repository_id: "repository-1".into(),
        stream_instance_id: StreamInstanceId::new("git-stream").unwrap(),
        revision: 3,
        path: String::new(),
        head: GitHeadDto::Branch {
            name: "main".into(),
            object_id: "0123456789abcdef".into(),
            upstream: None,
        },
        changes: (0..change_count).map(|_| test_change()).collect(),
    }
}

fn test_change() -> ash_app_server_protocol::protocol::git::GitRepositoryChangeDto {
    use ash_app_server_protocol::protocol::git::GitChangeStatusDto;
    use ash_app_server_protocol::protocol::git::GitSubmoduleStateDto;
    ash_app_server_protocol::protocol::git::GitRepositoryChangeDto {
        path: "src/lib.rs".into(),
        original_path: None,
        index_status: GitChangeStatusDto::Unmodified,
        worktree_status: GitChangeStatusDto::Modified,
        conflicted: false,
        submodule: GitSubmoduleStateDto {
            is_submodule: false,
            commit_changed: false,
            tracked_changes: false,
            untracked_changes: false,
        },
    }
}

fn model(provider: &str, model: &str) -> ModelRefDto {
    ModelRefDto {
        provider: provider.into(),
        model: model.into(),
    }
}

#[test]
fn expressive_status_line_shrinks_bars_before_removing_numbers() {
    use super::super::StatusLineStyle;
    let mut settings = StatusLineSettings::default();
    for item in StatusLineItem::ALL {
        settings.set(item, false);
    }
    settings.set_style(StatusLineStyle::Rich);
    let mut line = StatusLineModel::new();
    line.apply_settings(settings);
    let runtime = StatusLineRuntime {
        plan: Some((1, 3)),
        ..Default::default()
    };
    assert_eq!(
        line.top_text_for_width(80, runtime),
        "📋 plan ███░░░░░░░ 1/3"
    );
    assert_eq!(line.top_text_for_width(18, runtime), "📋 plan █░░░ 1/3");
    assert_eq!(line.top_text_for_width(8, runtime), "plan 1/3");
    assert_eq!(
        line.top_text_for_width(
            80,
            StatusLineRuntime {
                plan: Some((0, 0)),
                ..Default::default()
            }
        ),
        "📋 plan 0/0"
    );
}

#[test]
fn context_progress_requires_matching_model_and_clears_on_thread_switch() {
    use super::super::StatusLineStyle;
    use ash_protocol::ModelContextUsage;
    use ash_protocol::ModelContextUsageSource;
    let mut settings = StatusLineSettings::default();
    for item in StatusLineItem::ALL {
        settings.set(item, item == StatusLineItem::Context);
    }
    settings.set_style(StatusLineStyle::Rich);
    let mut line = StatusLineModel::new();
    line.apply_settings(settings);
    let selected = model("provider", "model");
    line.apply_context_capacity(Some(&selected), Some(100));
    assert_eq!(
        line.top_text_for_width(80, Default::default()),
        "🧠 context unknown"
    );
    line.apply_context_usage(Some((
        ash_protocol::ModelRef::new(
            ash_protocol::ProviderId::new("provider").unwrap(),
            ash_protocol::ModelId::new("model").unwrap(),
        ),
        ModelContextUsage {
            used_tokens: 40,
            source: ModelContextUsageSource::Estimated,
        },
    )));
    assert_eq!(
        line.context_header_segments(false)
            .iter()
            .map(|segment| segment.text())
            .collect::<String>(),
        "[~40 / 100]"
    );
    assert_eq!(
        line.context_header_segments(true)
            .iter()
            .map(|segment| segment.text())
            .collect::<String>(),
        "[████░░░░░░ ~40%]"
    );
    assert_eq!(
        line.top_text_for_width(80, Default::default()),
        "🧠 context ████░░░░░░ ~40%"
    );
    line.apply_context_capacity(Some(&selected), Some(0));
    assert_eq!(
        line.top_text_for_width(80, Default::default()),
        "🧠 context unknown"
    );
    line.apply_context_capacity(Some(&model("provider", "other")), Some(100));
    assert_eq!(
        line.top_text_for_width(80, Default::default()),
        "🧠 context unknown"
    );
    line.apply_context_capacity(Some(&selected), Some(100));
    line.clear_thread_accounting();
    assert_eq!(
        line.top_text_for_width(80, Default::default()),
        "🧠 context unknown"
    );
}

#[test]
fn status_line_truncation_preserves_combined_emoji_and_accents() {
    for text in ["👩‍💻 developer", "🖥️ cpu", "éclair"] {
        for width in 0..20 {
            let plain = super::truncate_with_ellipsis(text, width);
            assert!(unicode_width::UnicodeWidthStr::width(plain.as_str()) <= width);
            let segments = super::truncate_segments_with_ellipsis(
                &[super::StatusLineSegment::chrome(text)],
                width,
            );
            let joined: String = segments.iter().map(|segment| segment.text()).collect();
            assert_eq!(joined, plain);
            let prefix = plain.trim_end_matches('…');
            assert!(text.starts_with(prefix));
            assert!(
                prefix.is_empty()
                    || unicode_segmentation::UnicodeSegmentation::grapheme_indices(text, true)
                        .any(|(index, _)| index == prefix.len())
                    || prefix == text
            );
        }
    }
}
