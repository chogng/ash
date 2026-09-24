use super::ActiveMention;
use super::MentionMatchKind;
use super::MentionPluginItem;
use super::MentionPopup;
use super::Mentions;
use super::active_mention;
use ash_file_search::PathMatch;
use ash_file_search::PathSearchSnapshot;
use std::path::PathBuf;

#[test]
fn active_token_resolves_at_the_cursor_without_matching_email_text() {
    assert_eq!(
        active_mention("review @src/lib", "review @src".len()),
        Some(ActiveMention {
            range: 7..15,
            query: "src/lib",
        })
    );
    assert_eq!(active_mention("mail@example.com", 8), None);
}

#[test]
fn popup_ignores_stale_results_and_preserves_dismissal_for_an_unchanged_token() {
    let mut popup = MentionPopup::default();
    let active = active_mention("@src", 4);
    popup.sync(active.clone());
    popup.apply_search_snapshot(snapshot("old", &["old.rs"]));
    assert!(popup.view().unwrap().matches.is_empty());
    popup.apply_search_snapshot(snapshot("src", &["src/lib.rs", "src/main.rs"]));

    popup.select_previous();
    assert_eq!(popup.view().unwrap().selected, 1);
    popup.select_next();
    assert_eq!(popup.view().unwrap().selected, 0);

    popup.dismiss();
    popup.sync(active);
    assert_eq!(popup.view(), None);
}

#[test]
fn completing_a_file_returns_only_the_active_token_edit() {
    let mut mentions = Mentions {
        popup: MentionPopup::default(),
    };
    mentions.sync("review @src please", "review @src".len());
    mentions.apply_search_snapshot(snapshot("src", &["src/lib.rs"]));

    let completion = mentions.complete_selected().unwrap();
    assert_eq!(completion.range, 7..11);
    assert_eq!(completion.value, "src/lib.rs");
}

#[test]
fn plugin_catalog_joins_file_mentions_and_keeps_the_at_prefix() {
    let mut mentions = Mentions {
        popup: MentionPopup::default(),
    };
    mentions.replace_plugin_catalog(vec![MentionPluginItem::new("acme/review".into())]);
    mentions.sync("use @ac", "use @ac".len());
    mentions.apply_search_snapshot(snapshot("ac", &["src/actions.rs"]));

    let view = mentions.view().unwrap();
    assert_eq!(view.matches.len(), 2);
    assert_eq!(view.matches[0].kind, MentionMatchKind::Plugin);
    assert_eq!(view.matches[0].label, "acme/review");

    let completion = mentions.complete_selected().unwrap();
    assert_eq!(completion.range, 4..7);
    assert_eq!(completion.value, "@acme/review");
}

fn snapshot(query: &str, paths: &[&str]) -> PathSearchSnapshot {
    PathSearchSnapshot {
        query: query.to_owned(),
        matches: paths
            .iter()
            .map(|path| PathMatch {
                score: 1,
                path: PathBuf::from(path),
                indices: Vec::new(),
            })
            .collect(),
        search_complete: true,
        ..PathSearchSnapshot::default()
    }
}
