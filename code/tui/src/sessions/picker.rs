use crate::keymap::bindings;
use crate::sessions::session_size_label;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionSpec;
use crate::widgets::search_box::SearchBoxModel;
use ash_protocol::Session;
use ash_protocol::SessionStatus;
use chrono::DateTime;
use chrono::Local;
use std::collections::BTreeMap;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SessionSelectionAction {
    Resume { session_id: String },
}

pub(crate) type SessionChoices = ListSelectionSpec<SessionSelectionAction>;

pub(crate) fn session_choices(
    sessions: &[Session],
    active_session_id: Option<&str>,
) -> SessionChoices {
    session_choices_at(sessions, active_session_id, current_unix_millis())
}

fn session_choices_at(
    sessions: &[Session],
    active_session_id: Option<&str>,
    now_unix_ms: u64,
) -> SessionChoices {
    let mut actions = BTreeMap::new();
    let mut selected = 0;
    let items = sessions
        .iter()
        .filter(|session| session.status == SessionStatus::Active)
        .enumerate()
        .map(|(index, session)| {
            if Some(session.session_id.as_str()) == active_session_id {
                selected = index;
            }
            session_item(session, now_unix_ms, &mut actions)
        })
        .collect::<Vec<_>>();

    SessionChoices {
        model: ListSelectionModel::new(
            "Resume session",
            vec![ListSelectionGroup::new("Sessions", items)],
        )
        .without_tab_bar()
        .with_activation(bindings::SESSION_RESUME)
        .with_initial_selected(selected)
        .with_search(SearchBoxModel::new("Search saved sessions"))
        .with_empty_message("No matching sessions"),
        actions,
    }
}

fn session_item(
    session: &Session,
    now_unix_ms: u64,
    actions: &mut BTreeMap<ListSelectionItemId, SessionSelectionAction>,
) -> ListSelectionItem {
    let item_id = ListSelectionItemId::new(format!("session:{}", session.session_id));
    actions.insert(
        item_id.clone(),
        SessionSelectionAction::Resume {
            session_id: session.session_id.to_string(),
        },
    );
    ListSelectionItem::new(session.title.clone())
        .with_id(item_id)
        .with_description(format!(
            "{}  ·  {}",
            session_time(session, now_unix_ms),
            session_size_label(session),
        ))
}

fn session_time(session: &Session, now_unix_ms: u64) -> String {
    let changed_at = session.manager.status_changed_at_unix_ms;
    if changed_at == 0 {
        return "time unknown".into();
    }
    let minutes = now_unix_ms.saturating_sub(changed_at) / 60_000;
    match minutes {
        0 => "just now".into(),
        1..60 => format!("{minutes}m ago"),
        60..1_440 => {
            let hours = minutes / 60;
            let minutes = minutes % 60;
            if minutes == 0 {
                format!("{hours}h ago")
            } else {
                format!("{hours}h {minutes:02}m ago")
            }
        }
        1_440..10_080 => {
            let days = minutes / 1_440;
            let hours = minutes / 60 % 24;
            if hours == 0 {
                format!("{days}d ago")
            } else {
                format!("{days}d {hours}h ago")
            }
        }
        _ => {
            let Some(date) = i64::try_from(changed_at)
                .ok()
                .and_then(DateTime::from_timestamp_millis)
            else {
                return "time unknown".into();
            };
            date.with_timezone(&Local).format("%Y-%m-%d").to_string()
        }
    }
}

fn current_unix_millis() -> u64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after the Unix epoch")
        .as_millis();
    u64::try_from(millis).expect("Unix millisecond timestamp must fit u64")
}

#[cfg(test)]
#[path = "picker_tests.rs"]
mod tests;
