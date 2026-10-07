use super::export_markdown;
use crate::thread::transcript::CellView;
use crate::thread::transcript::MessageRole;

#[test]
fn markdown_export_preserves_roles_and_details() {
    let messages = vec![
        CellView::plain(MessageRole::User, "hello".into()),
        CellView::plain(MessageRole::Agent, "world".into()),
        CellView::local_command(
            "/example".into(),
            crate::thread::transcript::CommandStatus::Succeeded,
            Some("detail".into()),
        ),
    ];

    assert_eq!(
        export_markdown(&messages),
        "## User\n\nhello\n\n## Ash\n\nworld\n\n## Command\n\n/example\n\n```text\ndetail\n```\n\n"
    );
}

#[test]
fn markdown_export_uses_full_content_independently_of_expansion() {
    let text = "complete reasoning\n".repeat(20);
    let collapsed = CellView::plain(MessageRole::Reasoning, text.clone());
    let expanded = collapsed.clone().with_presentation(true, true);
    let expected = format!("## Reasoning\n\n{text}\n\n");
    assert_eq!(export_markdown(&[collapsed]), expected);
    assert_eq!(export_markdown(&[expanded]), expected);
}
