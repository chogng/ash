use super::chat_panel::ChatPanel;
use crate::thread::interaction::approval::Approval;
use crate::thread::interaction::approval::ApprovalSpec;
use crate::thread::interaction::query::Query;
use crate::thread::interaction::query::QueryChoice;
use crate::thread::interaction::query::QueryCustomAnswer;
use crate::thread::interaction::query::QueryQuestion;

#[test]
fn approval_and_query_share_one_request_position() {
    let mut panel = ChatPanel::new();
    panel.show_approval(Approval::new(ApprovalSpec {
        title: "Approval required".into(),
        reason: "Write a file".into(),
        details: Vec::new(),
    }));

    assert!(panel.approval_view().is_some());
    assert!(panel.query_view().is_none());

    panel.show_query(
        Query::new(vec![QueryQuestion {
            id: "choice".into(),
            header: "Choose".into(),
            prompt: "Which option?".into(),
            choices: vec![QueryChoice {
                label: "First".into(),
                description: "Use the first option".into(),
            }],
            custom_answer: QueryCustomAnswer::Unavailable,
        }])
        .expect("the test Query is valid"),
    );

    assert!(panel.approval_view().is_none());
    assert!(panel.query_view().is_some());
}

#[test]
fn opening_an_approval_replaces_an_existing_query() {
    let mut panel = ChatPanel::new();
    panel.show_query(
        Query::new(vec![QueryQuestion {
            id: "choice".into(),
            header: "Choose".into(),
            prompt: "Which option?".into(),
            choices: vec![QueryChoice {
                label: "First".into(),
                description: "Use the first option".into(),
            }],
            custom_answer: QueryCustomAnswer::Unavailable,
        }])
        .expect("the test Query is valid"),
    );

    panel.show_approval(Approval::new(ApprovalSpec {
        title: "Approval required".into(),
        reason: "Write a file".into(),
        details: Vec::new(),
    }));

    assert!(panel.approval_view().is_some());
    assert!(panel.query_view().is_none());
}
