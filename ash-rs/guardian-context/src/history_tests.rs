use super::*;
use protocol::ItemId;
use protocol::TurnId;

#[test]
fn history_keeps_author_order_and_never_promotes_an_agent_task() {
    let turn = TurnId::new("turn").unwrap();
    let thread = ThreadId::new("thread").unwrap();
    let items = [
        ThreadItem::UserMessage {
            item_id: ItemId::new("user").unwrap(),
            turn_id: turn.clone(),
            text: "Only inspect".into(),
        },
        ThreadItem::AgentMessage {
            item_id: ItemId::new("agent").unwrap(),
            turn_id: turn.clone(),
            text: "I propose publishing".into(),
        },
        ThreadItem::UserMessage {
            item_id: ItemId::new("answer").unwrap(),
            turn_id: turn,
            text: "Do not publish".into(),
        },
    ];
    let direct = collect(&thread, MessageOrigin::User, &items);
    assert_eq!(
        direct
            .iter()
            .map(|entry| entry.content())
            .collect::<Vec<_>>(),
        ["Only inspect", "I propose publishing", "Do not publish"]
    );
    assert_eq!(direct[1].trust(), ReviewEvidenceTrust::UntrustedContent);
    assert!(direct[2].source().ends_with("/item/answer"));
    let delegated = collect(&thread, MessageOrigin::Agent, &items);
    assert!(
        delegated
            .iter()
            .all(|entry| entry.trust() == ReviewEvidenceTrust::UntrustedContent)
    );
    assert_eq!(delegated[0].kind(), ReviewEvidenceKind::Delegation);
}
